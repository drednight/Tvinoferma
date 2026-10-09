// js/modules/launcher/partyLaunch.js
// Запуск игры из интерфейса: пати целиком (вкладка «Пати») и один персонаж (раскрытая карточка).
// Ход запуска виден в доке задач и в «Настройки → Журналы → Скрипты»; кнопка «Отмена» останавливает очередь.
// Одновременно идёт один запуск: GameCenter и окна клиентов общие для всех аккаунтов.

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { toast, confirmModal } from '../../core/ui.js';
import { startTask } from '../../core/taskLog.js';
import { launchCharacters, launchSummary, closeReportText, canCloseElevated, closeAllClientsElevated, checkGameCenterPath, captureAccount, forgetAccount, closeAllClients, runningClients, hasGameCenterPath, launchContext, launchWarnings, withoutSavedLogin, verifyLaunchedDecor, launchDelayMs, decorateEnabled, readLaunchFacts, pickGameCenter, windowDecor, decorateElevated } from './launch.js';
import { resolveGameCenter, accountKey, setGcAccount, pickMajorityGc, newGcId, suggestGcName } from './gameCenters.js';
import { launchPreflight, shouldShowPreflight, preflightLog, availableFixes, chooseGcToAttach, attachGcTo } from './preflight.js';
import { openPreflight } from './preflightDialog.js';
import { recordLaunchRun } from './launchLog.js';

let active = null; // { signal } идущего запуска

export const isLaunching = () => !!active;

/** Показывать ли итог запуска (настройка «Настройки → Запуск игры»). Ошибки показываются всегда. */
const notifyEnabled = () => state.settings?.launcher?.notify !== false;

/**
 * Один итог на весь запуск: в окне приложения — всплывающая подпись, если приложение свёрнуто (например, запуск из трея) —
 * системное уведомление. Никаких сообщений по каждому окну.
 */
async function reportDone(text, isError) {
  if (!isError && !notifyEnabled()) return;
  const focused = typeof document !== 'undefined' && document.hasFocus();
  if (focused) { toast(text, isError ? 'error' : 'success'); return; }
  try {
    const { notify } = await import('../../desktop/notifications.js');
    if (await notify('Твиноферма', text)) return;   // false — нет разрешения на уведомления: покажем подпись ниже
  } catch { /* системные уведомления недоступны */ }
  toast(text, isError ? 'error' : 'success');
}

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/** Проверки перед запуском по текущему состоянию системы (какие окна уже открыты, есть ли права администратора). */
async function runPreflight(characters) {
  const facts = await readLaunchFacts();
  const l = state.settings?.launcher || {};
  return launchPreflight({
    characters, ctx: launchContext(), clients: facts.clients, selfElevated: facts.selfElevated,
    skipRunning: l.skipRunning !== false, decorate: decorateEnabled()
  });
}

/**
 * «Исправить»: прикрепляет GameCenter персонажам, у которых его нет. Берётся тот, которым пользуется большинство группы
 * (иначе «запускать в первую очередь», иначе первый в списке); если список пуст — просит указать GameCenter.exe и добавляет его в список.
 * @returns {Promise<boolean>} получилось ли (false — отказались или путь не подошёл)
 */
/**
 * Подписывает окна игры, запущенной от администратора, — короткоживущим помощником.
 *
 * Раньше единственный выход был перезапустить Твиноферму от администратора. Теперь Windows
 * спрашивает разрешение один раз, помощник делает работу и выходит, а Твиноферма продолжает
 * работать с обычными правами. Отказ пользователя — не ошибка: окна останутся без подписи.
 *
 * @param {import('./preflight.js').Preflight} pre
 * @returns {Promise<boolean>} удалось ли (при отказе — false, но это не поломка)
 */
async function fixElevatedWindows(pre) {
  const targets = [];
  for (const row of pre.elevatedRows || []) {
    const decor = await windowDecor(row.char);
    if (!decor?.windowTitle) continue;
    targets.push({ pid: row.pid, title: decor.windowTitle, iconSmall: decor.iconSmall, iconBig: decor.iconBig });
  }
  if (!targets.length) {
    toast('Не нашёл, что подписать: у окон игры нет названия в виде «Ник — Класс»', 'warning');
    return false;
  }
  const res = await decorateElevated(targets);
  if (res.denied) {
    toast('Без прав администратора окна останутся без названия и значка. Запустите Твиноферму от администратора, если это нужно.', 'warning');
    return false;
  }
  const done = res.ok + res.fixed;
  toast(done
    ? `Окна подписаны с правами администратора: ${done}`
    : 'Не удалось подписать окна даже с правами администратора', done ? 'success' : 'error');
  return done > 0;
}

