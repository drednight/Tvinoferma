// js/desktop/updater.js
// Автообновление через tauri-plugin-updater + GitHub Releases (latest.json собирает CI).
// Найденное обновление не открывает окон: оно попадает в общее состояние (updateState.js),
// а кнопка «Доступно обновление» в шапке и раздел «Настройки → Обновления» его показывают.

import { toast } from '../core/ui.js';
import { getUpdateState, setUpdateState, hasUpdate, formatVersion } from './updateState.js';
import { isScheduledMode, isCheckDue, nextBoundary } from './updateSchedule.js';

export const CATCHUP_INTERVAL_MS = 10 * 60 * 1000; // если плановая проверка пропущена (сон ПК, офлайн), догоняем
export const BOUNDARY_SLACK_MS = 1000;
export const FIRST_CHECK_DELAY_MS = 5000;

let pending = null;      // объект Update из плагина (нужен для установки)
let checking = false;
let installing = false;
let timers = [];

const isSupported = () => !!window.__TAURI_INTERNALS__;

/**
 * Проверка обновлений. Диалогов не показывает.
 * @param {{ silent?: boolean }} opts silent — без тостов (автопроверка): ни «обновлений нет», ни ошибок
 * @returns {Promise<object|null>} найденное обновление или null
 */
export async function checkForUpdates({ silent = false } = {}) {
  if (!isSupported() || checking || installing) return pending;
  checking = true;
  if (!hasUpdate()) setUpdateState({ status: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    const lastCheckedAt = new Date().toISOString();
    if (!update) {
      pending = null;
      setUpdateState({ status: 'uptodate', version: null, notes: '', progress: null, error: null, lastCheckedAt });
      if (!silent) toast('Установлена последняя версия.', 'success');
      return null;
    }
    pending = update;
    setUpdateState({
      status: 'available',
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body || '',
      progress: null,
      error: null,
      lastCheckedAt
    });
    if (!silent) toast(`Доступна версия ${formatVersion(update.version)}. Кнопка обновления в шапке и в настройках.`, 'info');
    return update;
  } catch (e) {
    console.warn('[UPDATER]', e);
    const message = e?.message || String(e);
    if (pending) {
      // уже знаем о найденном обновлении — кнопку не убираем
      setUpdateState({ status: 'available', lastCheckedAt: new Date().toISOString() });
    } else {
      setUpdateState({ status: 'check_error', error: message, lastCheckedAt: new Date().toISOString() });
    }
    if (!silent) toast(`Не удалось проверить обновления: ${message}`, 'error');
    return null;
  } finally {
    checking = false;
  }
}

/**
 * Скачать и установить найденное обновление, затем перезапустить приложение.
 * Ход загрузки идёт в состояние (progress), а не серией тостов.
 * @returns {Promise<boolean>} true, если установка дошла до перезапуска
 */
export async function installUpdate() {
  if (!pending || installing) return false;
  installing = true;
  setUpdateState({ status: 'downloading', progress: null, error: null });
  try {
    let total = 0;
    let received = 0;
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data?.contentLength || 0;
        setUpdateState({ status: 'downloading', progress: total ? 0 : null });
      } else if (event.event === 'Progress') {
        received += event.data?.chunkLength || 0;
        if (total) setUpdateState({ progress: Math.min(99, Math.floor((received / total) * 100)) });
      } else if (event.event === 'Finished') {
        setUpdateState({ status: 'installing', progress: 100 });
      }
    });
    setUpdateState({ status: 'installing', progress: 100 });
    // Перед перезапуском гарантированно сохраняем данные
    try { const { saveNow } = await import('../core/storage.js'); await saveNow(); } catch (e) { console.warn('[UPDATER] saveNow', e); }
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return true;
  } catch (e) {
    console.warn('[UPDATER] install failed', e);
    const message = e?.message || String(e);
    setUpdateState({ status: 'error', error: message, progress: null });
    toast(`Не удалось установить обновление: ${message}`, 'error');
    return false;
  } finally {
    installing = false;
  }
}

let schedule = null;   // { getMode, getLastChecked }
let boundaryTimer = null;

const dueNow = () => !!schedule && isCheckDue(schedule.getMode(), schedule.getLastChecked());

/** Таймер на ближайшую полночь (или понедельник) для режимов daily/weekly. */
function armBoundary() {
  clearTimeout(boundaryTimer);
  boundaryTimer = null;
  const mode = schedule?.getMode();
  if (!isScheduledMode(mode)) return;
  const ms = Math.max(1000, nextBoundary(mode).getTime() - Date.now() + BOUNDARY_SLACK_MS);
  boundaryTimer = setTimeout(() => {
    if (dueNow()) checkForUpdates({ silent: true });   // если догоняющая проверка уже сработала, повтора нет
    armBoundary();
  }, Math.min(ms, 2 ** 31 - 1));
}

/**
 * Тихая автопроверка по расписанию (updateSchedule.js):
 *  - startup: один раз через 5 с после запуска;
 *  - daily/weekly: в 00:00 и, если пропустили срок, при запуске или в ближайшие 10 минут;
 *  - never: ничего.
 * @param {{ getMode?: () => string, getLastChecked?: () => (string|null|undefined) }} opts
 */
export function startUpdateScheduler({ getMode = () => 'startup', getLastChecked = () => getUpdateState().lastCheckedAt } = {}) {
  stopUpdateScheduler();
  if (!isSupported()) return;
  schedule = { getMode, getLastChecked };
  timers.push(setTimeout(() => {
    const mode = getMode();
    if (mode === 'startup' || dueNow()) checkForUpdates({ silent: true });
  }, FIRST_CHECK_DELAY_MS));
  timers.push(setInterval(() => { if (dueNow()) checkForUpdates({ silent: true }); }, CATCHUP_INTERVAL_MS));
  armBoundary();
}

/** Вызывается после смены режима в настройках: пересчитывает таймер и, если срок уже прошёл, проверяет сразу. */
export function rescheduleUpdates() {
  if (!schedule) return;
  armBoundary();
  if (dueNow()) checkForUpdates({ silent: true });
}

export function stopUpdateScheduler() {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
  clearTimeout(boundaryTimer);
  boundaryTimer = null;
  schedule = null;
}

export { getUpdateState };