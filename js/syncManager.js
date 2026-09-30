// js/syncManager.js

import { state } from './state.js';
import { persist } from './storage.js';
import { toast } from './ui.js';
import { listen } from '@tauri-apps/api/event';
import { renderCharacters } from './characters.js';
import { renderParties } from './parties/index.js'; // <-- Импорт из новой структуры
import { invoke } from '@tauri-apps/api/core';
import { escapeHtml } from './utils.js';
import { showModal, closeModal } from './ui.js';

// Импортируем скрипты запуска задач
import { checkCharacterAuth } from './scripts/checkAuth.js';
import { getCharacterBalance } from './scripts/getBalance.js';

// Импортируем компонент прогресса
import { ProgressBar } from './components/ProgressBar.js'; 

let activeListeners = [];
const authProgress = new ProgressBar();
const balanceProgress = new ProgressBar();
const marathonProgress = new ProgressBar(); // <--- НОВЫЙ ПРОГРЕСС БАР ДЛЯ МАРАФОНОВ

/**
 * Инициализация слушателей событий Tauri IPC
 */
export async function initSyncListeners() {
    // Очищаем старые слушатели, если есть
    activeListeners.forEach(unlisten => unlisten());
    activeListeners = [];

    console.log('[SYNC MANAGER] Initializing listeners...');

    // 1. Слушаем результат ПРОВЕРКИ ЛОГИНА
    const unlistenLoginStatus = await listen('login-status-result-global', (event) => {
        const { charId, status } = event.payload;
        console.log(`[EVENT LOGIN] ${charId}: ${status}`);
        
        const charIndex = state.characters.findIndex(c => c.id === charId);
        if (charIndex !== -1) {
            const isOnline = status === 'online';
            
            // Если статус изменился — обновляем UI
            if (state.characters[charIndex].isLoggedIn !== isOnline) {
                state.characters[charIndex].isLoggedIn = isOnline;
                state.characters[charIndex].lastLoginCheck = new Date().toISOString();
                
                persist().then(() => {
                    renderCharacters();
                    renderParties(); 
                });
            }
        }
    });
    activeListeners.push(unlistenLoginStatus);

    // 2. Слушаем результат БАЛАНСА
    const unlistenBalance = await listen('pw-balance-result-global', (event) => {
        const { charId, balance, error } = event.payload;
        console.log(`[EVENT BALANCE] ${charId}: Balance=${balance}, Error=${error}`);

        const charIndex = state.characters.findIndex(c => c.id === charId);
        if (charIndex === -1) return;

        const char = state.characters[charIndex];

        // ЛОГИКА ОБРАБОТКИ ОШИБОК АВТОРИЗАЦИИ
        if (error) {
            // Список ошибок, означающих потерю сессии
            const authErrors = ['not_logged_in', 'zero_no_user_session_expired', 'session_lost_during_parse'];
            
            if (authErrors.includes(error)) {
                console.warn(`[SYNC] Auth lost detected for ${char.nick}. Setting Offline.`);
                char.isLoggedIn = false;
                persist().then(() => {
                    renderCharacters();
                    renderParties();
                });
                toast(`⚠️ Сессия истекла для ${char.nick}. Требуется повторный вход.`, 'warning');
            } else {
                // Другие ошибки (таймаут, баг парсинга)
                console.error(`[SYNC ERROR] Parsing failed for ${char.nick}:`, error);
                toast(`Ошибка синхронизации (${char.nick}): ${error}`, 'error');
            }
            return;
        }

        // ЛОГИКА УСПЕХА
        if (balance !== null && balance >= 0) {
            const oldBalance = char.ancientCoins || 0;
            
            // Обновляем баланс
            char.ancientCoins = balance;
            char.lastCoinUpdate = new Date().toISOString();
            
            // Подтверждаем, что пользователь онлайн (раз смогли прочитать баланс без ошибок)
            char.isLoggedIn = true;

            // Добавляем в историю, если сумма изменилась
            if (oldBalance !== balance) {
                const historyEntry = {
                    id: crypto.randomUUID(),
                    date: char.lastCoinUpdate,
                    delta: balance - oldBalance,
                    note: 'Автосинхронизация PW Online',
                    balanceAfter: balance
                };
                char.coinHistory = [historyEntry, ...(char.coinHistory || [])];
            }

            persist().then(() => {
                renderCharacters();
                renderParties();
                // Тост только если баланс реально изменился, чтобы не спамить
                if (oldBalance !== balance) {
                   toast(`Баланс ${char.nick} обновлен: ${balance}`, 'success');
                }
            });
        }
    });
    activeListeners.push(unlistenBalance);

    // 3. Слушаем результат МАРАФОНА (НОВЫЙ БЛОК)
    const unlistenMarathon = await listen('marathon-progress-result-global', (event) => {
        const { charId, quests, error } = event.payload;
        console.log(`[EVENT MARATHON] ${charId}: Quests=${quests?.length}, Error=${error}`);

        const charIndex = state.characters.findIndex(c => c.id === charId);
        if (charIndex === -1) return;

        const char = state.characters[charIndex];

        if (error) {
            if (error === 'not_logged_in') {
                char.isLoggedIn = false;
                persist().then(renderCharacters);
                toast(`⚠️ Не удалось получить марафон для ${char.nick}: Нет авторизации.`, 'warning');
            } else {
                toast(`Ошибка парсинга марафона (${char.nick}): ${error}`, 'error');
            }
            return;
        }

        if (quests && Array.isArray(quests)) {
            // Обновляем данные марафона в стейте
            if (!char.marathonData) char.marathonData = {};
            
            char.marathonData.lastSyncDate = new Date().toISOString();
            char.marathonData.quests = quests; // Сохраняем полный массив
            
            // Вычисляем общий прогресс (опционально, для отображения одной цифры)
            const totalCompleted = quests.reduce((sum, q) => sum + q.completed, 0);
            const totalPossible = quests.reduce((sum, q) => sum + q.total, 0);
            
            char.marathonData.summary = {
                completed: totalCompleted,
                total: totalPossible,
                percentage: totalPossible > 0 ? Math.round((totalCompleted / totalPossible) * 100) : 0
            };

            persist().then(() => {
                renderCharacters();
                renderParties();
            });
        }
    });
    activeListeners.push(unlistenMarathon);

    // 4. Закрытие окна браузера
    const unlistenCloseBrowser = await listen('browser-window-closed', async (event) => {
        const { label } = event.payload;
        const charId = label.replace('sync-win-', '');
        const charIndex = state.characters.findIndex(c => c.id === charId);
        
        if (charIndex !== -1) {
             // При закрытии окна считаем оффлайном (безопаснее)
             state.characters[charIndex].isLoggedIn = false;
             persist().then(() => {
                 renderCharacters();
                 renderParties();
             });
        }
    });
    activeListeners.push(unlistenCloseBrowser);
}