async function fixMissingGameCenter(noGc, group) {
  const ctx = launchContext();
  let gc = chooseGcToAttach(group, ctx);
  if (!gc) {
    const path = await pickGameCenter();
    if (!path) return false;
    try { await checkGameCenterPath(path); }
    catch (e) { toast(errText(e), 'error'); return false; }
    gc = { id: newGcId(ctx.gameCenters), name: suggestGcName(path, ctx.gameCenters), path };
    state.settings.launcher.gameCenters = [...ctx.gameCenters, gc];
  }
  attachGcTo(noGc, gc.id);
  await persist();
  toast(`GameCenter «${gc.name}» прикреплён: ${noGc.length} перс.`, 'success');
  return true;
}

/**
 * Запускает игру для списка персонажей по очереди.
 *
 * Перед стартом идут проверки (preflight.js): персонаж, чьё окно уже открыто, пропускается — очередь сразу переходит к следующему;
 * у кого нет GameCenter — пропускается; при серьёзных проблемах (или всегда — по настройке) показывается экран проверок
 * с кнопкой «Исправить и запустить». Итог запуска пишется в историю (launchLog.js, «Настройки → Журналы → Запуски»).
 *
 * @param {string} title заголовок задачи в журнале
 * @param {any[]} characters
 * @param {{ gcId?: string, interactive?: boolean }} [opts] gcId — GameCenter, из которого запускать в этот раз (у кого его нет — из доступного).
 *   Не указан — берётся GameCenter, которым пользуется больше всего участников (pickMajorityGc).
 *   interactive: false — без экрана проверок (запуск из трея: окно приложения может быть скрыто).
 */
