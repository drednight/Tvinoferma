// @ts-check
// js/core/uiActions.js

import { openCharacterForm } from '../modules/characters/index.js';
// Добавили refreshAllMarathonStats к импортам
import { refreshAllLoginStatuses, refreshAllBalances, refreshAllMarathonStats } from '../modules/sync/syncManager.js'; 
import { toast } from './ui.js';
import { openCreatePartyModal } from '../modules/parties/manager.js'; 

/**
 * Инициализация глобальных UI действий
 */
export function initUiActions() {
    setupFabLogic();
    setupScriptsMenu();
    
    // Вызываем обновление сразу после инициализации
    updateFabVisibility(getActiveSectionName());
}

/**
 * Настройка обработчика кликов по FAB
 */
function setupFabLogic() {
    const fabBtn = document.getElementById('fab-main-btn');
    if (!fabBtn) return;

    fabBtn.addEventListener('click', () => {
        const activeSection = getActiveSectionName();
        
        if (activeSection === 'characters') {
            console.log('[UI] FAB: Create Character');
            openCharacterForm(null);
        } else if (activeSection === 'parties') {
            console.log('[UI] FAB: Create Party');
            openCreatePartyModal();
        } else {
            console.warn('[UI] FAB clicked on unknown section:', activeSection);
        }
    });
}

/**
 * Публичная функция для обновления видимости и состояния FAB.
 */
export function updateFabVisibility(sectionName) {
    const container = document.getElementById('global-fab-container');
    const fabBtn = document.getElementById('fab-main-btn');
    
    if (!container || !fabBtn) return;

    let isVisible;
    let tooltipText = '';

    if (sectionName === 'characters') {
        isVisible = true;
        tooltipText = 'Добавить персонажа';
    } else if (sectionName === 'parties') {
        isVisible = true;
        tooltipText = 'Создать новую пати';
    } else {
        isVisible = false;
    }

    if (isVisible) {
        container.classList.add('visible');
        fabBtn.setAttribute('title', tooltipText);
    } else {
        container.classList.remove('visible');
    }
}

/**
 * Получает имя активной секции из DOM
 */
function getActiveSectionName() {
    const activePage = document.querySelector('.page.active');
    return activePage ? /** @type {HTMLElement} */ (activePage).dataset.section : null;
}

/**
 * Настройка выпадающего меню скриптов
 */
function setupScriptsMenu() {
    const menuBtn = document.getElementById('btn-scripts-menu');
    const dropdown = document.getElementById('scripts-dropdown');
    
    if (!menuBtn || !dropdown) return;

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display === 'block';
        dropdown.style.display = isVisible ? 'none' : 'block';
    });

    dropdown.addEventListener('click', async (e) => {
        const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.dropdown-item'));
        if (!item) return;

        e.stopPropagation();
        const action = item.dataset.action;
        dropdown.style.display = 'none';

        try {
            if (action === 'check-auth') {
                await handleRunScript('check-auth');
            } else if (action === 'update-balance') {
                await handleRunScript('update-balance');
            } else if (action === 'update-marathons') {
                await handleRunScript('update-marathons');
            } else if (action === 'promo') {
                const { openPromoDialog } = await import('../modules/automation/promo.js');
                openPromoDialog();
            } else {
                console.warn(`[UI] Unknown script action: ${action}`);
            }
        } catch (err) {
            console.error(err);
            toast('Ошибка выполнения действия', 'error');
        }
    });

    window.addEventListener('click', (e) => {
        const target = /** @type {Node} */ (e.target);
        if (!menuBtn.contains(target) && !dropdown.contains(target)) {
            dropdown.style.display = 'none';
        }
    });
}

async function handleRunScript(scriptType) {
    try {
        let resultMessage = '';
        
        if (scriptType === 'check-auth') {
            toast('Запуск проверки авторизации...', 'info');
            await refreshAllLoginStatuses();
            resultMessage = 'Проверка авторизации завершена.';
        } else if (scriptType === 'update-balance') {
            toast('Запуск обновления балансов...', 'info');
            await refreshAllBalances();
            resultMessage = 'Обновление балансов завершено.';
        } else if (scriptType === 'update-marathons') {
            // === НОВАЯ ЛОГИКА ЗАПУСКА МАРАФОНА ===
            toast('Запуск обновления статистики марафонов...', 'info');
            await refreshAllMarathonStats();
            resultMessage = 'Обновление марафонов завершено.';
        } else {
            throw new Error('Unknown script type');
        }

        toast(resultMessage, 'success');

    } catch (error) {
        console.error(`[SCRIPT ERROR] ${scriptType}:`, error);
        toast(`Ошибка при выполнении скрипта: ${error.message}`, 'error');
    }
}