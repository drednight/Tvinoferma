// js/marathon.js

import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml } from './utils.js';
import { confirmDialog, toast } from './ui.js';
import { openMarathonForm } from './marathons/index.js'; // Новый модульный импорт
import { generateMarathonTableHTML, calculateTotalEarnedCoins } from './marathonTable.js';
import { completeMarathon, reopenMarathonForEditing, recalculateMarathonAwards } from './marathonRewards.js';
import { getAllDatesInRange, isTaskActiveOnDate, getAvailableCheckCount, getPastActiveDaysCount } from './marathonUtils.js';

let activeMarathonId = null;
let currentPartyFilter = 'all';
let currentTaskFilter = null;

export function renderMarathons() {
  const listEl = document.getElementById('marathon-list');
  if (!listEl) return;

  try {
    if (activeMarathonId) {
      renderMarathonDetail(activeMarathonId, listEl);
      return;
    }

    if (!state.marathons || !Array.isArray(state.marathons)) {
       console.warn('[MARATHON] State.marathons is missing or invalid.');
       listEl.innerHTML = '<div class="empty-state">Данные о марафонах повреждены.</div>';
       return;
    }

    if (!state.marathons.length) {
      listEl.innerHTML = '<div class="empty-state">Марафонов пока нет. Создайте первый!</div>';
      return;
    }

    listEl.innerHTML = state.marathons
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(m => {
        const statusColor = m.status === 'completed' ? 'var(--success)' : 
                            m.status === 'active' ? 'var(--accent)' : 'var(--muted)';
        
        let totalCoinsInList = 0;
        if (m.awards && Array.isArray(m.awards)) {
          totalCoinsInList = m.awards.reduce((sum, award) => sum + (Number(award.coins) || Number(award.rewardCoins) || 0), 0);
        } 

        return `
          <div class="party-item marathon-card" data-marathon-id="${m.id}" style="cursor: pointer;">
            <div class="meta">
              <strong>${escapeHtml(m.title)}</strong>
              <span class="muted">
                ${m.startDate} — ${m.endDate} · 
                Участников: ${(m.participantIds || []).length} · 
                Статус: <span style="color: ${statusColor}">${(m.status || 'unknown').toUpperCase()}</span>
              </span>
              ${totalCoinsInList > 0 ? `<br/><small style="color: gold;">🪙 Итого заработано: ${totalCoinsInList}</small>` : ''}
            </div>
            <div class="row gap">
              <button class="btn small edit-btn" data-id="${m.id}">✏️ Редактировать</button>
              <button class="btn small danger delete-btn" data-id="${m.id}">🗑 Удалить</button>
            </div>
          </div>
        `;
      }).join('');
      
    bindListEvents(listEl);

  } catch (err) {
    console.error('[RENDER MARATHONS ERROR]', err);
    listEl.innerHTML = `<div class="empty-state" style="color:red;">Ошибка отображения марафонов: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMarathonDetail(id, container) {
  const marathon = state.marathons.find(m => m.id === id);
  
  // Если марафон вообще не найден
  if (!marathon) {
    container.innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <h2>Ошибка</h2>
          <button class="btn ghost back-btn">← Назад к списку</button>
        </div>
        <p class="muted">Марафон не найден.</p>
      </div>
    `;
    bindDetailEvents(container, null); // Привязываем только кнопку назад
    return;
  }

  let tableHtml = '';
  let hasError = false;

  try {
    // Пытаемся сгенерировать таблицу
    tableHtml = generateMarathonTableHTML(marathon, currentPartyFilter, currentTaskFilter);
  } catch (err) {
    console.error('[TABLE GEN ERROR]', err);
    hasError = true;
    tableHtml = `<div class="empty-state" style="color: var(--danger); padding: 20px;">
      Ошибка отображения таблицы данных.<br/>
      Возможно, в марафоне остались ссылки на удаленных персонажей.<br/>
      <small>${escapeHtml(err.message)}</small>
    </div>`;
  }

  let actionButtons = '';
  if (marathon.status === 'draft' || marathon.status === 'active') {
    actionButtons = `
      <button class="btn primary complete-btn">✅ Завершить марафон</button>
      <button class="btn ghost edit-marathon-detail-btn" data-id="${id}">✏️ Редактировать</button>
    `;
  } else if (marathon.status === 'completed') {
    actionButtons = `
      <button class="btn info infographic-btn" data-id="${id}">📊 Инфографика</button>
      <button class="btn warning reopen-btn">🔓 Открыть для правки</button>
      <button class="btn ghost edit-marathon-detail-btn" data-id="${id}">✏️ Редактировать</button>
    `;
  }

  container.innerHTML = `
    <div class="panel" data-marathon-id="${id}">
      <div class="toolbar">
        <h2>${escapeHtml(marathon.title)}</h2>
        <div class="row gap">
          ${actionButtons}
          <button class="btn ghost back-btn">← Назад к списку</button>
        </div>
      </div>
      <p class="muted">${escapeHtml(marathon.description || '')}</p>
      <hr style="border-color: var(--border); margin: 16px 0;" />
      
      ${tableHtml}
    </div>
  `;

  bindDetailEvents(container, id);
}

