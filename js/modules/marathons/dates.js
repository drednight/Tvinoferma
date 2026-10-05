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


/** Целых дней от `from` до `to` (YYYY-MM-DD, локальные даты). Отрицательное — `to` раньше. */
export function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

const daysWord = (n) => {
  const k = Math.abs(n) % 100;
  const d = k % 10;
  if (k > 10 && k < 20) return 'дней';
  if (d === 1) return 'день';
  if (d >= 2 && d <= 4) return 'дня';
  return 'дней';
};

/**
 * Подпись на карточке марафона: сколько осталось / когда начнётся / сколько прошло с конца.
 * Пустая строка — подписи нет (марафон отмечен завершённым или у него нет даты окончания).
 * @param {{ status?: string, startDate?: string, endDate?: string }} m
 * @param {string} today YYYY-MM-DD
 * @returns {{ text: string, tone: 'info' | 'warn' | 'late' | '' }}
 */
export function phaseHint(m, today) {
  if (!m || m.status === 'completed') return { text: '', tone: '' };
  if (m.startDate && today < m.startDate) {
    const n = daysBetween(today, m.startDate);
    return { text: n === 1 ? 'начнётся завтра' : `начнётся через ${n} ${daysWord(n)}`, tone: 'info' };
  }
  if (!m.endDate) return { text: '', tone: '' };
  const left = daysBetween(today, m.endDate);
  if (left < 0) {
    const n = -left;
    return { text: n === 1 ? 'закончился вчера' : `закончился ${n} ${daysWord(n)} назад`, tone: 'late' };
  }
  if (left === 0) return { text: 'последний день', tone: 'warn' };
  return { text: `осталось ${left} ${daysWord(left)}`, tone: left <= 2 ? 'warn' : 'info' };
}