export async function launchGroup(title, characters, opts = {}) {
  if (active) {
    toast('Запуск уже идёт: дождитесь окончания или отмените его (док задач внизу)', 'error');
    return null;
  }
  if (!isTauri()) {
    toast('Запуск игры работает только в приложении (в браузере недоступен)', 'error');
    return null;
  }
  const signal = { cancelled: false };
  active = { signal };   // место занято и пока открыт экран проверок
  let task = null;
  try {
    let pre = await runPreflight(characters);
    const mode = state.settings?.launcher?.preflight;
    if (opts.interactive !== false && shouldShowPreflight(pre, mode)) {
      const choice = await openPreflight(pre, { title, gameCenters: launchContext().gameCenters });
      if (!choice) return null;
      if (choice === 'fix') {
        const fixes = availableFixes(pre, launchContext());
        if (fixes.some(f => f.id === 'attachGc') && !await fixMissingGameCenter(pre.noGc, characters)) return null;
        // Окна игры от администратора: подписываем их короткоживущим помощником от администратора.
        // Твиноферма при этом не перезапускается — права нужны только на это действие.
        if (fixes.some(f => f.id === 'elevate')) await fixElevatedWindows(pre);
      }
      pre = await runPreflight(characters);   // пока открыт экран, окна могли запуститься или закрыться
    }
    const ready = pre.toLaunch;
    const skipped = pre.noGc;
    if (!ready.length) {
      if (pre.alreadyRunning.length && !skipped.length) toast(launchSummary({ ok: 0, running: pre.alreadyRunning.length, ms: 0 }), 'info');
      else toast('Не указан GameCenter: «Настройки → Запуск игры» или карточка персонажа → «🎮 Запуск игры»', 'error');
      return null;
    }

    const startedAt = Date.now();
    task = startTask(title, { total: ready.length, cancelable: true });
    task.onCancel(() => { signal.cancelled = true; });
    preflightLog(pre).forEach(l => task.log(l.text, l.level));

    // Один GameCenter на всю пати — тот, которым пользуется большинство; остальные запускаются из того, что у них есть
    let gcId = opts.gcId;
    let gcName = '';
    if (!gcId && ready.length > 1) {
      const major = pickMajorityGc(ready, launchContext());
      if (major) {
        gcId = major.gc.id;
        gcName = major.gc.name;
        if (major.distinct > 1) task.log(`GameCenter «${major.gc.name}» — у ${major.count} из ${major.total}: запускаем из него, у остальных — из доступного`);
      }
    }

    const results = await launchCharacters(ready, {
      signal,
      gcId,
      onStart: (c) => task.setStep(`${c.nick}: запуск…`),
      onDone: (e, done, total) => {
        task.log(`${e.nick}: ${e.ok ? 'клиент игры запущен' : `ошибка — ${e.error}`}`, e.ok ? 'ok' : 'error');
        launchWarnings(e.info).forEach(w => task.log(`${e.nick}: ${w}`, 'warn'));
        task.progress(done, total);
      }
    });
    const noLogin = withoutSavedLogin(results);
    if (noLogin > 0 && results.length > 1) {
      task.log(`Без запомненного входа запущено: ${noLogin}. Такие окна открываются под аккаунтом, который сейчас выбран в GameCenter. Запомните вход: карточка персонажа → «🎮 Запуск игры» → «🔑 Запомнить текущий вход GameCenter»`, 'warn');
    }
    // Проверяем, что окна действительно получили название «Ник — Класс» и значок: окно клиента
    // появляется не сразу, и игра может переписать заголовок. Где не вышло — пробуем ещё раз.
    try {
      const decorNote = await verifyLaunchedDecor(results);
      if (decorNote) task.log(decorNote, 'warn');
    } catch (e) {
      console.warn('[LAUNCH] decorate verify failed:', e);
    }
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.cancelled).length;
    const cancelled = results.filter(r => r.cancelled).length;
    const ms = Date.now() - startedAt;
    const summary = launchSummary({ ok, failed, cancelled, skipped: skipped.length, running: pre.alreadyRunning.length, ms });
    task.finish(summary, failed ? 'warn' : undefined);
    reportDone(summary, failed > 0);
    saveRunToHistory({ title, results, pre, ms, gcName });
    return results;
  } catch (e) {
    task?.log(errText(e), 'error');
    task?.finish('Запуск прерван из-за ошибки', 'error');
    toast(`Запуск не удался: ${errText(e)}`, 'error');
    return null;
  } finally {
    active = null;
  }
}

/** Итог запуска → история запусков («Настройки → Журналы → Запуски»). Сбой записи запуску не мешает. */
function saveRunToHistory({ title, results, pre, ms, gcName }) {
  try {
    const items = [
      ...results.map(r => ({
        id: r.id, nick: r.nick,
        status: r.cancelled ? 'cancelled' : r.ok ? 'ok' : 'failed',
        ms: r.cancelled ? null : r.ms, error: r.error || null,
        noLogin: r.ok && r.info?.switched === false
      })),
      ...pre.alreadyRunning.map(r => ({ id: String(r.char.id), nick: r.char.nick, status: 'running' })),
      ...pre.noGc.map(c => ({ id: String(c.id), nick: c.nick, status: 'nogc' }))
    ];
    recordLaunchRun({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date(Date.now() - ms).toISOString(), title, ms, delayMs: launchDelayMs(), gc: gcName,
      requested: pre.total, items
    });
  } catch (e) {
    console.warn('[LAUNCH] history write failed:', e);
  }
}

/** Запуск одного персонажа (кнопка «▶» на карточке). Без пути к GameCenter открывает его карточку на блоке «Запуск игры». */
export async function launchOne(char, opts = {}) {
  if (!char) return null;
  if (!hasGameCenterPath(char)) {
    toast('Укажите GameCenter этого аккаунта', 'error');
    const { openCharacterProfile } = await import('../characters/profileView.js');
    openCharacterProfile(char);
    setTimeout(() => {
      const fold = document.querySelector('.pf-launch');
      if (fold) fold.open = true;
      document.getElementById('pf-gc-path')?.focus();
    }, 0);
    return null;
  }
  return launchGroup(`Запуск игры: ${char.nick}`, [char], opts);
}

