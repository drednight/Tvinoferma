// js/modules/parties/renderer.js

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, roundCoins } from '../../core/coins.js';
import { openEditPartyModal } from './manager.js'; 
import { openCharacterProfile } from '../characters/profileView.js'; 
import { getAuthView } from '../sync/authStatus.js';
import { charactersInMainParty, isMainParty, partyByName, hasNoParty, totalCoins, NO_PARTY_LABEL, charactersInPartyOrdered, movePartyMember } from './membership.js';
import { partyStyleVars } from './color.js';
import { launchBlocker } from '../launcher/gcSettingsModal.js';
import { getClassIconSrc } from '../../core/constants.js';
import { toast } from '../../core/ui.js';

// Функции цвета живут в color.js: ими пользуются ещё и список персонажей и окно настроек.
// `partyHue` реэкспортируется — на него ссылаются тесты (viewsRedesign).
export { partyHue } from './color.js';

// Локальное состояние раскрытых групп
let expandedParties = new Set();
let showingPartyArchive = false;

/**
 * Рассчитывает статистику для массива участников
 */
function calculatePartyStats(members, party = null) {
    if (!members || members.length === 0) return { totalCoins: 0, onlineCount: 0 };
    
    // Монеты пати = персонажи, для которых она основная (дополнительные пати монеты не добавляют)
    const coinMembers = party ? charactersInMainParty(members, party.id) : members;
    const sumCoins = roundCoins(totalCoins(coinMembers));
    const onlineCount = members.filter(c => c.isLoggedIn === true).length;
    return { totalCoins: sumCoins, onlineCount };
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

    // Персонажи из архива выводятся в отдельной копии пати во вкладке архива.
    state.parties.forEach(p => map.set(p.name, charactersInPartyOrdered(state.characters, p.id)));
    const unassigned = state.characters.filter(c => hasNoParty(c, state.parties));
    if (unassigned.length) map.set(NO_PARTY_LABEL, unassigned);

    return map;
}

/** Оттенок пати (0–359) по названию: у каждой пати свой стабильный цвет полоски и значка. */
/** Две буквы для значка пати: «Alpha Strike» → «AS», «Основная пати» → «ОП», «222» → «22». */
export function partyInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words.slice(0, 2).map(w => Array.from(w)[0]).join('') : Array.from(words[0] || '?').slice(0, 2).join('');
    return letters.toUpperCase();
}

/** Стопка значков классов (до 5) и «+N» — быстро видно, кто в пати. */
function avatarStackHtml(members) {
    const shown = members.slice(0, 5);
    const rest = members.length - shown.length;
    const icons = shown.map(m => {
        const src = getClassIconSrc(m.class);
        const archived = state.archivedCharacters.some(char => char.id === m.id);
        const online = !archived && m.isLoggedIn === true;
        return `<span class="pt-ava ${online ? 'is-online' : ''} ${archived ? 'is-archived' : ''}" title="${escapeHtml(m.nick)} · ${escapeHtml(m.class || '')}${archived ? ' · в архиве' : ''}">${src ? `<img src="${src}" alt="" loading="lazy" />` : escapeHtml(Array.from(m.nick || '?')[0])}</span>`;
    }).join('');
    return `<span class="pt-stack">${icons}${rest > 0 ? `<span class="pt-ava pt-ava-more">+${rest}</span>` : ''}</span>`;
}