/**
 * МАССОВАЯ ПРОВЕРКА АВТОРИЗАЦИИ (2 ПРОХОДА + ПРОГРЕСС)
 */
export async function refreshAllLoginStatuses() {
    const charsToCheck = [...state.characters];
    const total = charsToCheck.length;
    
    if (total === 0) {
        toast('Нет персонажей для проверки.', 'info');
        return;
    }

    // --- ПРОХОД 1: Быстрая проверка (3 секунды таймаут) ---
    authProgress.show('🔐 Проверка авторизации (Проход 1/2)');
    let completedCount = 0;

    const promisesPass1 = charsToCheck.map(async (char) => {
        try {
            // Вызываем напрямую invoke с параметром таймаута
            await invoke('check_login_status_http', { 
                charId: char.id,
                timeoutSeconds: 3 // Быстрый таймаут
            });
        } catch (err) {
            console.error(`[AUTH PASS 1] Error for ${char.nick}:`, err);
        } finally {
            completedCount++;
            authProgress.update(completedCount, total, 'Быстрая проверка');
        }
    });

    await Promise.all(promisesPass1);
    
    // Пауза между проходами, чтобы дать окнам стабилизироваться
    await new Promise(r => setTimeout(r, 1000));

    // --- ПРОХОД 2: Углубленная проверка для тех, кто НЕ онлайн ---
    const offlineChars = state.characters.filter(c => !c.isLoggedIn);
    
    if (offlineChars.length > 0) {
        authProgress.show('🔐 Проверка авторизации (Проход 2/2 - Верификация)');
        let pass2Completed = 0;
        const pass2Total = offlineChars.length;

        const promisesPass2 = offlineChars.map(async (char) => {
            try {
                await invoke('check_login_status_http', { 
                    charId: char.id,
                    timeoutSeconds: 8 // Долгий таймаут для надежности
                });
            } catch (err) {
                console.error(`[AUTH PASS 2] Error for ${char.nick}:`, err);
            } finally {
                pass2Completed++;
                authProgress.update(pass2Completed, pass2Total, 'Углубленная проверка');
            }
        });

        await Promise.all(promisesPass2);
    } else {
        // Если все оказались онлайн в первом проходе, скрываем прогресс сразу
        authProgress.hide();
    }

    // Финальное скрытие (на случай, если второй проход не запускался или завершился)
    setTimeout(() => {
        authProgress.hide();
        toast('Проверка авторизации завершена.', 'success');
    }, 500);
}

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ БАЛАНСА (+ ПРОГРЕСС)
 * ОПТИМИЗИРОВАННАЯ ВЕРСИЯ: Скипает проверку логина, если статус уже Online
 */
