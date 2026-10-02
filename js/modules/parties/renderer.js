// js/modules/parties/renderer.js

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, roundCoins } from '../../core/coins.js';
import { openEditPartyModal } from './manager.js'; 
import { openCharacterProfile } from '../characters/profileView.js'; 
import { getAuthView } from '../sync/authStatus.js';

// Локальное состояние раскрытых групп
let expandedParties = new Set();

/**
 * Рассчитывает статистику для массива участников
 */
function calculatePartyStats(members) {
    if (!members || members.length === 0) return { totalCoins: 0, onlineCount: 0 };
    
    const totalCoins = roundCoins(members.reduce((sum, c) => sum + (Number(c.ancientCoins) || 0), 0));
    const onlineCount = members.filter(c => c.isLoggedIn === true).length;
    return { totalCoins, onlineCount };
}

/**
 * Группирует персонажей по партиям
 */
function getGroupedParties() {
    const map = new Map();

    // Инициализируем известные группы
    state.parties.forEach(p => {
        if (!map.has(p.name)) map.set(p.name, []);
    });

    // Распределяем персонажей
    state.characters.forEach(char => {
        const pName = char.party || 'Без пати';
        if (!map.has(pName)) map.set(pName, []);
        map.get(pName).push(char);
    });

    return map;
}

