// js/syncManager.js

import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml } from './utils.js';
import { showModal, toast } from './ui.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

let activeListeners = [];
let navInjectionIntervals = {}; // Храним интервалы для каждого окна

/**
 * Инициализация слушателей событий
 */
export async function initSyncListeners() {
    activeListeners.forEach(unlisten => unlisten());
    activeListeners = [];

    const unlistenBalance = await listen('pw-balance-result', (event) => {
        const { charId, balance, error } = event.payload;
        if (error) return;
        if (balance !== null && balance >= 0) {
            updateCharacterBalance(charId, balance);
        }
    });
    activeListeners.push(unlistenBalance);
}

// js/syncManager.js (фрагмент openSyncHelper)

export async function openSyncHelper(characterId) {
  const char = state.characters.find(c => c.id === characterId);
  if (!char) return;

  const contacts = char.contacts || {};
  
  try {
    // 1. Открываем окно
    const label = await invoke('open_sync_window', { 
        charId: characterId, 
        url: 'https://pwonline.ru/' 
    });
    
    toast(`Окно для ${char.nick} открыто.`, 'info');

    // 2. НЕМЕДЛЕННЫЙ ПАТЧ ДЛЯ ПОПАПОВ И НАВИГАЦИИ
    // Ждем минимальное время, чтобы DOM начал строиться, и внедряем перехватчик
    setTimeout(async () => {
        
        // Скрипт, который переопределяет window.open и location.href
        // чтобы любой переход на vkplay.ru происходил в ТЕКУЩЕМ окне
        const popupPatchScript = `
            (function() {
                console.log('[TWINO-FERMA] Applying Popup Patch...');
                
                // 1. Перехват window.open
                const originalOpen = window.open;
                window.open = function(url, name, specs) {
                    if (url && (url.includes('vkplay') || url.includes('oauth') || url.includes('login'))) {
                        console.log('[TWINO-FERMA] Redirecting popup to current window:', url);
                        window.location.href = url;
                        return null; // Возвращаем null, чтобы код сайта не упал
                    }
                    // Для остальных ссылок используем оригинальное поведение (или тоже редиректим, если нужно)
                    return originalOpen.call(this, url, name, specs);
                };

                // 2. Блокировка alert/confirm/prompt, чтобы они не висели
                window.alert = function(msg) { console.log('Alert suppressed:', msg); };
                window.confirm = function(msg) { 
                    console.log('Confirm auto-approved:', msg);
                    return true; 
                };
                window.prompt = function() { return ''; };

                // 3. Инжект панели навигации (вызываем отдельную команду Rust для надежности)
                // Мы передаем label и charId, чтобы Rust знал, куда вставлять панель
                if (window.__TAURI__) {
                     window.__TAURI__.core.invoke('inject_nav_bar', { 
                         label: '${label}', 
                         charId: '${characterId}' 
                     }).catch(e => console.error('Nav inject failed', e));
                }

            })();
        `;

        try {
            await invoke('execute_script_in_window', { label: label, script: popupPatchScript });
        } catch (e) {
            console.error('Failed to apply popup patch:', e);
        }

        // 4. Запускаем цикл поддержания панели навигации
        startNavInjectionLoop(label, characterId);

    }, 500); // Уменьшили задержку до 0.5 сек, чтобы успеть до клика пользователя

    // 3. Модалка с контактами
    showSimpleCredentialsModal(char, contacts, label);

  } catch (err) {
    console.error(err);
    toast('Не удалось открыть окно браузера', 'error');
  }
}

/**
 * Цикл, который периодически инжектит панель навигации в окно.
 * Это гарантирует, что панель появится даже после переходов между страницами.
 */
function startNavInjectionLoop(windowLabel, charId) {
    // Очищаем старый интервал, если был
    if (navInjectionIntervals[windowLabel]) {
        clearInterval(navInjectionIntervals[windowLabel]);
    }

    // Инжект сразу
    invoke('inject_nav_bar', { label: windowLabel, charId: charId }).catch(console.error);

    // Повторяем каждые 3 секунды
    navInjectionIntervals[windowLabel] = setInterval(async () => {
        const exists = await invoke('check_window_exists', { label: windowLabel });
        if (!exists) {
            clearInterval(navInjectionIntervals[windowLabel]);
            delete navInjectionIntervals[windowLabel];
            return;
        }
        // Пробуем инжектить снова. Функция в Rust проверяет наличие и обновляет/создает.
        await invoke('inject_nav_bar', { label: windowLabel, charId: charId });
    }, 3000);
}

