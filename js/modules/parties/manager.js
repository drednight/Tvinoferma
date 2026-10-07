// js/modules/parties/manager.js

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { showModal, toast, confirmModal, closeModal } from '../../core/ui.js';
import { escapeHtml, uid } from '../../core/utils.js';
import { renderCharacters } from '../characters/list.js';
import { renderPartiesGrid } from './renderer.js';
import { getAuthView } from '../sync/authStatus.js';
import { partyByName, charactersInParty, isInParty, isMainParty, setMembership } from './membership.js';

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
 * Комплексное редактирование пати: имя, состав, удаление
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
            
            <!-- Опасная зона -->
            <div style="border-top:1px solid var(--border); padding-top:10px; margin-top:10px;">
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
            party.updatedAt = now;

            persist().then(() => {
                renderPartiesGrid();
                renderCharacters();
                toast('Пати обновлена.', 'success');
            });

            return true;
        }
    });

    // Обработчик удаления всей группы
    setTimeout(() => {
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
    }, 100);
}