// @ts-check
// Только явные поля записи календаря; пути, токены и новые неизвестные поля отклоняются.
import { CLAN_ENTRY_PREFIX } from '../guild/core.js';
import { isSyncId } from './envelope.js';
import { dictionary, invalidExport, number, object, oneOf, text } from './exportSchema.js';

const KEYS = [
  'id',
  'title',
  'date',
  'time',
  'durationMinutes',
  'kind',
  'priority',
  'reminderMinutes',
  'recurrence',
  'recurrenceEnd',
  'color',
  'status',
  'statusByDate',
  'createdAt',
  'updatedAt'
];
const STATUSES = ['todo', 'doing', 'done'];

/** @param {{ syncId?: string }} [options] */
export function exportPlannerEntry(entry, options = {}) {
  const opts = object(options, ['syncId']);
  if (!isSyncId(opts.syncId)) throw invalidExport();
  const data = object(entry, [...KEYS, 'syncId']);
  if (!text(data.id) || data.syncId !== opts.syncId) throw invalidExport();
  // Клановая запись узнаётся по site event ID в локальном id. Без него на втором ПК
  // календарь счёл бы её ручной, а сверка с сайтом создала бы дубликат.
  /** @type {{kind: 'manual'} | {kind: 'guild', eventId: string}} */
  let source = { kind: 'manual' };
  if (data.id.startsWith(CLAN_ENTRY_PREFIX)) {
    const eventId = data.id.slice(CLAN_ENTRY_PREFIX.length);
    if (!/^[a-z0-9_-]{1,100}$/i.test(eventId)) throw invalidExport();
    source = { kind: 'guild', eventId };
  }
  return {
    id: opts.syncId,
    type: 'plannerEntry',
    fields: {
      title: text(data.title),
      source,
      date: text(data.date),
      time: text(data.time),
      durationMinutes: number(data.durationMinutes),
      kind: oneOf(data.kind, ['task', 'event', 'note']),
      priority: oneOf(data.priority, ['low', 'normal', 'high']),
      reminderMinutes: number(data.reminderMinutes),
      recurrence: oneOf(data.recurrence, ['none', 'daily', 'weekly', 'monthly']),
      recurrenceEnd: text(data.recurrenceEnd),
      color: oneOf(data.color, ['blue', 'green', 'yellow', 'red', 'purple', 'gray']),
      status: oneOf(data.status, STATUSES),
      statusByDate: dictionary(
        data.statusByDate,
        key => /^\d{4}-\d{2}-\d{2}$/.test(key),
        value => oneOf(value, STATUSES)
      ),
      createdAt: text(data.createdAt),
      updatedAt: text(data.updatedAt)
    }
  };
}