export function renderPartiesGrid() {
    const container = document.getElementById('party-list');
    if (!container) return;

    const partyMap = getGroupedParties();
    
    // Сортировка ключей
    let sortedKeys = Array.from(partyMap.keys()).sort((a, b) => {
        if (a === 'Без пати') return 1;
        if (b === 'Без пати') return -1;

        const partyA = state.parties.find(p => p.name === a);
        const partyB = state.parties.find(p => p.name === b);

        const orderA = partyA?.order ?? Number.MAX_SAFE_INTEGER;
        const orderB = partyB?.order ?? Number.MAX_SAFE_INTEGER;

        if (orderA !== orderB) return orderA - orderB;
        return a.localeCompare(b, 'ru');
    });

    if (sortedKeys.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет активных партий.</div>';
        return;
    }

    // Добавляем стили один раз
    if (!document.getElementById('party-grid-styles')) {
        const styleSheet = document.createElement("style");
        styleSheet.id = "party-grid-styles";
                styleSheet.innerText = `
            .party-grid-container {
                display: grid;
                gap: 15px;
                width: 100%;
                padding-bottom: 20px;
                
                /* КРИТИЧЕСКИ ВАЖНО: Выравнивание по началу строки */
                align-items: start; 
                
                grid-template-columns: 1fr; 
            }
            
            @media (min-width: 768px) { 
                .party-grid-container { grid-template-columns: repeat(2, 1fr); } 
            }
            @media (min-width: 1024px) { 
                .party-grid-container { grid-template-columns: repeat(3, 1fr); } 
            }
            @media (min-width: 1280px) { 
                .party-grid-container { grid-template-columns: repeat(4, 1fr); } 
            }

            /* Стили для перетаскивания */
            .party-card-dragging { opacity: 0.5; border: 2px dashed var(--accent); }
            .party-card-drop-target { border: 2px solid var(--success, #9ece6a); box-shadow: 0 0 10px rgba(158, 206, 106, 0.3); }
            .party-card-header.draggable-area { cursor: grab; }
            .party-card-header.draggable-area:active { cursor: grabbing; }
            
            /* Управление видимостью через max-height */
            .party-body-wrapper {
                max-height: 0;
                overflow: hidden;
                transition: max-height 0.3s ease-out;
                background: transparent;
            }
            .party-card-modern.is-expanded .party-body-wrapper {
                max-height: 2000px; 
            }
        `;
        document.head.appendChild(styleSheet);
    }

    container.className = 'party-grid-container'; 
    
    container.innerHTML = sortedKeys.map(name => {
        const members = partyMap.get(name);
        const isExpanded = expandedParties.has(name);
        const stats = calculatePartyStats(members);
        
        const coinsDisplay = stats.totalCoins > 0 ? `${formatCoins(stats.totalCoins)} 🪙` : '';
        const memberCountLabel = `${members.length} чел.`;
        const isDraggable = name !== 'Без пати';

        // --- Тело карточки (всегда генерируется, но скрыто CSS) ---
        const memberListHtml = members.length > 0 ? `
            <ul style="list-style:none; padding:0; margin:0 0 15px 0;">
                ${members.map(m => {
                    const authView = getAuthView(m);
                    const isOnline = m.isLoggedIn === true;
                    const statusIcon = authView.icon;
                    const statusColor = authView.color;
                    
                    return `
                        <li class="party-member-row" data-char-id="${m.id}" 
                            style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; transition:background 0.2s;"
                            onmouseover="this.style.background='rgba(255,255,255,0.05)'"
                            onmouseout="this.style.background='transparent'">
                            
                            <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
                                <span style="color:${statusColor}; font-size:0.9rem; flex-shrink:0;" title="${isOnline ? 'Онлайн' : 'Оффлайн'}">${statusIcon}</span>
                                <strong style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-primary);">${escapeHtml(m.nick)}</strong>
                                <small class="muted" style="font-size:0.8rem; white-space:nowrap;">${escapeHtml(m.class)}</small>
                            </div>
                            
                            <button class="btn ghost small open-profile-btn" data-char-id="${m.id}" style="padding:2px 8px; font-size:0.75rem; border:1px solid var(--border); border-radius:4px; background:transparent; color:var(--accent); cursor:pointer;">
                                Открыть
                            </button>
                        </li>
                    `;
                }).join('')}
            </ul>
        ` : '<p class="muted" style="text-align:center; padding:20px; color:var(--muted);">Группа пуста</p>';

        const controlPanelHtml = `
            <div style="border-top:1px solid var(--border); padding-top:12px; margin-top:auto;">
                <button class="btn primary full-width edit-party-action-btn" data-party-name="${escapeHtml(name)}" style="width:100%;">
                    ⚙️ Настроить состав / Переименовать
                </button>
            </div>
        `;

        // Оборачиваем контент в div с классом wrapper
        const bodyContent = `
            <div class="party-body-wrapper">
                <div style="display:flex; flex-direction:column; height:100%; padding: 0 15px 15px 15px;">
                     ${memberListHtml}
                     ${controlPanelHtml}
                </div>
            </div>
        `;

        // --- Заголовок карточки ---
        const dragAttrs = isDraggable ? `draggable="true" data-drag-name="${escapeHtml(name)}"` : '';
        const dragClass = isDraggable ? 'draggable-area' : '';
        
        // Добавляем класс is-expanded к самой статье, если она открыта
        const cardClass = isExpanded ? 'card party-card-modern is-expanded' : 'card party-card-modern';

        const headerHtml = `
            <header class="party-card-header ${dragClass}" 
                    data-party-name="${escapeHtml(name)}"
                    ${dragAttrs}
                    style="padding:12px 15px; user-select:none; background:var(--panel-2); border-bottom:1px solid var(--border); transition:background 0.2s; display:flex; justify-content:space-between; align-items:center;">
                
                <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
                    ${isDraggable ? '<span style="color:var(--muted); font-size:0.8rem; margin-right:4px;">≡</span>' : ''}
                    
                    <!-- Стрелка поворачивается через CSS родителя -->
                    <span class="toggle-arrow" style="transition:transform 0.2s; transform:rotate(${isExpanded ? '90deg' : '0deg'}); font-size:0.8rem; color:var(--muted); flex-shrink:0;">▶</span>
                    <h3 style="margin:0; font-size:1rem; color:var(--accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(name)}
                    </h3>
                </div>
                
                <div style="text-align:right; flex-shrink:0; margin-left:10px;">
                    <span class="badge muted" style="font-size:0.7rem; display:block; margin-bottom:2px;">${memberCountLabel}</span>
                    <span style="font-size:0.85rem; color:gold; font-weight:bold;">${coinsDisplay}</span>
                </div>
            </header>
        `;

        return `
            <article class="${cardClass}" data-party-name="${escapeHtml(name)}" style="height:auto; min-height:100px; overflow:hidden; border-radius:8px; border:1px solid var(--border); background:var(--panel); box-shadow:0 2px 5px rgba(0,0,0,0.1); display:flex; flex-direction:column;">
                ${headerHtml}
                ${bodyContent}
            </article>
        `;
    }).join('');

    bindPartyEvents(container);
    initDragAndDrop(container);
}

