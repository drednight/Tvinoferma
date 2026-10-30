import { describe, expect, it, vi } from 'vitest';
import { normalizeArchivedParty, normalizeParty } from '../js/core/state/party.js';
import { normalizePlannerEntry } from '../js/modules/dashboard/planner.js';
import { exportParty } from '../js/modules/cloudSync/partyExport.js';
import { exportPlannerEntry } from '../js/modules/cloudSync/plannerExport.js';

const partyId = '8cd68f9b-900f-4efe-91f3-028fca46b6db';
const charId = '9cd68f9b-900f-4efe-91f3-028fca46b6db';
const entryId = 'bcd68f9b-900f-4efe-91f3-028fca46b6db';
const chars = new Map([['local-hero', charId]]);
const opts = { syncId: partyId, characterSyncIds: chars };
const date = '2026-10-28T12:00:00.000Z';

function party() {
  return normalizeParty({
    id: 'local-private-party-id',
    syncId: partyId,
    name: 'Альфа',
    order: 3,
    color: '#1a2b3c',
    createdAt: date,
    updatedAt: date
  });
}
function entry() {
  return normalizePlannerEntry({
    id: 'local-private-entry-id',
    syncId: entryId,
    title: 'Пример',
    date: '2026-10-28',
    time: '19:30',
    durationMinutes: 60,
    kind: 'task',
    priority: 'high',
    reminderMinutes: 15,
    recurrence: 'weekly',
    recurrenceEnd: '2026-12-30',
    color: 'purple',
    status: 'doing',
    statusByDate: { '2026-11-04': 'done' },
    createdAt: date,
    updatedAt: date
  });
}

describe('экспорт пати', () => {
  it('сохраняет разрешённые поля, но не отправляет локальный id', () => {
    const source = party();
    const before = JSON.stringify(source);
    const result = exportParty(source, opts);
    expect(result).toEqual({
      id: partyId,
      type: 'party',
      archived: false,
      fields: { name: 'Альфа', order: 3, color: '#1a2b3c', createdAt: date, updatedAt: date, memberLinks: [] }
    });
    expect(JSON.stringify(result)).not.toContain(source.id);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('не теряет участников архивной пати и заменяет ссылки на sync-ID', () => {
    const source = normalizeArchivedParty({
      ...party(),
      memberLinks: [{ characterId: 'local-hero', isMain: true, order: 4 }]
    });
    const result = exportParty(source, { ...opts, archived: true });
    expect(result.archived).toBe(true);
    expect(result.fields.memberLinks).toEqual([{ characterId: charId, isMain: true, order: 4 }]);
    expect(JSON.stringify(result)).not.toContain('local-hero');
  });

  it('проверяет все связи и не превращает ошибку в пустой состав', () => {
    const source = normalizeArchivedParty({ ...party(), memberLinks: [{ characterId: 'local-hero', isMain: true }] });
    expect(() => exportParty(source, { syncId: partyId, characterSyncIds: new Map(), archived: true })).toThrow(
      'участников'
    );
    source.memberLinks.push({ ...source.memberLinks[0] });
    expect(() => exportParty(source, { ...opts, archived: true })).toThrow('участников');
    expect(() => exportParty(party(), { ...opts, archived: true })).toThrow();
  });

  it('не берёт произвольные данные или неверный ранее назначенный id', () => {
    expect(() => exportParty({ ...party(), token: 'secret' }, opts)).toThrow();
    expect(() => exportParty({ ...party(), syncId: entryId }, opts)).toThrow();
    const unassigned = party();
    delete unassigned.syncId;
    expect(() => exportParty(unassigned, opts)).toThrow();
    expect(() => exportParty({ ...party(), color: 'url(private)' }, opts)).toThrow();
  });

  it('не исполняет getter и не меняет исходный состав', () => {
    const source = party();
    const getter = vi.fn(() => 'private');
    Object.defineProperty(source, 'name', { enumerable: true, get: getter });
    expect(() => exportParty(source, opts)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('экспорт календаря', () => {
  it('сохраняет повтор, статус в конкретные дни и напоминание без локального id', () => {
    const source = entry();
    const result = exportPlannerEntry(source, { syncId: entryId });
    expect(result).toMatchObject({
      id: entryId,
      type: 'plannerEntry',
      fields: {
        title: 'Пример',
        source: { kind: 'manual' },
        time: '19:30',
        reminderMinutes: 15,
        recurrence: 'weekly',
        statusByDate: { '2026-11-04': 'done' }
      }
    });
    expect(JSON.stringify(result)).not.toContain(source.id);
    expect(result.fields).not.toHaveProperty('syncId');
  });

  it('отличает записи кланового сайта от ручных, не копируя ответ на сайте', () => {
    const source = { ...entry(), id: 'guild-462', kind: 'event', status: 'done' };
    const result = exportPlannerEntry(source, { syncId: entryId });
    expect(result.fields).toMatchObject({ source: { kind: 'guild', eventId: '462' }, status: 'done' });
    expect(JSON.stringify(result)).not.toContain('guild-462');
    expect(result.fields).not.toHaveProperty('response');
    expect(() => exportPlannerEntry({ ...source, id: 'guild-' }, { syncId: entryId })).toThrow();
    expect(() => exportPlannerEntry({ ...source, id: 'guild-462/unsafe' }, { syncId: entryId })).toThrow();
  });

  it('не принимает секреты, лишние поля и незнакомые статусы', () => {
    expect(() => exportPlannerEntry({ ...entry(), accessToken: 'secret' }, { syncId: entryId })).toThrow();
    expect(() => exportPlannerEntry({ ...entry(), status: 'other' }, { syncId: entryId })).toThrow();
    expect(() => exportPlannerEntry({ ...entry(), statusByDate: { private: 'done' } }, { syncId: entryId })).toThrow();
    expect(() => exportPlannerEntry({ ...entry(), syncId: partyId }, { syncId: entryId })).toThrow();
    const unassigned = entry();
    delete unassigned.syncId;
    expect(() => exportPlannerEntry(unassigned, { syncId: entryId })).toThrow();
  });

  it('не читает getter в словаре состояний повторов', () => {
    const source = entry();
    const getter = vi.fn(() => 'done');
    Object.defineProperty(source.statusByDate, '2026-11-05', { enumerable: true, get: getter });
    expect(() => exportPlannerEntry(source, { syncId: entryId })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('возвращает независимую копию состояний, не меняя календарь', () => {
    const source = entry();
    const result = exportPlannerEntry(source, { syncId: entryId });
    result.fields.statusByDate['2026-11-04'] = 'todo';
    expect(source.statusByDate['2026-11-04']).toBe('done');
  });
});
