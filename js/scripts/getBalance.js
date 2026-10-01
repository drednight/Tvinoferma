// js/scripts/getBalance.js
import { invoke } from '@tauri-apps/api/core';

/**
 * Баланс древних монет персонажа (chests2.php).
 * @returns {Promise<{ charId: string, balance: number|null, error: string|null }>}
 */
export async function getCharacterBalance(charId, { timeoutSeconds = 15, closeAfter = true } = {}) {
  return await invoke('fetch_and_parse_balance_v4', { charId, timeoutSeconds, closeAfter });
}
