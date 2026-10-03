// js/modules/sync/syncManager.js

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { listen } from '@tauri-apps/api/event';
import { renderCharacters } from '../characters/list.js';
import { renderParties } from '../parties/index.js'; // <-- Импорт из новой структуры
import { invoke } from '@tauri-apps/api/core';
import { escapeHtml } from '../../core/utils.js';
import { applyCoinBalance, formatCoins } from '../../core/coins.js';
import { showModal, closeModal } from '../../core/ui.js';

// Импортируем скрипты запуска задач
import { buildPanelScript, panelDataFor } from '../../desktop/loginPanel.js';
import { checkCharacterAuth } from './checkAuth.js';
import { getCharacterBalance } from './getBalance.js';
import { runQueue, browserSlots, isRetryableCode } from './queue.js';
import { setAuthChecking, authDetails } from './authStatus.js';
import { onCharMarathonData, syncAllActiveMarathons } from '../marathons/siteSync.js';
import { logScope, errorText, startTask } from '../../core/taskLog.js';
import { recordParserResult } from '../../core/parserHealth.js';

let activeListeners = [];

/**
 * Инициализация слушателей событий Tauri IPC
 */
export async function initSyncListeners() {
    // Очищаем старые слушатели, если есть
    activeListeners.forEach(unlisten => unlisten());
    activeListeners = [];
    if (!window.__TAURI_INTERNALS__) return; // браузерный dev-режим: событий Tauri нет

    console.log('[SYNC MANAGER] Initializing listeners...');

    // Результаты проверки входа и баланса приходят как ответ invoke (см. applyLoginResult /
    // applyBalanceResult) — так очередь скриптов видит ошибку и может повторить попытку.

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
             await runAuthChecks([char], { baseTimeout: 8, closeAfter: true, silent: true });
        }
    });
    activeListeners.push(unlistenCloseBrowser);
}

/* ------------------------------------------------------------------ */
/*  Применение результатов скриптов                                    */
/* ------------------------------------------------------------------ */

const AUTH_ERRORS = ['not_logged_in', 'zero_no_user_session_expired', 'session_lost_during_parse'];

function scriptSettings() {
    const s = state.settings?.scripts || {};
    browserSlots.max = s.concurrency || 3;
    return { retries: Number(s.retries ?? 2), retryDelayMs: Number(s.retryDelayMs ?? 2000) };
}

/** Результат check_login_status_http → состояние персонажа. */
export function applyLoginResult(payload) {
    const { charId, status, reason } = payload || {};
    const char = state.characters.find(c => c.id === charId);
    if (!char) return null;
    const isOnline = status === 'online';
    const changed = char.isLoggedIn !== isOnline;
    char.isLoggedIn = isOnline;
    char.lastLoginCheck = new Date().toISOString();
    char.lastLoginReason = isOnline ? null : (reason || null);
    setAuthChecking(charId, false);
    recordParserResult('auth', isOnline ? null : (reason || 'unknown'));
    logScope(`char:${charId}`, `${char.nick}: ${isOnline ? 'вход подтверждён 🟢' : `нет входа 🔴 (${errorText(reason)})`}`, isOnline ? 'ok' : 'warn');
    return { char, changed };
}

/** Результат fetch_and_parse_balance_v4 → баланс и история монет. */
export function applyBalanceResult(payload, { final = true } = {}) {
    const { charId, balance, error } = payload || {};
    const char = state.characters.find(c => c.id === charId);
    if (!char) return null;

    if (error) {
        recordParserResult('balance', error);   // ошибка: прежний баланс и история монет не меняются
        logScope(`char:${charId}`, `${char.nick}: баланс не получен — ${errorText(error)}`, 'warn');
        if (AUTH_ERRORS.includes(error)) {
            char.isLoggedIn = false;
            if (final) toast(`⚠️ Сессия истекла для ${char.nick}. Требуется повторный вход.`, 'warning');
        } else if (final) {
            toast(`Ошибка синхронизации (${char.nick}): ${errorText(error)}`, 'error');
        }
        return { char, changed: AUTH_ERRORS.includes(error) };
    }
    if (balance === null || balance < 0) return { char, changed: false };

    recordParserResult('balance', null);
    char.isLoggedIn = true; // баланс прочитан — значит вход есть
    // Баланс не изменился — обновляется только дата проверки (запись «+0» в историю не пишется)
    const { delta, changed: balanceChanged } = applyCoinBalance(char, balance);
    logScope(`char:${charId}`, `${char.nick}: баланс ДМ ${formatCoins(balance)}${balanceChanged ? '' : ' (без изменений)'}`, 'ok');
    return { char, changed: true, delta };
}

function rerender() {
    renderCharacters();
    renderParties();
}

/* ------------------------------------------------------------------ */
/*  Проверка авторизации                                               */
/* ------------------------------------------------------------------ */

