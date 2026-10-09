// @ts-check
// js/core/uiActions.js
// Круглая кнопка «+» справа внизу — speed-dial: орбы с подписями раскрываются вокруг кнопки.
// FAB остался только для создания: персонаж, режим выбора, пати, папка, марафон.
// Скрипты и управление окнами игры переехали в отдельный раздел «Инструменты»
// (js/modules/tools/index.js) — там они видны сразу, без второго нажатия.
// Верхних кнопок «Выбрать»/«Скрипты» и отдельного FAB «Запущенные окна игры» больше нет.

import { openCharacterForm } from '../modules/characters/index.js';
import { refreshAllLoginStatuses, refreshAllBalances, refreshAllMarathonStats } from '../modules/sync/syncManager.js';
import { toast } from './ui.js';
import { openCreatePartyModal } from '../modules/parties/manager.js';

/**
 * Инициализация глобальных UI действий
 */
export function initUiActions() {
    setupFabLogic();

    // Вызываем обновление сразу после инициализации
    updateFabVisibility(getActiveSectionName());
}

/**
 * Настройка обработчика кликов по FAB
 */
function setupFabLogic() {
    const fabBtn = document.getElementById('fab-main-btn');
    if (!fabBtn) return;

    const menu = document.getElementById('fab-menu');
    const container = document.getElementById('global-fab-container');

    const setMenu = (open) => {
        if (!menu) return;
        menu.hidden = !open;
        fabBtn.classList.toggle('is-open', open);
        fabBtn.setAttribute('aria-expanded', String(open));
    };
    // Раздел сменился или кнопка скрыта: сворачиваем меню (событие шлёт updateFabVisibility)
    container?.addEventListener('fab:close', () => setMenu(false));

    // Пункты: создание пати, персонажа, папки, марафона и режим выбора
    menu?.addEventListener('click', async (e) => {
        const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-fab-action]'));
        if (!item) return;
        setMenu(false);
        const action = item.dataset.fabAction;
        if (action === 'folder' || action === 'marathon') {
            const { createFolderFromFab, createMarathonFromFab } = await import('../modules/marathons/page.js');
            if (action === 'folder') createFolderFromFab();
            else createMarathonFromFab();
        } else if (action === 'create-character') {
            openCharacterForm(null);
        } else if (action === 'select-mode') {
            const { setSelectionMode } = await import('../modules/characters/list.js');
            setSelectionMode(true);
        } else if (action === 'create-party') {
            openCreatePartyModal();
        }
    });

    document.addEventListener('click', (e) => {
        if (menu && !menu.hidden && !(/** @type {HTMLElement} */ (e.target)).closest('#global-fab-container')) setMenu(false);
    });
    // Esc закрывает меню целиком: подменю в нём больше нет
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !menu || menu.hidden) return;
        setMenu(false);
    });
    // Ушли с вкладки — меню закрываем
    document.addEventListener('click', (e) => {
        if ((/** @type {HTMLElement} */ (e.target)).closest?.('.tab')) setMenu(false);
    });

    fabBtn.addEventListener('click', () => {
        setMenu(!!menu?.hidden);
    });
}

/**
 * Запуск скрипта по его id. Раньше вызывалось из подменю «Скрипты» круглой кнопки,
 * теперь — из раздела «Инструменты» (js/modules/tools/index.js).
 * @param {string} action
 */
export async function runScriptAction(action) {
    try {
        if (action === 'check-auth') {
            toast('Запуск проверки авторизации...', 'info');
            await refreshAllLoginStatuses();
            toast('Проверка авторизации завершена.', 'success');
        } else if (action === 'update-balance') {
            toast('Запуск обновления балансов...', 'info');
            await refreshAllBalances();
            toast('Обновление балансов завершено.', 'success');
        } else if (action === 'update-marathons') {
            toast('Запуск обновления статистики марафонов...', 'info');
            await refreshAllMarathonStats();
            toast('Обновление марафонов завершено.', 'success');
        } else if (action === 'close-game') {
            const { closeAllGameWindows } = await import('../modules/launcher/partyLaunch.js');
            await closeAllGameWindows({ confirm: true });
        } else if (action === 'promo') {
            const { openPromoDialog } = await import('../modules/automation/promo.js');
            openPromoDialog();
        } else if (action === 'transfer') {
            const { openTransferDialog } = await import('../modules/automation/transfer.js');
            openTransferDialog();
        } else if (action === 'shop') {
            const { openShopDialog } = await import('../modules/automation/shop.js');
            openShopDialog();
        } else if (action === 'caravan') {
            const { openCaravanDialog } = await import('../modules/automation/caravan.js');
            openCaravanDialog();
        } else {
            console.warn(`[UI] Unknown script action: ${action}`);
        }
    } catch (err) {
        console.error(err);
        toast('Ошибка выполнения действия', 'error');
    }
}

/**
 * Публичная функция для обновления видимости и состояния FAB.
 */
export function updateFabVisibility(sectionName) {
    const container = document.getElementById('global-fab-container');
    const fabBtn = document.getElementById('fab-main-btn');

    if (!container || !fabBtn) return;

    const labels = {
        characters: 'Персонаж или режим выбора',
        parties: 'Пати или персонаж',
        marathons: 'Папка или марафон'
    };
    const isVisible = sectionName in labels;

    container.classList.toggle('visible', isVisible);
    // Пункты, не относящиеся к разделу, прячет CSS по data-section
    const nextSection = isVisible ? sectionName : '';
    if (container.dataset.section !== nextSection) container.dispatchEvent(new Event('fab:close'));
    container.dataset.section = nextSection;
    if (isVisible) fabBtn.setAttribute('title', labels[sectionName]);
}

/**
 * Получает имя активной секции из DOM
 */
function getActiveSectionName() {
    const activePage = document.querySelector('.page.active');
    return activePage ? /** @type {HTMLElement} */ (activePage).dataset.section : null;
}
