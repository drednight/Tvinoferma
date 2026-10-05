// Данные месячного планера: ручные записи и события приложения.

const COLORS = new Set(['blue', 'green', 'yellow', 'red', 'purple', 'gray']);
const PRIORITIES = new Set(['low', 'normal', 'high']);
const KINDS = new Set(['task', 'event', 'note']);
const RECURRENCES = new Set(['none', 'daily', 'weekly', 'monthly']);

export function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv');
}

export function normalizePlannerEntry(input = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : localDate();
  return {
    id: String(input.id || crypto.randomUUID?.() || `planner-${Date.now()}`),
    title: String(input.title || '').trim().slice(0, 160),
    date,
    time: /^\d{2}:\d{2}$/.test(String(input.time || '')) ? String(input.time) : '',
    kind: KINDS.has(input.kind) ? input.kind : 'task',
    priority: PRIORITIES.has(input.priority) ? input.priority : 'normal',
    reminderMinutes: Math.max(0, Math.round(Number(input.reminderMinutes) || 0)),
    recurrence: RECURRENCES.has(input.recurrence) ? input.recurrence : 'none',
    recurrenceEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(input.recurrenceEnd || '')) ? String(input.recurrenceEnd) : '',
    color: COLORS.has(input.color) ? input.color : 'blue',
    done: input.done === true,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

export function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = Array(mondayOffset).fill(null);
  for (let day = 1; day <= last.getDate(); day++) {
    cells.push(localDate(new Date(year, month, day)));
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
  return [...manual, ...marathons].sort((a, b) =>
    (a.done === true) - (b.done === true)
    || ({ high: 0, normal: 1, low: 2 }[a.priority] ?? 1) - ({ high: 0, normal: 1, low: 2 }[b.priority] ?? 1)
    || String(a.time || '').localeCompare(String(b.time || ''))
    || a.title.localeCompare(b.title, 'ru'));
}
