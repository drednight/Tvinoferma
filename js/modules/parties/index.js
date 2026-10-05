// js/modules/parties/index.js

import { renderPartiesGrid } from './renderer.js';
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

    // Первый рендер
    renderPartiesGrid();
}

/**
 * Экспорт функции рендера, чтобы её могли вызывать другие модули
 * (например, syncManager после обновления баланса)
 */
export { renderPartiesGrid as renderParties };