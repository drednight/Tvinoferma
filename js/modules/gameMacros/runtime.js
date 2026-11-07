import { backgroundReport } from './diagnostics.js';
import { BACKGROUND_METHODS, backgroundMethod, validateActivityCommand } from './background.js';
import { inputLabel, formatMirrorInput } from './inputTrace.js';
import { compileComposition, executeComposition, compositionActions } from './composition.js';
import { listen, emitTo } from '@tauri-apps/api/event';
import { state } from '../../core/state.js';
import {
  normalizeGameMacros,
  commandVisible,
  resolveTargets,
  steps,
  commandPoint,
  validPoint,
  backgroundCompatible,
  orderManagedTargets
} from './model.js';
let invoke;
let rootTiming = { switchMs: 30, holdMs: 30, backgroundMethod: 'post' },
  inputTiming = rootTiming;
let mirrorKeys = false,
  mirrorMouse = false;
let initialized = false,
  busy = false,
  cancelled = false,
  registered = false;
let cycleId = '';
let mirroring = false,
  mirrorPending = false,
  mirrorEpoch = 0,
  mirrorSession = '',
  mirrorTimer,
  mirrorInit;
let paused = false,
  composing = false;
let launchProgress = null;
let overlayWindows = [],
  overlayWindowNotice = 'Нажмите «Обновить окна», чтобы проверить запущенные клиенты.';
const logs = [];
const logEntries = [];
let activeCommandName = '',
  notice = '';
let executionState = 'idle';
const reviewedPoints = new Set();
export const config = () => normalizeGameMacros(state.settings.gameMacros);
const native = async (command, args) => {
  if (!window.__TAURI_INTERNALS__) throw new Error('Нужна настольная версия Windows.');
  invoke ||= (await import('@tauri-apps/api/core')).invoke;
  return invoke(command, args);
};
export function snapshot() {
  const c = config();
  return {
    busy,
    parties: (state.parties || []).map(({ id, name }) => ({ id, name })),
    partyId: c.partyId,
    windows: overlayWindows,
    windowNotice: overlayWindowNotice,
    launchProgress,
    executionState,
    runningName: activeCommandName,
    mirroring,
    mirrorKeys,
    mirrorMouse,
    mirrorPending,
    paused,
    registered,
    opacity: c.opacity,
    appearance: c.appearance,
    topmost: c.topmost,
    commands: c.commands.filter(commandVisible).map(({ id, name, hotkey, action }) => ({
      id,
      name,
      hotkey,
      allowWhileBusy: action === 'pause'
    })),
    notice,
    logEntries: logEntries.slice(-300),
    logs: logs.slice(-300)
  };
}
// Clear only this in-memory journal; do not cancel input or change execution state.
export async function clearLogs() {
  logs.length = 0;
  logEntries.length = 0;
  await broadcast();
}
export async function broadcast() {
  window.dispatchEvent(new Event('tf-game-macros-changed'));
  if (!window.__TAURI_INTERNALS__) return;
  try {
    await emitTo('game-overlay', 'game-macro-snapshot', snapshot());
  } catch {
    /* overlay closed */
  }
}
function log(text, commandName = activeCommandName, notify = true, terminal = false) {
  logs.push(`${new Date().toLocaleTimeString('ru-RU')} · ${text}`);
  logEntries.push({ text: logs.at(-1), commandName, terminal });
  if (logs.length > 300) {
    logs.shift();
    logEntries.shift();
  }
  if (notify) void broadcast();
}
export function stop(stopMirror = true) {
  if (stopMirror && (mirroring || mirrorPending || mirrorKeys || mirrorMouse)) void disableKeyboardMirror();
  cancelled = true;
  executionState = busy ? 'stopping' : 'stopped';
  notice = busy ? 'Остановка запрошена…' : 'Остановлено пользователем.';
  void broadcast();
  if (busy && window.__TAURI_INTERNALS__)
    void native('game_macro_guide', { mode: 'close', width: 0, height: 0, target: null, requestId: null }).catch(
      () => {}
    );
  if (busy) log('Запрошена остановка. Уже отправленный ввод отменить нельзя.');
}
const wait = async (ms, aborted = () => false) => {
  for (let left = ms; left > 0; left -= 50) {
    await checkpoint(aborted);
    await new Promise(r => setTimeout(r, Math.min(50, left)));
  }
};
let configureQueue = Promise.resolve();
export function configure() {
  configureQueue = configureQueue.catch(() => {}).then(applyConfig);
  return configureQueue;
}
async function applyConfig() {
  if (mirrorPending) mirrorConfigDirty = true;
  else if ((mirroring || mirrorKeys || mirrorMouse) && mirrorConfigKey !== mirrorFingerprint())
    await toggleKeyboardMirror('keyboard', '', { keys: mirrorKeys, mouse: mirrorMouse });
  const c = config();
  registered = false;
  if (!window.__TAURI_INTERNALS__) {
    void broadcast();
    return;
  }
  const bindings = c.enabled
    ? [
        { id: 'stop', chord: 'CTRL+ALT+PAUSE' },
        ...c.commands.filter(row => row.hotkey && commandReady(c, row)).map(row => ({ id: row.id, chord: row.hotkey }))
      ]
    : [];
  try {
    await native('game_macro_bindings', { bindings: [] });
    if (new Set(bindings.map(b => b.chord)).size !== bindings.length)
      throw new Error('Горячие клавиши повторяются; Ctrl+Alt+Pause зарезервирована для остановки.');
    await native('game_macro_bindings', { bindings });
    registered = c.enabled;
  } catch {
    log('Горячие клавиши не включены: сочетание занято или Windows недоступна. Кнопки остаются доступны.');
  }
  void broadcast();
}
export async function openOverlay() {
  await initGameMacros();
  state.settings.gameMacros = { ...config(), appearance: { ...config().appearance, hideHeader: false } };
  await native('game_macro_overlay', {
    topmost: config().topmost,
    position: config().overlayPosition,
    existingOnly: false
  });
  await broadcast();
}
export async function listMacroWindows() {
  const { windowRows } = await import('../launcher/windowList.js');
  const { windowOwnershipOptions } = await import('../launcher/launchedWindows.js');
  const clients = await native('launcher_running_details');
  const selfElevated = clients.some(c => c.elevated === true) && (await native('launcher_self_elevated')) === true;
  const rows = windowRows(clients, state.characters, windowOwnershipOptions(clients)).map(r => ({
    ...r,
    ...clients.find(c => c.pid === r.pid),
    selfElevated
  }));
  for (const row of rows) {
    if (
      row.ownershipSource !== 'manual' &&
      state.characters.filter(c => String(c.nick).toLowerCase() === String(row.nick).toLowerCase()).length > 1
    )
      row.known = false;
  }
  return rows;
}
export async function windowTargets(
  command = { target: 'all', action: 'next' },
  selected = config(),
  snapshotRows = null
) {
  selected = scopedConfig(selected, command);
  const rows = snapshotRows || (await listMacroWindows());
  if (command.scope === 'managed') {
    if (command.target !== 'all' || command.action === 'leader')
      throw new Error('Глобальная область требует явного выбора всех распознанных окон.');
    if (
      !rows.length ||
      rows.some(
        row =>
          !row.known ||
          !row.startedAt ||
          !row.hwnd ||
          !(row.elevated === false || (row.elevated === true && row.selfElevated === true))
      ) ||
      new Set(rows.map(row => row.charId)).size !== rows.length
    )
      throw new Error('Все окна должны быть однозначно распознаны.');
    return orderManagedTargets(state, selected, rows);
  }
  return resolveTargets(state, selected, command, rows);
}
let inputStarted = 0,
  firstInputLogged = false;