/**
 * Модалка с контактами
 */
function showSimpleCredentialsModal(char, contacts, windowLabel) {
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
            <div style="display:flex; flex-direction:column; gap:10px;">
                 <button id="btn-reopen-window" class="btn primary large full-width">🌐 Переоткрыть окно браузера</button>
                 <button id="btn-check-balance-modal" class="btn success large full-width">💰 Проверить баланс сейчас</button>
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

        const reopenBtn = document.getElementById('btn-reopen-window');
        if(reopenBtn) {
            reopenBtn.onclick = async () => {
                document.getElementById('modal-root').innerHTML = '';
                openSyncHelper(char.id);
            };
        }

        const checkBtn = document.getElementById('btn-check-balance-modal');
        if(checkBtn) {
            checkBtn.onclick = async () => {
                toast('Ищу баланс...', 'info');
                await manualCheckBalance(char.id, windowLabel);
            };
        }

        document.getElementById('btn-close-modal')?.addEventListener('click', () => {
            document.getElementById('modal-root').innerHTML = '';
        });
    }, 100);
}

/**
 * Ручная проверка баланса
 */
async function manualCheckBalance(charId, windowLabel) {
    const exists = await invoke('check_window_exists', { label: windowLabel });
    if (!exists) {
        toast('Окно браузера закрыто.', 'warning');
        return;
    }

    const script = `
        (function() {
            const charId = '${charId}';
            function sendResult(balance, error) {
                if (window.__TAURI__) {
                    window.__TAURI__.event.emit('pw-balance-result', { charId: charId, balance: balance, error: error });
                }
            }

            try {
                const url = window.location.href;
                if (!url.includes('chests2.php')) {
                     sendResult(null, 'not_on_chests_page');
                     return;
                }

                let foundBalance = -1;
                const pointsInfoBlock = document.querySelector('.points_info');
                if (pointsInfoBlock) {
                    const strongTag = pointsInfoBlock.querySelector('strong');
                    if (strongTag) {
                        const text = strongTag.innerText.trim();
                        const numericValue = parseInt(text.replace(/[^0-9]/g, ''), 10);
                        if (!isNaN(numericValue)) {
                            foundBalance = numericValue;
                        }
                    }
                }

                if (foundBalance !== -1) {
                    sendResult(foundBalance, null);
                } else {
                    sendResult(null, 'selector_not_found_or_empty');
                }

            } catch (e) {
                sendResult(null, e.message);
            }
        })();
    `;

    try {
        await invoke('execute_script_in_window', { label: windowLabel, script: script });
    } catch (err) {
        console.warn(`Не удалось проверить ${charId}:`, err);
        toast('Ошибка связи с окном браузера', 'error');
    }
}

/**
 * Обновляет баланс в стейте
 */
function updateCharacterBalance(charId, newBalance) {
    const charIndex = state.characters.findIndex(c => c.id === charId);
    if (charIndex === -1) return;

    const char = state.characters[charIndex];
    const oldBalance = char.ancientCoins;

    if (oldBalance === newBalance) return; 

    char.ancientCoins = newBalance;
    
    const historyEntry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        delta: newBalance - oldBalance,
        note: 'Автосинхронизация PW Online (Webview)',
        balanceAfter: newBalance
    };
    char.coinHistory = [historyEntry, ...(char.coinHistory || [])];

    persist().then(() => {
        toast(`Баланс ${char.nick} обновлен: ${newBalance}`, 'success');
        import('./characters.js').then(mod => mod.renderCharacters());
    });
}

/**
 * Массовое обновление
 */
export async function refreshAllBalances() {
    toast('Проверяю балансы в открытых окнах...', 'info');
    
    const charsWithAccounts = state.characters.filter(c => c.contacts?.email);
    let checkedCount = 0;

    for (const char of charsWithAccounts) {
        const label = `sync-win-${char.id}`;
        const isOpen = await invoke('check_window_exists', { label });
        
        if (isOpen) {
            await manualCheckBalance(char.id, label);
            checkedCount++;
            await new Promise(r => setTimeout(r, 200)); 
        }
    }

    if (checkedCount === 0) {
        toast('Нет открытых окон для проверки.', 'warning');
    } else {
        toast(`Проверено ${checkedCount} персонажей.`, 'success');
    }
}