function bindPartyEvents(container) {
    container.onclick = async (e) => {
        const target = e.target;

        // 1. Toggle Expand/Collapse
        const header = target.closest('.party-card-header');
        if (header && !target.closest('button')) {
            const card = header.closest('.party-card-modern');
            const name = header.dataset.partyName;
            
            if (!card || !name) return;

            // Проверяем текущее состояние визуально (через класс)
            const isCurrentlyExpanded = card.classList.contains('is-expanded');

            if (isCurrentlyExpanded) {
                // Свернуть
                card.classList.remove('is-expanded');
                // Обновить стрелку внутри заголовка
                const arrow = header.querySelector('.toggle-arrow');
                if(arrow) arrow.style.transform = 'rotate(0deg)';
                
                // Удаляем из Set
                expandedParties.delete(name);
            } else {
                // Развернуть
                card.classList.add('is-expanded');
                // Обновить стрелку
                const arrow = header.querySelector('.toggle-arrow');
                if(arrow) arrow.style.transform = 'rotate(90deg)';
                
                // Добавляем в Set
                expandedParties.add(name);
            }
            
            // НИКАКОЙ ПЕРЕРАИСОВКИ ВСЕГО СПИСКА!
            return;
        }

        // 2. Клик по кнопке "Настроить"
        const editBtn = target.closest('.edit-party-action-btn');
        if (editBtn) {
            e.stopPropagation();
            const partyName = editBtn.dataset.partyName;
            openEditPartyModal(partyName);
            return;
        }

        // 3. Клик по кнопке "Открыть" у персонажа
        const openBtn = target.closest('.open-profile-btn');
        if (openBtn) {
            e.stopPropagation(); 
            const charId = openBtn.dataset.charId;
            const char = state.characters.find(c => c.id === charId);
            if (char) {
                openCharacterProfile(char);
            }
            return;
        }

        // 4. Клик по строке персонажа
        const memberRow = target.closest('.party-member-row');
        if (memberRow && !target.closest('button')) {
             const charId = memberRow.dataset.charId;
             const char = state.characters.find(c => c.id === charId);
             if (char) {
                 openCharacterProfile(char);
             }
             return;
        }
    };
}

/**
 * Инициализация логики Drag and Drop (Исправленная версия)
 */
