import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve;
  const promise = new Promise(yes => (resolve = yes));
  return { promise, resolve };
}

let state;
let storage;
let adapter;
const STATE_KEY = 'tvinoferma_state_v1';

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  ({ state } = await import('../js/core/state.js'));
  ({ localStorageAdapter: adapter } = await import('../js/core/storageAdapters/localStorageAdapter.js'));
  storage = await import('../js/core/storage.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('очередь копирования с настоящим browser-адаптером', () => {
  it('копирует сохранённое состояние, а запрошенную во время копии правку записывает после неё', async () => {
    state.settings.backups = { maxCount: 10 };
    state.characters = [{ id: 'fictional', nick: 'Старое имя' }];
    await storage.persist();
    const preceding = localStorage.getItem(STATE_KEY);
    const gate = deferred();
    const originalCreate = adapter.createBackup.bind(adapter);
    const creating = vi.spyOn(adapter, 'createBackup').mockImplementation(async options => {
      await gate.promise;
      return originalCreate(options);
    });
    const copying = storage.createBackup('manual');
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
    state.characters[0].nick = 'Новое имя';
    const saving = storage.persist();
    expect(localStorage.getItem(STATE_KEY)).toBe(preceding);
    gate.resolve();
    const backup = await copying;
    await saving;
    expect(JSON.parse(localStorage.getItem(backup)).characters[0].nick).toBe('Старое имя');
    expect(JSON.parse(localStorage.getItem(STATE_KEY)).characters[0].nick).toBe('Новое имя');
  });

  it('после неудачного копирования ожидающее сохранение всё равно записывается', async () => {
    state.characters = [{ id: 'fictional', nick: 'До' }];
    await storage.persist();
    const gate = deferred();
    vi.spyOn(adapter, 'createBackup').mockImplementation(async () => {
      await gate.promise;
      throw new Error('PRIVATE');
    });
    const copying = storage.createBackup('manual');
    const failure = copying.catch(error => error);
    await vi.waitFor(() => expect(adapter.createBackup).toHaveBeenCalledOnce());
    state.characters[0].nick = 'После';
    const saving = storage.persist();
    gate.resolve();
    const error = await failure;
    expect(error.message).not.toContain('PRIVATE');
    await saving;
    expect(JSON.parse(localStorage.getItem(STATE_KEY)).characters[0].nick).toBe('После');
    expect(await adapter.listBackups()).toEqual([]);
  });
});
