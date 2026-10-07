// js/modules/parties/index.js

import { renderPartiesGrid, setPartyArchiveView } from './renderer.js';
import { openCreatePartyModal } from './manager.js';

/**
 * Инициализация раздела Пати
 * Вызывается один раз при старте приложения из main.js
 */
export function bindParties() {
    const addBtn = document.getElementById('add-party-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            openCreatePartyModal();
        });
    }

    for (const [id, archived] of [['show-active-parties', false], ['show-archived-parties', true]]) {
        const button = document.getElementById(id);
        if (button && !button.dataset.bound) {
            button.dataset.bound = 'true';
            button.addEventListener('click', () => {
                setPartyArchiveView(archived);
            });
        }
    }

    // Первый рендер
    renderPartiesGrid();
}

/**
 * Экспорт функции рендера, чтобы её могли вызывать другие модули
 * (например, syncManager после обновления баланса)
 */
export { renderPartiesGrid as renderParties };