function memberRowHtml(m, party) {
    const archived = state.archivedCharacters.some(char => char.id === m.id);
    if (archived) {
        const src = getClassIconSrc(m.class);
        return `
        <li class="pt-member party-member-row is-archived" data-char-id="${escapeHtml(m.id)}" data-party-id="${escapeHtml(party.id)}">
            <span class="pt-ava is-archived">${src ? `<img src="${src}" alt="" loading="lazy" />` : escapeHtml(Array.from(m.nick || '?')[0])}</span>
            <span class="pt-member-name"><strong>${escapeHtml(m.nick)}</strong><small class="muted">${escapeHtml(m.class || '')} · в архиве</small></span>
        </li>`;
    }
    const authView = getAuthView(m);
    const isOnline = m.isLoggedIn === true;
    const src = getClassIconSrc(m.class);
    // Порядок задаётся перетаскиванием: ручка слева, номер показывает место в очереди запуска
    const index = (party ? charactersInPartyOrdered(state.characters, party.id) : []).indexOf(m);
    const handle = party
        ? `<span class="pt-drag" draggable="true" title="Перетащите, чтобы изменить порядок запуска" aria-label="Изменить порядок">⠿</span>
           ${index >= 0 ? `<span class="pt-num" title="Порядок запуска">${index + 1}</span>` : ''}`
        : '';
    return `
        <li class="pt-member party-member-row" data-char-id="${m.id}"${party ? ` data-party-id="${escapeHtml(party.id)}"` : ''}>
            ${handle}
            <span class="pt-ava ${isOnline ? 'is-online' : ''}">${src ? `<img src="${src}" alt="" loading="lazy" />` : escapeHtml(Array.from(m.nick || '?')[0])}</span>
            <span class="pt-member-name"><strong>${escapeHtml(m.nick)}</strong><small class="muted">${escapeHtml(m.class || '')}</small></span>
            ${party && !isMainParty(m, party.id) ? '<span class="pt-badge" title="Для этого персонажа это дополнительная пати: его монеты считаются в основной">доп.</span>' : ''}
            <span class="pt-dot" style="color:${authView.color}" title="${isOnline ? 'Онлайн' : 'Оффлайн'}">${authView.icon}</span>
            <button class="pt-open open-profile-btn" data-char-id="${m.id}" type="button">Открыть</button>
        </li>`;
}

function partyCardHtml(name, members) {
    const isExpanded = expandedParties.has(name);
    const party = partyByName(state.parties, name);
    const activeMembers = members.filter(m => !state.archivedCharacters.some(char => char.id === m.id));
    const archivedCount = members.length - activeMembers.length;
    const stats = calculatePartyStats(activeMembers, party);
    const mainCount = party ? charactersInMainParty(activeMembers, party.id).length : activeMembers.length;
    const activeCountLabel = party && mainCount !== activeMembers.length
        ? `${activeMembers.length} чел. (осн. ${mainCount})`
        : `${activeMembers.length} чел.`;
    const countLabel = `${activeCountLabel}${archivedCount ? ` · ${archivedCount} в архиве` : ''}`;
    const isDraggable = name !== NO_PARTY_LABEL;
    // Считаем тех, кого действительно можно запустить: нужен и GameCenter, и запомненный вход.
// Раньше считалось только наличие GameCenter, и цифра обещала больше, чем запускалось:
// вход без него не запускает (см. preflight), и пользователь удивлялся, где делся персонаж.
// Кнопку из-за нуля не блокируем: она открывает экран проверки, где всё показано и всё чинится.
const launchReady = activeMembers.filter(m => !launchBlocker(m)).length;
    const onlinePct = activeMembers.length ? Math.round(stats.onlineCount / activeMembers.length * 100) : 0;
    const dragAttrs = isDraggable ? `draggable="true" data-drag-name="${escapeHtml(name)}"` : '';
    const style = partyStyleVars(name, party);

    return `
        <article class="party-card-modern pt-card ${isExpanded ? 'is-expanded' : ''} ${isDraggable ? '' : 'is-none'}" data-party-name="${escapeHtml(name)}" style="${style}">
            <header class="party-card-header pt-head ${isDraggable ? 'draggable-area' : ''}" data-party-name="${escapeHtml(name)}" ${dragAttrs}>
                <span class="pt-badge-icon" aria-hidden="true">${isDraggable ? escapeHtml(partyInitials(name)) : '∅'}</span>
                <div class="pt-title">
                    <h3 title="${escapeHtml(name)}">${escapeHtml(name)}</h3>
                    <span class="pt-sub">${countLabel}${activeMembers.length ? ` · онлайн ${stats.onlineCount}` : ''}</span>
                </div>
                <div class="pt-coins" title="Монеты считаются по основной пати персонажей">${stats.totalCoins > 0 ? `${formatCoins(stats.totalCoins)} 🪙` : ''}</div>
                <span class="toggle-arrow pt-arrow" aria-hidden="true"></span>
            </header>
            <div class="pt-glance">
                ${members.length ? avatarStackHtml(members) : '<span class="muted pt-empty-note">Пока никого</span>'}
                <div class="pt-online" title="Онлайн: ${stats.onlineCount} из ${activeMembers.length} активных"><span style="width:${onlinePct}%"></span></div>
            </div>
            <div class="pt-actions">
                <button class="pt-btn pt-btn-launch launch-party-action-btn" type="button" data-party-name="${escapeHtml(name)}" ${activeMembers.length ? '' : 'disabled'}
                        title="${launchReady ? 'Запустить игру для активных участников по очереди (GameCenter выбирается по большинству участников)' : activeMembers.length ? `Готовы к запуску: ${launchReady} из ${activeMembers.length}. Остальным нужен GameCenter и запомненный вход — откроется экран проверки` : 'В пати нет активных персонажей'}">
                    ▶ Запустить <small>${launchReady}/${activeMembers.length}</small>
                </button>
                ${activeMembers.length ? `<button class="pt-btn pt-btn-icon close-party-action-btn" type="button" data-party-name="${escapeHtml(name)}" title="Закрыть окна игры этой пати (откроется список, если запущено больше окон)" aria-label="Закрыть окна игры пати">🛑</button>` : ''}
                ${isDraggable ? `<button class="pt-btn pt-btn-icon edit-party-action-btn" type="button" data-party-name="${escapeHtml(name)}" title="Состав, название и цвет пати">⚙</button>` : ''}
            </div>
            <div class="party-body-wrapper pt-body">
                <div class="pt-body-inner">
                    ${members.length ? `<ul class="pt-members">${members.map(m => memberRowHtml(m, party)).join('')}</ul>` : '<p class="muted pt-empty">Группа пуста. Добавьте персонажей кнопкой ⚙ или через режим «Выбрать» на вкладке «Персонажи».</p>'}
                </div>
            </div>
        </article>`;
}

