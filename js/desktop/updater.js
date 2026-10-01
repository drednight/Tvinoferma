// js/desktop/updater.js
// Автообновление через tauri-plugin-updater + GitHub Releases (latest.json собирает CI).

import { toast, confirmDialog } from '../core/ui.js';

let checking = false;

/**
 * @param {{ silent?: boolean }} opts silent — не показывать «обновлений нет» и ошибки (проверка при запуске)
 */
export async function checkForUpdates({ silent = false } = {}) {
  if (!window.__TAURI_INTERNALS__ || checking) return null;
  checking = true;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      if (!silent) toast('Установлена последняя версия.', 'success');
      return null;
    }
    const notes = update.body ? `\n\n${update.body.slice(0, 600)}` : '';
    if (!confirmDialog(`Доступна версия ${update.version} (сейчас ${update.currentVersion}).${notes}\n\nСкачать и установить?`)) {
      return update;
    }
    let total = 0, received = 0, lastPct = -1;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') { total = event.data.contentLength || 0; toast('Загрузка обновления…', 'info'); }
      if (event.event === 'Progress') {
        received += event.data.chunkLength;
        const pct = total ? Math.floor(received / total * 100 / 25) * 25 : -1;
        if (pct > lastPct && pct > 0 && pct < 100) { lastPct = pct; toast(`Обновление: ${pct}%`, 'info'); }
      }
      if (event.event === 'Finished') toast('Обновление загружено, перезапуск…', 'success');
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return update;
  } catch (e) {
    console.warn('[UPDATER]', e);
    if (!silent) toast(`Не удалось проверить обновления: ${e?.message || e}`, 'error');
    return null;
  } finally {
    checking = false;
  }
}