function bindListEvents(container) {
  container.onclick = (e) => {
    const target = e.target;

    if (target.classList.contains('edit-btn')) {
      e.stopPropagation();
      const id = target.dataset.id;
      const marathon = state.marathons.find(m => m.id === id);
      if (marathon) openMarathonForm(marathon);
      return;
    }

    if (target.classList.contains('delete-btn')) {
      e.stopPropagation();
      const id = target.dataset.id;
      const marathon = state.marathons.find(m => m.id === id);
      if (marathon && confirmDialog(`Удалить марафон "${marathon.title}"?`)) {
        state.marathons = state.marathons.filter(m => m.id !== id);
        persist().then(() => {
          renderMarathons();
          toast('Марафон удален', 'success');
        });
      }
      return;
    }

    const card = target.closest('.marathon-card');
    if (card) {
      activeMarathonId = card.dataset.marathonId;
      currentPartyFilter = 'all';
      currentTaskFilter = null;
      renderMarathons();
    }
  };
}

function bindDetailEvents(container, marathonId) {
  const marathon = state.marathons.find(m => m.id === marathonId);
  if (!marathon) return;

  // 1. Кнопка Назад
  const backBtn = container.querySelector('.back-btn');
  if (backBtn) {
    backBtn.onclick = () => {
      activeMarathonId = null;
      currentPartyFilter = 'all';
      currentTaskFilter = null;
      renderMarathons();
    };
  }

  // 2. Кнопки действий
  const completeBtn = container.querySelector('.complete-btn');
  if (completeBtn) {
    completeBtn.onclick = () => completeMarathon(marathonId);
  }

  const reopenBtn = container.querySelector('.reopen-btn');
  if (reopenBtn) {
    reopenBtn.onclick = () => reopenMarathonForEditing(marathonId);
  }

  const editBtn = container.querySelector('.edit-marathon-detail-btn');
  if (editBtn) {
    editBtn.onclick = (e) => {
      e.stopPropagation();
      const id = editBtn.dataset.id;
      const mar = state.marathons.find(m => m.id === id);
      if (mar) openMarathonForm(mar);
    };
  }

  // 3. Кнопка Инфографики
  const infoBtn = container.querySelector('.infographic-btn');
  if (infoBtn) {
    infoBtn.onclick = async () => {
      try {
        const mod = await import('./marathons/charts.js');
        mod.showMarathonInfographic(marathonId);
      } catch (err) {
        console.error(err);
        toast('Ошибка загрузки графиков', 'error');
      }
    };
  }

  // 4. Фильтры
  const partySelect = container.querySelector('#party-filter-select');
  if (partySelect) {
    partySelect.onchange = (e) => {
      currentPartyFilter = e.target.value;
      renderMarathonDetail(marathonId, container.parentElement); 
    };
    partySelect.onclick = (e) => e.stopPropagation();
  }

  const taskSelect = container.querySelector('#task-filter-select');
  if (taskSelect) {
    taskSelect.onchange = (e) => {
      currentTaskFilter = e.target.value || null;
      renderMarathonDetail(marathonId, container.parentElement); 
    };
    taskSelect.onclick = (e) => e.stopPropagation();
  }

  // 5. ЧЕКБОКСЫ
  const tableWrapper = container.querySelector('.table-wrapper');
  if (tableWrapper) {
    tableWrapper.addEventListener('change', async (event) => {
      const checkbox = event.target;
      if (!checkbox.classList.contains('record-checkbox')) return;

      const charId = checkbox.dataset.charId;
      const taskId = checkbox.dataset.taskId;
      const date = checkbox.dataset.date;
      const isChecked = checkbox.checked;

      try {
        const existingIdx = marathon.records.findIndex(r => 
          r.characterId === charId && 
          r.taskId === taskId && 
          String(r.date) === String(date)
        );

        if (isChecked) {
          if (existingIdx === -1) {
            marathon.records.push({
              id: crypto.randomUUID(),
              characterId: charId,
              taskId: taskId,
              date: String(date),
              completed: true,
              note: '',
              updatedAt: new Date().toISOString()
            });
          }
        } else {
          if (existingIdx !== -1) {
            marathon.records.splice(existingIdx, 1);
          }
        }

        await persist();
        updateLocalProgressUI(marathon, charId, taskId);

      } catch (err) {
        console.error('[SAVE ERROR]', err);
        toast('Ошибка сохранения', 'error');
        checkbox.checked = !isChecked;
      }
    });
  }
}

