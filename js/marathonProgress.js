// js/marathonProgress.js

import { getAllDatesInRange, isTaskActiveOnDate } from './marathonUtils.js';

/**
 * Рассчитывает статистику по всем заданиям для конкретного участника в рамках марафона.
 * @param {Object} marathon - Объект марафона
 * @param {string} characterId - ID персонажа-участника
 * @returns {Array<Object>} Массив результатов по каждому заданию
 */
export function calculateParticipantStats(marathon, characterId) {
  const allDates = getAllDatesInRange(marathon.startDate, marathon.endDate);
  
  return marathon.tasks.map(task => {
    // 1. Собираем все записи выполнения этого задания этим персонажем
    const records = marathon.records.filter(r => 
      r.characterId === characterId && 
      r.taskId === task.id &&
      r.completed === true // Учитываем только успешные отметки
    );

    const completedCount = records.length;
    
    // 2. Определяем доступное количество дней
    let availableDays = 0;
    if (task.schedule.mode === 'everyDay') {
      availableDays = allDates.length;
    } else if (task.schedule.mode === 'dates') {
      // Считаем только те даты из расписания, которые входят в диапазон марафона
      availableDays = task.schedule.dates.filter(d => allDates.includes(d)).length;
    }

    // 3. Расчет запасных дней (автоматически)
    // spareDays = available - target
    const target = Number(task.targetChecks) || 0;
    const theoreticalSpare = Math.max(0, availableDays - target);
    
    // Реальные пропуски: сколько раз НЕ отметили в доступные дни?
    // Но для награды важно просто соотношение completed vs target
    
    // 4. Определение достигнутого этапа
    // Ищем максимальный threshold, который <= completedCount
    const stages = [...(task.stages || [])].sort((a, b) => a.threshold - b.threshold);
    
    let reachedStageIndex = -1;
    for (let i = 0; i < stages.length; i++) {
      if (completedCount >= stages[i].threshold) {
        reachedStageIndex = i;
      } else {
        break; // Этапы идут по возрастанию, дальше смысла нет
      }
    }

    const reachedStage = reachedStageIndex !== -1 ? stages[reachedStageIndex] : null;
    
    // 5. Проверка условия допуска (пропуски > запасных?)
    // Пропуски = availableDays - completedCount
    const missedDays = Math.max(0, availableDays - completedCount);
    const isEligible = missedDays <= theoreticalSpare; 
    
    // Если задание еще активно (дата окончания не наступила), мы можем показывать "в процессе"
    const isFinished = new Date(marathon.endDate) < new Date();

    return {
      taskId: task.id,
      taskTitle: task.title,
      completedCount,
      target,
      availableDays,
      theoreticalSpare,
      missedDays,
      isEligible, // Можно ли получить награду за это задание
      reachedStage, // Какая награда получена (или null)
      stages, // Все этапы для прогресс-бара
      percentage: target > 0 ? Math.min(100, Math.round((completedCount / target) * 100)) : 0
    };
  });
}

/**
 * Общая сводка по марафону для KPI панели или шапки таблицы
 */
export function getMarathonSummary(marathon) {
  const statsPerCharacter = {};
  
  marathon.participantIds.forEach(charId => {
    statsPerCharacter[charId] = calculateParticipantStats(marathon, charId);
  });

  return {
    totalParticipants: marathon.participantIds.length,
    totalTasks: marathon.tasks.length,
    statsPerCharacter
  };
}