export function renderPartiesGrid() {
    const container = document.getElementById('party-list');
    if (!container) return;

    document.getElementById('active-party-count')?.replaceChildren(String(state.parties.length));
    const archivedPartyMirrors = state.parties
        .map(party => ({
            party,
            members: charactersInPartyOrdered(state.archivedCharacters, party.id)
        }))
        .filter(item => item.members.length > 0);
    document.getElementById('archived-party-count')?.replaceChildren(String(state.archivedParties.length + archivedPartyMirrors.length));
    document.getElementById('show-active-parties')?.classList.toggle('secondary', !showingPartyArchive);
    document.getElementById('show-active-parties')?.classList.toggle('ghost', showingPartyArchive);
    document.getElementById('show-archived-parties')?.classList.toggle('secondary', showingPartyArchive);
    document.getElementById('show-archived-parties')?.classList.toggle('ghost', !showingPartyArchive);

    if (showingPartyArchive) {
        container._tfDndAbort?.abort();
        const chars = [...state.characters, ...state.archivedCharacters];
        const archivedPartyCards = [
            ...state.archivedParties.map(party => ({ party, members: (party.memberLinks || []).map(link => chars.find(char => char.id === link.characterId)).filter(Boolean), mirror: false })),
            ...archivedPartyMirrors.map(({ party, members }) => ({ party, members, mirror: true }))
        ];
        container.className = 'pt-grid';
        container.innerHTML = archivedPartyCards.length
            ? archivedPartyCards.map(({ party, members, mirror }) => {
                // Цвет задаём и в архиве: иначе `hsl(var(--pt-h) …)` здесь невалиден и карточка
                // остаётся серой, хотя у пати есть и свой выбранный цвет, и оттенок по названию.
                return `<article class="party-card-modern pt-card" style="${partyStyleVars(party.name, party)}">
                    <header class="party-card-header pt-head">
                      <span class="pt-badge-icon" aria-hidden="true">${escapeHtml(partyInitials(party.name))}</span>
                      <div class="pt-title"><h3>${escapeHtml(party.name)}</h3><span class="pt-sub">${members.length} чел. · ${mirror ? 'архивные участники активной пати' : 'пати в архиве'}</span></div>
                    </header>
                    <div class="pt-body-inner"><ul class="pt-members">${members.length
                      ? members.map(char => {
                          const archived = state.archivedCharacters.some(item => item.id === char.id);
                          return `<li class="pt-member${archived ? ' is-archived' : ''}">
                            <span class="pt-member-name"><strong>${escapeHtml(char.nick)}</strong><small class="muted">${escapeHtml(char.class || '')}${archived ? ' · архив' : ''}</small></span>
                            ${mirror ? `<button class="pt-btn restore-archived-member-btn" type="button" data-char-id="${escapeHtml(char.id)}">↩ Восстановить</button>` : ''}
                          </li>`;
                        }).join('')
                      : '<li class="muted">Состав пуст</li>'}</ul></div>
                    ${mirror ? '' : `<div class="pt-actions"><button class="pt-btn restore-party-action-btn" type="button" data-party-id="${escapeHtml(party.id)}">↩ Восстановить пати</button></div>`}
                  </article>`;
            }).join('')
            : '<div class="empty-state">Архив пати пуст.</div>';
        bindPartyArchiveEvents(container);
        return;
    }

    const partyMap = getGroupedParties();

    // Сортировка ключей
    let sortedKeys = Array.from(partyMap.keys()).sort((a, b) => {
        if (a === NO_PARTY_LABEL) return 1;
        if (b === NO_PARTY_LABEL) return -1;

        const partyA = state.parties.find(p => p.name === a);
        const partyB = state.parties.find(p => p.name === b);

        const orderA = partyA?.order ?? Number.MAX_SAFE_INTEGER;
        const orderB = partyB?.order ?? Number.MAX_SAFE_INTEGER;

        if (orderA !== orderB) return orderA - orderB;
        return a.localeCompare(b, 'ru');
    });

    // Сводка над сеткой: общий итог (персонаж из нескольких пати учитывается один раз)
    const summary = document.getElementById('party-summary');
    if (summary) {
        const overall = totalCoins(state.characters);
        const multi = state.characters.filter(c => (c.partyIds || []).length > 1).length;
        summary.innerHTML = `
            <span class="pt-chip">👥 Персонажей <b>${state.characters.length}</b></span>
            <span class="pt-chip">🛡 Пати <b>${state.parties.length}</b></span>
            <span class="pt-chip pt-chip-gold">🪙 <b>${formatCoins(overall)}</b></span>
            ${multi ? `<span class="pt-chip" title="Монеты таких персонажей считаются только по основной пати">В нескольких пати: <b>${multi}</b></span>` : ''}`;
    }

    if (sortedKeys.length === 0) {
        container.className = 'pt-grid';
        container.innerHTML = state.archivedParties.length
            ? '<div class="empty-state">Активных пати нет. Переключитесь на «Архив», чтобы посмотреть или восстановить архивные пати.</div>'
            : '<div class="empty-state">Пока нет пати. Нажмите «+» справа внизу, чтобы создать первую.</div>';
        return;
    }

    container.className = 'pt-grid';
    container.innerHTML = sortedKeys.map(name => partyCardHtml(name, partyMap.get(name))).join('');

    bindPartyEvents(container);
    // Контейнер `#party-list` живёт всё время, а перерисовка вызывается часто. Обработчики drag-and-drop
    // вешаются через addEventListener, поэтому без снятия старых они копились: после нескольких
    // перерисовок один `drop` запускал десятки сохранений и перерисовок, каждая из которых добавляла
    // ещё обработчики, — приложение зависало (hotfix 1.0.1)
    const signal = resetDndBindings(container);
    initDragAndDrop(container, signal);
    initMemberDrag(container, signal);
}

