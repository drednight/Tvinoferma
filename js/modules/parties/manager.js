// js/modules/parties/manager.js

import { state, normalizePartyColor } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { showModal, toast, confirmModal, closeModal } from '../../core/ui.js';
import { escapeHtml, uid } from '../../core/utils.js';
import { renderCharacters } from '../characters/list.js';
import { renderPartiesGrid, partyInitials } from './renderer.js';
import { getAuthView } from '../sync/authStatus.js';
import { partyByName, charactersInParty, isInParty, isMainParty, setMembership } from './membership.js';
import { PARTY_COLORS, hexToHsl, hslToHex, partyHue } from './color.js';

/**
 * Открывает модальное окно для создания новой пати
 */
export function openCreatePartyModal() {
    const content = `
        <div class="field">
            <label>Название новой группы</label>
            <input class="input" id="create-party-name-input" placeholder="Например: Main Squad" autofocus />
        </div>
    `;

    showModal({
        title: 'Создать группу',
        content,
        submitText: 'Создать',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
            const nameInput = document.getElementById('create-party-name-input');
            const name = String(nameInput.value || '').trim();

            if (!name) {
                setError('Введите название.');
                return false;
            }
            
            if (partyByName([...state.parties, ...state.archivedParties], name)) {
                setError('Такая группа уже существует.');
                return false;
            }

            // В js/parties/manager.js внутри openCreatePartyModal -> onSubmit
            state.parties.push({
                id: uid(),
                name: name,
                order: state.parties.length + 1, // Новый элемент получает следующий порядковый номер
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            persist().then(() => {
                renderPartiesGrid();
                toast(`Группа "${name}" создана.`, 'success');
            });

            return true;
        }
    });
}

/**
 * Выбор цвета пати (кнопка 🎨 в карточке пати).
 *
 * Зачем: просьба пользователей — красить пати в свои цвета, а не только в автоматический оттенок
 * от названия. Вид карточки не меняется: выбранный цвет подставляется в те же переменные
 * `--pt-h/--pt-s/--pt-l`, что и автоматический оттенок (см. `partyStyleVars` в renderer.js).
 *
 * @param {string} currentName название пати
 */
/**
 * Поле «Цвет пати» для окна настроек пати: палитра, свой цвет и возврат к оттенку по названию.
 *
 * Сделано частью настроек, а не отдельным окном: раньше цвет выбирался кнопкой 🎨 прямо
 * в карточке, и настройки пати о нём ничего не знали. Теперь всё, что можно сделать с пати,
 * собрано в одном месте.
 *
 * @param {string} currentName название пати
 * @param {{ color?: string | null }} party
 * @returns {string} разметка поля
 */
export function partyColorFieldHtml(currentName, party) {
    const current = normalizePartyColor(party?.color);
    // Текущий оттенок по названию — «начальное значение», пока свой цвет не выбран
    const auto = hslToHex({ h: partyHue(currentName), s: 70, l: 65 });
    const initial = current || auto;
    const previewHsl = hexToHsl(initial) || { h: 220, s: 70, l: 65 };

    const swatches = PARTY_COLORS.map(color => `
        <button type="button" class="ptc-swatch${color === current ? ' is-on' : ''}"
                style="--c:${color}" data-color="${color}"
                title="${color}" aria-label="Цвет ${color}"></button>`).join('');

    return `
        <div class="ptc" data-party-color>
            <label class="ptc-label">Цвет карточки пати</label>
            <div class="ptc-row">
                <label class="ptc-native">
                    <input type="color" id="ptc-native" value="${initial}" aria-label="Свой цвет" />
                    <span>Свой цвет</span>
                </label>
                <input class="input ptc-hex" id="ptc-hex" value="${current || ''}" placeholder="по названию" maxlength="7" spellcheck="false" />
                <button type="button" class="btn ghost small" id="ptc-reset" ${current ? '' : 'disabled'}>По названию</button>
            </div>
            <div class="ptc-swatches">${swatches}</div>
            <div class="ptc-preview" id="ptc-preview" style="--pt-h:${previewHsl.h};--pt-s:${previewHsl.s}%;--pt-l:${previewHsl.l}%">
                <span class="ptc-preview-stripe"></span>
                <span class="ptc-preview-badge">${escapeHtml(partyInitials(currentName))}</span>
                <span class="ptc-preview-text">${escapeHtml(currentName)}</span>
            </div>
            <small class="muted">Меняется полоска, значок и подсветка карточки. Без своего цвета берётся оттенок от названия пати.</small>
        </div>`;
}

/**
 * Живой предпросмотр поля цвета: выбор сразу видно в «образце» карточки.
 *
 * `showModal` собирает окно синхронно, поэтому обработчики вешаем сразу — без setTimeout,
 * иначе первые касания окна (и тесты) остались бы без реакции. Само значение цвета при
 * сохранении читается из поля напрямую (см. `openEditPartyModal`), а не отсюда.
 *
 * @param {HTMLElement} root где искать поле (`#modal-root`)
 */
export function bindPartyColorField(root) {
    const field = root?.querySelector('[data-party-color]');
    if (!field) return;
    const hexInput = /** @type {HTMLInputElement | null} */ (field.querySelector('#ptc-hex'));
    const native = /** @type {HTMLInputElement | null} */ (field.querySelector('#ptc-native'));
    const preview = /** @type {HTMLElement | null} */ (field.querySelector('#ptc-preview'));
    const reset = /** @type {HTMLButtonElement | null} */ (field.querySelector('#ptc-reset'));
    if (!hexInput || !native || !preview) return;

    const paint = (value) => {
        const hsl = hexToHsl(value);
        if (!hsl) return;
        preview.style.setProperty('--pt-h', String(hsl.h));
        preview.style.setProperty('--pt-s', `${hsl.s}%`);
        preview.style.setProperty('--pt-l', `${hsl.l}%`);
    };
    /** Выбран конкретный цвет: поле, образец и предпросмотр показывают одно и то же. */
    const pick = (value) => {
        hexInput.value = value;
        native.value = value;
        paint(value);
        field.querySelectorAll('.ptc-swatch').forEach(s =>
            s.classList.toggle('is-on', s.dataset.color === value));
    };

    native.addEventListener('input', () => pick(native.value));
    hexInput.addEventListener('input', () => {
        const v = hexInput.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) pick(v.toLowerCase());
    });
    field.querySelectorAll('.ptc-swatch').forEach(s => {
        s.addEventListener('click', () => pick(/** @type {string} */ (s.dataset.color)));
    });
    // «По названию»: поле очищается — по нему при сохранении и узнаётся, что цвет сброшен
    reset?.addEventListener('click', () => {
        hexInput.value = '';
        paint(native.value);
        field.querySelectorAll('.ptc-swatch').forEach(s => s.classList.remove('is-on'));
    });
}