const act = async (row, action, extra = {}) => {
  if (busy && cancelled) throw new Error('cancel');
  const input = ['key', 'key-background', 'click', 'right-click'].includes(action);
  if (input && busy && !firstInputLogged && inputStarted) {
    firstInputLogged = true;
    log(
      `Первый запрос ввода: через ${Math.round(performance.now() - inputStarted)} мс после запуска (до обработки Windows/игрой).`
    );
  }
  const result = await native('game_macro_action', {
    target: { pid: row.pid, startedAt: row.startedAt, ...(row.hwnd ? { hwnd: row.hwnd } : {}) },
    timing: inputTiming,
    action,
    key: null,
    rect: null,
    point: null,
    ...extra
  });
  if (action === 'key-background' && result?.schema === 1) {
    log(`Диагностика ввода → ${row.nick || row.pid}:`, '', false);
    for (const line of backgroundReport(result)) log(line, '', false);
    if (inputTiming.backgroundMethod === 'activity' && typeof result.originalForeground === 'string')
      inputTiming.activityForeground ??= result.originalForeground;
    if (result.ok === false) {
      if (result.foregroundChanged) throw new Error('Focus changed during background test');
      if (result.refused)
        throw new Error('Тест активности отклонён: проверьте состояние окна и отпустите клавиши/мышь.');
      if (result.error != null) throw new Error(`Background delivery failed: ${result.error}`);
      throw new Error('Focus changed during background test');
    }
  }
  if (input)
    log(
      `Отправлено: ${extra.key || (action === 'right-click' ? 'ПКМ' : 'ЛКМ')} → ${row.nick || row.pid}${extra.point ? ` · точка (${extra.point.x}, ${extra.point.y})` : ''}. Нажатие и отпускание; обработка игрой не подтверждена.`
    );
  return result;
};
export async function saveProfile(name) {
  if (busy) throw new Error('Дождитесь окончания команды.');
  busy = true;
  cancelled = false;
  void broadcast();
  try {
    const c = config();
    const rows = await windowTargets({ target: 'all', action: 'layout' }, c);
    const windows = [];
    for (const row of rows) {
      await wait(50);
      windows.push({ charId: row.charId, ...(await act(row, 'geometry')) });
    }
    const profile = { id: crypto.randomUUID(), name: String(name).slice(0, 80), windows };
    state.settings.gameMacros = {
      ...config(),
      profiles: [...config().profiles, profile].slice(-10),
      profileId: profile.id
    };
  } finally {
    busy = false;
    void broadcast();
  }
}
export function macroErrorText(error) {
  const raw = String(error?.message || error || 'Не удалось выполнить команду.');
  const deliveryFailure = /^Background delivery failed: (\d{1,10})$/.exec(raw);
  if (deliveryFailure) {
    const code = Number(deliveryFailure[1]);
    const reason =
      code === 5
        ? 'Отказ в доступе Windows (код 5): возможное ограничение прав/UIPI.'
        : code === 1460
          ? 'Таймаут Windows (код 1460).'
          : code === 0
            ? 'Windows не подтвердила доставку и не сообщила код ошибки.'
            : `Windows не подтвердила доставку (код ${code}).`;
    return `${reason} Сделаны попытки отпускания тем же способом; автоповтора и переключения фокуса нет.`;
  }
  const messages = {
    'Point is outside client area':
      'Абсолютная точка не попадает в клиентскую область получателя. Передача остановлена без клика по другому приложению.',
    'no party': 'Выберите пати в верхней части раздела.',
    'PL required': 'В настройках выбранной пати назначьте ПЛ.',
    'preview required':
      'Для этой координатной команды нажмите «Предпросмотр без клика» в «Моих командах». Это нужно один раз в текущем сеансе и после изменения точки.',
    'Ambiguous/missing calibration for client size and DPI':
      'Для одного из окон нет единственной подходящей точки. Задайте точку при его текущем размере и масштабе Windows; для других размеров добавьте дополнительные профили этой же точки.',
    'no complete profile': 'Не выбран полный профиль размещения окон. Сначала сохраните профиль для текущей пати.',
    'missing profile member':
      'В профиле размещения отсутствует участник пати. Сохраните профиль заново для текущего состава.',
    'Release modifier keys and retry':
      'После запуска отпустите Ctrl, Shift и Alt. Команда не отправлялась с зажатыми клавишами. Нажмите сочетание ещё раз коротко.',
    'Not the active game window': 'Сначала активируйте игровое окно выбранной пати, затем нажмите сочетание.',
    'Focus changed; command stopped': 'Активное окно сменилось. Не переключайте окна во время выполнения команды.',
    'Windows refused game activation':
      'Windows не разрешила переключиться на игру. Откройте клиент вручную и повторите.',
    'Client size or DPI differs from calibration':
      'Размер игровой области или масштаб Windows изменился после задания точки. Задайте координаты заново и выполните предпросмотр.',
    'Another window covers the calibrated point':
      'Место клика перекрыто другим окном. Уберите оверлей или другое окно с этой точки.',
    'Focus changed or physical input is held':
      'Фокус сменился или зажата кнопка мыши/клавиша. Отпустите ввод и повторите из игрового окна.',
    'Game window disappeared':
      'Игровое окно закрылось или перезапустилось. Заново откройте клиент и проверьте список окон.',
    'Focus changed during background test':
      'Во время фонового теста изменился фокус. Дальнейший ввод остановлен, переключение обратно не выполнялось.',
    'Cannot deliver background key':
      'Windows не подтвердила фоновую доставку: таймаут или отказ. Сделаны попытки отпускания тем же способом; автоповтора и переключения фокуса нет.',
    'Cannot queue background key':
      'Windows отказала в постановке фоновой клавиши. Автоповтора и переключения окон нет.',
    'Focus changed while clicking': 'Во время клика сменился фокус. Кнопка отпущена, дальнейший ввод остановлен.',
    'Windows did not accept the click':
      'Windows не приняла нажатие или отпускание мыши целиком. Дальнейшие клики остановлены.',
    'Key input incomplete or focus changed':
      'Windows не приняла ввод целиком или сменилось активное окно. Повтора автоматически не будет.'
  };
  return (
    messages[raw] ||
    (/[А-Яа-яЁё]/.test(raw) && !/(https?:|token|password|cookie|\/home\/|[A-Z]:\\)/i.test(raw)
      ? raw.slice(0, 600)
      : 'Не удалось проверить или выполнить действие Windows. Откройте «Проверить окна»; ввод не повторяется автоматически.')
  );
}
export async function run(id, hotkey = false) {
  if (id === 'stop') {
    stop();
    return;
  }
  const requested = config().commands.find(row => row.id === id);
  if (requested?.action === 'pause') {
    paused = !paused;
    if (!composing) stop(false);
    log(paused ? 'Макросы на паузе.' : 'Макросы возобновлены.');
    void broadcast();
    return;
  }
  if (paused) {
    log('Макросы на паузе. Нажмите «Пауза / продолжить».');
    return;
  }
  if (busy) {
    log('Предыдущая команда ещё выполняется.');
    return;
  }
  const c = config(),
    command = c.commands.find(r => r.id === id);
  if (!command) return;
  try {
    validateActivityCommand(command);
  } catch (error) {
    notice = macroErrorText(error);
    executionState = 'failed';
    log(notice, command.name);
    void broadcast();
    return;
  }
  if (['mirror', 'mouse-mirror'].includes(command.action)) {
    await toggleKeyboardMirror(command.action === 'mouse-mirror' ? 'mouse' : 'keyboard', command.name);
    return;
  }
  busy = true;
  notice = '';
  activeCommandName = command.name;
  executionState = 'running';
  const started = performance.now();
  inputStarted = started;
  firstInputLogged = false;
  let suspended = false;
  cancelled = false;
  log(`Запуск: ${command.name}. Проверка окон и отпускания клавиш…`);
  try {
    const idleArgs = { chord: hotkey ? command.hotkey : null };
    let idle = await native('game_macro_input_idle', idleArgs);
    const preparedRows = !['composite', 'launch'].includes(command.action) ? listMacroWindows() : null;
    if (preparedRows) void preparedRows.catch(() => {});
    for (let attempt = 0; idle === false; attempt++) {
      if (attempt >= 150)
        throw new Error(
          'Отпустите клавиши запуска, модификаторы и кнопки мыши, затем повторите команду. Ввод не отправлен.'
        );
      await wait(10);
      idle = await native('game_macro_input_idle', idleArgs);
    }
    await checkpoint();
    suspended = true;
    await native('game_macro_bindings', { bindings: [{ id: 'stop', chord: 'CTRL+ALT+PAUSE' }] });
    registered = false;
    rootTiming = {
      switchMs: command.switchMs ?? 30,
      holdMs: command.holdMs ?? 30,
      backgroundMethod: backgroundMethod(command.backgroundMethod)
    };
    inputTiming = rootTiming;
    if (command.action === 'composite') {
      composing = true;
      const plan = compileComposition(command, c);
      await preflightComposition(plan, c, false);
      await executeComposition(plan, {
        action: cmd => executeLegacy(cmd, c, false, false),
        wait,
        checkpoint,
        pause: async () => {
          paused = true;
          log('Последовательность на паузе. Нажмите «Пауза / продолжить».');
        }
      });
      if (command.returnTo === 'leader') {
        const [leader] = await windowTargets({ action: 'leader', target: 'leader' }, scopedConfig(c, command));
        await checkpoint();
        await act(leader, 'focus');
      }
    } else await executeLegacy(command, c, hotkey, true, preparedRows);
    executionState = cancelled ? 'stopped' : 'finished';
    notice = cancelled ? 'Остановлено пользователем.' : `Завершена: ${command.name}.`;
    if (command.delivery === 'background')
      notice += ' Фоновая доставка: игра может игнорировать сообщения; результат не подтверждён.';
    log(notice, activeCommandName, true, true);
  } catch (error) {
    executionState = cancelled ? 'stopped' : 'failed';
    notice = cancelled ? 'Остановлено пользователем.' : `Остановлено: ${macroErrorText(error)}`;
    log(notice, activeCommandName, true, true);
  } finally {
    log(
      `Время выполнения: ${Math.round(performance.now() - started)} мс. Это время доставки/проверок, не подтверждение действия в игре.`,
      activeCommandName,
      true,
      true
    );
    activeCommandName = '';
    inputStarted = 0;
    if (composing) paused = false;
    composing = false;
    if (suspended) {
      try {
        await configure();
      } catch (error) {
        log(`Сочетания не восстановлены: ${macroErrorText(error)}`);
      }
    }
    if (cancelled && executionState !== 'failed') {
      executionState = 'stopped';
      notice = 'Остановлено пользователем.';
    }
    busy = false;
    void broadcast();
  }
}