export function setPartyArchiveView(archived) {
    showingPartyArchive = archived;
    renderPartiesGrid();
}

function bindPartyArchiveEvents(container) {
    container.onclick = async event => {
        const memberButton = event.target.closest('.restore-archived-member-btn');
        if (memberButton) {
            memberButton.disabled = true;
            try {
                const { restoreCharacter } = await import('../archive/archive.js');
                await restoreCharacter(memberButton.dataset.charId);
            } catch (error) {
                console.error('[ARCHIVE] Archived party member restore failed:', error);
                toast(`Не удалось восстановить персонажа: ${error?.message || error}`, 'error');
            } finally {
                memberButton.disabled = false;
            }
            return;
        }
        const button = event.target.closest('.restore-party-action-btn');
        if (!button) return;
        button.disabled = true;
        try {
            const { restoreParty } = await import('../archive/archive.js');
            await restoreParty(button.dataset.partyId);
        } catch (error) {
            console.error('[ARCHIVE] Party restore failed:', error);
            toast(`Не удалось восстановить пати: ${error?.message || error}`, 'error');
        } finally {
            button.disabled = false;
        }
    };
}

/**
 * Снимает обработчики прошлой отрисовки и возвращает сигнал для новых.
 * @param {HTMLElement & { _tfDndAbort?: AbortController }} container
 * @returns {AbortSignal}
 */