/** Запуск пати по названию (меню трея и вкладка «Пати»). */
export async function launchPartyByName(name, opts = {}) {
  const { partyByName, charactersInPartyOrdered } = await import('../parties/membership.js');
  const party = partyByName(state.parties, name);
  if (!party) { toast(`Пати «${name}» не найдена`, 'error'); return null; }
  // Именно порядок пати, а не общий порядок списка персонажей: его задаёт перетаскивание
  // участников в карточке («⠿» → «изменить порядок запуска»), и запускаться надо в нём же.
  return launchGroup(`Запуск игры: ${party.name}`, charactersInPartyOrdered(state.characters, party.id), opts);
}

/**
 * Закрывает окна игры участников пати.
 *
 * Зачем отдельно от «Закрыть все»: после запуска пати её окна и нужно закрыть — чужие аккаунты
 * трогать не надо. Если окон нашлось больше, чем участников пати (кто-то запущен вручную),
 * показывается список, где можно выбрать, что именно закрыть.
 *
 * @param {string} partyName название пати
 * @returns {Promise<number>} сколько окон закрыто
 */
export async function closePartyWindows(partyName) {
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return 0; }
  const { partyByName, charactersInParty } = await import('../parties/membership.js');
  const { runningClientDetails, closeClientsByPid } = await import('./launch.js');
  const { windowRows, rowLabel } = await import('./windowList.js');

  const party = partyByName(state.parties, partyName);
  if (!party) { toast(`Пати «${partyName}» не найдена`, 'error'); return 0; }
  const members = charactersInParty(state.characters, party.id);
  if (!members.length) { toast(`В пати «${party.name}» нет персонажей`, 'info'); return 0; }

  let rows;
  try {
    rows = windowRows(await runningClientDetails(), state.characters);
  } catch (e) {
    toast(`Не удалось получить список окон: ${errText(e)}`, 'error');
    return 0;
  }

  const mine = rows.filter(r => r.known && members.some(m => m.id === r.charId));
  if (!mine.length) {
    toast(`Окна пати «${party.name}» не запущены`, 'info');
    return 0;
  }

  const ok = await confirmModal({
    title: `Закрыть окна пати «${party.name}»?`,
    text: `Будет закрыто окон: ${mine.length} — ${mine.map(rowLabel).join(', ')}. Всё, что не сохранено в игре, будет потеряно.`,
    okText: `Закрыть (${mine.length})`,
    danger: true
  });
  if (!ok) return 0;

  try {
    const report = await closeClientsByPid(mine.map(r => r.pid));
    showCloseReport(report);
    return Number(report?.closed) || 0;
  } catch (e) {
    toast(`Не удалось закрыть окна пати: ${errText(e)}`, 'error');
    return 0;
  }
}

/**
 * Закрывает все окна игры. `confirm: true` — сначала спросить, сколько окон будет закрыто.
 * (Из меню трея окна закрывает сам Rust, интерфейс получает только итог — см. showCloseReport.)
 */
export async function closeAllGameWindows({ confirm = true } = {}) {
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return 0; }
  try {
    const running = await runningClients();
    if (!running.length) { showCloseReport({ found: 0 }); return 0; }
    if (confirm) {
      const ok = await confirmModal({
        title: 'Закрыть все окна игры?',
        text: `Будет закрыто окон: ${running.length}. Всё, что не сохранено в игре, будет потеряно.`,
        okText: `Закрыть (${running.length})`,
        danger: true
      });
      if (!ok) return 0;
    }
    const report = await closeAllClients();
    showCloseReport(report);
    return Number(report?.closed) || 0;
  } catch (e) {
    toast(`Не удалось закрыть окна игры: ${errText(e)}`, 'error');
    return 0;
  }
}

/** Итог закрытия окон: подпись в приложении или системное уведомление, если приложение свёрнуто. */
export function showCloseReport(report) {
  const text = closeReportText(report);
  const isError = !!(report?.error || report?.failed);
  const focused = typeof document !== 'undefined' && document.hasFocus();
  if (canCloseElevated(report)) offerElevatedClose(report, focused);
  if (focused) { toast(text, isError ? 'error' : 'success'); return; }
  import('../../desktop/notifications.js')
    .then(m => m.notify('Твиноферма', text))
    .then(sent => { if (!sent) toast(text, isError ? 'error' : 'success'); })
    .catch(() => toast(text, isError ? 'error' : 'success'));
}