function initDragAndDrop(container) {
    let draggedElement = null;
    let draggedName = null;

    // 1. Начало перетаскивания
    container.addEventListener('dragstart', (e) => {
        const header = e.target.closest('.party-card-header.draggable-area');
        if (!header) return;

        draggedElement = header.closest('.party-card-modern');
        draggedName = header.dataset.partyName;

        if (draggedElement) {
            // Визуальный эффект "захваченного" элемента
            setTimeout(() => {
                if(draggedElement) draggedElement.classList.add('party-card-dragging');
            }, 0);
            
            e.dataTransfer.effectAllowed = 'move';
            // Передаем имя пати в данные
            e.dataTransfer.setData('text/plain', draggedName);
        }
    });

    // 2. Конец перетаскивания (очистка всего)
    container.addEventListener('dragend', () => {
        if (draggedElement) {
            draggedElement.classList.remove('party-card-dragging');
            draggedElement = null;
            draggedName = null;
        }
        // Удаляем подсветку со всех возможных целей
        document.querySelectorAll('.party-card-drop-target').forEach(el => el.classList.remove('party-card-drop-target'));
    });

    // 3. Наведение на другую карточку (Критически важный момент)
    container.addEventListener('dragover', (e) => {
        // Обязательно preventDefault, иначе drop не сработает!
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move';

        // Ищем ближайшую родительскую карточку от точки курсора
        const targetCard = e.target.closest('.party-card-modern');
        
        // Очищаем предыдущую подсветку перед установкой новой
        document.querySelectorAll('.party-card-drop-target').forEach(el => {
            if (el !== targetCard) {
                el.classList.remove('party-card-drop-target');
            }
        });

        if (targetCard && targetCard !== draggedElement) {
            // Подсвечиваем цель зеленым
            targetCard.classList.add('party-card-drop-target');
        } else {
            // Если вышли за пределы или на себя - убираем подсветку
             document.querySelectorAll('.party-card-drop-target').forEach(el => el.classList.remove('party-card-drop-target'));
        }
    });

    // 4. Уход мыши с области (опционально, для чистоты)
    container.addEventListener('dragleave', (e) => {
        // Проверяем, что мы действительно покинули контейнер, а не просто вошли в его дочерний элемент
        if (!container.contains(e.relatedTarget)) {
             document.querySelectorAll('.party-card-drop-target').forEach(el => el.classList.remove('party-card-drop-target'));
        }
    });

    // 5. Бросок (Drop)
    container.addEventListener('drop', async (e) => {
        e.preventDefault(); // Запрещаем стандартное поведение браузера
        
        // Получаем имя перетаскиваемого объекта из данных
        const sourceName = e.dataTransfer.getData('text/plain');
        if (!sourceName) return;

        // Находим целевую карточку
        const targetCard = e.target.closest('.party-card-modern');
        if (!targetCard) return;

        const targetName = targetCard.dataset.partyName;

        // Проверки безопасности
        if (targetName === sourceName) return; // Бросили на себя же
        if (targetName === 'Без пати') return; // Нельзя менять местами "Без пати"
        if (sourceName === 'Без пати') return; // На всякий случай

        console.log(`[DND] Swapping "${sourceName}" with "${targetName}"`);

        // Выполняем обмен
        await swapPartyOrder(sourceName, targetName);
    });
}

/**
 * Меняет местами порядок двух партий
 */
async function swapPartyOrder(nameA, nameB) {
    const partyA = state.parties.find(p => p.name === nameA);
    const partyB = state.parties.find(p => p.name === nameB);

    if (!partyA || !partyB) return;

    // 1. Читаем визуальный порядок из DOM
    const container = document.getElementById('party-list');
    if (!container) return;

    const cardsInDom = Array.from(container.querySelectorAll('.party-card-modern'));
    let currentVisualOrder = cardsInDom.map(card => card.dataset.partyName).filter(Boolean);

    const indexA = currentVisualOrder.indexOf(nameA);
    const indexB = currentVisualOrder.indexOf(nameB);

    if (indexA === -1 || indexB === -1) return;

    // 2. Меняем местами в массиве имен
    [currentVisualOrder[indexA], currentVisualOrder[indexB]] = [currentVisualOrder[indexB], currentVisualOrder[indexA]];

    // 3. ОБНОВЛЯЕМ STATE.PARTIES НАПРЯМУЮ
    // Мы создаем новый массив партий с обновленными order
    const newPartiesList = currentVisualOrder.map((name, idx) => {
        const originalParty = state.parties.find(p => p.name === name);
        if (originalParty) {
            return {
                ...originalParty,
                order: idx + 1 // Присваиваем жесткий индекс 1, 2, 3...
            };
        }
        return null;
    }).filter(Boolean);

    // Заменяем старый массив на новый
    state.parties = newPartiesList;

    // 4. СОХРАНЯЕМ И ПЕРЕРИСОВЫВАЕМ
    try {
        await persist(); // Ждем физического записи на диск
        
        // Принудительно перерисовываем UI, чтобы убедиться, что он соответствует стейту
        renderPartiesGrid(); 
        
        console.log(`[DND] Saved and Re-rendered. Order updated.`);
    } catch (err) {
        console.error('[DND] Save failed:', err);
        // Откат изменений в памяти, если запись не удалась
        // (В идеале нужно было бы сохранить копию до изменений, но для MVP хватит лога)
    }
}