/**
 * Проверка входа через общую очередь: лимит окон, повтор с увеличенным таймаутом,
 * если сайт не ответил или показал «Проверку безопасности» («Вы не авторизованы» не повторяется).
 */
export async function runAuthChecks(chars, { title = '🔐 Проверка авторизации', baseTimeout = 4, closeAfter = false, silent = false } = {}) {
    const { retries, retryDelayMs } = scriptSettings();
    const task = silent && chars.length === 1 ? null : startTask(title, { total: chars.length, cancelable: chars.length > 1 });
    const signal = { cancelled: false };
    task?.onCancel(() => { signal.cancelled = true; });
    task?.watch(...chars.map(c => `char:${c.id}`));
    task?.setStep(`${chars.length} персонажей, по ${browserSlots.max} одновременно, повторов до ${retries}`);
    chars.forEach(c => setAuthChecking(c.id, true));
    rerender();

    const results = await runQueue(chars, async (char, attempt) => {
        if (signal.cancelled) return { skipped: true };   // ждал свободное окно, а пользователь уже отменил
        if (attempt > 0) task?.log(`${char.nick}: повтор ${attempt}/${retries}`, 'info');
        return await checkCharacterAuth(char.id, { timeoutSeconds: baseTimeout * (attempt + 1), closeAfter });
    }, {
        retries, retryDelayMs, signal,
        shouldRetry: (res, err) => !!err || (res?.status !== 'online' && isRetryableCode(res?.reason)),
        onDone: ({ item, result, error }, done, total) => {
            if (error) task?.log(`${item.nick}: ошибка проверки — ${error}`, 'error');
            const applied = result && !result.skipped ? applyLoginResult(result) : (setAuthChecking(item.id, false), null);
            task?.progress(done, total, item.nick);
            persist().then(() => { if (applied?.changed !== false) rerender(); });
        }
    });

    chars.forEach(c => setAuthChecking(c.id, false));
    rerender();
    // Пропущенные из-за отмены не считаем ни «онлайн», ни «оффлайн»: их статус остался прежним
    const checked = results.filter(r => !r.cancelled && !r.result?.skipped).map(r => r.item);
    const skipped = chars.length - checked.length;
    const online = checked.filter(c => c.isLoggedIn === true).length;
    const offline = checked.filter(c => c.isLoggedIn !== true).map(c => c.nick);
    if (offline.length) task?.log(`Без входа: ${offline.join(', ')}`, 'warn');
    if (signal.cancelled) task?.finish(`Отменено: проверено ${checked.length} из ${chars.length}, в сети ${online}`, 'warn');
    else task?.finish(`В сети ${online} из ${chars.length}`, offline.length ? 'warn' : 'done');
    return { online, offline, results, cancelled: signal.cancelled, skipped };
}

/**
 * МАССОВАЯ ПРОВЕРКА АВТОРИЗАЦИИ (все персонажи или выбранные)
 */
export async function refreshAllLoginStatuses(chars = state.characters) {
    const list = [...chars];
    if (list.length === 0) {
        toast('Нет персонажей для проверки.', 'info');
        return;
    }
    // closeAfter: окна профилей после проверки закрываются (иначе каждое держит ~100 МБ памяти)
    const { online, offline, cancelled, skipped } = await runAuthChecks(list, { closeAfter: true });
    if (cancelled) { toast(`Проверка отменена: проверено ${list.length - skipped} из ${list.length}, в сети ${online}.`, 'info'); return; }
    toast(`Проверка авторизации: в сети ${online} из ${list.length}.`, offline.length ? 'warning' : 'success');
}

/**
 * Ручная проверка входа одного персонажа (кнопка в карточке и в профиле).
 * Показывает результат и время проверки; причина «оффлайн» — понятным текстом.
 * → строка authDetails(char)
 */
export async function refreshAuthFor(char) {
    await runAuthChecks([char], { title: `🔐 Вход: ${char.nick}`, baseTimeout: 8, closeAfter: true });
    await persist();
    const text = authDetails(char);
    toast(`${char.nick}: ${text}`, char.isLoggedIn === true ? 'success' : 'warning');
    return text;
}

/* ------------------------------------------------------------------ */
/*  Балансы                                                            */
/* ------------------------------------------------------------------ */

/**
 * МАССОВОЕ ОБНОВЛЕНИЕ БАЛАНСА (все авторизованные или выбранные)
 * Персонажи без входа пропускаются; при таймауте / «Проверке безопасности» — повтор.
 */
