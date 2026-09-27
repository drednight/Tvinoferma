// js/marathons/stateManager.js
import { uid, nowISO } from '../utils.js';
import { getAllDatesInRange, getAvailableCheckCount } from '../marathonUtils.js';

function createEmptyTask() {
  return {
    id: uid(),
    title: 'Новое задание',
    description: '',
    targetChecks: 1,
    schedule: { mode: 'everyDay', dates: [], weekStartDay: 1 },
    baseRewardText: '', 
    baseRewardCoins: 0,
    stages: []
  };
}

export class MarathonFormState {
  constructor(initialData = null) {
    this.data = initialData ? JSON.parse(JSON.stringify(initialData)) : this.getDefaultData();
    this.currentTab = 'info';
  }

  getDefaultData() {
    return {
      id: uid(),
      title: '',
      description: '',
      startDate: new Date().toLocaleDateString('sv'),
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('sv'),
      status: 'draft',
      participantIds: [],
      tasks: [createEmptyTask()],
      comboRewards: [],
      records: [],
      awards: [],
      participantAssignments: {},
      createdAt: nowISO(),
      updatedAt: nowISO(),
      completedAt: null
    };
  }

  switchTab(tabName) {
    this.currentTab = tabName;
  }

  addTask() {
    this.data.tasks.push(createEmptyTask());
  }

  removeTask(taskId) {
    this.data.tasks = this.data.tasks.filter(t => t.id !== taskId);
    Object.keys(this.data.participantAssignments).forEach(pid => {
      this.data.participantAssignments[pid] = this.data.participantAssignments[pid].filter(tid => tid !== taskId);
    });
  }

  toggleParticipant(charId, isChecked) {
    if (isChecked) {
      if (!this.data.participantIds.includes(charId)) {
        this.data.participantIds.push(charId);
      }
    } else {
      this.data.participantIds = this.data.participantIds.filter(id => id !== charId);
      delete this.data.participantAssignments[charId];
    }
  }

  setAssignment(charId, taskId, isChecked) {
    if (!this.data.participantAssignments[charId]) {
      this.data.participantAssignments[charId] = this.data.tasks.map(t => t.id);
    }

    if (isChecked) {
      if (!this.data.participantAssignments[charId].includes(taskId)) {
        this.data.participantAssignments[charId].push(taskId);
      }
    } else {
      this.data.participantAssignments[charId] = this.data.participantAssignments[charId].filter(id => id !== taskId);
    }
  }

  // --- ИСПРАВЛЕННАЯ ЛОГИКА СИНХРОНИЗАЦИИ ---
  syncFromDOM(containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    if (this.currentTab === 'info') {
      // 1. Основные поля марафона
      const titleInput = container.querySelector('[name="title"]');
      const descInput = container.querySelector('[name="description"]');
      const startInput = container.querySelector('[name="startDate"]');
      const endInput = container.querySelector('[name="endDate"]');
      
      if(titleInput) this.data.title = String(titleInput.value || '').trim();
      if(descInput) this.data.description = String(descInput.value || '').trim();
      if(startInput) this.data.startDate = String(startInput.value);
      if(endInput) this.data.endDate = String(endInput.value);

      // 2. Сборка заданий из DOM
      const taskElements = container.querySelectorAll('.task-item');
      
      // Создаем новый массив задач, чтобы избежать проблем с порядком
      const newTasks = [];

      taskElements.forEach(el => {
        const taskId = el.dataset.taskId;
        // Находим старую задачу для сохранения ID и других метаданных, если нужно
        const existingTask = this.data.tasks.find(t => t.id === taskId) || {};
        
        // Читаем значения по классам, которые мы задали в taskEditor.js
        const getTitle = () => String(el.querySelector('.input-title')?.value || '').trim();
        const getDesc = () => String(el.querySelector('.input-desc')?.value || '').trim();
        const getTarget = () => parseInt(el.querySelector('.input-target')?.value, 10) || 1;
        const getMode = () => el.querySelector('.select-schedule-mode')?.value || 'everyDay';
        const getRewardText = () => String(el.querySelector('.input-reward-text')?.value || '').trim();
        const getRewardCoins = () => parseInt(el.querySelector('.input-reward-coins')?.value, 10) || 0;
        const getWeekDay = () => parseInt(el.querySelector('.select-week-day')?.value || '1', 10);
        
        let tDates = [];
        if (getMode() === 'dates') {
          const val = el.querySelector('.input-dates')?.value || '';
          tDates = val.split(',').map(d => d.trim()).filter(Boolean);
        }

        // Сборка этапов
        const stageEls = el.querySelectorAll('.stage-item');
        const stages = Array.from(stageEls).map(se => ({
          id: se.dataset.stageId || uid(),
          threshold: parseInt(se.querySelector('.stage-threshold')?.value, 10) || 1,
          rewardText: String(se.querySelector('.stage-reward-text')?.value || '').trim(),
          rewardCoins: parseInt(se.querySelector('.stage-reward-coins')?.value, 10) || 0
        }));

        newTasks.push({
          ...existingTask, // Сохраняем оригинальный ID и другие свойства
          title: getTitle(),
          description: getDesc(),
          targetChecks: Math.max(1, getTarget()),
          schedule: { 
            mode: getMode(), 
            dates: tDates, 
            weekStartDay: getWeekDay()
          },
          baseRewardText: getRewardText(),
          baseRewardCoins: getRewardCoins(),
          stages: stages
        });
      });

      // Заменяем массив задач в стейте
      this.data.tasks = newTasks;

    } else if (this.currentTab === 'participants') {
      const checkedBoxes = container.querySelectorAll('#participants-list-container input[type="checkbox"]:checked');
      this.data.participantIds = Array.from(checkedBoxes).map(cb => cb.value);
    }
  }

  validate() {
    const errors = [];
    
    if (!this.data.title) errors.push('Название обязательно.');
    if (!this.data.startDate || !this.data.endDate) errors.push('Даты обязательны.');
    
    try {
        if (new Date(this.data.startDate) > new Date(this.data.endDate)) {
            errors.push('Дата окончания раньше начала.');
        }
    } catch(e) {
        errors.push('Неверный формат даты.');
    }

    if (this.data.tasks.length === 0) errors.push('Нужно хотя бы одно задание.');
    
    // Проверка целей заданий
    for (const task of this.data.tasks) {
       const allDates = getAllDatesInRange(this.data.startDate, this.data.endDate);
       const available = getAvailableCheckCount(task, allDates);
       
       const target = Number(task.targetChecks) || 0;
       
       if (target > available) {
         errors.push(`Цель "${task.title}" (${target}) превышает доступные дни (${available}).`);
       }
    }

    if (this.data.participantIds.length === 0 && this.currentTab === 'participants') {
       errors.push('Выберите хотя бы одного участника.');
    }

    return errors;
  }
}