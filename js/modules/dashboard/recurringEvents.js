// js/modules/dashboard/recurringEvents.js
// @ts-check
// Постоянные игровые ивенты: повторяются каждую неделю в одно и то же время.
//
// Зачем: ивенты идут по расписанию, которое не меняется от недели к неделе, и держать их
// в ручных записях бессмысленно — их пришлось бы заводить заново каждый период. Здесь они
// описаны один раз, планировщик подмешивает их в нужные дни, а форма их не редактирует и не удаляет.
//
// Время указано по Москве (см. js/core/msk.js) — так же, как в игре.
//
// Модуль без DOM: на вход дата, на выход список ивентов. Поэтому он покрыт тестами.

import { weekdayOfDate } from '../../core/msk.js';

/**
 * Порядок дней недели — как в планировщике: 0 — понедельник … 6 — воскресенье
 * (`mskWeekday`, `Date.getDay()` от понедельника).
 */
export const WEEKDAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

/**
 * Постоянные ивенты. `days` — дни недели, `start`/`end` — московское время «ЧЧ:ММ»,
 * `end` = '24:00' означает «до конца суток».
 * @type {Array<{ id: string, title: string, days: number[], start: string, end: string, color: string, note: string }>}
 */
export const RECURRING_EVENTS = [
  {
    id: 'dynasty-battle',
    title: 'Битва Династий',
    days: [0, 4],   // понедельник и пятница
    start: '20:20',
    end: '22:20',
    color: 'red',
    note: 'Понедельник и пятница'
  },
  {
    id: 'guild-rhythm',
    title: 'Ритм Гильдии',
    days: [2],      // среда
    start: '19:30',
    end: '20:00',
    color: 'green',
    note: 'Среда'
  },
  {
    id: 'forbidden-teaching',
    title: 'Запретное учение',
    days: [2],      // среда
    start: '20:00',
    end: '21:30',
    color: 'purple',
    note: 'Среда'
  },
  {
    id: 'hero-arena',
    title: 'Арена Героев',
    days: [3],      // четверг
    start: '19:00',
    end: '24:00',
    color: 'yellow',
    note: 'Четверг'
  }
];

/** Ивент по идентификатору (нужен настройкам уведомлений и загрузке состояния). */
export function recurringEventById(id) {
  return RECURRING_EVENTS.find(e => e.id === id) || null;
}

/** Минуты от полуночи для «ЧЧ:ММ»; «24:00» → 1440 (конец суток). */
export function clockMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return 0;
  return Math.min(Number(m[1]) * 60 + Number(m[2]), 1440);
}

/**
 * Длительность ивента в минутах (для шкалы дня).
 */
export function recurringDurationMinutes(event) {
  if (!event) return 0;
  return Math.max(0, clockMinutes(event.end) - clockMinutes(event.start));
}

/**
 * Ивенты, которые идут в этот день.
 *
 * `date` — «ГГГГ-ММ-ДД». Записи планировщика те же поля, что у ручных: `id`, `title`, `date`,
 * `time`, `kind`, `color`, но `source: 'recurring'` — по нему форма понимает, что запись
 * нельзя редактировать или удалить.
 *
 * @param {string} date «ГГГГ-ММ-ДД»
 * @returns {Array<any>}
 */
export function recurringEventsForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return [];
  const weekday = weekdayOf(date);
  return RECURRING_EVENTS
    .filter(event => event.days.includes(weekday))
    .map(event => ({
      id: `recurring-${event.id}`,
      title: event.title,
      date,
      time: event.start,
      endTime: event.end,
      durationMinutes: recurringDurationMinutes(event),
      kind: 'event',
      priority: 'normal',
      color: event.color,
      colorKey: event.color,
      recurring: true,
      source: 'recurring',
      recurringId: event.id,
      note: event.note
    }));
}

/** День недели календарной даты в нумерации планировщика (0 — понедельник). */
export function weekdayOf(date) {
  return weekdayOfDate(date);
}

/** Список ивентов для настроек: подпись с днями и временем. */
export function recurringEventScheduleText(event) {
  const days = (event?.days || []).map(d => WEEKDAY_NAMES[d]).join(', ');
  return `${days}, ${event?.start}–${event?.end}`;
}
