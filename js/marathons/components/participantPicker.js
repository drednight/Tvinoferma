// js/marathons/components/participantPicker.js

import { escapeHtml } from '../../utils.js';

/**
 * Рендерит панель выбора участников и назначений
 */
export function renderParticipantPanel(container, charactersList, selectedIds, assignmentsMap, tasksList, onChangeSelection, onToggleAssignment) {
  container.innerHTML = '';

  // Разделение на две колонки
  const gridDiv = document.createElement('div');
  gridDiv.style.display = 'grid';
  gridDiv.style.gridTemplateColumns = '1fr 2fr';
  gridDiv.style.gap = '16px';
  gridDiv.style.borderTop = '1px solid var(--border)';
  gridDiv.style.paddingTop = '12px';

  const leftCol = document.createElement('div');
  leftCol.id = 'participants-list-container';
  leftCol.style.maxHeight = '300px';
  leftCol.style.overflowY = 'auto';
  leftCol.style.borderRight = '1px solid var(--border)';
  leftCol.style.paddingRight = '12px';

  const rightCol = document.createElement('div');
  rightCol.id = 'assignments-panel';
  rightCol.style.maxHeight = '300px';
  rightCol.style.overflowY = 'auto';
  rightCol.style.paddingLeft = '4px';

  gridDiv.appendChild(leftCol);
  gridDiv.appendChild(rightCol);
  container.appendChild(gridDiv);

  // 1. Рендер левого столбца (Список персонажей)
  renderCharacterList(leftCol, charactersList, selectedIds, onChangeSelection);

  // 2. Рендер правого столбца (Назначения для выбранных)
  renderAssignments(rightCol, charactersList, selectedIds, assignmentsMap, tasksList, onToggleAssignment);
}

function renderCharacterList(container, chars, selectedIds, onChange) {
  container.innerHTML = '';
  
  if (chars.length === 0) {
    container.innerHTML = '<p class="muted">Нет доступных персонажей.</p>';
    return;
  }

  chars.forEach(c => {
    const isChecked = selectedIds.includes(c.id);
    
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.padding = '6px 0';
    label.style.borderBottom = '1px dashed rgba(255,255,255,0.1)';
    label.style.cursor = 'pointer';
    
    label.innerHTML = `
      <input type="checkbox" value="${c.id}" ${isChecked ? 'checked' : ''} />
      <span><strong>${escapeHtml(c.nick)}</strong> <small class="muted">(${escapeHtml(c.party || '-')})</small></span>
    `;

    const cb = label.querySelector('input');
    cb.onchange = () => {
      onChange(c.id, cb.checked);
    };

    container.appendChild(label);
  });
}

function renderAssignments(panel, chars, selectedIds, assignmentsMap, tasksList, onToggle) {
  panel.innerHTML = '';

  if (selectedIds.length === 0) {
     panel.innerHTML = '<p class="muted" style="text-align:center; margin-top: 50px;">Выберите персонажей слева,<br/>чтобы назначить им задания.</p>';
     return;
  }

  if (tasksList.length === 0) {
     panel.innerHTML = '<p class="muted" style="text-align:center; margin-top: 50px;">Нет заданий для назначения.<br/>Вернитесь на вкладку "Информация".</p>';
     return;
  }

  selectedIds.forEach(pid => {
    const char = chars.find(c => c.id === pid);
    if (!char) return;

    const block = document.createElement('div');
    block.id = `assign-box-${pid}`;
    block.style.marginBottom = '12px';
    block.style.padding = '8px';
    block.style.background = 'var(--panel-2)';
    block.style.borderRadius = '6px';
    block.style.border = '1px solid var(--border)';

    const currentAssigned = assignmentsMap[pid] || [];
    // Если назначений нет, считаем что назначены ВСЕ задания (дефолтное поведение)
    const effectiveAssigned = currentAssigned.length > 0 ? currentAssigned : tasksList.map(t => t.id);

    let html = `<strong style="color: var(--accent); display:block; margin-bottom:6px;">${escapeHtml(char.nick)}</strong>`;
    html += `<div style="display:flex; flex-wrap:wrap; gap:8px;">`;
    
    tasksList.forEach(task => {
      const isTaskAssigned = effectiveAssigned.includes(task.id);
      html += `
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.85rem; cursor:pointer; background:rgba(255,255,255,0.05); padding:4px 8px; border-radius:4px;">
          <input type="checkbox" value="${task.id}" ${isTaskAssigned ? 'checked' : ''} />
          ${escapeHtml(task.title)}
        </label>
      `;
    });
    html += `</div>`;

    block.innerHTML = html;
    panel.appendChild(block);

    // Привязка событий чекбоксов заданий
    block.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        onToggle(pid, cb.value, cb.checked);
      };
    });
  });
}