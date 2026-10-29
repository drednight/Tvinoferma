import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  modal: null,
  compare: vi.fn(),
  persist: vi.fn(async () => {}),
  backup: vi.fn(async () => 'test-backup'),
  toast: vi.fn()
}));
vi.mock('../js/core/storage.js', () => ({
  saveNow: vi.fn(async () => {}),
  createBackup: mocks.backup,
  forceRenderAndPersist: mocks.persist,
  assertStateWriteAvailable: vi.fn(),
  haltAfterPartialStateChange: vi.fn(),
  isTauri: () => false
}));
vi.mock('../js/core/ui.js', () => ({
  showModal: options => {
    mocks.modal = options;
  },
  toast: mocks.toast
}));
vi.mock('../js/data/compare.js', () => ({ openCompareDialog: mocks.compare }));

import { state, normalizeState } from '../js/core/state.js';
import { createMarathon } from '../js/modules/marathons/model.js';
import { openImportDialog, preserveImportedMarathonIdentity } from '../js/data/import.js';

const ids = [
  'a9115bf2-e834-444d-aeb6-7c3af1db8890',
  'b9115bf2-e834-444d-aeb6-7c3af1db8890',
  'c9115bf2-e834-444d-aeb6-7c3af1db8890',
  'd9115bf2-e834-444d-aeb6-7c3af1db8890',
  'e9115bf2-e834-444d-aeb6-7c3af1db8890'
];
function marathon(sync = true) {
  return createMarathon({
    id: 'm',
    ...(sync ? { syncId: ids[0] } : {}),
    title: 'Марафон',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks: [
      {
        id: 't',
        ...(sync ? { syncId: ids[1] } : {}),
        title: 'Задание',
        rewards: [{ id: 'r', ...(sync ? { syncId: ids[2] } : {}), threshold: 1 }]
      }
    ],
    bonuses: [{ id: 'b', ...(sync ? { syncId: ids[3] } : {}), needTasks: 1, text: 'Бонус' }]
  });
}
const selection = cmp => ({ get: () => 'merge', getAll: key => (key === 'cmp' ? cmp : key === 'add' ? ['new'] : []) });

beforeEach(() => {
  Object.assign(state, normalizeState({ schemaVersion: 10 }));
  mocks.modal = null;
  mocks.compare.mockReset();
  mocks.persist.mockClear();
  mocks.backup.mockClear();
  mocks.toast.mockClear();
});

describe('идентичность при обычном импорте', () => {
  it('старый файл обновляет существующий марафон, не теряя его sync-ID и вложенные ID', () => {
    const local = marathon();
    const incoming = marathon(false);
    incoming.title = 'Новые данные';
    incoming.tasks.push({ ...incoming.tasks[0], id: 'new-task', rewards: [] });
    const before = JSON.stringify([local, incoming]);
    const result = preserveImportedMarathonIdentity(local, incoming);
    expect(result).toMatchObject({
      syncId: ids[0],
      title: 'Новые данные',
      tasks: [{ syncId: ids[1], rewards: [{ syncId: ids[2] }] }, { id: 'new-task' }],
      bonuses: [{ syncId: ids[3] }]
    });
    expect(result.tasks[1]).not.toHaveProperty('syncId');
    expect(JSON.stringify([local, incoming])).toBe(before);
  });
  it('не принимает подмену родительского или вложенного sync-ID и неоднозначные локальные ID', () => {
    const local = marathon();
    const incoming = marathon();
    incoming.tasks[0].rewards[0].syncId = ids[4];
    expect(() => preserveImportedMarathonIdentity(local, incoming)).toThrow();
    incoming.tasks[0].rewards[0].syncId = ids[2];
    incoming.syncId = ids[4];
    expect(() => preserveImportedMarathonIdentity(local, incoming)).toThrow();
    incoming.syncId = ids[0];
    incoming.tasks.push(structuredClone(incoming.tasks[0]));
    expect(() => preserveImportedMarathonIdentity(local, incoming)).toThrow();
  });
  it('через диалог «Оставить обе» создаёт новую карточку без чужого sync-ID', async () => {
    state.characters = normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'hero', nick: 'Герой', level: 10, syncId: ids[0] }]
    }).characters;
    mocks.compare.mockResolvedValue({ action: 'both' });
    openImportDialog({ schemaVersion: 10, characters: [{ id: 'hero', nick: 'Герой', level: 20, syncId: ids[0] }] });
    await mocks.modal.onSubmit(selection(['hero']));
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    expect(state.characters).toHaveLength(2);
    expect(state.characters[0].syncId).toBe(ids[0]);
    expect(state.characters[1]).not.toHaveProperty('syncId');
    expect(state.characters[1].id).not.toBe('hero');
  });
  it('при конфликте идентичности марафона отменяет импорт целиком до изменений и сохранения', async () => {
    state.marathons = [marathon()];
    const incoming = marathon();
    incoming.syncId = ids[4];
    incoming.updatedAt = '2030-01-01T00:00:00Z';
    const before = JSON.stringify(state.marathons);
    openImportDialog({ schemaVersion: 10, characters: [{ id: 'new', nick: 'Новый' }], marathons: [incoming] });
    await mocks.modal.onSubmit(selection([]));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Импорт отменён'), 'error');
    expect(state.characters).toEqual([]);
    expect(JSON.stringify(state.marathons)).toBe(before);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
  });
});
