// js/parties.js

import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml, uid } from './utils.js';
import { showModal, toast, confirmDialog } from './ui.js';
import { renderCharacters } from './characters.js'; 

// Хранилище состояния раскрытых групп (Set для быстрого поиска)
let expandedParties = new Set();

export function renderParties() {
  const listEl = document.getElementById('party-list');
  if (!listEl) return;

  // 1. Группируем персонажей по партиям
  const partyMap = new Map();
  
  // Инициализация известных групп
  state.parties.forEach(p => {
    if (!partyMap.has(p.name)) partyMap.set(p.name, []);
  });

  // Распределение персонажей
  state.characters.forEach(char => {
    const pName = char.party || 'Без пати';
    if (!partyMap.has(pName)) partyMap.set(pName, []);
    partyMap.get(pName).push(char);
  });

  // Сортировка ключей
  let sortedKeys = Array.from(partyMap.keys()).sort((a, b) => {
    if (a === 'Без пати') return 1;
    if (b === 'Без пати') return -1;
    return a.localeCompare(b, 'ru');
  });

  if (sortedKeys.length === 0) {
    listEl.innerHTML = '<div class="empty-state">Нет активных партий.</div>';
    return;
  }

  // 2. Генерация HTML
  listEl.innerHTML = sortedKeys.map(name => {
    const members = partyMap.get(name);
    const isExpanded = expandedParties.has(name);
    const isNoParty = name === 'Без пати';
    
    // Список участников (виден только если isExpanded true)
    const membersContent = isExpanded ? `
      <ul class="party-members-ul" style="list-style:none; padding:0; margin:0; border-top:1px solid var(--border); background:var(--panel-2);">
        ${members.length > 0 ? members.map(m => `
          <li class="member-item" data-char-id="${m.id}" style="display:flex; justify-content:space-between; align-items:center; padding:8px 16px; cursor:pointer; transition:background 0.2s; border-bottom:1px solid rgba(255,255,255,0.05);">
            <div>
              <strong style="color:var(--text-primary);">${escapeHtml(m.nick)}</strong>
              <small class="muted" style="margin-left:8px;">${escapeHtml(m.class)} • Ур.${m.level}</small>
            </div>
            <span style="color:var(--accent); font-size:0.9rem;">Открыть →</span>
          </li>
        `).join('') : '<li style="padding:12px 16px; color:var(--muted); text-align:center;">Группа пуста</li>'}
      </ul>
    ` : '';

    return `
      <article class="card party-card-expandable" data-party-name="${escapeHtml(name)}" style="margin-bottom:12px; border-radius:var(--radius); overflow:hidden; border:1px solid var(--border); background:var(--panel); box-shadow:0 2px 5px rgba(0,0,0,0.1);">
        
        <!-- Заголовок (Кликабельный) -->
        <header class="party-header" style="padding:12px 16px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none; background:${isExpanded ? 'var(--panel-3)' : 'transparent'}; transition:background 0.2s;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="toggle-icon" style="font-size:1.2rem; transition:transform 0.2s; transform:rotate(${isExpanded ? '90deg' : '0deg'});">▶</span>
            <h3 style="margin:0; font-size:1.1rem; color:${isNoParty ? 'var(--muted)' : 'var(--accent)'};">
              ${escapeHtml(name)}
            </h3>
            <span class="badge muted" style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:0.75rem;">
              ${members.length} чел.
            </span>
          </div>
          
          <div style="display:flex; gap:8px;" onclick="event.stopPropagation()">
             ${!isNoParty ? `
               <button class="btn ghost small edit-party-btn" data-name="${escapeHtml(name)}" title="Переименовать">✏️</button>
               <button class="btn danger small delete-party-btn" data-name="${escapeHtml(name)}" title="Удалить">🗑</button>
             ` : ''}
             <button class="btn primary small add-member-to-party-btn" data-name="${escapeHtml(name)}" title="Добавить участника">➕</button>
          </div>
        </header>

        <!-- Тело (Раскрываемая часть) -->
        <div class="party-body" style="max-height:${isExpanded ? '500px' : '0'}; overflow-y:auto; transition:max-height 0.3s ease-out; opacity:${isExpanded ? '1' : '0'};">
           ${membersContent}
        </div>

      </article>
    `;
  }).join('');

  bindPartyEvents(listEl);
}

