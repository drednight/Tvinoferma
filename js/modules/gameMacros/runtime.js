import { compileComposition, executeComposition, compositionActions } from './composition.js';
import { listen, emitTo } from '@tauri-apps/api/event';
import { state } from '../../core/state.js';
import {
  normalizeGameMacros,
  resolveTargets,
  steps,
  commandPoint,
  validPoint,
  backgroundCompatible,
  orderManagedTargets
} from './model.js';
let invoke;
let rootTiming = { switchMs: 30, holdMs: 30 },
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
const logs = [];
const logEntries = [];
let activeCommandName = '',
  notice = '';
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
    mirroring,
    mirrorKeys,
    mirrorMouse,
    mirrorPending,
    paused,
    registered,
    opacity: c.opacity,
    appearance: c.appearance,
    topmost: c.topmost,
    commands: c.commands.map(({ id, name, hotkey }) => ({ id, name, hotkey })),
    notice,
    logEntries: logEntries.slice(-80),
    logs: logs.slice(-80)
  };
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
function log(text, commandName = activeCommandName) {
  logs.push(`${new Date().toLocaleTimeString('ru-RU')} · ${text}`);
  logEntries.push({ text: logs.at(-1), commandName });
  if (logs.length > 120) {
    logs.shift();
    logEntries.shift();
  }
  void broadcast();
}
export function stop() {
  if (mirroring || mirrorPending) void disableKeyboardMirror();
  cancelled = true;
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
  if (mirroring || mirrorPending) await disableKeyboardMirror();
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
  const { recalledOwnership } = await import('../launcher/launchedWindows.js');
  const clients = await native('launcher_running_details');
  const selfElevated = clients.some(c => c.elevated === true) && (await native('launcher_self_elevated')) === true;
  const rows = windowRows(clients, state.characters, {
    recalled: recalledOwnership(clients.map(c => ({ pid: c.pid, uptimeMs: Date.now() - c.startedAt })))
  }).map(r => ({ ...r, ...clients.find(c => c.pid === r.pid), selfElevated }));
  for (const row of rows) {
    if (state.characters.filter(c => String(c.nick).toLowerCase() === String(row.nick).toLowerCase()).length > 1)
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
const act = (row, action, extra = {}) =>
  native('game_macro_action', {
    target: { pid: row.pid, startedAt: row.startedAt, ...(row.hwnd ? { hwnd: row.hwnd } : {}) },
    timing: inputTiming,
    action,
    key: null,
    rect: null,
    point: null,
    ...extra
  });
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
    'Cannot queue background key':
      'Windows отказала в постановке фоновой клавиши. Автоповтора и переключения окон нет.',
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
    if (!composing) stop();
    else if (mirroring || mirrorPending) void disableKeyboardMirror();
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
  if (['mirror', 'mouse-mirror'].includes(command.action)) {
    await toggleKeyboardMirror(command.action === 'mouse-mirror' ? 'mouse' : 'keyboard', command.name);
    return;
  }
  busy = true;
  notice = '';
  activeCommandName = command.name;
  const started = performance.now();
  let suspended = false;
  cancelled = false;
  void broadcast();
  try {
    if (mirroring || mirrorPending) await disableKeyboardMirror();
    for (
      let attempt = 0;
      (await native('game_macro_input_idle', { chord: hotkey ? command.hotkey : null })) === false;
      attempt++
    ) {
      if (attempt >= 75)
        throw new Error('Отпустите клавиши запуска и модификаторы, затем повторите команду. Ввод не отправлен.');
      await wait(20);
    }
    await checkpoint();
    suspended = true;
    await native('game_macro_bindings', { bindings: [{ id: 'stop', chord: 'CTRL+ALT+PAUSE' }] });
    registered = false;
    rootTiming = { switchMs: command.switchMs ?? 30, holdMs: command.holdMs ?? 30 };
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
    } else await executeLegacy(command, c, hotkey);
    if (command.delivery === 'background') {
      notice = 'Фоновая доставка завершена. Игра может игнорировать сообщения; результат не подтверждён.';
      log(notice);
    }
  } catch (error) {
    notice = cancelled ? 'Остановлено пользователем.' : `Остановлено: ${macroErrorText(error)}`;
    log(notice);
  } finally {
    log(
      `Время выполнения: ${Math.round(performance.now() - started)} мс. Это время доставки/проверок, не подтверждение действия в игре.`
    );
    activeCommandName = '';
    if (composing) paused = false;
    composing = false;
    if (suspended) {
      try {
        await configure();
      } catch (error) {
        log(`Сочетания не восстановлены: ${macroErrorText(error)}`);
      }
    }
    busy = false;
    void broadcast();
  }
}

