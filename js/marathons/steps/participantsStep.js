// js/marathons/steps/participantsStep.js

import { renderParticipantPanel } from '../components/participantPicker.js';
import { escapeHtml } from '../../utils.js';

export function renderParticipantsStep(container, formState, charactersList, uniqueParties) {
  const data = formState.data;

  if (data.tasks.length === 0) {
    container.innerHTML = `<p class="muted" style="text-align:center; padding:20px;">Нет заданий. Вернитесь на вкладку "Информация" и добавьте задания.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="info-block" style="margin-top: 0;">
      <h4>Участники (${data.participantIds.length})</h4>
      
      <div class="row gap" style="margin-bottom: 8px; align-items: center; justify-content: space-between;">
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn ghost small" id="select-all-participants">Выбрать всех</button>
          <button type="button" class="btn ghost small" id="deselect-all-participants">Снять всех</button>
        </div>
        
        <div style="display:flex; gap:8px; align-items:center;">
          <label style="font-size: 0.9rem;">Фильтр:</label>
          <select id="party-filter-form" class="select" style="width: 150px;">
            <option value="all">Все персонажи</option>
            <option value="__none__">Без пати</option>
            ${uniqueParties.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div id="participant-picker-mount-point"></div>
    </div>
  `;

  const mountPoint = container.querySelector('#participant-picker-mount-point');
  const partyFilterSelect = container.querySelector('#party-filter-form');
  const selectAllBtn = container.querySelector('#select-all-participants');
  const deselectAllBtn = container.querySelector('#deselect-all-participants');

  // Функция обновления панели с учетом фильтра
  function updatePanel(filterValue = 'all') {
    let filteredChars = charactersList;
    
    if (filterValue === '__none__') {
      filteredChars = charactersList.filter(c => !c.party);
    } else if (filterValue !== 'all') {
      filteredChars = charactersList.filter(c => c.party === filterValue);
    }

    renderParticipantPanel(
      mountPoint, 
      filteredChars, 
      data.participantIds, 
      data.participantAssignments, 
      data.tasks,
      // Колбэк изменения выбора участника
      (charId, isChecked) => {
        formState.toggleParticipant(charId, isChecked);
        // Обновляем счетчик в заголовке
        const header = container.querySelector('h4');
        if(header) header.textContent = `Участники (${formState.data.participantIds.length})`;
      },
      // Колбэк переключения назначения задания
      (charId, taskId, isChecked) => {
        formState.setAssignment(charId, taskId, isChecked);
      }
    );
  }

  // Инициализация
  updatePanel('all');

  // Слушатели
  partyFilterSelect.onchange = (e) => updatePanel(e.target.value);
  
  selectAllBtn.onclick = () => {
    const visibleInputs = mountPoint.querySelectorAll('#participants-list-container input[name="participants"], #participants-list-container input[type="checkbox"]');
    visibleInputs.forEach(cb => {
       if(!cb.checked) {
         cb.click(); // Эмулируем клик, чтобы вызвать onchange
       }
    });
  };

  deselectAllBtn.onclick = () => {
    const visibleInputs = mountPoint.querySelectorAll('#participants-list-container input[type="checkbox"]');
    visibleInputs.forEach(cb => {
       if(cb.checked) {
         cb.click();
       }
    });
  };
}