let elevatedOfferPending = false;

/**
 * Игра запущена от администратора, и обычная Твиноферма её закрыть не может. Предлагаем закрыть с правами администратора
 * (Windows спросит разрешение). Если приложение свёрнуто (например, закрывали из трея), вопрос появится, когда его откроют.
 */
function offerElevatedClose(report, focused) {
  if (elevatedOfferPending) return;
  elevatedOfferPending = true;
  const ask = async () => {
    try {
      const left = Number(report.denied) || 0;
      const ok = await confirmModal({
        title: 'Нужны права администратора',
        text: `Окон игры, которые не удалось закрыть: ${left}. Игра запущена от имени администратора. Закрыть их с правами администратора? Windows попросит подтверждение.`,
        okText: 'Закрыть как администратор',
        danger: true
      });
      if (!ok) return;
      const result = await closeAllClientsElevated();
      const isError = !!result?.failed;
      toast(closeReportText(result), isError ? 'error' : 'success');
    } catch (e) {
      toast(`Не удалось закрыть окна игры: ${errText(e)}`, 'error');
    } finally {
      elevatedOfferPending = false;
    }
  };
  if (focused) { ask(); return; }
  window.addEventListener('focus', () => { ask(); }, { once: true });
}

/** Сохраняет путь к GameCenter у персонажа (в приложении путь проверяется). */
export async function saveGameCenterPath(char, path) {
  const value = String(path || '').trim();
  if (value && isTauri()) {
    try { await checkGameCenterPath(value); }
    catch (e) { toast(errText(e), 'error'); return false; }
  }
  char.launch = { ...(char.launch || {}), gcPath: value };
  char.updatedAt = new Date().toISOString();
  await persist();
  toast(value ? 'Путь к GameCenter сохранён' : 'Путь к GameCenter убран', 'success');
  return true;
}

/**
 * Куда привязывать вход: GameCenter из списка (`gcId` или тот, из которого персонаж запускается) либо «свой путь» из карточки.
 * @returns {{ gc: any, key: string, path: string } | { gc: null, key: string, path: string } | null}
 */
function loginTarget(char, gcId) {
  const ctx = launchContext();
  const gc = gcId ? ctx.gameCenters.find(g => g.id === gcId) : resolveGameCenter(char, ctx)?.gc;
  if (gc) return { gc, key: accountKey(char, gc.id), path: gc.path };
  const own = String(char.launch?.gcPath || '').trim();
  return own ? { gc: null, key: String(char.id), path: own } : null;
}

/**
 * Запоминает вход, открытый сейчас в GameCenter персонажа.
 * `gcId` — для какого из его GameCenter (по умолчанию — для того, из которого он запускается).
 */
export async function captureLogin(char, gcId = null) {
  const target = loginTarget(char, gcId);
  if (!target) {
    toast('Сначала укажите GameCenter (и сохраните путь)', 'error');
    return false;
  }
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return false; }
  try {
    const nick = await captureAccount(char, {}, target);
    if (target.gc) {
      const legacy = !!char.launch?.gcAccounts?.[target.gc.id]?.legacy;
      setGcAccount(char, target.gc.id, nick || '', legacy);
    } else {
      char.launch = { ...char.launch, gcNick: nick || '', gcAccount: true };
    }
    char.updatedAt = new Date().toISOString();
    await persist();
    toast(nick ? `Вход запомнен: ${nick}` : 'Вход запомнен', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}

/** Забывает сохранённый вход персонажа (в указанном GameCenter или в том, из которого он запускается). */
export async function forgetLogin(char, gcId = null) {
  try {
    const target = loginTarget(char, gcId);
    if (isTauri() && target) await forgetAccount(target.key);
    if (target?.gc) {
      const legacy = !!char.launch?.gcAccounts?.[target.gc.id]?.legacy;
      setGcAccount(char, target.gc.id, null);
      // legacy-вход — это тот же токен, что и у «своего пути»: убираем и его отметку
      if (legacy) char.launch = { ...char.launch, gcNick: '', gcAccount: false };
    } else {
      char.launch = { ...(char.launch || {}), gcNick: '', gcAccount: false };
    }
    char.updatedAt = new Date().toISOString();
    await persist();
    toast('Сохранённый вход удалён', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}