function resetDndBindings(container) {
    container._tfDndAbort?.abort();
    container._tfDndAbort = new AbortController();
    return container._tfDndAbort.signal;
}

/**
 * Перетаскивание персонажей внутри пати: задаёт порядок запуска игры.
 * Порядок сохраняется у персонажа (`char.partyOrder`) и переживает перезапуск приложения.
 *
 * Куда встанет персонаж, зависит от половины строки, на которую навели: верхняя половина —
 * перед ней, нижняя — после. Поэтому перетаскивание на соседнюю строку сдвигает на одну
 * позицию, а не переносит в конец списка.
 */
function initMemberDrag(container, signal) {
    let draggedId = null;
    let draggedPartyId = null;
    /** Над какой строкой сейчас курсор и в какую её половину — от этого зависит место вставки. */
    let dropTarget = null;

    const clearMarks = () => container.querySelectorAll('.pt-member-over, .pt-member-over-after').forEach(el => {
        el.classList.remove('pt-member-over', 'pt-member-over-after');
    });

    container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest?.('.pt-drag');
        if (!handle) return;
        const row = handle.closest('.pt-member');
        if (!row) return;
        draggedId = row.dataset.charId;
        draggedPartyId = row.dataset.partyId;
        row.classList.add('pt-member-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
        e.stopPropagation();   // иначе начнётся перетаскивание самой карточки пати
    }, { signal });

    container.addEventListener('dragend', () => {
        draggedId = null;
        draggedPartyId = null;
        dropTarget = null;
        container.querySelectorAll('.pt-member-dragging').forEach(el => el.classList.remove('pt-member-dragging'));
        clearMarks();
    }, { signal });

    container.addEventListener('dragover', (e) => {
        if (!draggedId) return;
        const row = e.target.closest?.('.pt-member');
        // Перетаскивать можно только внутри своей пати
        if (!row || row.dataset.partyId !== draggedPartyId || row.dataset.charId === draggedId) return;
        e.preventDefault();
        e.stopPropagation();
        // Нижняя половина строки — вставка после неё, верхняя — перед ней
        const box = row.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        if (dropTarget?.row === row && dropTarget.after === after) return;
        clearMarks();
        row.classList.add(after ? 'pt-member-over-after' : 'pt-member-over');
        dropTarget = { row, after };
    }, { signal });

    container.addEventListener('drop', async (e) => {
        if (!draggedId) return;
        const row = e.target.closest?.('.pt-member');
        if (!row || row.dataset.partyId !== draggedPartyId || row.dataset.charId === draggedId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const box = row.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        const partyId = draggedPartyId;
        const fromId = draggedId;
        const changed = movePartyMember(state.characters, partyId, fromId, row.dataset.charId, { after });
        draggedId = null;
        draggedPartyId = null;
        dropTarget = null;
        if (!changed) return;
        // Порядок — часть данных персонажа: сохраняем сразу, чтобы он пережил перезапуск
        const now = new Date().toISOString();
        for (const c of state.characters) {
            if (c.partyOrder?.[partyId]) c.updatedAt = now;
        }
        await persist();
        renderPartiesGrid();
    }, { signal });
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

            // Стрелка и раскрытие списка — чисто через CSS по классу is-expanded
            card.classList.toggle('is-expanded', !isCurrentlyExpanded);
            if (isCurrentlyExpanded) expandedParties.delete(name);
            else expandedParties.add(name);
            
            return;
        }

        // 1a. Клик по кнопке "Запустить пати"
        const launchBtn = target.closest('.launch-party-action-btn');
        if (launchBtn) {
            e.stopPropagation();
            const name = launchBtn.dataset.partyName;
            const party = partyByName(state.parties, name);
            // Именно `charactersInPartyOrdered`, а не `charactersInParty`: карточка пати нарисована
            // в порядке перетаскивания, и запускать надо в том же порядке. Раньше здесь брался сырой
            // список из состояния — окна открывались в другой последовательности, чем на экране.
            const members = party
                ? charactersInPartyOrdered(state.characters, party.id)
                : state.characters.filter(c => hasNoParty(c, state.parties));
            import('../launcher/partyLaunch.js').then(m => m.launchGroup(`Запуск игры: ${name}`, members));
            return;
        }

        // 1b. Клик по кнопке "Закрыть окна пати": закрывает окна участников этой пати
        const closeBtn = target.closest('.close-party-action-btn');
        if (closeBtn) {
            e.stopPropagation();
            import('../launcher/partyLaunch.js').then(m => m.closePartyWindows(closeBtn.dataset.partyName));
            return;
        }

        // 2. Клик по кнопке "Настроить" (название, состав, цвет, архив)
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
function initDragAndDrop(container, signal) {
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
    }, { signal });

    // 2. Конец перетаскивания (очистка всего)
    container.addEventListener('dragend', () => {
        if (draggedElement) {
            draggedElement.classList.remove('party-card-dragging');
            draggedElement = null;
            draggedName = null;
        }
        // Удаляем подсветку со всех возможных целей
        document.querySelectorAll('.party-card-drop-target').forEach(el => el.classList.remove('party-card-drop-target'));
    }, { signal });

    // 3. Наведение на другую карточку (Критически важный момент)
    container.addEventListener('dragover', (e) => {
        // Перетаскивание персонажа внутри пати сюда не относится
        if (!draggedName) return;
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
    }, { signal });

    // 4. Уход мыши с области (опционально, для чистоты)
    container.addEventListener('dragleave', (e) => {
        // Проверяем, что мы действительно покинули контейнер, а не просто вошли в его дочерний элемент
        if (!container.contains(e.relatedTarget)) {
             document.querySelectorAll('.party-card-drop-target').forEach(el => el.classList.remove('party-card-drop-target'));
        }
    }, { signal });

    // 5. Бросок (Drop)
    container.addEventListener('drop', async (e) => {
        e.preventDefault(); // Запрещаем стандартное поведение браузера
        
        // Получаем имя перетаскиваемого объекта из данных
        // Имя берём из состояния перетаскивания: в dataTransfer при переносе персонажа лежит его id
        const sourceName = draggedName;
        if (!sourceName) return;

        // Находим целевую карточку
        const targetCard = e.target.closest('.party-card-modern');
        if (!targetCard) return;

        const targetName = targetCard.dataset.partyName;

        // Проверки безопасности
        if (targetName === sourceName) return; // Бросили на себя же
        if (targetName === NO_PARTY_LABEL) return; // Нельзя менять местами "Без пати"
        if (sourceName === NO_PARTY_LABEL) return; // На всякий случай

        console.log(`[DND] Swapping "${sourceName}" with "${targetName}"`);

        // Выполняем обмен
        await swapPartyOrder(sourceName, targetName);
    }, { signal });
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