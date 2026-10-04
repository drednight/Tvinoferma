// js/modules/launcher/partyLaunch.js
// Запуск игры из интерфейса: пати целиком (вкладка «Пати») и один персонаж (раскрытая карточка).
// Ход запуска виден в доке задач и в «Настройки → Журналы → Скрипты»; кнопка «Отмена» останавливает очередь.
// Одновременно идёт один запуск: GameCenter и окна клиентов общие для всех аккаунтов.

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { toast, confirmModal } from '../../core/ui.js';
import { startTask } from '../../core/taskLog.js';
import { launchCharacters, launchPlan, launchSummary, closeReportText, checkGameCenterPath, captureAccount, forgetAccount, closeAllClients, runningClients, hasGameCenterPath, launchContext } from './launch.js';
import { resolveGameCenter, accountKey, setGcAccount } from './gameCenters.js';

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

/**
 * Запускает игру для списка персонажей по очереди.
 * @param {string} title заголовок задачи в журнале
 * @param {any[]} characters
 * @param {{ gcId?: string }} [opts] gcId — GameCenter, из которого запускать в этот раз (у кого его нет — из доступного)
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
  const { ready, skipped } = launchPlan(characters);
  if (!ready.length) {
    toast('Не указан GameCenter: «Настройки → Запуск игры» или карточка персонажа → «🎮 Запуск игры»', 'error');
    return null;
  }

  const startedAt = Date.now();
  const signal = { cancelled: false };
  const task = startTask(title, { total: ready.length, cancelable: true });
  task.onCancel(() => { signal.cancelled = true; });
  active = { signal };
  skipped.forEach(c => task.log(`${c.nick}: пропущен — не указан GameCenter`, 'warn'));

  try {
    const results = await launchCharacters(ready, {
      signal,
      gcId: opts.gcId,
      onStart: (c) => task.setStep(`${c.nick}: запуск…`),
      onDone: (e, done, total) => {
        task.log(`${e.nick}: ${e.ok ? 'клиент игры запущен' : `ошибка — ${e.error}`}`, e.ok ? 'ok' : 'error');
        task.progress(done, total);
      }
    });
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.cancelled).length;
    const cancelled = results.filter(r => r.cancelled).length;
    const summary = launchSummary({ ok, failed, cancelled, skipped: skipped.length, ms: Date.now() - startedAt });
    task.finish(summary, failed ? 'warn' : undefined);
    reportDone(summary, failed > 0);
    return results;
  } catch (e) {
    task.log(errText(e), 'error');
    task.finish('Запуск прерван из-за ошибки', 'error');
    toast(`Запуск не удался: ${errText(e)}`, 'error');
    return null;
  } finally {
    active = null;
  }
}

/** Запуск одного персонажа (кнопка «▶» на карточке). Без пути к GameCenter открывает его карточку на блоке «Запуск игры». */
export async function launchOne(char) {
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
  return launchGroup(`Запуск игры: ${char.nick}`, [char]);
}

/** Запуск пати по названию (меню трея и вкладка «Пати»). */
export async function launchPartyByName(name) {
  const { partyByName, charactersInParty } = await import('../parties/membership.js');
  const party = partyByName(state.parties, name);
  if (!party) { toast(`Пати «${name}» не найдена`, 'error'); return null; }
  return launchGroup(`Запуск игры: ${party.name}`, charactersInParty(state.characters, party.id));
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
  if (typeof document !== 'undefined' && document.hasFocus()) { toast(text, isError ? 'error' : 'success'); return; }
  import('../../desktop/notifications.js')
    .then(m => m.notify('Твиноферма', text))
    .then(sent => { if (!sent) toast(text, isError ? 'error' : 'success'); })
    .catch(() => toast(text, isError ? 'error' : 'success'));
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
