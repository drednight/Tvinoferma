// js/data/export.js

import { state } from '../core/state.js';
import { showModal, toast } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';
import { SCHEMA_VERSION } from '../core/migrations.js';
import { partyByName, partyNamesOf, mainPartyName, additionalPartiesOf, charactersInParty, hasNoParty } from '../modules/parties/membership.js';

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
  
  const allParties = [...state.parties].sort((a, b) => (Number(a.order) || 1e9) - (Number(b.order) || 1e9)).map(p => p.name);
  
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
           <label><input type="checkbox" id="inc-emails" checked /> Email, recovery, телефон</label>
           <label><input type="checkbox" id="inc-passwords" /> Пароли (<span style="color:red">Опасно!</span>)</label>
           <label><input type="checkbox" id="inc-stats" checked /> Характеристики (все статы)</label>
           <label><input type="checkbox" id="inc-passes" checked /> Проходки</label>
           <label><input type="checkbox" id="inc-coins" checked /> Монеты и история</label>
           <label><input type="checkbox" id="inc-tags" checked /> Теги</label>
           <label><input type="checkbox" id="inc-notes" checked /> Примечания</label>
           <label><input type="checkbox" id="inc-sync" checked /> Прогресс марафонов с сайта</label>
        </div>
        <p class="muted" style="font-size:0.8rem; margin:6px 0 0;">Невыбранные группы не попадут в файл, а при импорте не затрут данные у получателя.</p>
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
        const incStats = document.getElementById('inc-stats')?.checked || false;
        const incTags = document.getElementById('inc-tags')?.checked || false;
        const incNotes = document.getElementById('inc-notes')?.checked || false;
        const incSync = document.getElementById('inc-sync')?.checked || false;

        // Сбор финального списка ID персонажей
        const finalCharIds = new Set([...selectedCharacterIds]); 
        Object.values(partySelectedCharacters).forEach(idsArray => {
          idsArray.forEach(id => finalCharIds.add(id));
        });

        const exportData = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() };

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
             ...JSON.parse(JSON.stringify(m)),
             // ОЧИСТКА ЛИЧНЫХ ДАННЫХ (структура, задания и награды сохраняются):
             participantIds: [],
             assignments: {},
             progress: {},
             lastSync: null,
             balance: { start: {}, end: {} },
             awards: [],
             status: m.kind === 'series' ? undefined : 'active',
             completedAt: null
           }));
           if (state.marathonTemplates?.length) exportData.marathonTemplates = JSON.parse(JSON.stringify(state.marathonTemplates));
        }

        // 2. ЭКСПОРТ ПАТИ (Структура групп)
        if (selectedTypes.has('parties')) {
           const partiesToExport = state.parties.filter(p => selectedPartyNames.has(p.name));
           if(partiesToExport.length > 0) exportData.parties = partiesToExport;
        }

        // 3. ЭКСПОРТ ПЕРСОНАЖЕЙ
        if (selectedTypes.has('characters') || selectedTypes.has('parties')) {
           const charsToExport = state.characters.filter(c => finalCharIds.has(c.id));
           
           // Структура как в state.json: импорт понимает её без преобразований
           exportData.characters = charsToExport.map(c => {
             const copy = JSON.parse(JSON.stringify(c));
             const clean = {
               id: copy.id, nick: copy.nick, class: copy.class, partyIds: copy.partyIds || [], mainPartyId: copy.mainPartyId || null, level: copy.level, sky: copy.sky,
               createdAt: copy.createdAt, updatedAt: copy.updatedAt
             };
             const contacts = {};
             if (incEmails) {
               contacts.email = copy.contacts?.email || '';
               contacts.recoveryEmail = copy.contacts?.recoveryEmail || '';
               contacts.phone = copy.contacts?.phone || '';
             }
             if (incPasswords) contacts.password = copy.contacts?.password || '';
             if (Object.keys(contacts).length) clean.contacts = contacts;
             if (incStats) clean.stats = copy.stats;
             if (incPasses) clean.dungeonPasses = copy.dungeonPasses;
             if (incCoins) {
               clean.ancientCoins = copy.ancientCoins;
               clean.lastCoinUpdate = copy.lastCoinUpdate;
               clean.coinHistory = copy.coinHistory;
             }
             if (incTags) clean.tags = copy.tags;
             if (incNotes) clean.notes = copy.notes || '';
             if (incSync) clean.marathonData = copy.marathonData;
             return clean;
           });

           // partyIds ссылаются на id партий: кладём в файл и сами партии, иначе при импорте ссылки потеряются
           const needed = new Set(charsToExport.flatMap(c => c.partyIds || []));
           const have = new Set((exportData.parties || []).map(p => p.id));
           const extra = state.parties.filter(p => needed.has(p.id) && !have.has(p.id));
           if (extra.length) exportData.parties = [...(exportData.parties || []), ...JSON.parse(JSON.stringify(extra))];
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
          
          const headers = ['ID', 'Nick', 'Class', 'Party', 'Extra Parties', 'Level'];
          if (incEmails) headers.push('Email');
          if (incPasses) headers.push('Weapon Passes', 'Armor Passes', 'Relic Passes');
          if (incCoins) headers.push('Ancient Coins');

          const rows = exportData.characters.map(c => {
            const row = [c.id, `"${c.nick}"`, c.class || '', `"${mainPartyName(c, state.parties) || '-'}"`, `"${additionalPartiesOf(c, state.parties).map(p => p.name).join(' / ')}"`, c.level];
            if (incEmails) row.push(`"${c.contacts?.email || ''}"`);
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
           ${escapeHtml(c.nick)} <small class="muted">(${escapeHtml(partyNamesOf(c, state.parties).join(', ') || '-')})</small>
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
           charsInParty = allCharacters.filter(c => hasNoParty(c, state.parties));
        } else {
           const party = partyByName(state.parties, partyName);
           charsInParty = party ? charactersInParty(allCharacters, party.id) : [];
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