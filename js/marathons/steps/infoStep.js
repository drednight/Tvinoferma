// js/marathons/steps/infoStep.js

import { escapeHtml } from '../../utils.js'; // Путь верный: steps -> marathons -> js
import { renderTasksList } from '../components/taskEditor.js'; // Путь верный

export function renderInfoStep(container, stateInstance, onAddTask) {
  const data = stateInstance.data;
  
  container.innerHTML = `
    <div class="two-cols">
      <div class="field">
        <label>Название марафона *</label>
        <input class="input" name="title" value="${escapeHtml(data.title)}" required />
      </div>
      <div class="field">
        <label>Статус</label>
        <select class="select" name="status" disabled>
          <option value="${data.status}" selected>${data.status.toUpperCase()}</option>
        </select>
      </div>
    </div>

    <div class="field">
      <label>Описание</label>
      <textarea class="textarea" name="description" rows="2">${escapeHtml(data.description)}</textarea>
    </div>

    <div class="two-cols">
      <div class="field">
        <label>Дата начала *</label>
        <input class="input" type="date" name="startDate" value="${data.startDate}" required />
      </div>
      <div class="field">
        <label>Дата окончания *</label>
        <input class="input" type="date" name="endDate" value="${data.endDate}" required />
      </div>
    </div>

    <div class="info-block" style="margin-top: 16px;">
      <div class="toolbar" style="margin-bottom: 12px; justify-content: space-between;">
        <h4>Список заданий марафона</h4>
        <button type="button" class="btn primary small" id="add-task-btn-info">+ Добавить задание</button>
      </div>
      <div id="tasks-container-info"></div>
    </div>
  `;

  const tasksContainer = container.querySelector('#tasks-container-info');
  
  // Вызываем компонент рендера заданий
  renderTasksList(
    tasksContainer, 
    data.tasks, 
    data.startDate, 
    data.endDate,
    // Колбэк удаления задания
    (taskId) => {
      stateInstance.removeTask(taskId);
      rerenderInfoStepInternal(container, stateInstance, onAddTask); // Перерисовываем себя
    },
    // Колбэк добавления этапа
    (taskId) => {
      const task = stateInstance.data.tasks.find(t => t.id === taskId);
      if (task) {
        task.stages = task.stages || [];
        const lastThreshold = task.stages[task.stages.length - 1]?.threshold || 0;
        task.stages.push({
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          threshold: lastThreshold + 1,
          rewardText: '',
          rewardCoins: 0
        });
        rerenderInfoStepInternal(container, stateInstance, onAddTask);
      }
    },
    // Колбэк удаления этапа
    (taskId, stageId) => {
      const task = stateInstance.data.tasks.find(t => t.id === taskId);
      if (task) {
        task.stages = task.stages.filter(s => s.id !== stageId);
        rerenderInfoStepInternal(container, stateInstance, onAddTask);
      }
    }
  );

  // Кнопка добавить задачу
  container.querySelector('#add-task-btn-info').onclick = () => {
    stateInstance.syncFromDOM('#dynamic-form-content'); // Сохраняем текущие изменения перед добавлением
    onAddTask();
  };
}

// Вспомогательная функция для перерисовки только блока инфо без потери фокуса (опционально, пока просто вызываем полный ререндер)
function rerenderInfoStepInternal(container, stateInstance, onAddTask) {
   // Для MVP можно просто вызвать внешний rerenderContent из index.js, 
   // но здесь мы делаем локальный рефреш списка задач
   const tasksContainer = container.querySelector('#tasks-container-info');
   if(tasksContainer) {
      renderTasksList(
        tasksContainer, 
        stateInstance.data.tasks, 
        stateInstance.data.startDate, 
        stateInstance.data.endDate,
        (taskId) => { stateInstance.removeTask(taskId); rerenderInfoStepInternal(container, stateInstance, onAddTask); },
        (taskId) => { /* ... логика как выше ... */ },
        (taskId, stageId) => { /* ... логика как выше ... */ }
      );
   }
}