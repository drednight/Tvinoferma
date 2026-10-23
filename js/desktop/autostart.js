// js/desktop/autostart.js
// Автозапуск вместе с Windows: переключатели в «Настройки → Трей и фоновые проверки».
// Сама запись (HKCU\...\Run) делается в Rust (src-tauri/src/autostart.rs); режим «в трее» хранится в команде запуска.

import { toast, confirmModal } from '../core/ui.js';

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

const errText = e => String(e?.message || e);

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

/**
 * Перезапуск приложения с правами администратора.
 *
 * Зачем, если автозапуск от администратора уже настроен: автозапуск работает, а вот ручной
 * запуск (ярлык, «Пуск») и перезапуск после обновления — обычные. Приложение само повысить
 * права не умеет, и без них оно не может ни подписать, ни закрыть окна игры, запущенные с
 * правами администратора. Раньше это выходило только вручную, каждый раз.
 *
 * @param {boolean} minimized запускать сразу в трей — как при автозапуске
 * @param {{ invoke?: Function }} [deps]
 * @returns {Promise<boolean>} `false`, если приложение уже администратор и перезапуск не нужен
 */
export function relaunchElevated(minimized, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_relaunch_elevated', { minimized: !!minimized });
}

/**
 * Пояснение под переключателями: где именно живёт запись автозапуска.
 *
 * Отдельно говорим, где её искать: при запуске от администратора записью Планировщика
 * («Диспетчер задач → Автозагрузка» показывает только записи реестра и папки «Автозагрузка»
 * и потому её не видит), иначе выглядит как «автозагрузка не работает».
 */
export function autostartNote(info) {
  if (!info?.supported) return 'Автозапуск доступен только в Windows.';
  const now = info.selfElevated ? 'Сейчас Твиноферма запущена от администратора. ' : '';
  if (!info.enabled) return `${now}Выключен.`;
  const how = info.minimized ? 'сразу в трей, без окна' : 'с окном';
  if (!info.current)
    return `${now}Включён (${how}), но запись ведёт на другую копию: ${info.path}. Чтобы привязать к этой копии, выключите и включите снова.`;
  const where = info.admin
    ? 'Запись: Планировщик заданий → «Tvinoferma autostart» (Панель управления → Планировщик заданий). В «Диспетчере задач → Автозагрузка» её не видно — там только записи реестра и папка «Автозагрузка».'
    : 'Запись: «Диспетчер задач → Автозагрузка», имя — Tvinoferma.';
  return `${now}Включён${info.admin ? ' от администратора' : ''}: при входе в Windows Твиноферма запустится ${how}. ${where}`;
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
  const relaunch = document.getElementById('autostart-relaunch');
  if (!block || !on || !min || !adm) return;
  if (!deps.invoke && !window.__TAURI_INTERNALS__) return;

  const show = info => {
    block.hidden = !info.supported;
    on.checked = info.enabled;
    min.checked = info.minimized;
    adm.checked = info.admin;
    min.disabled = adm.disabled = !info.enabled;
    if (note) note.textContent = autostartNote(info);
    // Кнопка перезапуска нужна ровно тогда, когда прав нет, а пользователь их хочет.
    // Если уже администратор — вопрос снят, и лишний запрос UAC показывать незачем.
    if (relaunch) {
      relaunch.hidden = !info.supported;
      relaunch.disabled = !!info.selfElevated;
      relaunch.textContent = info.selfElevated ? '✓ Уже от администратора' : '🔄 Перезапустить от администратора';
    }
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
    if (adm.checked !== wasAdmin)
      toast('Windows спросит разрешение на изменение автозапуска от администратора', 'info', 5000);
    try {
      show(await setAutostart(on.checked, min.checked, adm.checked, deps));
    } catch (e) {
      toast(`Автозапуск: ${errText(e)}`, 'error', 6000);
      try {
        show(await getAutostart(deps));
      } catch {
        /* оставляем как есть */
      }
    } finally {
      on.disabled = false;
      min.disabled = adm.disabled = !on.checked;
      wasAdmin = adm.checked;
    }
  };
  on.addEventListener('change', apply);
  min.addEventListener('change', apply);
  adm.addEventListener('change', apply);

  relaunch?.addEventListener('click', async () => {
    if (relaunch.disabled) return;
    const ok = await confirmModal({
      title: 'Перезапустить от администратора?',
      text:
        'Windows спросит разрешение. Твиноферма закроется и откроется заново с правами ' +
        'администратора — иначе она не может подписывать и закрывать окна игры, запущенные с правами администратора.',
      okText: 'Перезапустить',
      danger: false
    });
    if (!ok) return;
    relaunch.disabled = true;
    try {
      // Приложение само себя завершит после успешного запуска новой копии — здесь ждать нечего.
      await relaunchElevated(min.checked, deps);
    } catch (e) {
      toast(`Перезапуск от администратора: ${errText(e)}`, 'error', 6000);
      relaunch.disabled = false;
    }
  });
}