async function executeLegacy(command, c, hotkey = false, restore = true, preparedRows = null) {
  await checkpoint();
  c = scopedConfig(c, command);
  inputTiming = {
    switchMs: command.switchMs ?? rootTiming.switchMs ?? 30,
    holdMs: command.holdMs ?? rootTiming.holdMs ?? 30,
    backgroundMethod: backgroundMethod(command.backgroundMethod ?? rootTiming.backgroundMethod)
  };
  if (command.action === 'launch') {
    const party = state.parties.find(p => p.id === (command.partyId || c.partyId));
    if (!party) throw new Error('no party');
    const { launchPartyByName } = await import('../launcher/partyLaunch.js');
    const result = await launchPartyByName(party.name, {
      cancelled: () => cancelled,
      onProgress: progress => {
        launchProgress = progress;
        void broadcast();
      }
    });
    if (!result || result.some(r => r.ok === false || r.cancelled))
      throw new Error('Запуск пати не завершён. Последующие действия не выполнялись.');
    for (let tries = 0; tries < 60; tries++) {
      try {
        await windowTargets({ action: 'sequence', target: 'all' }, { ...c, partyId: party.id });
        break;
      } catch (error) {
        if (tries === 59) throw error;
        await wait(250);
      }
    }
    log('Открыта штатная очередь запуска пати.');
    return;
  }
  if (
    command.delivery === 'background' &&
    !backgroundCompatible(command) &&
    !['click', 'screen', 'layout', 'resize'].includes(command.action)
  )
    throw new Error('Эта команда не поддерживает фоновую доставку. Нужна последовательность клавиш либо F6→F1.');
  validateActivityCommand(command, composing);
  const snapshotRows = await (preparedRows || listMacroWindows());
  let rows,
    fallbackAll = false;
  try {
    rows = await windowTargets(command, c, snapshotRows);
  } catch (error) {
    if (composing || command.action !== 'sequence' || command.scope === 'managed') throw error;
    // Resolution-only fallback, before input. Never retry/broaden after a delivery failure.
    if (
      !snapshotRows.length ||
      snapshotRows.some(
        row =>
          !row.pid ||
          !row.startedAt ||
          !row.hwnd ||
          !(row.elevated === false || (row.elevated === true && row.selfElevated === true))
      ) ||
      new Set(snapshotRows.map(row => row.pid)).size !== snapshotRows.length
    ) {
      throw new Error(
        'Резерв для всех окон недоступен: есть непроверенный процесс, дескриптор или права. Ввод не отправлен.',
        { cause: error }
      );
    }
    rows = orderManagedTargets(
      state,
      c,
      snapshotRows.map(row => ({
        ...row,
        charId: row.known ? row.charId : `window:${row.pid}`,
        nick: row.known ? row.nick : `PID ${row.pid}`
      }))
    );
    fallbackAll = true;
    log(
      `Управляющая пати недоступна: ${macroErrorText(error)} Резерв: ВСЕ проверенные игровые окна (${rows.length}). Фильтр ПЛ/поднабора не применяется.`,
      command.name
    );
  }
  if (hotkey) {
    let foreground = false;
    const memberIds = new Set((await import('./model.js')).partyMembers(state, c.partyId).map(ch => ch.id));
    const sources =
      fallbackAll || command.scope === 'managed'
        ? rows
        : snapshotRows.filter(row => row.known && memberIds.has(row.charId));
    for (const row of sources) {
      try {
        await act(row, 'foreground');
        foreground = true;
        break;
      } catch {
        /* not this window */
      }
    }
    if (!foreground) {
      throw new Error('Горячая команда пропущена: активное окно не относится к выбранной пати.');
    }
  }
  log(`Начало: ${command.name}. Получателей: ${rows.length}.`);
  log(
    `Порядок «${fallbackAll ? 'Все проверенные игровые окна (резерв)' : state.parties.find(p => p.id === c.partyId)?.name || 'Все окна'}»: ${rows.map(row => state.characters.find(ch => ch.id === row.charId)?.nick || row.pid).join(' → ')}`
  );
  if (command.delivery === 'background' && ['sequence', 'f6f1'].includes(command.action)) {
    log(
      `Фоновый тест: ${BACKGROUND_METHODS[inputTiming.backgroundMethod]}. Выполняется один выбранный способ; обработки игрой это не подтверждает.`
    );
    const send = async (row, key) => {
      if (cancelled) throw new Error('cancel');
      await act(row, 'key-background', { key });
    };
    if (command.action === 'f6f1') {
      const scoped = scopedConfig(c, command),
        leaderId = scoped.leaders[scoped.partyId];
      if (!rows.some(row => row.charId === leaderId)) throw new Error('PL required');
      for (const row of rows.filter(row => row.charId !== leaderId)) await send(row, 'F6');
      for (const row of rows) await send(row, 'F1');
    } else {
      for (const row of rows) {
        let previousKey = false;
        for (const step of steps(command.sequence)) {
          if (step.wait) {
            await wait(step.wait);
            previousKey = false;
          } else {
            if (previousKey) await wait(30);
            await send(row, step.key);
            previousKey = true;
          }
        }
      }
    }
    log(
      'Доставка оконных сообщений завершена без обнаруженного переключения foreground. Обработка игрой НЕ подтверждена; автоматического повтора/переключения нет.'
    );
    return;
  }

  if (['next', 'previous'].includes(command.action)) {
    let activeId = cycleId;
    for (const row of rows) {
      try {
        await act(row, 'foreground');
        activeId = row.charId;
        break;
      } catch {
        /* not active */
      }
    }
    const found = rows.findIndex(r => r.charId === activeId),
      idx = found < 0 && command.action === 'previous' ? 0 : found,
      next = (idx + (command.action === 'next' ? 1 : -1) + rows.length) % rows.length;
    await act(rows[next], 'focus');
    cycleId = rows[next].charId;
    log('Окно переключено.');
    return;
  }
  if (command.action === 'f6f1' || command.action === 'optimize') {
    const scoped = scopedConfig(c, command),
      leaderId = scoped.leaders[scoped.partyId];
    const leader = rows.find(row => row.charId === leaderId);
    if (!leader) throw new Error('PL required');
    if (command.action === 'f6f1') {
      for (const row of rows.filter(r => r.charId !== leaderId)) {
        if (cancelled) throw new Error('cancel');
        await act(row, 'focus');
        await act(row, 'key', { key: 'F6' });
      }
      for (const row of rows) {
        if (cancelled) throw new Error('cancel');
        await act(row, 'focus');
        await act(row, 'key', { key: 'F1' });
      }
    } else {
      const rectFor = row => ({
        x: 0,
        y: 0,
        width: row.charId === leaderId ? c.leaderWidth : c.otherWidth,
        height: row.charId === leaderId ? c.leaderHeight : c.otherHeight
      });
      for (const row of rows) {
        if (cancelled) throw new Error('cancel');
        await act(row, 'resize-check', { rect: rectFor(row) });
      }
      if (cancelled) throw new Error('cancel');
      await act(leader, 'client-layout', { rect: rectFor(leader) });
      for (const row of rows.filter(r => r.charId !== leaderId)) {
        if (cancelled) throw new Error('cancel');
        await act(row, 'focus');
        await act(row, 'key', { key: 'CTRL+F9' });
        await wait(150);
        await act(row, 'client-layout', { rect: rectFor(row) });
      }
    }
    if (cancelled) throw new Error('cancel');
    if (restore && command.returnTo !== 'last') await act(leader, 'focus');
    log(
      command.action === 'f6f1'
        ? 'Оба прохода F6 → F1 завершены.'
        : 'Размеры клиентских областей применены; Ctrl+F9 отправлен остальным.'
    );
  } else if (command.action === 'follow') {
    const point = commandPoint(c, command),
      menu = commandPoint(c, { ...command, pointId: command.menuPointId });
    if (![point, menu].every(p => reviewedPoints.has(JSON.stringify(p)))) throw new Error('preview required');
    for (const row of rows)
      for (const p of [point, menu]) {
        if (cancelled) throw new Error('cancel');
        await act(row, 'preview', { point: p });
      }
    for (const row of rows) {
      if (cancelled) throw new Error('cancel');
      await act(row, 'focus');
      await act(row, 'key', { key: 'SHIFT+1' });
      await wait(80);
      await act(row, 'right-click', { point });
      await wait(120);
      await act(row, 'click', { point: menu });
      log(`Следование: ввод отправлен для ${row.nick}; результат в игре не проверялся.`);
    }
  } else if (command.action === 'click') {
    const plan = await pointPlan(c, command, rows, true);
    for (const { row, point } of plan) {
      if (cancelled) throw new Error('cancel');
      await act(row, 'preview', { point });
    }
    for (const [index, { row, point }] of plan.entries()) {
      if (cancelled) throw new Error('cancel');
      if (command.delivery !== 'background') {
        await act(row, 'focus');
      }
      if (
        (command.button && command.button !== 'left') ||
        command.count === 2 ||
        command.modifiers?.length ||
        command.delivery === 'background'
      )
        await pointer(row, command, point, false);
      else await act(row, 'click', { point });
      log(`Клик отправлен: ${index + 1}/${rows.length}. Игровой результат не проверялся.`);
    }
  } else if (command.action === 'screen') {
    for (const row of rows) {
      await checkpoint();
      if (command.delivery !== 'background') await act(row, 'focus');
      await pointer(row, command, null, false);
    }
  } else if (command.action === 'resize') {
    for (const row of rows) {
      await checkpoint();
      await act(row, 'client-layout', { rect: { x: 0, y: 0, width: command.width, height: command.height } });
    }
  } else if (command.action === 'layout') {
    const profile = c.profiles.find(p => p.id === (command.profileId || c.profileId));
    if (!profile || rows.some(row => !profile.windows.some(w => w.charId === row.charId)))
      throw new Error('no complete profile');
    for (const row of rows) {
      if (cancelled) throw new Error('cancel');
      const geometry = profile.windows.find(w => w.charId === row.charId);
      if (!geometry) throw new Error('missing profile member');
      await act(row, 'layout', { rect: geometry });
    }
  } else {
    const sequence = command.action === 'sequence' ? steps(command.sequence) : [];
    for (const [index, row] of rows.entries()) {
      if (cancelled) throw new Error('cancel');
      await act(row, 'focus');
      if (cancelled) throw new Error('cancel');
      let previousKey = false;
      for (const step of sequence) {
        if (step.wait) {
          await wait(step.wait);
          previousKey = false;
        } else {
          if (previousKey) await wait(30);
          await act(row, 'key', { key: step.key });
          previousKey = true;
        }
      }
      log(`Обработано окон: ${index + 1}/${rows.length}. Ввод отправлен; результат в игре не проверялся.`);
    }
  }
  if (
    restore &&
    !fallbackAll &&
    command.returnTo !== 'last' &&
    ['sequence', 'follow', 'click', 'resize', 'layout'].includes(command.action) &&
    !cancelled
  ) {
    const scoped = scopedConfig(c, command),
      leaderId = scoped.leaders[scoped.partyId];
    if (leaderId) {
      try {
        const leader =
          rows.find(row => row.charId === leaderId) ||
          (await windowTargets({ target: 'leader', action: 'leader' }, scoped, snapshotRows))[0];
        if (cancelled) throw new Error('cancel');
        await act(leader, 'focus');
      } catch (error) {
        if (cancelled) throw error;
        log(`Возврат к ПЛ не выполнен: ${macroErrorText(error)}. Подмена окна не производится.`);
      }
    }
  }
  log('Команда завершена.');
}