export async function refreshAllBalances() {
    // 1. Находим всех, кто помечен как Онлайн в локальном стейте
    const onlineChars = state.characters.filter(c => c.isLoggedIn === true);
    
    if (onlineChars.length === 0) {
        toast('Нет активных аккаунтов (по данным приложения). Сначала нажмите "Проверить авторизацию".', 'warning');
        return;
    }

    const total = onlineChars.length;
    balanceProgress.show(`💰 Обновление балансов (${total} акк.)`);
    let completedCount = 0;

    console.log(`[BALANCE SYNC] Starting update for ${total} characters...`);

    // 2. Последовательный запуск запросов к Rust
    for (const char of onlineChars) {
        try {
            await getCharacterBalance(char.id);
            
            completedCount++;
            balanceProgress.update(completedCount, total, char.nick);
            
            // Небольшая пауза между запросами для стабильности
            await new Promise(r => setTimeout(r, 500)); 
            
        } catch (e) {
            console.error(`[BALANCE SYNC] Error processing ${char.nick}:`, e);
            completedCount++; 
            balanceProgress.update(completedCount, total, `Ошибка: ${char.nick}`);
        }
    }

    balanceProgress.hide();
    toast('Обновление балансов завершено.', 'success');
}

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ СТАТИСТИКИ МАРАФОНА (НОВАЯ ФУНКЦИЯ)
 */
export async function refreshAllMarathonStats() {
    const charsToCheck = [...state.characters];
    const total = charsToCheck.length;
    
    if (total === 0) {
        toast('Нет персонажей для проверки.', 'info');
        return;
    }

    marathonProgress.show('🏃 Обновление статистики марафонов');
    let completedCount = 0;

    // Последовательный запуск, чтобы не перегружать сеть/CPU
    for (const char of charsToCheck) {
        try {
            // Вызываем новую Rust команду fetch_marathon_progress_v1
            await invoke('fetch_marathon_progress_v1', { charId: char.id });
            
            completedCount++;
            marathonProgress.update(completedCount, total, char.nick);
            
            // Пауза между запросами
            await new Promise(r => setTimeout(r, 500)); 
            
        } catch (e) {
            console.error(e);
            completedCount++;
            marathonProgress.update(completedCount, total, `Ошибка: ${char.nick}`);
        }
    }

    marathonProgress.hide();
    toast('Обновление марафонов завершено.', 'success');
}

