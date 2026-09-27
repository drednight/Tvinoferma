// js/marathons/components/taskEditor.js

import { escapeHtml } from '../../utils.js';
import { getAllDatesInRange, getAvailableCheckCount } from '../../marathonUtils.js';

/**
 * Рендерит список всех заданий в контейнер
 */
export function renderTasksList(container, tasks, startDate, endDate, onDeleteTask, onAddStage, onRemoveStage) {
  container.innerHTML = '';
  
  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<p class="muted">Нет заданий. Добавьте первое!</p>';
    return;
  }

  const allDates = getAllDatesInRange(startDate, endDate);

  tasks.forEach((task, index) => {
    const taskEl = document.createElement('div');
    taskEl.className = 'task-item info-block';
    taskEl.dataset.taskId = task.id; // Ключевой идентификатор
    taskEl.style.marginBottom = '12px';
    taskEl.style.border = '1px solid var(--border)';
    taskEl.style.padding = '12px';
    
    // Расчет запасных дней
    const available = getAvailableCheckCount(task, allDates);
    const spareDays = Math.max(0, available - (Number(task.targetChecks) || 0));

    taskEl.innerHTML = `
      <div class="toolbar" style="justify-content: space-between; margin-bottom: 8px;">
        <strong>Задание ${index + 1}: <span class="display-title">${escapeHtml(task.title)}</span></strong>
        <button type="button" class="icon-btn danger remove-task-btn" data-id="${task.id}">🗑</button>
      </div>
      
      <div class="two-cols">
        <div class="field">
          <label>Название</label>
          <!-- Используем класс input-title для поиска -->
          <input class="input input-title" value="${escapeHtml(task.title)}" />
        </div>
        <div class="field">
          <label>Цель (кол-во выполнений)</label>
          <!-- Используем класс input-target -->
          <input class="input input-target" type="number" min="1" value="${task.targetChecks}" />
        </div>
      </div>
      
      <div class="field">
        <label>Описание</label>
        <!-- Используем класс input-desc -->
        <input class="input input-desc" value="${escapeHtml(task.description)}" placeholder="Краткое описание..." />
      </div>

      <div class="two-cols" style="margin-top: 8px; background: rgba(255,255,255,0.02); padding: 8px; border-radius: 6px;">
         <div class="field">
           <label>Описание награды (опционально)</label>
           <!-- Используем класс input-reward-text -->
           <input class="input input-reward-text" value="${escapeHtml(task.baseRewardText || '')}" placeholder="Например: Малый сундук" />
         </div>
         <div class="field">
           <label>Монеты за выполнение (опционально)</label>
           <!-- Используем класс input-reward-coins -->
           <input class="input input-reward-coins" type="number" min="0" value="${task.baseRewardCoins || 0}" />
         </div>
      </div>

      <div class="two-cols" style="margin-top: 8px;">
        <div class="field">
          <label>Режим расписания</label>
          <!-- Используем класс select-schedule-mode -->
          <select class="select select-schedule-mode">
            <option value="everyDay" ${task.schedule.mode === 'everyDay' ? 'selected' : ''}>Каждый день</option>
            <option value="dates" ${task.schedule.mode === 'dates' ? 'selected' : ''}>Выбранные даты</option>
            <option value="weekly" ${task.schedule.mode === 'weekly' ? 'selected' : ''}>Раз в неделю</option>
          </select>
        </div>
        <div class="field">
          <label>Доступно дней: <strong>${available}</strong></label>
          <label>Запасных дней: <strong style="color: var(--warning)">${spareDays}</strong></label>
        </div>
      </div>

      <!-- Поля для разных режимов -->
      <div class="field dates-field" style="display: ${task.schedule.mode === 'dates' ? 'block' : 'none'}; margin-top: 8px;">
        <label>Даты (через запятую, YYYY-MM-DD)</label>
        <!-- Используем класс input-dates -->
        <input class="input input-dates" value="${task.schedule.dates.join(', ')}" placeholder="2026-09-01, 2026-09-05..." />
      </div>

      <div class="field weekly-field" style="display: ${task.schedule.mode === 'weekly' ? 'block' : 'none'}; margin-top: 8px;">
        <label>День недели для выполнения</label>
        <!-- Используем класс select-week-day -->
        <select class="select select-week-day">
          <option value="0" ${task.schedule.weekStartDay == 0 ? 'selected':''}>Воскресенье</option>
          <option value="1" ${task.schedule.weekStartDay == 1 ? 'selected':''}>Понедельник</option>
          <option value="2" ${task.schedule.weekStartDay == 2 ? 'selected':''}>Вторник</option>
          <option value="3" ${task.schedule.weekStartDay == 3 ? 'selected':''}>Среда</option>
          <option value="4" ${task.schedule.weekStartDay == 4 ? 'selected':''}>Четверг</option>
          <option value="5" ${task.schedule.weekStartDay == 5 ? 'selected':''}>Пятница</option>
          <option value="6" ${task.schedule.weekStartDay == 6 ? 'selected':''}>Суббота</option>
        </select>
      </div>

      <div class="stages-container" style="margin-top: 12px;">
        <div class="toolbar" style="justify-content: space-between; margin-bottom: 4px;">
          <span style="font-size: 0.9rem; color: var(--muted)">Этапы наград</span>
          <button type="button" class="btn ghost small add-stage-btn">+ Этап</button>
        </div>
        <div class="stages-list">
          ${(task.stages || []).map(stage => `
            <div class="stage-item row gap" data-stage-id="${stage.id}" style="margin-bottom: 4px; align-items: flex-end;">
              <div class="field" style="flex: 0 0 80px;">
                <label>Порог</label>
                <!-- Класс stage-threshold -->
                <input class="input stage-threshold" type="number" min="1" value="${stage.threshold}" />
              </div>
              <div class="field" style="flex: 1;">
                <label>Текст награды</label>
                <!-- Класс stage-reward-text -->
                <input class="input stage-reward-text" value="${escapeHtml(stage.rewardText)}" />
              </div>
              <div class="field" style="flex: 0 0 100px;">
                <label>Монеты</label>
                <!-- Класс stage-reward-coins -->
                <input class="input stage-reward-coins" type="number" min="0" value="${stage.rewardCoins}" />
              </div>
              <button type="button" class="icon-btn danger remove-stage-btn" data-stage-id="${stage.id}">✕</button>
            </div>
          `).join('')}
          ${(task.stages || []).length === 0 ? '<p class="muted" style="font-size:0.8rem; margin:4px 0;">Нет этапов.</p>' : ''}
        </div>
      </div>
    `;
    
    container.appendChild(taskEl);

    // Привязка событий к элементам этого задания
    bindTaskItemEvents(taskEl, task, onDeleteTask, onAddStage, onRemoveStage);
  });
}

function bindTaskItemEvents(el, taskData, onDelete, onAddStage, onRemoveStage) {
  // Удаление задания
  el.querySelector('.remove-task-btn').onclick = () => onDelete(taskData.id);
  
  // Добавление этапа
  el.querySelector('.add-stage-btn').onclick = () => onAddStage(taskData.id);
  
  // Удаление этапа
  el.querySelectorAll('.remove-stage-btn').forEach(btn => {
    btn.onclick = () => onRemoveStage(taskData.id, btn.dataset.stageId);
  });
}