export async function capturePoint(charId, name, uiScale) {
  if (busy) throw new Error('Дождитесь окончания команды.');
  if (!name.trim() || !uiScale.trim()) throw new Error('Укажите имя точки и масштаб UI игры.');
  if (config().points.length >= 30) throw new Error('Не более 30 точек; удалите ненужную.');
  busy = true;
  cancelled = false;
  void broadcast();
  try {
    const rows = await windowTargets({ target: 'subset', charIds: [charId] });
    log('Калибровка: за 5 секунд активируйте выбранное окно игры и наведите мышь на точку. Клика не будет.');
    await wait(5000);
    const geometry = await act(rows[0], 'capture');
    if (cancelled) throw new Error('cancel');
    const point = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 80),
      uiScale: uiScale.trim().slice(0, 40),
      ...geometry
    };
    state.settings.gameMacros = { ...config(), points: [...config().points, point] };
    log('Точка считана относительно клиентской области. Проверьте схему, масштаб UI и предпросмотр команды.');
    return point;
  } finally {
    busy = false;
    void broadcast();
  }
}
export async function previewCommand(id) {
  if (busy) throw new Error('Дождитесь окончания команды.');
  const c = config(),
    command = c.commands.find(row => row.id === id);
  if (!command || !['click', 'follow'].includes(command.action)) throw new Error('Выберите координатную команду.');
  const point = commandPoint(c, command, false);
  busy = true;
  cancelled = false;
  void broadcast();
  try {
    const rows = await windowTargets(command, c);
    const plan =
      command.action === 'click'
        ? await pointPlan(c, command, rows, false, false)
        : rows.flatMap(row =>
            [point, commandPoint(c, { ...command, pointId: command.menuPointId }, false)].map(point => ({ row, point }))
          );
    for (const { row, point } of plan) {
      await wait(50);
      await act(row, 'preview', { point });
    }
    for (const { point } of plan) reviewedPoints.add(JSON.stringify(point));
    log(
      `Проверены профили: ${[...new Set(plan.map(({ point }) => `${point.name} (${point.width}×${point.height}, DPI ${point.dpi}, UI ${point.uiScale})`))].join('; ')}. Без кликов.`
    );
    log(
      `Предпросмотр без клика: ${rows.map(r => r.nick).join(', ')}; точка ${point.name}; клиент ${point.width}×${point.height}, DPI ${point.dpi}, UI ${point.uiScale}. Визуально проверьте соответствие UI на схеме в настройках.`
    );
    return point;
  } finally {
    busy = false;
    void broadcast();
  }
}
export function openSettings() {
  document.querySelector('.tab[data-tab="tools"]')?.click();
  setTimeout(
    () => document.getElementById('game-macros-block')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    0
  );
}
export async function initGameMacros() {
  if (initialized || !window.__TAURI_INTERNALS__) return;
  initialized = true;
  await ensureMirror();
  await listen('game-macro-hotkey', event => {
    if (config().enabled && registered) void run(String(event.payload), true);
  });
  await listen('game-overlay-preferences', async event => {
    const p = event.payload;
    if (!p || !Number.isFinite(p.opacity) || p.opacity < 0.1 || p.opacity > 1 || typeof p.topmost !== 'boolean') return;
    const previous = config();
    state.settings.gameMacros = normalizeGameMacros({
      ...previous,
      opacity: p.opacity,
      topmost: p.topmost,
      appearance: p.appearance || previous.appearance
    });
    try {
      await (await import('../../core/storage.js')).persist();
    } catch {
      state.settings.gameMacros = previous;
      log('Не удалось сохранить настройки оверлея.');
    }
    await applyOverlayPreferences();
    await broadcast();
  });
  await listen('game-overlay-ready', () => {
    void broadcast();
  });
  await listen('game-overlay-party', event => {
    void overlayPartyAction(event.payload);
  });
  await listen('game-overlay-keyboard-toggle', event => {
    void setMirrorEnabled('keyboard', event.payload?.enabled).catch(() =>
      log('Не удалось изменить повтор клавиатуры из оверлея.')
    );
  });
  await listen('game-overlay-mouse-toggle', event => {
    void setMirrorEnabled('mouse', event.payload?.enabled).catch(() =>
      log('Не удалось изменить повтор мыши из оверлея.')
    );
  });
  await listen('game-overlay-run', event => {
    const id = event.payload;
    if (typeof id !== 'string' || !config().commands.some(command => command.id === id)) return;
    void run(id).catch(() => log('Не удалось запустить команду из оверлея.'));
  });
  await listen('game-overlay-action', event => {
    if (event.payload === 'stop') stop();
    else if (event.payload === 'clear-logs') void clearLogs();
  });
  await listen('game-macro-navigate', event => {
    openSettings();
    setTimeout(() => window.dispatchEvent(new CustomEvent('tf-game-macro-dialog', { detail: event.payload })), 60);
  });
  let positionTimer;
  await listen('game-overlay-position', event => {
    const p = event.payload;
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return;
    state.settings.gameMacros = { ...config(), overlayPosition: { x: p.x, y: p.y } };
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      import('../../core/storage.js').then(({ persist }) => persist()).catch(() => {});
    }, 250);
  });
  await configure();
}