/**
 * ОТКРЫТЬ ПОМОЩНИКА ВХОДА (Браузер + Модалка контактов)
 */
export async function openSyncHelper(characterId) {
    const char = state.characters.find(c => c.id === characterId);
    if (!char) {
        toast('Персонаж не найден', 'error');
        return;
    }

    // Показываем модалку с данными
    showCredentialsModal(char);

    // Открываем браузерное окно
    try {
        await invoke('open_sync_window', { 
            charId: char.id, 
            url: 'https://pwonline.ru/',
            charNick: char.nick 
        });
    } catch (err) {
        console.error(err);
        toast('Не удалось открыть окно браузера', 'error');
    }
}

// --- ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ МОДАЛКИ КОНТАКТОВ ---
function showCredentialsModal(char) {
    const contacts = char.contacts || {};
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
                    data-value="${escapeHtml(value)}"
                    style="cursor:pointer; background:var(--panel-2); padding:6px 10px; border-radius:4px; border:1px solid transparent; transition:border-color 0.2s; word-break:break-all; font-family:monospace;"
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
            
            <!-- БЛОК С КОНТАКТАМИ -->
            <div style="background:var(--bg-secondary, #1a1a24); padding:15px; border-radius:8px; border:1px solid var(--border);">
                <p><strong>Нажмите на поле, чтобы скопировать:</strong></p>
                ${copyField('Email / Логин', email, 'email')}
                ${copyField('Пароль', password, 'pass')}
                ${copyField('Recovery Email', recovery, 'rec')}
                ${copyField('Телефон', phone, 'phone')}
            </div>

            <!-- ПОДСКАЗКА ПРО БЕЛЫЙ ЭКРАН -->
            <div style="background:rgba(255, 193, 7, 0.1); border:1px solid rgba(255, 193, 7, 0.3); padding:10px; border-radius:6px; font-size:0.85rem; color:#ffc107; display:flex; align-items:flex-start; gap:8px;">
                <span style="font-size:1.2rem;">ℹ️</span>
                <div>
                    <strong>Важно при авторизации:</strong><br/>
                    Если после входа через VK Play появился <b>белый экран</b>:<br/>
                    1. Закройте это окно браузера.<br/>
                    2. Нажмите кнопку "Проверить авторизацию" или откройте сайт заново.<br/>
                    3. Статус должен обновиться на 🟢 Онлайн.
                </div>
            </div>
            
            <!-- УПРАВЛЕНИЕ ОКНОМ БРАУЗЕРА -->
            <div style="display:flex; gap:10px;">
                 <button id="btn-reopen-window-modal" class="btn secondary small full-width">🌐 Открыть/Фокус Браузер</button>
                 <button id="btn-close-browser-modal" class="btn danger small full-width">❌ Закрыть Браузер</button>
            </div>
            
            <button id="btn-close-modal-btn" class="btn ghost" style="width:100%; margin-top:5px;">Закрыть подсказку</button>
        </div>
    `;

    showModal({
      title: 'Помощник входа',
      content,
      submitText: null,
      cancelText: null,
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

        document.getElementById('btn-reopen-window-modal')?.addEventListener('click', async () => {
            await invoke('open_sync_window', { 
                charId: char.id, 
                url: 'https://pwonline.ru/',
                charNick: char.nick 
            });
            toast('Окно браузера открыто/сфокусировано.', 'info');
        });

        document.getElementById('btn-close-browser-modal')?.addEventListener('click', async () => {
            await invoke('close_sync_window', { charId: char.id });
            toast('Окно браузера закрыто.', 'info');
        });

        document.getElementById('btn-close-modal-btn')?.addEventListener('click', () => {
            closeModal();
        });
    }, 100);
}