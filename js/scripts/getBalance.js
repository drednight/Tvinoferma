// js/scripts/getBalance.js
import { invoke } from '@tauri-apps/api/core';

/**
 * Запускает парсинг баланса для персонажа.
 * Результат будет доставлен через событие 'pw-balance-result-global'.
 */
export async function getCharacterBalance(charId) {
    try {
        await invoke('fetch_and_parse_balance_v4', { charId });
        
        console.log(`[SCRIPT BALANCE] Fetch initiated for ${charId}`);
        return true;
        
    } catch (error) {
        console.error(`[SCRIPT BALANCE] Failed to start fetch for ${charId}:`, error);
        throw error;
    }
}