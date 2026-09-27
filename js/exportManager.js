// js/exportManager.js

import { state } from './state.js';
import { showModal, toast } from './ui.js';
import { escapeHtml } from './utils.js';

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export function openExportDialog() {
  // Состояние мастера
  let selectedTypes = new Set(['marathons', 'characters']);
  let selectedMarathonIds = new Set();
  let selectedPartyNames = new Set();
  let selectedCharacterIds = new Set(); 
  let partySelectedCharacters = {}; 

  const allMarathons = [...state.marathons].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  const partiesSet = new Set(state.characters.map(c => c.party).filter(Boolean));
  const allParties = Array.from(partiesSet);
  
  const allCharacters = [...state.characters].sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));

  const contentTemplate = () => `
    <div class="form-grid">
      
      <!-- ШАГ 1: ТИПЫ ДАННЫХ -->
      <h4 style="margin-top:0;">1. Выберите типы данных</h4>
      <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;">
        <label><input type="checkbox" id="chk-marathons" ${selectedTypes.has('marathons') ? 'checked':''}/> 🏃 Марафоны (Экспорт шаблона без участников)</label>
        <label><input type="checkbox" id="chk-characters" ${selectedTypes.has('characters') ? 'checked':''}/> 👤 Персонажи (Ручной выбор)</label>
        <label><input type="checkbox" id="chk-parties" ${selectedTypes.has('parties') ? 'checked':''}/> 🛡️ Пати (Выбор групп и их состава)</label>
      </div>

      <!-- ШАГ 2: ДЕТАЛИ ВЫБОРА -->
      <div id="selection-details-area" style="border-top:1px solid var(--border); padding-top:16px; display:none;">
        
        <!-- Блок Марафонов -->
        <div id="block-marathons" style="display:none; margin-bottom:12px;">
          <strong>Марафоны:</strong>
          <button type="button" class="btn ghost small" onclick="window.toggleAllMarathons()">Все/Никто</button>
          <div id="list-marathons" style="max-height:150px; overflow-y:auto; border:1px solid var(--border); padding:8px; margin-top:4px; background:var(--panel-2);"></div>
        </div>

        <!-- Блок Пати -->
        <div id="block-parties" style="display:none; margin-bottom:12px;">
          <strong>Пати:</strong>
          <button type="button" class="btn ghost small" onclick="window.toggleAllParties()">Все/Никто</button>
          <div id="list-parties" style="max-height:150px; overflow-y:auto; border:1px solid var(--border); padding:8px; margin-top:4px; background:var(--panel-2);"></div>
          
          <!-- Под-блок: Состав выбранных пати -->
          <div id="sub-block-party-chars" style="display:none; margin-left:20px; margin-top:8px; font-size:0.9rem;">
            <em>Персонажи из выбранных пати:</em>
            <button type="button" class="btn ghost tiny" onclick="window.toggleAllPartyChars()">Все/Никто</button>
            <div id="list-party-chars-container" style="margin-top:4px;"></div>
          </div>
        </div>

        <!-- Блок Индивидуальных персонажей -->
        <div id="block-individual-chars" style="display:none; margin-bottom:12px;">
          <strong>Персонажи (вручную):</strong>
          <button type="button" class="btn ghost small" onclick="window.toggleAllIndividualChars()">Все/Никто</button>
          <div id="list-individual-chars" style="max-height:150px; overflow-y:auto; border:1px solid var(--border); padding:8px; margin-top:4px; background:var(--panel-2);"></div>
        </div>
      </div>

      <!-- ШАГ 3: КОНФИДЕНЦИАЛЬНОСТЬ -->
      <div id="privacy-settings" style="border-top:1px solid var(--border); padding-top:16px; margin-top:16px; display:none;">
        <h4>3. Детали экспорта персонажей</h4>
        <div style="display:flex; flex-wrap:wrap; gap:12px;">
           <label><input type="checkbox" id="inc-emails" checked /> Email</label>
           <label><input type="checkbox" id="inc-passwords" /> Пароли (<span style="color:red">Опасно!</span>)</label>
           <label><input type="checkbox" id="inc-passes" checked /> Проходки</label>
           <label><input type="checkbox" id="inc-coins" checked /> Монеты & История</label>
        </div>
      </div>

      <!-- ШАГ 4: ФОРМАТ И ИНФО -->
      <div style="border-top:1px solid var(--border); padding-top:16px; margin-top:16px;">
        <h4>4. Формат файла</h4>
        <select id="exp-format" class="select" style="width:100%;">
          <option value="json">JSON (Полная структура / Шаблон)</option>
          <option value="csv">CSV (Только таблица персонажей)</option>
        </select>
        
        <!-- ПОДСКАЗКА О СОХРАНЕНИИ -->
        <p class="muted" style="font-size: 0.85rem; margin-top: 8px; color: var(--accent);">
          💾 Файл будет сохранен в вашу системную папку <strong>"Загрузки"</strong>.<br/>
          * При экспорте Марафонов данные об участниках очищаются для создания чистого шаблона.
        </p>
      </div>
    </div>
  `;

  showModal({
    title: 'Мастер экспорта данных',
    content: contentTemplate(),
    submitText: 'Сформировать и скачать',
    onSubmit(formData, { setError }) {
      try {
        const format = document.getElementById('exp-format').value;
        const incEmails = document.getElementById('inc-emails')?.checked || false;
        const incPasswords = document.getElementById('inc-passwords')?.checked || false;
        const incPasses = document.getElementById('inc-passes')?.checked || false;
        const incCoins = document.getElementById('inc-coins')?.checked || false;

        // Сбор финального списка ID персонажей
        const finalCharIds = new Set([...selectedCharacterIds]); 
        Object.values(partySelectedCharacters).forEach(idsArray => {
          idsArray.forEach(id => finalCharIds.add(id));
        });

        const exportData = {};

        // 1. ЭКСПОРТ МАРАФОНОВ (Шаблон без участников)
        if (selectedTypes.has('marathons')) {
           let marathonsToExport = [];
           
           if (selectedMarathonIds.size === 0 && allMarathons.length > 0) {
              marathonsToExport = [...allMarathons];
           } else {
              marathonsToExport = allMarathons.filter(m => selectedMarathonIds.has(m.id));
           }

           // ВАЖНО: Очищаем марафоны от личных данных перед сохранением в файл
           exportData.marathons = marathonsToExport.map(m => ({
             id: m.id,
             title: m.title,
             description: m.description,
             startDate: m.startDate,
             endDate: m.endDate,
             status: 'draft', // Всегда начинаем как черновик
             
             // Копируем структуру заданий и этапов (это важно!)
             tasks: JSON.parse(JSON.stringify(m.tasks)), 
             
             // ОЧИСТКА ЛИЧНЫХ ДАННЫХ:
             participantIds: [],       // Пустой список участников
             participantAssignments: {}, // Пустые назначения
             records: [],              // Нет истории галочек
             awards: []                // Нет начисленных наград
           }));
        }

        // 2. ЭКСПОРТ ПАТИ (Структура групп)
        if (selectedTypes.has('parties')) {
           const partiesToExport = state.parties.filter(p => selectedPartyNames.has(p.name));
           if(partiesToExport.length > 0) exportData.parties = partiesToExport;
        }

        // 3. ЭКСПОРТ ПЕРСОНАЖЕЙ
        if (selectedTypes.has('characters') || selectedTypes.has('parties')) {
           const charsToExport = state.characters.filter(c => finalCharIds.has(c.id));
           
           exportData.characters = charsToExport.map(c => {
             const clean = {
               id: c.id, nick: c.nick, class: c.class, party: c.party, level: c.level, sky: c.sky,
               createdAt: c.createdAt, updatedAt: c.updatedAt
             };
             if (incEmails) clean.email = c.contacts?.email;
             if (incPasswords) clean.password = c.contacts?.password;
             if (incPasses) clean.dungeonPasses = c.dungeonPasses;
             if (incCoins) {
                clean.ancientCoins = c.ancientCoins;
                clean.coinHistory = c.coinHistory;
             }
             return clean;
           });
        }

        // Генерация файла
        let fileContent = '';
        let mimeType = '';
        let fileName = '';
        const dateStamp = new Date().toISOString().slice(0,10);

        if (format === 'json') {
          fileContent = JSON.stringify(exportData, null, 2);
          mimeType = 'application/json';
          fileName = `tvinoferma_export_${dateStamp}.json`;
        } else if (format === 'csv') {
          if (!exportData.characters || exportData.characters.length === 0) {
             setError('Для CSV необходимо выбрать хотя бы одного персонажа.');
             return false;
          }
          
          const headers = ['ID', 'Nick', 'Class', 'Party', 'Level'];
          if (incEmails) headers.push('Email');
          if (incPasses) headers.push('Weapon Passes', 'Armor Passes', 'Relic Passes');
          if (incCoins) headers.push('Ancient Coins');

          const rows = exportData.characters.map(c => {
            const row = [c.id, `"${c.nick}"`, c.class || '', c.party || '-', c.level];
            if (incEmails) row.push(`"${c.email || ''}"`);
            if (incPasses) row.push(c.dungeonPasses?.weapon || 0, c.dungeonPasses?.armor || 0, c.dungeonPasses?.relic || 0);
            if (incCoins) row.push(c.ancientCoins || 0);
            return row.join(';');
          });

          fileContent = '\uFEFF' + [headers.join(';'), ...rows].join('\n');
          mimeType = 'text/csv;charset=utf-8;';
          fileName = `tvinoferma_characters_${dateStamp}.csv`;
        }

        downloadFile(fileContent, fileName, mimeType);
        toast('Файл успешно сохранен в папку Загрузки!', 'success');
        return true;

      } catch (err) {
        console.error(err);
        setError(`Ошибка: ${err.message}`);
        return false;
      }
    }
  });

  // --- ЛОГИКА ИНТЕРАКТИВНОГО МАСТЕРА ---

  const chkMarathons = document.getElementById('chk-marathons');
  const chkCharacters = document.getElementById('chk-characters');
  const chkParties = document.getElementById('chk-parties');
  const detailsArea = document.getElementById('selection-details-area');
  const privacySettings = document.getElementById('privacy-settings');
  
  const blockMarathons = document.getElementById('block-marathons');
  const blockParties = document.getElementById('block-parties');
  const blockIndivChars = document.getElementById('block-individual-chars');
  const subBlockPartyChars = document.getElementById('sub-block-party-chars');
  const listPartyCharsContainer = document.getElementById('list-party-chars-container');

  function updateVisibility() {
    const hasAny = chkMarathons.checked || chkCharacters.checked || chkParties.checked;
    detailsArea.style.display = hasAny ? 'block' : 'none';
    
    privacySettings.style.display = (chkCharacters.checked || chkParties.checked) ? 'block' : 'none';

    blockMarathons.style.display = chkMarathons.checked ? 'block' : 'none';
    blockParties.style.display = chkParties.checked ? 'block' : 'none';
    blockIndivChars.style.display = chkCharacters.checked ? 'block' : 'none';
    
    renderLists();
  }

  function renderLists() {
    // 1. Марафоны
    if (chkMarathons.checked) {
      const listEl = document.getElementById('list-marathons');
      listEl.innerHTML = allMarathons.map(m => `
        <label style="display:block; padding:2px 0;">
          <input type="checkbox" value="${m.id}" ${selectedMarathonIds.has(m.id) ? 'checked':''} onchange="window.handleMarathonCheck(this)" />
          ${escapeHtml(m.title)} <small class="muted">(${m.startDate})</small>
        </label>
      `).join('');
    }

    // 2. Пати
    if (chkParties.checked) {
      const listEl = document.getElementById('list-parties');
      // Добавляем опцию "Без пати" (__none__)
      const options = [`<option value="__none__">Без пати</option>`, ...allParties.map(p => `<option value="${p}">${p}</option>`)];
      
      listEl.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:4px;">
          ${options.map(optVal => {
             const val = optVal.match(/value="([^"]+)"/)[1];
             const label = optVal.match(/>([^<]+)</)[1];
             const isChecked = selectedPartyNames.has(val);
             return `
               <label style="display:block; padding:2px 0;">
                 <input type="checkbox" value="${val}" ${isChecked ? 'checked':''} onchange="window.handlePartyCheck(this)" />
                 ${escapeHtml(label)}
               </label>
             `;
          }).join('')}
        </div>
      `;
      
      updatePartySubList();
    }

    // 3. Индивидуальные персонажи
    if (chkCharacters.checked) {
       const listEl = document.getElementById('list-individual-chars');
       listEl.innerHTML = allCharacters.map(c => `
         <label style="display:block; padding:2px 0;">
           <input type="checkbox" value="${c.id}" ${selectedCharacterIds.has(c.id) ? 'checked':''} onchange="window.handleCharCheck(this)" />
           ${escapeHtml(c.nick)} <small class="muted">(${c.party || '-'})</small>
         </label>
       `).join('');
    }
  }

  function updatePartySubList() {
     if (selectedPartyNames.size === 0) {
        subBlockPartyChars.style.display = 'none';
        return;
     }
     
     subBlockPartyChars.style.display = 'block';
     listPartyCharsContainer.innerHTML = ''; // Очищаем перед перерисовкой
     
     selectedPartyNames.forEach(partyName => {
        // Находим персонажей этой пати
        let charsInParty = [];
        if (partyName === '__none__') {
           charsInParty = allCharacters.filter(c => !c.party);
        } else {
           charsInParty = allCharacters.filter(c => c.party === partyName);
        }

        if (charsInParty.length === 0) return;

        // Инициализируем массив выбранных ID для этой пати, если его еще нет
        if (!partySelectedCharacters[partyName]) {
           partySelectedCharacters[partyName] = charsInParty.map(c => c.id); // По умолчанию все выбраны
        }

        const groupDiv = document.createElement('div');
        groupDiv.style.marginBottom = '8px';
        groupDiv.style.padding = '4px';
        groupDiv.style.borderLeft = '2px solid var(--accent)';
        groupDiv.style.background = 'rgba(255,255,255,0.02)';

        let html = `<strong style="font-size:0.85rem; display:block; margin-bottom:4px;">${escapeHtml(partyName === '__none__' ? 'Без пати' : partyName)}</strong>`;
        html += `<div style="display:flex; flex-wrap:wrap; gap:8px;">`;
        
        charsInParty.forEach(c => {
           const isSelected = partySelectedCharacters[partyName].includes(c.id);
           html += `
             <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.85rem; cursor:pointer;">
               <input type="checkbox" value="${c.id}" data-party="${partyName}" ${isSelected ? 'checked' : ''} onchange="window.handlePartyCharCheck(this)" />
               ${escapeHtml(c.nick)}
             </label>
           `;
        });
        html += `</div>`;
        
        groupDiv.innerHTML = html;
        listPartyCharsContainer.appendChild(groupDiv);
     });
  }

  // Глобальные хелперы
  window.handleMarathonCheck = (cb) => {
    if(cb.checked) selectedMarathonIds.add(cb.value); else selectedMarathonIds.delete(cb.value);
  };
  
  window.handlePartyCheck = (cb) => {
    if(cb.checked) selectedPartyNames.add(cb.value); else selectedPartyNames.delete(cb.value);
    updatePartySubList();
  };
  
  window.handleCharCheck = (cb) => {
    if(cb.checked) selectedCharacterIds.add(cb.value); else selectedCharacterIds.delete(cb.value);
  };

  window.handlePartyCharCheck = (cb) => {
    const partyName = cb.dataset.party;
    const charId = cb.value;
    
    if (!partySelectedCharacters[partyName]) {
       partySelectedCharacters[partyName] = [];
    }

    if (cb.checked) {
       if (!partySelectedCharacters[partyName].includes(charId)) {
          partySelectedCharacters[partyName].push(charId);
       }
    } else {
       partySelectedCharacters[partyName] = partySelectedCharacters[partyName].filter(id => id !== charId);
    }
  };

  window.toggleAllMarathons = () => {
    const cbs = document.querySelectorAll('#list-marathons input');
    const allChecked = Array.from(cbs).every(c => c.checked);
    cbs.forEach(c => {
      c.checked = !allChecked;
      window.handleMarathonCheck(c);
    });
  };

  window.toggleAllParties = () => {
    const cbs = document.querySelectorAll('#list-parties input');
    const allChecked = Array.from(cbs).every(c => c.checked);
    cbs.forEach(c => {
      c.checked = !allChecked;
      window.handlePartyCheck(c);
    });
  };

  window.toggleAllIndividualChars = () => {
    const cbs = document.querySelectorAll('#list-individual-chars input');
    const allChecked = Array.from(cbs).every(c => c.checked);
    cbs.forEach(c => {
      c.checked = !allChecked;
      window.handleCharCheck(c);
    });
  };

  window.toggleAllPartyChars = () => {
    const cbs = document.querySelectorAll('#list-party-chars-container input[type="checkbox"]');
    const allChecked = Array.from(cbs).every(c => c.checked);
    cbs.forEach(c => {
      c.checked = !allChecked;
      window.handlePartyCharCheck(c);
    });
  };

  // Слушатели главных чекбоксов
  chkMarathons.onchange = updateVisibility;
  chkCharacters.onchange = updateVisibility;
  chkParties.onchange = updateVisibility;

  // Инициализация
  updateVisibility();
}