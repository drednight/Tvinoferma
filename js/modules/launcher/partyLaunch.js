// js/modules/launcher/partyLaunch.js
// Запуск игры из интерфейса: пати целиком (вкладка «Пати») и один персонаж (раскрытая карточка).
// Ход запуска виден в доке задач и в «Настройки → Журналы → Скрипты»; кнопка «Отмена» останавливает очередь.
// Одновременно идёт один запуск: GameCenter и окна клиентов общие для всех аккаунтов.

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { toast, confirmDialog } from '../../core/ui.js';
import { startTask } from '../../core/taskLog.js';
import { launchCharacters, launchPlan, launchSummary, checkGameCenterPath, captureAccount, forgetAccount, closeAllClients, runningClients } from './launch.js';

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
    if (await notify('Твиноферма', text)) return;
  } catch { /* системные уведомления недоступны */ }
  toast(text, isError ? 'error' : 'success');
}

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/**
 * Запускает игру для списка персонажей по очереди.
 * @param {string} title заголовок задачи в журнале
 * @param {any[]} characters
 */
export async function launchGroup(title, characters) {
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
    toast('Не указан путь к GameCenter: откройте персонажа → «🎮 Запуск игры»', 'error');
    return null;
  }

  const startedAt = Date.now();
  const signal = { cancelled: false };
  const task = startTask(title, { total: ready.length, cancelable: true });
  task.onCancel(() => { signal.cancelled = true; });
  active = { signal };
  skipped.forEach(c => task.log(`${c.nick}: пропущен — не указан путь к GameCenter`, 'warn'));

  try {
    const results = await launchCharacters(ready, {
      signal,
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
  if (!String(char.launch?.gcPath || '').trim()) {
    toast('Укажите путь к GameCenter этого аккаунта', 'error');
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
 * Закрывает все окна игры (elementclient_64.exe). `confirm: true` — спросить, сколько окон будет закрыто
 * (из меню трея спрашивать не нужно: пункт выбран явно).
 */
export async function closeAllGameWindows({ confirm = true } = {}) {
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return 0; }
  try {
    const running = await runningClients();
    if (!running.length) { reportClosed('Окон игры не запущено'); return 0; }
    if (confirm && !confirmDialog(`Закрыть все окна игры (${running.length})? Несохранённое в игре будет потеряно.`)) return 0;
    const closed = await closeAllClients();
    reportClosed(`Закрыто окон игры: ${closed}`);
    return closed;
  } catch (e) {
    toast(`Не удалось закрыть окна игры: ${errText(e)}`, 'error');
    return 0;
  }
}

function reportClosed(text) {
  if (typeof document !== 'undefined' && document.hasFocus()) { toast(text, 'success'); return; }
  import('../../desktop/notifications.js').then(m => m.notify('Твиноферма', text)).catch(() => toast(text, 'success'));
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

/** Запоминает вход, открытый сейчас в GameCenter персонажа. */
export async function captureLogin(char) {
  if (!String(char.launch?.gcPath || '').trim()) {
    toast('Сначала укажите и сохраните путь к GameCenter', 'error');
    return false;
  }
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return false; }
  try {
    const nick = await captureAccount(char);
    char.launch = { ...char.launch, gcNick: nick || '', gcAccount: true };
    char.updatedAt = new Date().toISOString();
    await persist();
    toast(nick ? `Вход запомнен: ${nick}` : 'Вход запомнен', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}

/** Забывает сохранённый вход персонажа. */
export async function forgetLogin(char) {
  try {
    if (isTauri()) await forgetAccount(char.id);
    char.launch = { ...(char.launch || {}), gcNick: '', gcAccount: false };
    char.updatedAt = new Date().toISOString();
    await persist();
    toast('Сохранённый вход удалён', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}
