// Данные месячного планера: ручные записи, события приложения и постоянные ивенты.

import { mskDate } from '../../core/msk.js';
import { recurringEventsForDate } from './recurringEvents.js';
import { DEFAULT_DURATION_MINUTES } from './timeline.js';

const COLORS = new Set(['blue', 'green', 'yellow', 'red', 'purple', 'gray']);
const PRIORITIES = new Set(['low', 'normal', 'high']);
const KINDS = new Set(['task', 'event', 'note']);
const RECURRENCES = new Set(['none', 'daily', 'weekly', 'monthly']);
const STATUSES = new Set(['todo', 'doing', 'done']);

/** Порядок статусов в списке дел: сначала то, над чем работают, потом ожидающее, в конце выполненное. */
const STATUS_ORDER = { doing: 0, todo: 1, done: 2 };

/**
 * Статус записи в списке задач на день.
 *
 * Это поле, а не вывод из галочки: «в работе» нельзя получить из «выполнено» — это
 * промежуточное состояние, и без него лист выродился бы в обычный чек-лист.
 * Старое булево `done` из сохранённых данных переносится сюда один раз при нормализации,
 * поэтому два источника истины не заводятся.
 *
 * @param {{ status?: string, done?: boolean }} [input]
 * @returns {'todo'|'doing'|'done'}
 */
export function entryStatus(input = {}) {
  if (STATUSES.has(input.status)) return String(input.status);
  return input.done === true ? 'done' : 'todo';
}

/** Запись выполнена. Единственный ответ на вопрос «а не сделано ли это». */
export function isEntryDone(entry) {
  return entry?.status === 'done';
}

/**
 * Календарная дата записи. Считается по Москве: у пользователя в другом часовом поясе
 * «сегодня» в планировщике должно совпадать с игровым днём (см. js/core/msk.js).
 */
export function localDate(value = new Date()) {
  return mskDate(value);
}

export function normalizePlannerEntry(input = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : localDate();
  const duration = Math.round(Number(input.durationMinutes));
  return {
    id: String(input.id || crypto.randomUUID?.() || `planner-${Date.now()}`),
    title: String(input.title || '').trim().slice(0, 160),
    date,
    time: /^\d{2}:\d{2}$/.test(String(input.time || '')) ? String(input.time) : '',
    // Длительность нужна шкале дня: высота блока = сколько идёт запись
    durationMinutes: Number.isFinite(duration) && duration > 0 ? Math.min(duration, 1440) : DEFAULT_DURATION_MINUTES,
    kind: KINDS.has(input.kind) ? input.kind : 'task',
    priority: PRIORITIES.has(input.priority) ? input.priority : 'normal',
    reminderMinutes: Math.max(0, Math.round(Number(input.reminderMinutes) || 0)),
    recurrence: RECURRENCES.has(input.recurrence) ? input.recurrence : 'none',
    recurrenceEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(input.recurrenceEnd || '')) ? String(input.recurrenceEnd) : '',
    color: COLORS.has(input.color) ? input.color : 'blue',
    status: entryStatus(input),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

export function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = Array(mondayOffset).fill(null);
  // Дата собирается строкой, а не через `Date` в местном поясе: иначе на машине не в Москве
  // ячейка первого числа уехала бы на день назад
  const prefix = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-`;
  for (let day = 1; day <= last.getDate(); day++) {
    cells.push(`${prefix}${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}

function occursOn(entry, date) {
  if (!entry?.date || date < entry.date) return false;
  if (entry.recurrenceEnd && date > entry.recurrenceEnd) return false;
  if (entry.recurrence === 'none') return date === entry.date;
  const start = new Date(`${entry.date}T00:00:00`);
  const current = new Date(`${date}T00:00:00`);
  const days = Math.round((current - start) / 86400000);
  if (entry.recurrence === 'daily') return days >= 0;
  if (entry.recurrence === 'weekly') return days >= 0 && days % 7 === 0;
  return entry.recurrence === 'monthly' && current.getDate() === start.getDate();
}

export function plannerEventsForDate(appState, date) {
  const manual = (appState?.plannerEntries || [])
    .filter(entry => occursOn(entry, date))
    .map(entry => ({ ...entry, source: 'manual' }));
  const marathons = (appState?.marathons || [])
    .filter(m => m?.kind !== 'series' && m?.status !== 'completed' && m.startDate && m.endDate
      && date >= m.startDate && date <= m.endDate)
    .map(m => ({
      id: `marathon-${m.id}`,
      title: m.title || 'Марафон',
      date,
      kind: 'event',
      priority: date === m.endDate ? 'high' : 'normal',
      color: 'purple',
      source: 'marathon',
      marathonId: m.id,
      phase: date === m.startDate ? 'start' : date === m.endDate ? 'end' : 'active'
    }));
  // Постоянные ивенты приходят из расписания, а не из состояния: их нельзя изменить или удалить
  const recurring = recurringEventsForDate(date);
  return [...manual, ...recurring, ...marathons].sort((a, b) =>
    // У псевдо-записей марафонов и постоянных ивентов статуса нет — они попадают в середину
    (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1)
    || ({ high: 0, normal: 1, low: 2 }[a.priority] ?? 1) - ({ high: 0, normal: 1, low: 2 }[b.priority] ?? 1)
    || String(a.time || '').localeCompare(String(b.time || ''))
    || a.title.localeCompare(b.title, 'ru'));
}
