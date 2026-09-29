// js/syncManager.js

import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml } from './utils.js';
import { showModal, toast } from './ui.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

let activeListeners = [];

/**
 * Инициализация слушателей событий Tauri IPC
 */
export async function initSyncListeners() {
    activeListeners.forEach(unlisten => unlisten());
    activeListeners = [];

    console.log('[SYNC LISTENER] Initializing listeners in MAIN WINDOW...');

    // 1. Слушаем результат ПРОВЕРКИ ЛОГИНА (быстрый статус)
    const unlistenLoginStatus = await listen('login-status-result-global', (event) => {
        const { charId, status } = event.payload;
        console.log(`[LOGIN STATUS] ${charId}: ${status}`);
        
        updateCharacterLoginStatus(charId, status === 'online');
    });
    activeListeners.push(unlistenLoginStatus);

    // 2. Слушаем результат БАЛАНСА (медленный парсинг)
    const unlistenBalance = await listen('pw-balance-result-global', (event) => {
        console.group('[MAIN WINDOW] Received pw-balance-result-global');
        console.log('Payload Details:', event.payload);
        
        const { charId, balance, error } = event.payload;
        
        if (error) {
            console.error(`[SYNC ERROR] Parsing failed for ${charId}:`, error);
            
            if (error === 'not_logged_in') {
                // Если при запросе баланса выяснилось, что не залогинен, обновляем статус
                updateCharacterLoginStatus(charId, false);
                toast(`⚠️ Персонаж не залогинен. Пожалуйста, войдите в аккаунт PW Online.`, 'warning');
            } else {
                toast(`Ошибка синхронизации (${charId}): ${error}`, 'error');
            }
            console.groupEnd();
            return;
        }

        if (balance !== null && balance >= 0) {
            console.log(`[SYNC SUCCESS] Ready to update character ${charId} with balance ${balance}`);
            
            const exists = state.characters.some(c => c.id === charId);
            if (!exists) {
                console.error(`[SYNC CRITICAL] Character ${charId} NOT FOUND in local state!`);
                toast(`Ошибка: Персонаж ${charId} отсутствует в базе.`, 'error');
            } else {
                updateCharacterBalance(charId, balance);
                // Успешное чтение баланса подтверждает онлайн-статус
                updateCharacterLoginStatus(charId, true); 
            }
        } else {
            console.warn('[SYNC WARNING] Balance is invalid or null', balance);
        }
        console.groupEnd();
    });
    activeListeners.push(unlistenBalance);

    // 3. Закрытие окна браузера пользователем
    const unlistenCloseBrowser = await listen('browser-window-closed', async (event) => {
        const { label } = event.payload;
        const charId = label.replace('sync-win-', '');
        console.log(`[SYNC] Browser closed for ${charId}`);
        // При закрытии окна статус становится неизвестным/оффлайн
        updateCharacterLoginStatus(charId, false);
    });
    activeListeners.push(unlistenCloseBrowser);
}

/**
 * Обновляет статус логина в стейте
 */
export function updateCharacterLoginStatus(charId, isOnline) {
    const charIndex = state.characters.findIndex(c => c.id === charId);
    if (charIndex === -1) return;

    const char = state.characters[charIndex];
    
    // Только если статус изменился, чтобы не спамить перерисовкой
    if (char.isLoggedIn !== isOnline) {
        char.isLoggedIn = isOnline;
        char.lastLoginCheck = new Date().toISOString();
        
        persist().then(() => {
            import('./characters.js').then(mod => mod.renderCharacters());
        }).catch(e => console.error('Persist failed', e));
    }
}

/**
 * Главная функция: Показать помощника и открыть браузер
 */
export async function openSyncHelper(characterId) {
  const char = state.characters.find(c => c.id === characterId);
  if (!char) {
    toast('Персонаж не найден', 'error');
    return;
  }

  const contacts = char.contacts || {};
  
  // 1. Показываем МОДАЛКУ ПОМОЩНИКА
  showCredentialsModal(char, contacts);

  // 2. Автоматически открываем ВИДИМОЕ окно браузера
  try {
      await invoke('open_sync_window', { 
          charId: characterId, 
          url: 'https://pwonline.ru/' 
      });
      toast(`Окно браузера открыто для ${char.nick}.`, 'info');
  } catch (err) {
      console.error(err);
      toast('Не удалось открыть окно браузера', 'error');
  }
}

/**
 * Модалка с контактами и управлением окном браузера
 */
