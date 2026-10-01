// js/modules/marathons/dates.js

/**
 * Получает список всех дат между start и end включительно (YYYY-MM-DD)
 * ИСПРАВЛЕНО: Использование локального времени вместо UTC
 */
export function getAllDatesInRange(startStr, endStr) {
  const dates = [];
  
  // Парсим строки YYYY-MM-DD в объекты Date (локальное время)
  let current = new Date(startStr + 'T00:00:00'); 
  const end = new Date(endStr + 'T00:00:00');
  
  // Копируем даты, чтобы не мутировать оригиналы
  const tempCurrent = new Date(current);
  const tempEnd = new Date(end);

  while (tempCurrent <= tempEnd) {
    // Форматируем обратно в YYYY-MM-DD без смещения UTC
    const year = tempCurrent.getFullYear();
    const month = String(tempCurrent.getMonth() + 1).padStart(2, '0');
    const day = String(tempCurrent.getDate()).padStart(2, '0');
    
    dates.push(`${year}-${month}-${day}`);
    
    // Добавляем один день
    tempCurrent.setDate(tempCurrent.getDate() + 1);
  }
  
  return dates;
}

/**
 * Рассчитывает количество доступных дат для конкретного задания
 */
/**
 * Проверяет, является ли дата активной для данного задания
 */
export function isTaskActiveOnDate(task, dateStr, allMarathonDates) {
  if (!allMarathonDates.includes(dateStr)) return false;
  
  if (task.schedule.mode === 'everyDay') return true;
  
  if (task.schedule.mode === 'dates') {
    return task.schedule.dates.includes(dateStr);
  }

  if (task.schedule.mode === 'weekly') {
    const targetWeekday = Number(task.schedule.weekStartDay ?? 1);
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDay() === targetWeekday;
  }
  
  return false;
}