export async function refreshAllBalances(chars = state.characters, { title, onlyLoggedIn = true } = {}) {
    const list = onlyLoggedIn ? chars.filter(c => c.isLoggedIn === true) : [...chars];
    if (list.length === 0) {
        toast('Нет активных аккаунтов (по данным приложения). Сначала нажмите "Проверить авторизацию".', 'warning');
        return { updated: 0, failed: 0 };
    }
    const { retries, retryDelayMs } = scriptSettings();
    const task = startTask(title || `💰 Обновление балансов (${list.length} акк.)`, { total: list.length, cancelable: list.length > 1 });
    const signal = { cancelled: false };
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...list.map(c => `char:${c.id}`));
    let updated = 0, failed = 0;

    await runQueue(list, async (char, attempt) => {
        if (signal.cancelled) return { skipped: true };      // ждал свободное окно, а пользователь уже отменил
        task.setStep(`Запрашиваю баланс: ${char.nick}${attempt ? ` (повтор ${attempt})` : ''}`);
        return await getCharacterBalance(char.id, { timeoutSeconds: 15 + attempt * 10 });
    }, {
        retries, retryDelayMs, signal,
        shouldRetry: (res, err) => !!err || isRetryableCode(res?.error),
        onDone: ({ item, result, error }, done, total) => {
            if (result?.skipped) return;
            if (error) task.log(`${item.nick}: ${error?.message || error}`, 'error');
            const applied = result ? applyBalanceResult(result) : null;
            if (result && !result.error) updated++; else failed++;
            task.progress(done, total, item.nick);
            if (applied?.changed) persist().then(rerender);
        }
    });

    if (signal.cancelled) {
        task.finish(`Отменено: обновлено ${updated} из ${list.length}${failed ? `, ошибок ${failed}` : ''}`, 'warn');
        toast(`Обновление балансов отменено: обновлено ${updated} из ${list.length}.`, 'info');
        return { updated, failed, cancelled: true };
    }
    task.finish(`Обновлено ${updated} из ${list.length}${failed ? `, ошибок ${failed}` : ''}`, failed ? 'warn' : 'done');
    toast(`Обновление балансов: ${updated} из ${list.length}.`, failed ? 'warning' : 'success');
    return { updated, failed };
}

/** Баланс одного персонажа (кнопка в профиле). */
export async function refreshBalanceFor(char) {
    return refreshAllBalances([char], { title: `💰 Баланс: ${char.nick}`, onlyLoggedIn: false });
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

    const { report, noUrl, cancelled } = await syncAllActiveMarathons();

    const changes = Object.values(report).reduce((a, r) => a + r.changes.length, 0);
    const errors = Object.values(report).reduce((a, r) => a + r.errors.length, 0);
    if (noUrl.length) toast(`Без страницы на сайте: ${noUrl.map(m => m.title).join(', ')}`, 'warning');
    toast(`Марафоны${cancelled ? ' (отменено)' : ''}: изменений ${changes}${errors ? `, ошибок ${errors}` : ''}`, cancelled ? 'info' : errors ? 'warning' : 'success');

    renderCharacters();
    renderParties();
    const { renderMarathons } = await import('../marathons/page.js');
    renderMarathons();
}

/** Идёт ли сейчас проверка входа этого персонажа (пока идёт — вручную открывать сайт нельзя). */
export function isCheckInProgress(charId) {
    return state.ui?.authCheck?.[charId] === 'checking';
}

/**
 * ОТКРЫТЬ ПОМОЩНИКА ВХОДА (Браузер + панель контактов внутри окна)
 */
export async function openSyncHelper(characterId) {
    const char = state.characters.find(c => c.id === characterId);
    if (!char) {
        toast('Персонаж не найден', 'error');
        return;
    }
    if (isCheckInProgress(char.id)) {
        toast(`Идёт проверка входа для ${char.nick} — дождитесь окончания, потом откройте сайт`, 'info');
        return;
    }

    // Открываем браузерное окно; контакты показывает сворачиваемая панель слева поверх страницы
    try {
        await invoke('open_sync_window', {
            charId: char.id,
            url: 'https://pwonline.ru/',
            charNick: char.nick,
            panelScript: buildPanelScript(panelDataFor(char))
        });
    } catch (err) {
        console.error(err);
        toast('Не удалось открыть окно браузера', 'error');
        showCredentialsModal(char);   // запасной вариант: контакты в модалке
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
            if (isCheckInProgress(char.id)) { toast('Идёт проверка входа — дождитесь окончания', 'info'); return; }
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
export async function verifySavedLoginsOnStartup({ title = '🔐 Проверка входа при запуске', quiet = false } = {}) {
    const candidates = state.characters.filter(c => c.isLoggedIn === true);
    if (candidates.length === 0) return { online: 0, offline: [] };
    const res = await runAuthChecks(candidates, { title, baseTimeout: 5, closeAfter: true });
    if (res.cancelled) { toast(`Проверка входа отменена: проверено ${candidates.length - res.skipped} из ${candidates.length}.`, 'info'); return res; }
    if (res.offline.length > 0) toast(`Авторизация: ${res.online} онлайн, ${res.offline.length} требуют повторного входа.`, 'warning');
    else if (!quiet) toast(`Авторизация подтверждена у ${candidates.length} персонажей.`, 'success');
    return res;
}
