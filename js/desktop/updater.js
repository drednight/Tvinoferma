// js/desktop/updater.js
// Автообновление через tauri-plugin-updater + GitHub Releases (latest.json собирает CI).
// Найденное обновление не открывает окон: оно попадает в общее состояние (updateState.js),
// а кнопка «Доступно обновление» в шапке и раздел «Настройки → Обновления» его показывают.

import { toast } from '../core/ui.js';
import { getUpdateState, setUpdateState, hasUpdate, formatVersion } from './updateState.js';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // повторная проверка раз в 6 часов
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

/**
 * Тихая проверка при запуске (через 5 с) и затем раз в 6 часов.
 * @param {{ isEnabled?: () => boolean }} opts isEnabled — читает настройку «Проверять при запуске»
 */
export function startUpdateScheduler({ isEnabled = () => true } = {}) {
  stopUpdateScheduler();
  if (!isSupported()) return;
  const run = () => { if (isEnabled()) checkForUpdates({ silent: true }); };
  timers.push(setTimeout(run, FIRST_CHECK_DELAY_MS));
  timers.push(setInterval(run, UPDATE_CHECK_INTERVAL_MS));
}

export function stopUpdateScheduler() {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
}

export { getUpdateState };