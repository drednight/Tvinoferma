// js/parties/manager.js

import { state } from '../state.js';
import { persist } from '../storage.js';
import { showModal, toast, confirmDialog, closeModal } from '../ui.js';
import { escapeHtml, uid } from '../utils.js';
import { renderCharacters } from '../characters.js';
import { renderPartiesGrid } from './renderer.js';

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
            
            const existsInParties = state.parties.some(p => p.name.toLowerCase() === name.toLowerCase());
            const existsInChars = state.characters.some(c => c.party && c.party.toLowerCase() === name.toLowerCase());

            if (existsInParties || existsInChars) {
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
    const currentMembers = state.characters.filter(c => c.party === currentName);
    
    // Для простоты UX: показываем всех персонажей с чекбоксами.
    // Те, кто в группе — отмечены. Снятие галочки убирает из группы.
    const allCharsForCheckbox = state.characters.map(c => {
        const isInCurrentGroup = c.party === currentName;
        const statusIcon = c.isLoggedIn ? '🟢' : '🔴';
        return `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.1);">
                <input type="checkbox" class="member-checkbox" data-char-id="${c.id}" ${isInCurrentGroup ? 'checked' : ''} />
                <span>${statusIcon} <strong>${escapeHtml(c.nick)}</strong> <small class="muted">(${c.class})</small></span>
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
                <p class="muted" style="font-size:0.8rem; margin-bottom:8px;">Отметьте галочкой тех, кто должен быть в этой группе.</p>
                
                <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border); padding: 8px; border-radius: 4px; background: var(--panel-2);">
                    ${allCharsForCheckbox}
                </div>
            </div>
            
            <!-- Опасная зона -->
            <div style="border-top:1px solid var(--border); padding-top:10px; margin-top:10px;">
                 <button id="delete-this-party-btn" class="btn danger outline" style="width:100%;">
                    🗑 Удалить эту группу (все участники станут "Без пати")
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
            if (newName !== currentName) {
                const exists = state.parties.some(p => p.name.toLowerCase() === newName.toLowerCase()) ||
                               state.characters.some(c => c.party && c.party.toLowerCase() === newName.toLowerCase());
                if (exists) {
                    setError('Такая группа уже существует.');
                    return false;
                }
            }

            const checkboxes = document.querySelectorAll('.member-checkbox');
            
            // Обновляем состояние персонажей
            checkboxes.forEach(cb => {
                const charId = cb.dataset.charId;
                const charIndex = state.characters.findIndex(c => c.id === charId);
                
                if (charIndex !== -1) {
                    const char = state.characters[charIndex];
                    
                    if (cb.checked) {
                        char.party = newName;
                    } else {
                        // Если был в старой группе, а сейчас сняли галочку -> убираем из группы
                        if (char.party === currentName) {
                            char.party = null; 
                        }
                    }
                    char.updatedAt = new Date().toISOString();
                }
            });

            // Обновляем запись о группе
            let partyObj = state.parties.find(p => p.name === currentName);
            if (partyObj) {
                partyObj.name = newName;
                partyObj.updatedAt = new Date().toISOString();
            } else {
                state.parties.push({
                    id: uid(),
                    name: newName,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }

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
            delBtn.onclick = () => {
                if (confirmDialog(`Удалить группу "${currentName}"?\nВсе участники станут без пати.`)) {
                    state.parties = state.parties.filter(p => p.name !== currentName);
                    state.characters.forEach(c => {
                        if (c.party === currentName) {
                            c.party = null;
                            c.updatedAt = new Date().toISOString();
                        }
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