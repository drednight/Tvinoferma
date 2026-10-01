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
import { setAuthChecking } from './authStatus.js';
import { onCharMarathonData, syncAllActiveMarathons } from './marathons/siteSync.js';
import { logScope, errorText, startTask } from './taskLog.js';

let activeListeners = [];
const authProgress = new ProgressBar();
const balanceProgress = new ProgressBar();

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
            const char = state.characters[charIndex];
            const isOnline = status === 'online';
            const wasChecking = state.ui.authCheck?.[charId] === 'checking';

            char.lastLoginCheck = new Date().toISOString();
            setAuthChecking(charId, false);

            // Сохраняем всегда (lastLoginCheck), перерисовываем если статус изменился или шла проверка
            const changed = char.isLoggedIn !== isOnline;
            logScope(`char:${charId}`, `${char.nick}: ${isOnline ? 'вход подтверждён 🟢' : `нет входа 🔴 (${status})`}`, isOnline ? 'ok' : 'warn');
            char.isLoggedIn = isOnline;
            persist().then(() => {
                if (changed || wasChecking) {
                    renderCharacters();
                    renderParties();
                }
            });
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
        logScope(`char:${charId}`, error ? `${char.nick}: баланс не получен — ${errorText(error)}` : `${char.nick}: баланс ДМ ${balance}`, error ? 'warn' : 'ok');
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

        // Передаём результат модулю марафонов (сверка, ожидающие запросы)
        onCharMarathonData(charId, quests, error);

        const char = state.characters.find(c => c.id === charId);
        if (!char) return;

        if (error) {
            // Ошибки показываются в панели «Результат сверки» марафона, без всплывающих уведомлений
            if (error === 'not_logged_in') char.isLoggedIn = false;
            return;
        }

        if (Array.isArray(quests)) {
            const totalCompleted = quests.reduce((sum, q) => sum + q.completed, 0);
            const totalPossible = quests.reduce((sum, q) => sum + q.total, 0);
            char.marathonData = {
                lastSyncDate: new Date().toISOString(),
                quests,
                summary: {
                    completed: totalCompleted,
                    total: totalPossible,
                    percentage: totalPossible > 0 ? Math.round((totalCompleted / totalPossible) * 100) : 0
                }
            };
        }
    });
    activeListeners.push(unlistenMarathon);

    // 4. Закрытие окна браузера
    const unlistenCloseBrowser = await listen('browser-window-closed', async (event) => {
        const { label } = event.payload;
        const charId = label.replace('sync-win-', '');
        const charIndex = state.characters.findIndex(c => c.id === charId);
        
        if (charIndex !== -1 && label.startsWith('sync-win-')) {
             // Куки сохраняются в профиле персонажа, поэтому закрытие окна ≠ выход.
             // Вместо «оффлайн» сразу перепроверяем авторизацию в фоне
             // (удобно: вошли в окне → закрыли → статус подтвердился сам).
             const char = state.characters[charIndex];
             setAuthChecking(char.id, true);
             renderCharacters();
             renderParties();
             await new Promise(r => setTimeout(r, 1000)); // даём окну закрыться полностью
             try {
                 await invoke('check_login_status_http', { charId: char.id, timeoutSeconds: 8, closeAfter: true });
             } catch (err) {
                 console.error(`[AUTH] Re-check after close failed for ${char.nick}:`, err);
                 setAuthChecking(char.id, false);
                 renderCharacters();
                 renderParties();
             }
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

    const task = authProgress.show('🔐 Проверка авторизации');
    task.watch(...charsToCheck.map(c => `char:${c.id}`));
    task.setStep(`Проход 1/2: быстрая проверка ${total} персонажей (таймаут 3 с)`);
    let completedCount = 0;

    const promisesPass1 = charsToCheck.map(async (char) => {
        try {
            await invoke('check_login_status_http', { charId: char.id, timeoutSeconds: 3 });
        } catch (err) {
            console.error(`[AUTH PASS 1] Error for ${char.nick}:`, err);
            task.log(`${char.nick}: ошибка проверки — ${err}`, 'error');
        } finally {
            completedCount++;
            task.progress(completedCount, total * 2, `Проход 1/2 · ${char.nick}`);
        }
    });

    await Promise.all(promisesPass1);
    await new Promise(r => setTimeout(r, 1000));

    // --- ПРОХОД 2: Углубленная проверка для тех, кто НЕ онлайн ---
    const offlineChars = state.characters.filter(c => !c.isLoggedIn);
    if (offlineChars.length > 0) {
        task.setStep(`Проход 2/2: перепроверка ${offlineChars.length} без входа (таймаут 8 с)`);
        let pass2Completed = 0;
        await Promise.all(offlineChars.map(async (char) => {
            try {
                await invoke('check_login_status_http', { charId: char.id, timeoutSeconds: 8 });
            } catch (err) {
                console.error(`[AUTH PASS 2] Error for ${char.nick}:`, err);
                task.log(`${char.nick}: ошибка проверки — ${err}`, 'error');
            } finally {
                pass2Completed++;
                task.progress(total + Math.round(pass2Completed / offlineChars.length * total), total * 2, `Проход 2/2 · ${char.nick}`);
            }
        }));
    } else {
        task.log('Все персонажи в сети — второй проход не нужен', 'info');
    }

    await new Promise(r => setTimeout(r, 500));
    const online = state.characters.filter(c => c.isLoggedIn).length;
    const offline = state.characters.filter(c => !c.isLoggedIn).map(c => c.nick);
    if (offline.length) task.log(`Без входа: ${offline.join(', ')}`, 'warn');
    authProgress.hide(`В сети ${online} из ${total}`, offline.length ? 'warn' : 'done');
    toast(`Проверка авторизации: в сети ${online} из ${total}.`, offline.length ? 'warning' : 'success');
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
    const task = balanceProgress.show(`💰 Обновление балансов (${total} акк.)`);
    task.watch(...onlineChars.map(c => `char:${c.id}`));
    let completedCount = 0;

    console.log(`[BALANCE SYNC] Starting update for ${total} characters...`);

    // 2. Последовательный запуск запросов к Rust
    for (const char of onlineChars) {
        try {
            task.setStep(`Запрашиваю баланс: ${char.nick}`);
            await getCharacterBalance(char.id);
            
            completedCount++;
            task.progress(completedCount, total, char.nick);
            
            // Небольшая пауза между запросами для стабильности
            await new Promise(r => setTimeout(r, 500)); 
            
        } catch (e) {
            console.error(`[BALANCE SYNC] Error processing ${char.nick}:`, e);
            completedCount++; 
            task.progress(completedCount, total, `Ошибка: ${char.nick}`);
            task.log(`${char.nick}: ${e?.message || e}`, 'error');
        }
    }

    balanceProgress.hide(`Обработано ${completedCount} из ${total}`);
    toast('Обновление балансов завершено.', 'success');
}

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ СТАТИСТИКИ МАРАФОНА (НОВАЯ ФУНКЦИЯ)
 */
export async function refreshAllMarathonStats() {
    const active = state.marathons.filter(m => m.kind !== 'series' && m.status !== 'completed' && m.participantIds?.length);
    if (!active.length) {
        toast('Нет идущих марафонов с участниками.', 'info');
        return;
    }

    const { report, noUrl } = await syncAllActiveMarathons();

    const changes = Object.values(report).reduce((a, r) => a + r.changes.length, 0);
    const errors = Object.values(report).reduce((a, r) => a + r.errors.length, 0);
    if (noUrl.length) toast(`Без страницы на сайте: ${noUrl.map(m => m.title).join(', ')}`, 'warning');
    toast(`Марафоны: изменений ${changes}${errors ? `, ошибок ${errors}` : ''}`, errors ? 'warning' : 'success');

    renderCharacters();
    renderParties();
    const { renderMarathons } = await import('./marathon.js');
    renderMarathons();
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

/**
 * АВТОПРОВЕРКА ПРИ ЗАПУСКЕ
 * Проверяет только тех, кто в прошлый раз был авторизован (isLoggedIn === true).
 * Пока идёт проверка, персонаж показывается жёлтым 🟡 «Проверка…».
 * Скрытые окна, созданные для проверки, закрываются сразу после неё (экономия RAM).
 */
export async function verifySavedLoginsOnStartup({ concurrency = 3 } = {}) {
    const candidates = state.characters.filter(c => c.isLoggedIn === true);
    if (candidates.length === 0) return;

    console.log(`[AUTH STARTUP] Verifying ${candidates.length} saved logins...`);
    const task = startTask('🔐 Проверка входа при запуске', { total: candidates.length });
    task.watch(...candidates.map(c => `char:${c.id}`));
    task.setStep(`Проход 1/2: ${candidates.length} сохранённых входов (таймаут 5 с, по ${concurrency} одновременно)`);
    let doneCount = 0;
    candidates.forEach(c => setAuthChecking(c.id, true));
    renderCharacters();
    renderParties();

    const runCheck = async (char, timeoutSeconds) => {
        try {
            await invoke('check_login_status_http', { charId: char.id, timeoutSeconds, closeAfter: true });
        } catch (err) {
            console.error(`[AUTH STARTUP] Error for ${char.nick}:`, err);
            task.log(`${char.nick}: ошибка проверки — ${err}`, 'error');
        }
        doneCount++;
        task.progress(Math.min(doneCount, candidates.length * 2), null, `${timeoutSeconds === 5 ? 'Проход 1/2' : 'Проход 2/2'} · ${char.nick}`);
    };

    // Ограничиваем число одновременно открытых скрытых окон
    const runPool = async (items, timeoutSeconds) => {
        const queue = [...items];
        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            while (queue.length) await runCheck(queue.shift(), timeoutSeconds);
        });
        await Promise.all(workers);
    };

    // Проход 1: быстрая проверка
    await runPool(candidates, 5);

    // Проход 2: перепроверяем тех, кто «отвалился», с длинным таймаутом (защита от медленной загрузки)
    const failed = candidates.filter(c => {
        const ch = state.characters.find(x => x.id === c.id);
        return ch && ch.isLoggedIn !== true;
    });
    if (failed.length) {
        task.setStep(`Проход 2/2: перепроверка ${failed.length} (таймаут 10 с)`);
        doneCount = candidates.length;
        task.total = candidates.length + failed.length;
        failed.forEach(c => setAuthChecking(c.id, true));
        renderCharacters();
        renderParties();
        await runPool(failed, 10);
    }

    // На всякий случай снимаем «Проверка…» со всех, по кому не пришёл ответ
    candidates.forEach(c => setAuthChecking(c.id, false));
    renderCharacters();
    renderParties();

    const online = state.characters.filter(c => c.isLoggedIn === true).length;
    const lost = candidates.length - candidates.filter(c => state.characters.find(x => x.id === c.id)?.isLoggedIn).length;
    task.finish(`В сети ${online}, требуют входа ${lost}`, lost ? 'warn' : 'done');
    if (lost > 0) toast(`Авторизация: ${online} онлайн, ${lost} требуют повторного входа.`, 'warning');
    else toast(`Авторизация подтверждена у ${candidates.length} персонажей.`, 'success');
}
