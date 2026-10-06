// @ts-check
// js/core/uiActions.js
// Круглая кнопка «+» справа внизу — speed-dial: орбы с подписями раскрываются вокруг кнопки.
// Состав орбов зависит от активной вкладки:
//   Персонажи — создать персонажа, режим выбора, скрипты;
//   Пати — создать пати, создать персонажа, запущенные окна игры;
//   Марафоны — создать папку или марафон.
// Орб «Скрипты» заменяет орбы главным уровнем на подменю со скриптами, «Назад» возвращает.
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
    const mainLevel = menu?.querySelector('.fab-orbs:not(.fab-submenu)');
    // Пункты со списком: действие пункта → id подменю. Новые списки добавляются сюда.
    const SUBMENUS = { scripts: 'fab-scripts-submenu' };

    /** Показывает ровно один уровень меню: главный (null) или подменю с указанным id. Остальные закрываются. */
    const showLevel = (submenuId = null) => {
        if (!menu) return;
        if (mainLevel) /** @type {HTMLElement} */ (mainLevel).hidden = !!submenuId;
        menu.querySelectorAll('.fab-submenu').forEach((el) => {
            const open = el.id === submenuId;
            /** @type {HTMLElement} */ (el).hidden = !open;
            el.classList.toggle('is-open', open);
        });
        // aria-expanded у пунктов-списков отражает, какой список открыт
        Object.entries(SUBMENUS).forEach(([action, id]) => {
            menu.querySelector(`[data-fab-action="${action}"]`)?.setAttribute('aria-expanded', String(id === submenuId));
        });
    };
    const currentLevel = () => menu?.querySelector('.fab-submenu:not([hidden])')?.id || null;
    const setMenu = (open) => {
        if (!menu) return;
        menu.hidden = !open;
        fabBtn.classList.toggle('is-open', open);
        fabBtn.setAttribute('aria-expanded', String(open));
        showLevel(null);   // при каждом открытии и закрытии начинаем с главного уровня
    };
    // Раздел сменился или кнопка скрыта: сворачиваем меню (событие шлёт updateFabVisibility)
    container?.addEventListener('fab:close', () => setMenu(false));
    showLevel(null);

    // Пункты: действия разделов, открытие списков, возврат и сами скрипты
    menu?.addEventListener('click', async (e) => {
        const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-fab-action], [data-script-action], [data-script-back]'));
        if (!item) return;

        // Пункт со списком: прошлый список закрывается, нужный открывается
        const listId = SUBMENUS[item.dataset.fabAction || ''];
        if (listId) {
            showLevel(currentLevel() === listId ? null : listId);
            return;
        }
        // «Назад» на уровне списка
        if (item.dataset.scriptBack) {
            showLevel(null);
            return;
        }
        if (item.dataset.scriptAction) {
            setMenu(false);
            await runScriptAction(item.dataset.scriptAction);
            return;
        }

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
        } else if (action === 'game-windows') {
            const { openWindowPicker } = await import('../modules/launcher/windowPicker.js');
            await openWindowPicker();
        }
    });

    document.addEventListener('click', (e) => {
        if (menu && !menu.hidden && !(/** @type {HTMLElement} */ (e.target)).closest('#global-fab-container')) setMenu(false);
    });
    // Esc: сначала закрывает открытый список (возврат на главный уровень), затем само меню
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !menu || menu.hidden) return;
        if (currentLevel()) showLevel(null);
        else setMenu(false);
    });
    // Ушли с вкладки — меню закрываем
    document.addEventListener('click', (e) => {
        if ((/** @type {HTMLElement} */ (e.target)).closest?.('.tab')) setMenu(false);
    });

    fabBtn.addEventListener('click', () => {
        setMenu(!!menu?.hidden);
    });
}

/** Действия из подменю «Скрипты» (бывшее выпадающее меню в шапке «Персонажей»). */
async function runScriptAction(action) {
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
        characters: 'Персонаж, выбор, скрипты',
        parties: 'Пати, персонаж, окна игры',
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