function bindPartyEvents(container) {
  container.onclick = async (e) => {
    const target = e.target;

    // 1. Клик по заголовку группы (Toggle Expand/Collapse)
    const header = target.closest('.party-header');
    if (header && !target.closest('button')) {
      const card = header.closest('.party-card-expandable');
      const name = card.dataset.partyName;
      
      if (expandedParties.has(name)) {
        expandedParties.delete(name);
      } else {
        expandedParties.add(name);
      }
      
      renderParties(); // Перерисовываем для анимации и обновления DOM
      return;
    }

    // 2. Клик по строке персонажа (ОТКРЫТЬ ПРОФИЛЬ ПЕРСОНАЖА)
    const memberItem = target.closest('.member-item');
    if (memberItem) {
      const charId = memberItem.dataset.charId;
      
      try {
         // Динамически импортируем модуль персонажей, чтобы избежать циклической зависимости при старте
         const mod = await import('./characters.js');
         
         // Находим функцию открытия профиля
         if (typeof mod.openCharacterProfile === 'function') {
            const char = state.characters.find(c => c.id === charId);
            if (char) {
               mod.openCharacterProfile(char);
            } else {
               toast('Персонаж не найден', 'error');
            }
         } else {
            console.warn('[PARTIES] openCharacterProfile not found in characters.js');
            toast('Функция просмотра недоступна', 'warning');
         }
      } catch (err) {
         console.error('[PARTIES] Error opening character profile:', err);
         toast('Ошибка при открытии профиля', 'error');
      }
      return;
    }

    // 3. Кнопка "Добавить участника"
    const addMemberBtn = target.closest('.add-member-to-party-btn');
    if (addMemberBtn) {
      e.stopPropagation();
      const partyName = addMemberBtn.dataset.name;
      openAddMemberModal(partyName);
      return;
    }

    // 4. Кнопка "Переименовать"
    const renameBtn = target.closest('.edit-party-btn');
    if (renameBtn) {
      e.stopPropagation();
      openRenamePartyModal(renameBtn.dataset.name);
      return;
    }

    // 5. Кнопка "Удалить группу"
    const deleteBtn = target.closest('.delete-party-btn');
    if (deleteBtn) {
      e.stopPropagation();
      handleDeleteParty(deleteBtn.dataset.name);
      return;
    }
  };
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Same as before) ---

function handleDeleteParty(nameToDelete) {
   if (confirmDialog(`Удалить группу "${nameToDelete}"?\nВсе участники станут без пати.`)) {
      state.parties = state.parties.filter(p => p.name !== nameToDelete);
      state.characters.forEach(c => {
        if (c.party === nameToDelete) {
          c.party = null; 
          c.updatedAt = new Date().toISOString();
        }
      });
      persist().then(() => {
        renderParties();
        renderCharacters(); 
        toast(`Группа удалена`, 'success');
      });
   }
}

function openAddMemberModal(currentPartyName) {
  const availableChars = state.characters.filter(c => c.party !== currentPartyName);
  
  if (availableChars.length === 0) {
     toast('Все персонажи уже распределены.', 'info');
     return;
  }

  const content = `
    <div class="form-grid">
      <p class="muted">Выберите персонажей для добавления в <strong>${escapeHtml(currentPartyName)}</strong>:</p>
      <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border); padding: 8px; border-radius: 4px; background: var(--panel-2);">
        ${availableChars.map(c => `
          <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.1);">
            <input type="checkbox" value="${c.id}" />
            <span><strong>${escapeHtml(c.nick)}</strong> <small class="muted">(${c.party || 'Без пати'})</small></span>
          </label>
        `).join('')}
      </div>
    </div>
  `;

  showModal({
    title: 'Добавить участников',
    content,
    submitText: 'Добавить выбранных',
    onSubmit(formData, { setError }) {
      const checkboxes = document.querySelectorAll('#modal-root input[type="checkbox"]:checked');
      const idsToAdd = Array.from(checkboxes).map(cb => cb.value);

      if (idsToAdd.length === 0) {
        setError('Не выбрано ни одного персонажа.');
        return false;
      }

      idsToAdd.forEach(id => {
        const char = state.characters.find(c => c.id === id);
        if (char) {
          char.party = currentPartyName;
          char.updatedAt = new Date().toISOString();
        }
      });

      persist().then(() => {
        renderParties();
        renderCharacters();
        toast(`Добавлено ${idsToAdd.length} участников.`, 'success');
      });

      return true;
    }
  });
}

function openRenamePartyModal(oldName) {
  const content = `
    <div class="field">
      <label>Новое название группы</label>
      <input class="input" id="new-party-name" value="${escapeHtml(oldName)}" autofocus />
    </div>
  `;

  showModal({
    title: 'Переименовать группу',
    content,
    submitText: 'Сохранить',
    onSubmit(formData, { setError }) {
      const newName = String(document.getElementById('new-party-name').value || '').trim();
      if (!newName) { setError('Название пустое.'); return false; }
      if (newName === oldName) return true;

      const exists = state.parties.some(p => p.name.toLowerCase() === newName.toLowerCase()) || 
                     state.characters.some(c => c.party && c.party.toLowerCase() === newName.toLowerCase());
      
      if (exists && newName !== oldName) {
         setError('Такая группа уже существует.');
         return false;
      }

      state.characters.forEach(c => {
        if (c.party === oldName) {
          c.party = newName;
          c.updatedAt = new Date().toISOString();
        }
      });

      const partyObj = state.parties.find(p => p.name === oldName);
      if (partyObj) {
        partyObj.name = newName;
        partyObj.updatedAt = new Date().toISOString();
      } else {
        state.parties.push({ id: uid(), name: newName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }

      persist().then(() => {
        renderParties();
        renderCharacters();
        toast('Группа переименована.', 'success');
      });

      return true;
    }
  });
}

export function bindParties() {
  const addBtn = document.getElementById('add-party-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
       const content = `<div class="field"><label>Название новой группы</label><input class="input" id="create-party-name" placeholder="Alpha Strike" /></div>`;
       showModal({
         title: 'Создать группу',
         content,
         submitText: 'Создать',
         onSubmit(fD, {setError}) {
           const name = String(document.getElementById('create-party-name').value||'').trim();
           if(!name){setError('Введите название');return false;}
           if(state.parties.some(p=>p.name===name)){setError('Есть такая');return false;}
           
           state.parties.push({id:uid(), name, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()});
           persist().then(()=>{renderParties(); toast('Создано','success');});
           return true;
         }
       });
    });
  }
  renderParties();
}