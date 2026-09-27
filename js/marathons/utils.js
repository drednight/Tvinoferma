// js/marathons/utils.js
import { getAllDatesInRange, getAvailableCheckCount } from '../marathonUtils.js';

/**
 * Рассчитывает запасные дни для конкретного задания
 */
export function calculateSpareDays(task, startDate, endDate) {
  const allDates = getAllDatesInRange(startDate, endDate);
  const available = getAvailableCheckCount(task, allDates);
  const target = Number(task.targetChecks) || 0;
  
  return Math.max(0, available - target);
}

/**
 * Проверяет, валидно ли задание (цель <= доступных дней)
 */
export function isTaskValid(task, startDate, endDate) {
  const allDates = getAllDatesInRange(startDate, endDate);
  const available = getAvailableCheckCount(task, allDates);
  const target = Number(task.targetChecks) || 0;
  
  return target <= available;
}