function showCredentialsModal(char, contacts) {
    const email = contacts.email || '';
    const password = contacts.password || '';
    const recovery = contacts.recoveryEmail || '';
    const phone = contacts.phone || '';

    const copyField = (label, value, idSuffix) => {
        if (!value) return `<p class="muted">${label}: Не указано</p>`;
        return `
            <div style="margin-bottom:8px;">
                <span class="muted" style="font-size:0.8rem; display:block;">${label}</span>
                <div 
                    id="copy-${idSuffix}" 
                    data-value="${escapeHtml(value)}"
                    style="cursor:pointer; background:var(--panel-2); padding:6px 10px; border-radius:4px; border:1px solid transparent; transition:border-color 0.2s; word-break:break-all; font-family:monospace;"
                    onmouseover="this.style.borderColor='var(--accent)'"
                    onmouseout="this.style.borderColor='transparent'"
                    onclick="window.handleCopyClick(this)"
                >
                    ${escapeHtml(value)}
                </div>
            </div>
        `;
    };

    const content = `
        <div class="sync-helper-container" style="display:flex; flex-direction:column; gap:15px;">
            <h3 style="margin:0; color:var(--accent);">Данные: ${escapeHtml(char.nick)}</h3>
            <div style="background:var(--bg-secondary, #1a1a24); padding:15px; border-radius:8px; border:1px solid var(--border);">
                <p><strong>Нажмите на поле, чтобы скопировать:</strong></p>
                ${copyField('Email / Логин', email, 'email')}
                ${copyField('Пароль', password, 'pass')}
                ${copyField('Recovery Email', recovery, 'rec')}
                ${copyField('Телефон', phone, 'phone')}
            </div>
            
            <!-- УПРАВЛЕНИЕ ОКНОМ БРАУЗЕРА -->
            <div style="display:flex; gap:10px;">
                 <button id="btn-reopen-window" class="btn secondary small full-width">🌐 Открыть/Фокус Браузер</button>
                 <button id="btn-close-browser-only" class="btn danger small full-width">❌ Закрыть Браузер</button>
            </div>
            
            <button id="btn-close-modal" class="btn ghost" style="width:100%; margin-top:5px;">Закрыть подсказку</button>
        </div>
    `;

    showModal({
      title: 'Помощник входа',
      content,
      submitText: null,
      cancelText: 'Отмена',
      onSubmit: () => true,
      onClose: () => {}
    });

    setTimeout(() => {
        // Копирование
        window.handleCopyClick = async (el) => {
            const val = el.dataset.value;
            if (val) {
                try {
                    await navigator.clipboard.writeText(val);
                    toast(`${el.previousElementSibling.textContent} скопирован!`, 'success');
                    const origBg = el.style.background;
                    el.style.background = 'rgba(76, 175, 80, 0.2)';
                    setTimeout(() => el.style.background = origBg, 300);
                } catch (err) {
                    console.error(err);
                    toast('Ошибка копирования', 'error');
                }
            }
        };

        // Переоткрытие окна
        const reopenBtn = document.getElementById('btn-reopen-window');
        if(reopenBtn) {
            reopenBtn.onclick = async () => {
                await invoke('open_sync_window', { 
                    charId: char.id, 
                    url: 'https://pwonline.ru/' 
                });
                toast('Окно браузера открыто/сфокусировано.', 'info');
            };
        }

        // Закрытие браузера
        const closeBrowserBtn = document.getElementById('btn-close-browser-only');
        if(closeBrowserBtn) {
            closeBrowserBtn.onclick = async () => {
                await invoke('close_sync_window', { charId: char.id });
                toast('Окно браузера закрыто.', 'info');
            };
        }

        // Закрытие модалки
        document.getElementById('btn-close-modal')?.addEventListener('click', () => {
            document.getElementById('modal-root').innerHTML = '';
        });
    }, 100);
}

/**
 * Обновляет баланс в стейте и сохраняет
 */
function updateCharacterBalance(charId, newBalance) {
    const charIndex = state.characters.findIndex(c => c.id === charId);
    if (charIndex === -1) return;

    const char = state.characters[charIndex];
    const oldBalance = char.ancientCoins;

    if (oldBalance !== newBalance || !char.lastCoinUpdate) {
        char.ancientCoins = newBalance;
        char.lastCoinUpdate = new Date().toISOString(); 
        
        const historyEntry = {
            id: crypto.randomUUID(),
            date: char.lastCoinUpdate,
            delta: newBalance - (oldBalance || 0),
            note: 'Автосинхронизация PW Online',
            balanceAfter: newBalance
        };
        char.coinHistory = [historyEntry, ...(char.coinHistory || [])];

        persist().then(() => {
            toast(`Баланс ${char.nick} обновлен: ${newBalance}`, 'success');
            import('./characters.js').then(mod => mod.renderCharacters());
        }).catch(e => console.error('Persist failed', e));
    }
}

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ СТАТУСА (Быстрое, фоновое)
 */
export async function refreshAllLoginStatuses() {
    toast('Проверяю статус аккаунтов в фоне...', 'info');
    
    const charsToCheck = [...state.characters];
    
    // Запускаем все проверки параллельно
    const promises = charsToCheck.map(async (char) => {
        try {
            await invoke('check_login_status_http', { charId: char.id });
        } catch (err) {
            console.error(`Failed to check login for ${char.nick}`, err);
        }
    });

    await Promise.all(promises);
    
    toast('Проверка статуса завершена.', 'success');
}

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ БАЛАНСА (Для тех, кто онлайн)
 */
export async function refreshAllBalances() {
    // Сначала обновляем статусы
    await refreshAllLoginStatuses();
    
    // Ждем секунду, чтобы UI успел перерисовать точки
    await new Promise(r => setTimeout(r, 1000)); 

    const onlineChars = state.characters.filter(c => c.isLoggedIn);
    
    if (onlineChars.length === 0) {
        toast('Ни один аккаунт не активен. Пожалуйста, войдите вручную.', 'warning');
        return;
    }

    toast(`Найдено ${onlineChars.length} активных аккаунтов. Обновляю баланс...`, 'info');

    for (const char of onlineChars) {
        await invoke('fetch_and_parse_balance_v4', { charId: char.id });
        await new Promise(r => setTimeout(r, 1500)); 
    }

    toast('Обновление баланса завершено.', 'success');
}