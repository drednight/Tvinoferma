// js/desktop/autostart.js
// Автозапуск вместе с Windows: переключатели в «Настройки → Трей и фоновые проверки».
// Сама запись (HKCU\...\Run) делается в Rust (src-tauri/src/autostart.rs); режим «в трее» хранится в команде запуска.

import { toast } from '../core/ui.js';

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

const errText = (e) => String(e?.message || e);

/**
 * Ответ Rust: что сейчас записано в автозагрузке.
 * @typedef {{ supported: boolean, enabled: boolean, minimized: boolean, path: string, current: boolean, broken: boolean }} AutostartInfo
 */

/** @param {{ invoke?: Function }} [deps] @returns {Promise<AutostartInfo>} */
export function getAutostart(deps = {}) {
  return (deps.invoke || tauriInvoke)('autostart_status');
}

/** @param {{ invoke?: Function }} [deps] @returns {Promise<AutostartInfo>} */
export function setAutostart(enabled, minimized, deps = {}) {
  return (deps.invoke || tauriInvoke)('autostart_set', { enabled: !!enabled, minimized: !!minimized });
}

/** Пояснение под переключателями. */
export function autostartNote(info) {
  if (!info?.supported) return 'Автозапуск доступен только в Windows.';
  if (!info.enabled) return 'Выключен.';
  const how = info.minimized ? 'сразу в трей, без окна' : 'с окном';
  if (!info.current) return `Включён (${how}), но запись ведёт на другую копию: ${info.path}. Чтобы привязать к этой копии, выключите и включите снова.`;
  return `Включён: при входе в Windows Твиноферма запустится ${how}.`;
}

/**
 * Если программу переустановили или перенесли и запись автозапуска указывает на несуществующий файл — перезаписываем её.
 * @returns {Promise<AutostartInfo | null>} обновлённое состояние или `null`, если чинить нечего
 */
export async function healAutostart(info, deps = {}) {
  if (!info?.supported || !info.enabled || !info.broken) return null;
  return setAutostart(true, info.minimized, deps);
}

/** Подключает переключатели. Вне приложения (в браузере) блок остаётся скрытым. */
export async function bindAutostart(deps = {}) {
  const block = document.getElementById('autostart-block');
  const on = document.getElementById('autostart-enabled');
  const min = document.getElementById('autostart-minimized');
  const note = document.getElementById('autostart-note');
  if (!block || !on || !min) return;
  if (!deps.invoke && !window.__TAURI_INTERNALS__) return;

  const show = (info) => {
    block.hidden = !info.supported;
    on.checked = info.enabled;
    min.checked = info.minimized;
    min.disabled = !info.enabled;
    if (note) note.textContent = autostartNote(info);
  };

  try {
    let info = await getAutostart(deps);
    info = (await healAutostart(info, deps)) || info;
    show(info);
  } catch (e) {
    console.warn('[AUTOSTART]', e);
    return;
  }

  const apply = async () => {
    on.disabled = min.disabled = true;
    try {
      show(await setAutostart(on.checked, min.checked, deps));
    } catch (e) {
      toast(`Автозапуск: ${errText(e)}`, 'error', 6000);
      try { show(await getAutostart(deps)); } catch { /* оставляем как есть */ }
    } finally {
      on.disabled = false;
      min.disabled = !on.checked;
    }
  };
  on.addEventListener('change', apply);
  min.addEventListener('change', apply);
}