export function scopedConfig(c, command) {
  return command.partyId ? { ...c, partyId: command.partyId } : c;
}
export function commandReady(c, command) {
  if (['click', 'follow'].includes(command.action)) {
    try {
      commandPoint(c, command);
      if (command.action === 'follow') commandPoint(c, { ...command, pointId: command.menuPointId });
    } catch {
      return false;
    }
  }
  return true;
}

async function pointPlan(c, command, rows, requireReview, authorize = true) {
  const primary = commandPoint(c, command, authorize);
  const candidates = [
    primary,
    ...(command.pointIds || [])
      .filter(id => id !== primary.id)
      .map(pointId => commandPoint(c, { ...command, pointId }, authorize))
  ];
  const plan = [];
  for (const row of rows) {
    await checkpoint();
    let point = primary;
    if (candidates.length > 1) {
      const metric = await act(row, 'client-info');
      const matches = candidates.filter(
        p => p.width === metric.width && p.height === metric.height && p.dpi === metric.dpi
      );
      if (matches.length !== 1) throw new Error('Ambiguous/missing calibration for client size and DPI');
      point = matches[0];
    }
    if (requireReview && !reviewedPoints.has(JSON.stringify(point))) throw new Error('preview required');
    plan.push({ row, point });
  }
  return plan;
}

export async function selectMacroParty(partyId) {
  if (!state.parties.some(p => p.id === partyId)) return;
  state.settings.gameMacros = { ...config(), partyId, buffPartyId: partyId };
  await (await import('../../core/storage.js')).persist();
  await configure();
  window.dispatchEvent(new Event('tf-game-macro-party-selected'));
}
let sizeUnlisten,
  sizeGeneration = 0;