/**
 * Комплексное редактирование пати: название, состав, цвет и архив.
 *
 * Раньше цвет (кнопка 🎨) и архив (📦) жили прямо в карточке пати, а в настройках о них
 * ничего не было. Теперь всё, что можно сделать с пати, в одном окне: карточка оставила
 * только «Запустить», «Закрыть окна» и «Настроить».
 */
export function openEditPartyModal(currentName) {
    const party = partyByName(state.parties, currentName);
    if (!party) { toast('Пати не найдена.', 'error'); return; }
    const currentMembers = charactersInParty(state.characters, party.id);
    
    // Для простоты UX: показываем всех персонажей с чекбоксами.
    // Те, кто в группе — отмечены. Снятие галочки убирает из группы.
    const allCharsForCheckbox = state.characters.map(c => {
        const isInCurrentGroup = isInParty(c, party.id);
        const statusIcon = getAuthView(c).icon;
        return `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.1);">
                <input type="checkbox" class="member-checkbox" data-char-id="${c.id}" ${isInCurrentGroup ? 'checked' : ''} />
                <span>${statusIcon} <strong>${escapeHtml(c.nick)}</strong> <small class="muted">(${escapeHtml(c.class)})</small>${isInCurrentGroup ? (isMainParty(c, party.id) ? ' <small class="muted">· основная</small>' : ' <small class="muted">· доп.</small>') : ''}</span>
            </label>
        `;
    }).join('');

    const content = `
        <div style="display:flex; flex-direction:column; gap:15px;">
            
            <!-- 1. Название -->
            <div class="field">
                <label>Новое название группы</label>
                <input class="input" id="edit-party-name-input" value="${escapeHtml(currentName)}" />
            </div>

            <!-- 2. Состав -->
            <div>
                <label style="display:block; margin-bottom:8px; font-weight:bold;">Состав группы (${currentMembers.length} чел.)</label>
                <p class="muted" style="font-size:0.8rem; margin-bottom:8px;">Отметьте галочкой тех, кто должен быть в этой группе. У персонажа одна основная пати (по ней считаются монеты) и сколько угодно дополнительных; основную меняют в карточке персонажа.</p>
                
                <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border); padding: 8px; border-radius: 4px; background: var(--panel-2);">
                    ${allCharsForCheckbox}
                </div>
            </div>

            <!-- 3. Цвет карточки -->
            ${partyColorFieldHtml(currentName, party)}
            
            <!-- Опасная зона -->
            <div class="pt-danger">
                 <button id="archive-this-party-btn" class="btn outline" style="width:100%;">
                    📦 Переместить в архив (состав сохранится, её можно вернуть)
                 </button>
                 <button id="delete-this-party-btn" class="btn danger outline" style="width:100%;">
                    🗑 Удалить эту группу (участники останутся в других группах)
                 </button>
            </div>
        </div>
    `;

    showModal({
        title: `Настройка: ${currentName}`,
        content,
        submitText: 'Сохранить изменения',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
            const newNameInput = document.getElementById('edit-party-name-input');
            const newName = String(newNameInput.value || '').trim();

            if (!newName) {
                setError('Название не может быть пустым.');
                return false;
            }

            // Проверка дубликата имени
            if (newName.toLowerCase() !== currentName.toLowerCase()) {
                if (partyByName(state.parties, newName)) {
                    setError('Такая группа уже существует.');
                    return false;
                }
            }

            const checkboxes = document.querySelectorAll('.member-checkbox');
            const now = new Date().toISOString();

            // Состав: добавляем/убираем только эту пати, остальные пати персонажа не трогаем
            checkboxes.forEach(cb => {
                const char = state.characters.find(c => c.id === cb.dataset.charId);
                if (char && setMembership(char, party.id, cb.checked)) char.updatedAt = now;
            });

            // Переименование меняет только название: персонажи ссылаются на id
            party.name = newName;
            // Цвет читаем из поля при сохранении, а не по событию ввода: так он сохранится
            // и если значение подставилось мимо события (вставка, автозаполнение).
            // Пусто или некорректное значение = вернуть автоматический оттенок по названию.
            const hex = String(document.getElementById('ptc-hex')?.value || '').trim();
            party.color = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
            party.updatedAt = now;

            persist().then(() => {
                renderPartiesGrid();
                renderCharacters();
                toast('Пати обновлена.', 'success');
            });

            return true;
        }
    });

    // Живой предпросмотр цвета: пока пользователь выбирает, образец карточки меняется сразу.
    // Окно собрано синхронно, поэтому обработчики можно вешать сразу — без setTimeout.
    bindPartyColorField(document.getElementById('modal-root'));

    // Обработчики опасных зон: перенос в архив и удаление.
    // Назначаем сразу, без setTimeout: showModal собирает окно синхронно, а отложенное
    // назначение оставляло кнопки «мёртвыми» на первом касании.
    const archiveBtn = document.getElementById('archive-this-party-btn');
    if (archiveBtn) {
        archiveBtn.onclick = async () => {
            const ok = await confirmModal({
                title: `Переместить «${currentName}» в архив?`,
                text: 'Пати уберётся из активного списка, состав сохранится. Вернуть её можно из раздела «Архив» на вкладке «Пати».',
                okText: 'В архив'
            });
            if (!ok) return;
            // Закрываем настройки до архивации: после archiveParty пати в списке уже нет,
            // и оставшееся окно настроек выглядело бы как ошибка.
            closeModal();
            try {
                const { archiveParty } = await import('../archive/archive.js');
                await archiveParty(party.id);
            } catch (error) {
                console.error('[ARCHIVE] Party archive failed:', error);
                toast(`Не удалось переместить пати в архив: ${error?.message || error}`, 'error');
            }
        };
    }
    const delBtn = document.getElementById('delete-this-party-btn');
    if (delBtn) {
        delBtn.onclick = async () => {
            const ok = await confirmModal({
                title: `Удалить группу «${currentName}»?`,
                text: 'Все участники станут без пати. Персонажи, их монеты и марафоны не меняются.',
                okText: 'Удалить группу',
                danger: true
            });
            if (ok) {
                state.parties = state.parties.filter(p => p.id !== party.id);
                const now = new Date().toISOString();
                [...state.characters, ...state.archivedCharacters].forEach(c => {
                    if (setMembership(c, party.id, false)) c.updatedAt = now;
                });
                persist().then(() => {
                    closeModal();
                    renderPartiesGrid();
                    renderCharacters();
                    toast('Группа удалена.', 'success');
                });
            }
        };
    }
}