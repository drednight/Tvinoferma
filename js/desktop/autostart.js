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
 * @typedef {{ supported: boolean, enabled: boolean, minimized: boolean, path: string, current: boolean, broken: boolean, admin: boolean, selfElevated: boolean }} AutostartInfo
 */

/** @param {{ invoke?: Function }} [deps] @returns {Promise<AutostartInfo>} */
export function getAutostart(deps = {}) {
  return (deps.invoke || tauriInvoke)('autostart_status');
}

/** @param {{ invoke?: Function }} [deps] @returns {Promise<AutostartInfo>} */
export function setAutostart(enabled, minimized, admin, deps = {}) {
  return (deps.invoke || tauriInvoke)('autostart_set', { enabled: !!enabled, minimized: !!minimized, admin: !!admin });
}

/** Пояснение под переключателями. */
export function autostartNote(info) {
  if (!info?.supported) return 'Автозапуск доступен только в Windows.';
  const now = info.selfElevated ? 'Сейчас Твиноферма запущена от администратора. ' : '';
  if (!info.enabled) return `${now}Выключен.`;
  const how = info.minimized ? 'сразу в трей, без окна' : 'с окном';
  const rights = info.admin ? ' от администратора' : '';
  if (!info.current) return `${now}Включён (${how}${rights}), но запись ведёт на другую копию: ${info.path}. Чтобы привязать к этой копии, выключите и включите снова.`;
  return `${now}Включён: при входе в Windows Твиноферма запустится${rights} ${how}.`;
}

/**
 * Если программу переустановили или перенесли и запись автозапуска указывает на несуществующий файл — перезаписываем её.
 * @returns {Promise<AutostartInfo | null>} обновлённое состояние или `null`, если чинить нечего
 */
export async function healAutostart(info, deps = {}) {
  // запись «от администратора» молча не пересоздаём: это вызвало бы запрос UAC при каждом запуске
  if (!info?.supported || !info.enabled || !info.broken || info.admin) return null;
  return setAutostart(true, info.minimized, false, deps);
}

/** Подключает переключатели. Вне приложения (в браузере) блок остаётся скрытым. */
export async function bindAutostart(deps = {}) {
  const block = document.getElementById('autostart-block');
  const on = document.getElementById('autostart-enabled');
  const min = document.getElementById('autostart-minimized');
  const adm = document.getElementById('autostart-admin');
  const note = document.getElementById('autostart-note');
  if (!block || !on || !min || !adm) return;
  if (!deps.invoke && !window.__TAURI_INTERNALS__) return;

  const show = (info) => {
    block.hidden = !info.supported;
    on.checked = info.enabled;
    min.checked = info.minimized;
    adm.checked = info.admin;
    min.disabled = adm.disabled = !info.enabled;
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

  let wasAdmin = adm.checked;
  const apply = async () => {
    on.disabled = min.disabled = adm.disabled = true;
    if (adm.checked !== wasAdmin) toast('Windows спросит разрешение на изменение автозапуска от администратора', 'info', 5000);
    try {
      show(await setAutostart(on.checked, min.checked, adm.checked, deps));
    } catch (e) {
      toast(`Автозапуск: ${errText(e)}`, 'error', 6000);
      try { show(await getAutostart(deps)); } catch { /* оставляем как есть */ }
    } finally {
      on.disabled = false;
      min.disabled = adm.disabled = !on.checked;
      wasAdmin = adm.checked;
    }
  };
  on.addEventListener('change', apply);
  min.addEventListener('change', apply);
  adm.addEventListener('change', apply);
}