async function executeLegacy(command, c, hotkey = false, restore = true) {
  await checkpoint();
  c = scopedConfig(c, command);
  inputTiming = {
    switchMs: command.switchMs ?? rootTiming.switchMs ?? 30,
    holdMs: command.holdMs ?? rootTiming.holdMs ?? 30
  };
  if (command.action === 'launch') {
    const party = state.parties.find(p => p.id === (command.partyId || c.partyId));
    if (!party) throw new Error('no party');
    const { launchPartyByName } = await import('../launcher/partyLaunch.js');
    const result = await launchPartyByName(party.name, { cancelled: () => cancelled });
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
  const snapshotRows = await listMacroWindows();
  const rows = await windowTargets(command, c, snapshotRows);
  if (hotkey) {
    let foreground = false;
    const memberIds = new Set((await import('./model.js')).partyMembers(state, c.partyId).map(ch => ch.id));
    const sources =
      command.scope === 'managed' ? rows : snapshotRows.filter(row => row.known && memberIds.has(row.charId));
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
      log('Горячая команда пропущена: активное окно не относится к выбранной пати.');
      return;
    }
  }
  log(`Начало: ${command.name}. Получателей: ${rows.length}.`);
  log(
    `Порядок «${state.parties.find(p => p.id === c.partyId)?.name || 'Все окна'}»: ${rows.map(row => state.characters.find(ch => ch.id === row.charId)?.nick || row.pid).join(' → ')}`
  );
  if (command.delivery === 'background' && ['sequence', 'f6f1'].includes(command.action)) {
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
      'Оконные сообщения поставлены в очередь без активации окон. Обработка игрой НЕ подтверждена; автоматического повтора/переключения нет.'
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
        await wait(100);
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
  await listen('game-overlay-action', event => {
    if (event.payload === 'stop') stop();
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
    await wait(50);
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
  ...extra
});
function ensureMirror() {
  return (mirrorInit ||= (async () => {
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
        5: 'Клавиша удерживалась более 60 секунд без повтора: режим выключен защитой.'
      };
      notice = reasons[event.payload.reason] || 'Повтор выключен.';
      log(notice);
    });
    await native('game_macro_mirror', mirrorArgs('stop', ''));
  })());
}
export async function disableKeyboardMirror() {
  const sessionId = mirrorSession;
  mirrorSession = '';
  ++mirrorEpoch;
  mirroring = false;
  mirrorKeys = false;
  mirrorMouse = false;
  clearInterval(mirrorTimer);
  void broadcast();
  try {
    await native('game_macro_mirror', mirrorArgs('stop', sessionId));
  } catch {
    log('Не удалось подтвердить выключение повтора; защита связи отключит его автоматически.');
  }
}
export async function toggleKeyboardMirror(kind = 'keyboard', commandName = '') {
  kind = kind === 'mouse' ? 'mouse' : 'keyboard';
  if (mirrorPending) return;
  const desiredKeys = kind === 'keyboard' ? !mirrorKeys : mirrorKeys,
    desiredMouse = kind === 'mouse' ? !mirrorMouse : mirrorMouse;
  if (mirroring) await disableKeyboardMirror();
  if (!desiredKeys && !desiredMouse) return;
  if (busy || paused) {
    log('Сначала остановите команду и снимите паузу.');
    return;
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
    const id = crypto.randomUUID();
    mirrorSession = id;
    const active = await native(
      'game_macro_mirror',
      mirrorArgs('start', id, {
        mouse: desiredMouse,
        keyboard: desiredKeys,
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
            notice = 'Повтор отключён нативной защитой.';
            log(notice);
          }
        }
      } catch {
        if (epoch === mirrorEpoch) await disableKeyboardMirror();
      }
    }, 1000);
    log(
      `Повтор ВКЛЮЧЁН (клавиатура: ${mirrorKeys ? 'да' : 'нет'}, мышь: ${mirrorMouse ? 'да' : 'нет'}): ${rows.length} проверенных окон, только при фокусе игры. ${mirrorMouse ? 'Кнопки мыши: абсолютные экранные точки.' : 'Мышь не передаётся.'} Ctrl+Alt+Pause — выключить. Обработка сообщений игрой не подтверждена.`,
      commandName
    );
  } catch (error) {
    const message = `Повтор не включён: ${macroErrorText(error)}`;
    notice = message;
    log(message, commandName);
    const { toast } = await import('../../core/ui.js');
    toast(message, 'error');
  } finally {
    mirrorPending = false;
    void broadcast();
  }
}

async function checkpoint(aborted = () => false) {
  while (paused) {
    if (cancelled || aborted()) throw new Error('cancel');
    await new Promise(r => setTimeout(r, 50));
  }
  if (cancelled || aborted()) throw new Error('cancel');
}
function pointer(row, command, point, checkOnly) {
  if (command.delivery === 'background' && command.modifiers?.includes('ALT'))
    throw new Error('Alt+клик: выберите обычный режим этого блока. Фоновый режим поддерживает только Ctrl/Shift.');
  return native('game_macro_pointer', {
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