/**
 * Функция обновления конкретного элемента прогресса в DOM
 */
function updateLocalProgressUI(currentMarathon, charId, taskId) {
  try {
    const task = currentMarathon.tasks.find(t => t.id === taskId);
    if (!task) return;

    const allDates = getAllDatesInRange(currentMarathon.startDate, currentMarathon.endDate);
    const todayStr = new Date().toLocaleDateString('sv');

    const target = Number(task.targetChecks) || 0;
    const completedCount = currentMarathon.records.filter(r => 
      r.characterId === charId && 
      r.taskId === taskId && 
      r.completed
    ).length;

    const totalActiveDays = getAvailableCheckCount(task, allDates);
    const maxAllowedMisses = Math.max(0, totalActiveDays - target);
    const passedActiveDays = getPastActiveDaysCount(task, allDates, todayStr);
    const currentMisses = Math.max(0, passedActiveDays - completedCount);

    let statusText = '';
    let statusClass = 'status-neutral';
    let barColor = 'var(--accent)';

    if (completedCount >= target) {
      statusText = '✅ Задание завершено';
      statusClass = 'status-success';
      barColor = 'var(--success)';
    } else if (currentMisses > maxAllowedMisses) {
      statusText = `❌ Провалено (пропущено: ${currentMisses}, лимит: ${maxAllowedMisses})`;
      statusClass = 'status-danger';
      barColor = 'var(--danger)';
    } else {
      const remainingSpare = maxAllowedMisses - currentMisses;
      statusText = `⏳ Запасных дней: ${remainingSpare}`;
      statusClass = 'status-warning';
      barColor = 'var(--accent)';
    }

    const percentage = target > 0 ? Math.min(100, Math.round((completedCount / target) * 100)) : 0;

    const pctEl = document.getElementById(`prog-${charId}-${taskId}-pct`);
    const barEl = document.getElementById(`prog-${charId}-${taskId}-bar`);
    const statusEl = document.getElementById(`prog-${charId}-${taskId}-status`);

    if (pctEl) { pctEl.textContent = `${percentage}%`; pctEl.style.color = barColor; }
    if (barEl) { barEl.style.width = `${percentage}%`; barEl.style.background = barColor; }
    if (statusEl) { 
      statusEl.textContent = statusText; 
      statusEl.className = statusClass; 
    }

    // Обновление общего счетчика монет
    const totalCoinsEl = document.getElementById('total-coins-display');
    if (totalCoinsEl) {
      const newTotal = calculateTotalEarnedCoins(currentMarathon);
      totalCoinsEl.textContent = `🪙 ${newTotal}`;
    }
  } catch (err) {
    console.error('[UPDATE PROGRESS ERROR]', err);
  }
}

export function bindMarathons() {
  const addBtn = document.getElementById('add-marathon-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openMarathonForm();
    });
  }
  
  // Безопасный первичный рендер
  try {
    renderMarathons();
  } catch (err) {
    console.error('[INITIAL RENDER ERROR]', err);
  }
}