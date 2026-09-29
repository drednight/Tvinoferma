// js/scripts/checkAuth.js
import { invoke } from '@tauri-apps/api/core';

/**
 * Запускает скрытую проверку авторизации для персонажа.
 * Результат будет доставлен через событие 'login-status-result-global'.
 */
export async function checkCharacterAuth(charId) {
    try {
        // Просто инициируем процесс в Rust
        await invoke('check_login_status_http', { charId });
        
        console.log(`[SCRIPT AUTH] Check initiated for ${charId}`);
        return true; 
        
    } catch (error) {
        console.error(`[SCRIPT AUTH] Failed to start check for ${charId}:`, error);
        return false;
    }
}