export async function showSize(width, height, role = 'leader') {
  if (busy) throw new Error('Сначала остановите текущую команду.');
  if (!['leader', 'other'].includes(role)) throw new Error('Неизвестная группа размеров.');
  const generation = ++sizeGeneration;
  sizeUnlisten?.();
  const requestId = crypto.randomUUID();
  const off = await listen('game-macro-size-picked', async event => {
    const p = event.payload;
    if (p?.requestId !== requestId || generation !== sizeGeneration) return;
    off();
    if (generation === sizeGeneration) sizeUnlisten = null;
    if (p.cancelled) return;
    if (![p.width, p.height].every(n => Number.isInteger(n) && n >= 160 && n <= 8000)) return;
    const previous = config();
    state.settings.gameMacros = normalizeGameMacros({
      ...previous,
      [role + 'Width']: p.width,
      [role + 'Height']: p.height
    });
    try {
      await (await import('../../core/storage.js')).persist();
      window.dispatchEvent(new Event('tf-game-macro-size-selected'));
      log(`Размеры сохранены: ${p.width} × ${p.height}.`);
    } catch {
      state.settings.gameMacros = previous;
      log(`Не удалось сохранить ${p.width} × ${p.height}. Проверьте доступность сохранения.`);
    }
  });
  if (generation !== sizeGeneration) {
    off();
    return;
  }
  sizeUnlisten = off;
  try {
    await native('game_macro_guide', { mode: 'size', width, height, target: null, requestId });
  } catch (error) {
    off();
    if (generation === sizeGeneration) sizeUnlisten = null;
    throw error;
  }
}

export async function pickPoint(
  charId,
  name,
  replaceId = null,
  partyId = config().partyId,
  draftOnly = false,
  initialPoint = null
) {
  if (busy) throw new Error('Дождитесь окончания команды.');
  if (!name.trim()) throw new Error('Введите название точки.');
  if (replaceId && !config().points.some(p => p.id === replaceId))
    throw new Error('Точка уже удалена. Обновите список.');
  if (!replaceId && config().points.length >= 30) throw new Error('Удалите ненужную точку: максимум 30.');
  busy = true;
  cancelled = false;
  void broadcast();
  let unlisten, timer;
  try {
    const rows = await windowTargets({ target: 'subset', charIds: [charId], partyId });
    if (cancelled) throw new Error('Задание точки отменено.');
    const requestId = crypto.randomUUID();
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => {});
    unlisten = await listen('game-macro-picked', event => {
      if (event.payload?.requestId !== requestId) return;
      if (event.payload?.cancelled) rejectResult(new Error('Задание точки отменено.'));
      else resolveResult(event.payload.geometry);
    });
    timer = setTimeout(() => rejectResult(new Error('Время задания точки истекло.')), 300000);
    if (cancelled) throw new Error('Задание точки отменено.');
    await native('game_macro_guide', {
      mode: 'point',
      requestId,
      width: 280,
      height: 180,
      initialPoint,
      target: { pid: rows[0].pid, startedAt: rows[0].startedAt }
    });
    if (cancelled) throw new Error('Задание точки отменено.');
    const geometry = await result;
    if (cancelled) throw new Error('Задание точки отменено.');
    const point = {
      id: replaceId || crypto.randomUUID(),
      name: name.trim().slice(0, 80),
      uiScale: 'Ручная калибровка',
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      dpi: geometry.dpi
    };
    if (!validPoint(point)) throw new Error('Некорректная точка. Повторите калибровку.');
    if (!draftOnly)
      state.settings.gameMacros = {
        ...config(),
        points: replaceId ? config().points.map(p => (p.id === replaceId ? point : p)) : [...config().points, point]
      };
    log(`Точка «${point.name}»: ${draftOnly ? 'черновик, сохраните в редакторе' : 'сохранена'}. Без клика в игру.`);
    return point;
  } finally {
    clearTimeout(timer);
    unlisten?.();
    await native('game_macro_guide', { mode: 'close', width: 0, height: 0, target: null, requestId: null }).catch(
      () => {}
    );
    busy = false;
    void broadcast();
  }
}

export async function applyOverlayPreferences() {
  if (!window.__TAURI_INTERNALS__) return;
  await native('game_macro_overlay', {
    topmost: config().topmost,
    position: config().overlayPosition,
    existingOnly: true
  });
  await broadcast();
}

const mirrorArgs = (operation, sessionId = mirrorSession, extra = {}) => ({
  operation,
  sessionId,
  targets: [],
  shortcuts: [],
  mouse: false,
  source: null,
  ...extra
});
function ensureMirror() {
  return (mirrorInit ||= (async () => {
    await listen('game-macro-mirror-input', event => {
      const data = event.payload;
      if (data?.sessionId !== mirrorSession) return;
      for (const entry of (Array.isArray(data.events) ? data.events : []).slice(0, 64)) {
        const text = formatMirrorInput(entry);
        if (text) log(text, '', false);
      }
      if (data.omitted > 0)
        log(
          'Диагностические записи объединены/пропущены из-за частоты событий; ввод не задерживался ради журнала.',
          '',
          false
        );
      void broadcast();
    });
    await listen('game-macro-mirror-state', event => {
      if (event.payload?.sessionId !== mirrorSession || event.payload.active !== false) return;
      ++mirrorEpoch;
      mirrorSession = '';
      mirrorPending = false;
      mirroring = false;
      mirrorKeys = false;
      mirrorMouse = false;
      clearInterval(mirrorTimer);
      const reasons = {
        1: 'Очередь ввода не успевает: повтор остановлен.',
        2: 'Потеря связи с интерфейсом: повтор остановлен.',
        3: 'Игровое окно изменилось: повтор остановлен.',
        4: 'Windows отказала в доставке: повтор остановлен.',
        5: 'Клавиша удерживалась более 60 секунд без повтора: режим выключен защитой.',
        6: 'Точка мыши вне игровой области или недоступна: повтор остановлен.'
      };
      const failed = event.payload.failedInput;
      const label = inputLabel(failed?.vk);
      executionState = event.payload.reason ? 'failed' : 'stopped';
      notice =
        (reasons[event.payload.reason] || 'Повтор выключен.') +
        (label
          ? ` Событие: ${label}, ${failed.up ? 'отпускание' : 'нажатие'}, задержка ${Math.max(0, Math.min(60000, Number(failed.ageMs) || 0))} мс.`
          : '');
      log(notice, '', true, true);
    });
    await native('game_macro_mirror', mirrorArgs('stop', ''));
  })());
}
let mirrorConfigKey = '',
  mirrorConfigDirty = false;
