// js/scripts/checkAuth.js
import { invoke } from '@tauri-apps/api/core';

/**
 * Проверка входа персонажа в скрытом окне его профиля.
 * @returns {Promise<{ charId: string, status: 'online'|'offline', reason: string|null }>}
 */
export async function checkCharacterAuth(charId, { timeoutSeconds = 5, closeAfter = false } = {}) {
  return await invoke('check_login_status_http', { charId, timeoutSeconds, closeAfter });
}
