// js/modules/sync/checkAuth.js
import { invoke } from '@tauri-apps/api/core';

/**
 * Проверка входа персонажа в скрытом окне его профиля.
 * @returns {Promise<{ charId: string, status: 'online'|'offline', reason: string|null }>}
 */
export async function checkCharacterAuth(charId, { timeoutSeconds = 5, closeAfter = false } = {}) {
  return await invoke('check_login_status_http', { charId, timeoutSeconds, closeAfter });
}

/**
 * Закрыть только окна авторизации персонажа (основное окно не трогаем).
 *
 * Нужно после успешной авторизации: окно возврата VK не всегда закрывается само
 * (если родительское окно перезагрузилось, `window.opener` теряется) — и у пользователя
 * остаётся белая страница. Раз вход подтверждён, окно закрываем сами.
 * @returns {Promise<number>} сколько окон закрыто
 */
export function closeAuthPopups(charId) {
  return invoke('close_auth_popups', { charId }).catch(() => 0);
}