function mirrorFingerprint() {
  const c = config();
  return JSON.stringify({
    source: c.mirrorSource,
    leader: c.mirrorSource === 'leader' ? c.leaders[c.partyId] : null,
    shortcuts: c.commands
      .map(row => row.hotkey)
      .filter(Boolean)
      .sort()
  });
}
export async function disableKeyboardMirror(preserveModes = false) {
  const sessionId = mirrorSession;
  mirrorSession = '';
  ++mirrorEpoch;
  mirroring = false;
  if (!preserveModes) {
    mirrorKeys = false;
    mirrorMouse = false;
  }
  if (!busy && !preserveModes) {
    executionState = 'stopped';
    notice = 'Повтор выключен.';
  }
  clearInterval(mirrorTimer);
  void broadcast();
  try {
    await native('game_macro_mirror', mirrorArgs('stop', sessionId));
  } catch {
    log('Не удалось подтвердить выключение повтора; защита связи отключит его автоматически.');
  }
}
// Overlay buttons request a state, never an ambiguous toggle from a stale snapshot.
export async function setMirrorEnabled(kind, enabled) {
  if (typeof enabled !== 'boolean' || !['mouse', 'keyboard'].includes(kind)) return;
  if (enabled === (kind === 'mouse' ? mirrorMouse : mirrorKeys)) return;
  await toggleKeyboardMirror(kind);
}
export async function toggleKeyboardMirror(kind = 'keyboard', commandName = '', refreshModes = null) {
  kind = kind === 'mouse' ? 'mouse' : 'keyboard';
  if (mirrorPending) return;
  const turningOff = kind === 'keyboard' ? mirrorKeys : mirrorMouse;
  const desiredKeys = refreshModes ? refreshModes.keys : kind === 'keyboard' ? !mirrorKeys : mirrorKeys,
    desiredMouse = refreshModes ? refreshModes.mouse : kind === 'mouse' ? !mirrorMouse : mirrorMouse;
  if ((busy || paused) && !refreshModes && !turningOff) {
    log('Сначала остановите команду и снимите паузу.');
    return;
  }
  if (!desiredKeys && !desiredMouse) {
    await disableKeyboardMirror();
    return;
  }
  if (mirroring) {
    const transitionEpoch = mirrorEpoch;
    await disableKeyboardMirror(true);
    if (mirrorEpoch !== transitionEpoch + 1) return; // Explicit stop wins over an in-flight refresh.
  }
  if (mirrorKeys || mirrorMouse) {
    mirrorKeys = desiredKeys;
    mirrorMouse = desiredMouse;
  }
  mirrorPending = true;
  notice = '';
  const epoch = ++mirrorEpoch;
  void broadcast();
  try {
    await ensureMirror();
    const rows = (await listMacroWindows()).filter(
      r =>
        r.known &&
        r.charId &&
        r.startedAt &&
        r.hwnd &&
        (r.elevated === false || (r.elevated === true && r.selfElevated === true))
    );
    if (rows.length < 2 || rows.length > 30 || new Set(rows.map(r => r.charId)).size !== rows.length)
      throw new Error('Для повтора нужны 2–30 однозначно распознанных игровых окон. Неизвестные клиенты исключены.');
    if (epoch !== mirrorEpoch) return;
    const c = config();
    const sourceRow = c.mirrorSource === 'leader' ? rows.find(row => row.charId === c.leaders[c.partyId]) : null;
    if (c.mirrorSource === 'leader' && !sourceRow)
      throw new Error('Для повтора только из ПЛ выберите пати, назначьте ПЛ и запустите его распознанное окно.');
    const settingsKey = mirrorFingerprint();
    const id = crypto.randomUUID();
    mirrorSession = id;
    const active = await native(
      'game_macro_mirror',
      mirrorArgs('start', id, {
        mouse: desiredMouse,
        keyboard: desiredKeys,
        source: sourceRow ? { pid: sourceRow.pid, startedAt: sourceRow.startedAt, hwnd: sourceRow.hwnd } : null,
        targets: rows.map(r => ({ pid: r.pid, startedAt: r.startedAt })),
        shortcuts: [
          'CTRL+ALT+PAUSE',
          ...config()
            .commands.map(c => c.hotkey)
            .filter(k => k && !k.includes('WHEEL'))
        ]
      })
    );
    if (epoch !== mirrorEpoch) {
      await native('game_macro_mirror', mirrorArgs('stop', id));
      return;
    }
    if (!active) throw new Error('Повтор клавиатуры не включён.');
    mirrorConfigKey = settingsKey;
    executionState = 'running';
    mirroring = true;
    mirrorKeys = desiredKeys;
    mirrorMouse = desiredMouse;
    mirrorTimer = setInterval(async () => {
      if (epoch !== mirrorEpoch) return;
      try {
        if (!(await native('game_macro_mirror', mirrorArgs('heartbeat', id)))) {
          if (epoch === mirrorEpoch) {
            mirroring = false;
            mirrorKeys = false;
            mirrorMouse = false;
            clearInterval(mirrorTimer);
            executionState = 'failed';
            notice = 'Повтор отключён нативной защитой.';
            log(notice);
          }
        }
      } catch {
        if (epoch === mirrorEpoch) await disableKeyboardMirror();
      }
    }, 1000);
    log(
      `Повтор ВКЛЮЧЁН (клавиатура: ${mirrorKeys ? 'да' : 'нет'}, мышь: ${mirrorMouse ? 'да' : 'нет'}): ${rows.length} проверенных окон, источник: ${sourceRow ? 'ПЛ выбранной пати' : 'любая распознанная игра'}. ${mirrorMouse ? 'Кнопки мыши: абсолютные экранные точки.' : 'Мышь не передаётся.'} Ctrl+Alt+Pause — выключить. Обработка сообщений игрой не подтверждена.`,
      commandName
    );
  } catch (error) {
    const message = `Повтор не включён: ${macroErrorText(error)}`;
    executionState = 'failed';
    notice = message;
    log(message, commandName);
    const { toast } = await import('../../core/ui.js');
    toast(message, 'error');
  } finally {
    mirrorPending = false;
    void broadcast();
    if (mirrorConfigDirty) {
      mirrorConfigDirty = false;
      void configure();
    }
  }
}

async function checkpoint(aborted = () => false) {
  while (paused) {
    if (cancelled || aborted()) throw new Error('cancel');
    await new Promise(r => setTimeout(r, 50));
  }
  if (cancelled || aborted()) throw new Error('cancel');
}
async function pointer(row, command, point, checkOnly) {
  if (busy && cancelled) throw new Error('cancel');
  if (command.delivery === 'background' && command.modifiers?.includes('ALT'))
    throw new Error('Alt+клик: выберите обычный режим этого блока. Фоновый режим поддерживает только Ctrl/Shift.');
  const result = await native('game_macro_pointer', {
    target: { pid: row.pid, startedAt: row.startedAt, ...(row.hwnd ? { hwnd: row.hwnd } : {}) },
    timing: inputTiming,
    point: point || null,
    input: {
      x: command.x || 0,
      y: command.y || 0,
      button: command.button || 'left',
      count: command.count || 1,
      background: command.delivery === 'background',
      checkOnly,
      modifiers: command.modifiers || []
    }
  });
  if (!checkOnly)
    log(
      `Отправлена кнопка мыши ${command.button || 'left'} → ${row.nick || row.pid} · ${point ? `точка (${point.x}, ${point.y})` : `экран (${command.x}, ${command.y})`}. Обработка игрой не подтверждена.`
    );
  return result;
}
export async function recorderCursor() {
  return native('game_macro_cursor');
}
const screenReview = cmd => JSON.stringify({ screen: true, x: cmd.x, y: cmd.y });
async function preflightComposition(plan, c, preview) {
  const actions = compositionActions(plan),
    launched = new Set(),
    changed = new Set(),
    reviewed = [];
  for (const cmd of actions) validateActivityCommand(cmd, true);
  for (const cmd of actions) {
    await checkpoint();
    const scoped = scopedConfig(c, cmd),
      party = scoped.partyId;
    if (
      cmd.delivery === 'background' &&
      !backgroundCompatible(cmd) &&
      !['launch', 'click', 'screen', 'layout', 'resize'].includes(cmd.action)
    )
      throw new Error('Действие переключает окна: выберите обычный режим его блока.');
    if (cmd.action === 'launch') {
      if (!state.parties.some(p => p.id === party)) throw new Error('Пати для запуска удалена.');
      launched.add(party);
      changed.add(party);
      continue;
    }
    let points = [];
    if (['click', 'follow'].includes(cmd.action)) {
      points = [
        commandPoint(scoped, cmd, false),
        ...(cmd.pointIds || []).map(pointId => commandPoint(scoped, { ...cmd, pointId }, false))
      ];
      if (cmd.action === 'follow') points.push(commandPoint(scoped, { ...cmd, pointId: cmd.menuPointId }, false));
      if (!cmd.resourceAllowed) throw new Error('Разрешите координатные действия.');
      if (!preview && points.some(p => !reviewedPoints.has(JSON.stringify(p)))) throw new Error('preview required');
      reviewed.push(...points.map(p => JSON.stringify(p)));
    }
    if (cmd.action === 'screen') {
      if (!cmd.resourceAllowed) throw new Error('Разрешите действия мышью.');
      if (cmd.delivery === 'background' && cmd.modifiers?.includes('ALT'))
        throw new Error('Alt+клик: выберите обычный режим блока.');
      if (!preview && !reviewedPoints.has(screenReview(cmd))) throw new Error('preview required');
      reviewed.push(screenReview(cmd));
    }
    let rows;
    try {
      rows = await windowTargets(cmd, scoped);
    } catch (error) {
      if (!launched.has(party)) throw error;
      log('Окна после запуска будут проверены непосредственно перед действием.');
      continue;
    }
    if (
      cmd.action === 'layout' &&
      !scoped.profiles.some(
        p => p.id === (cmd.profileId || scoped.profileId) && rows.every(r => p.windows.some(w => w.charId === r.charId))
      )
    )
      throw new Error('В профиле нет всех получателей.');
    if (cmd.action === 'resize')
      for (const row of rows)
        await act(row, 'resize-check', { rect: { x: 0, y: 0, width: cmd.width, height: cmd.height } });
    if (['resize', 'layout', 'optimize'].includes(cmd.action)) changed.add(party);
    if (changed.has(party) && ['screen', 'click', 'follow'].includes(cmd.action)) {
      log('Геометрия точки после изменения окон проверяется перед фактическим кликом; предпросмотр не меняет окна.');
      continue;
    }
    if (cmd.action === 'screen') for (const row of rows) await pointer(row, cmd, null, true);
    for (const row of rows) for (const point of points) await act(row, 'preview', { point });
  }
  if (preview) for (const id of reviewed) reviewedPoints.add(id);
}
export async function previewComposition(id) {
  if (busy) throw new Error('Сначала остановите команду.');
  busy = true;
  cancelled = false;
  try {
    const c = config(),
      cmd = c.commands.find(a => a.id === id);
    if (!cmd || cmd.action !== 'composite') throw new Error('Выберите составную команду.');
    await preflightComposition(compileComposition(cmd, c), c, true);
    log('План и доступные получатели проверены без ввода; отложенные проверки геометрии указаны выше.');
  } finally {
    busy = false;
    void broadcast();
  }
}

// Native bridge accepts requests only from main/overlay. Resolve IDs against current user data.
export async function overlayPartyAction(request) {
  if (!['party-refresh', 'party-launch', 'party-close-all'].includes(request?.action)) return;
  if (busy) {
    overlayWindowNotice = 'Сначала завершите текущую команду.';
    await broadcast();
    return;
  }
  busy = true;
  cancelled = false;
  launchProgress = null;
  overlayWindowNotice = 'Проверка окон…';
  void broadcast();
  try {
    if (request.action === 'party-close-all') {
      const { closeAllClients } = await import('../launcher/launch.js');
      const { closeSelectedText } = await import('../launcher/windowList.js');
      const report = await closeAllClients();
      overlayWindowNotice = closeSelectedText(report);
      const rows = await listMacroWindows();
      overlayWindows = rows.map(row => ({
        name: row.nick || 'Нераспознанное окно',
        pid: row.pid,
        known: !!row.known,
        ownershipSource: row.ownershipSource
      }));
      return;
    }
    if (request.action === 'party-launch') {
      const party = (state.parties || []).find(p => p.id === request.partyId);
      if (!party) throw new Error('Выберите существующую пати.');
      overlayWindowNotice = `Запуск пати: ${party.name}…`;
      void broadcast();
      const { launchPartyByName } = await import('../launcher/partyLaunch.js');
      if (cancelled) throw new Error('Остановлено пользователем.');
      const result = await launchPartyByName(party.name, {
        cancelled: () => cancelled,
        onProgress: progress => {
          launchProgress = progress;
          void broadcast();
        }
      });
      if (!result || result.some(r => r.ok === false || r.cancelled))
        throw new Error('Запуск пати не завершён. Проверьте журнал скриптов.');
    }
    const rows = await listMacroWindows();
    overlayWindows = rows.map(row => ({
      name: row.nick || 'Нераспознанное окно',
      pid: row.pid,
      known: !!row.known,
      ownershipSource: row.ownershipSource
    }));
    overlayWindowNotice = cancelled
      ? 'Остановлено пользователем.'
      : `Найдено окон: ${rows.length}. Обновите список после входа персонажей.`;
  } catch (error) {
    overlayWindowNotice = macroErrorText(error);
  } finally {
    busy = false;
    await broadcast();
  }
}

export async function diagnoseBackground(charId, key = 'B', activityTest = false) {
  if (busy || mirroring || mirrorPending) throw new Error('Завершите команду и выключите повтор перед диагностикой.');
  busy = true;
  cancelled = false;
  notice = activityTest
    ? 'Через 5 секунд — тест активности и один B. Перейдите в другой клиент; проверяемое окно оставьте неактивным.'
    : 'Диагностика фона без клавиш…';
  void broadcast();
  try {
    if (activityTest) {
      for (let tick = 0; tick < 100; tick++) {
        if (cancelled || paused) throw new Error('cancel');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (cancelled || paused) throw new Error('cancel');
    }
    const rows = await listMacroWindows();
    const row = rows.find(row => row.known && row.charId === charId && row.hwnd && row.startedAt);
    if (!row) throw new Error('Не найдено однозначно распознанное окно выбранного персонажа.');
    if (cancelled) throw new Error('Остановлено пользователем.');
    const report = await native('game_macro_background_probe', {
      target: { pid: row.pid, startedAt: row.startedAt, hwnd: row.hwnd },
      key: activityTest ? 'B' : key,
      ...(activityTest ? { activityTest: true } : {})
    });
    const lines = [
      `${activityTest ? 'Эксперимент активности + B' : 'Диагностика фона без клавиш'} → ${row.nick || row.pid}:`,
      ...backgroundReport(report)
    ];
    for (const line of lines) log(line, '', false);
    notice = cancelled
      ? 'Проверка остановлена.'
      : activityTest
        ? 'Эксперимент завершён. Смотрите отчёт; реакция игры не подтверждена.'
        : 'Диагностика фона завершена. Клавиши не отправлялись.';
    return lines.join('\n');
  } catch (error) {
    notice = macroErrorText(error);
    log(notice, '', false);
    throw new Error(notice, { cause: error });
  } finally {
    busy = false;
    void broadcast();
  }
}
