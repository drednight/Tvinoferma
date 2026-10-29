import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let adapter;
let state;
let secrets;
let storage;
let entries;
let invoke;
let previousTauri;
let events;

const json = (email, password) => JSON.stringify({ email, password, recoveryEmail: '', phone: '' });

beforeEach(async () => {
  vi.resetModules();
  adapter = {
    saveState: vi.fn(async () => true),
    restoreBackup: vi.fn(async () => true),
    loadState: vi.fn(async () => null),
    createBackup: vi.fn(async () => 'backup')
  };
  vi.doMock('../js/core/storageAdapters/tauriAdapter.js', () => ({ tauriAdapter: adapter }));
  vi.doMock('../js/core/storageAdapters/localStorageAdapter.js', () => ({ localStorageAdapter: adapter }));
  previousTauri = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  entries = new Map([['hero', json('user@example.test', 'PRIVATE-OLD')]]);
  invoke = vi.fn(async (command, args = {}) => {
    if (command === 'secrets_available') return true;
    if (command === 'secrets_get_many') {
      return Object.fromEntries(args.keys.filter(key => entries.has(key)).map(key => [key, entries.get(key)]));
    }
    if (command === 'secrets_set_many') {
      for (const [id, value] of Object.entries(args.items)) value ? entries.set(id, value) : entries.delete(id);
      return null;
    }
    if (command === 'secrets_delete_many') {
      args.keys.forEach(id => entries.delete(id));
      return null;
    }
    throw new Error('unexpected fake command');
  });
  ({ state } = await import('../js/core/state.js'));
  state.settings.security = { useVault: true };
  state.characters = [
    { id: 'hero', nick: 'Hero', contacts: { email: '', password: '', recoveryEmail: '', phone: '' } }
  ];
  state.archivedCharacters = [];
  secrets = await import('../js/core/secrets.js');
  secrets.__setInvoke(invoke);
  await secrets.hydrateSecrets(state.characters, { requiresVault: true });
  storage = await import('../js/core/storage.js');
  events = [];
  window.addEventListener('tf-storage-uncertain', recordEvent);
});

function recordEvent(event) {
  events.push(event.detail);
}

afterEach(() => {
  window.removeEventListener('tf-storage-uncertain', recordEvent);
  window.__TAURI_INTERNALS__ = previousTauri;
  vi.doUnmock('../js/core/storageAdapters/tauriAdapter.js');
  vi.doUnmock('../js/core/storageAdapters/localStorageAdapter.js');
  vi.restoreAllMocks();
});

describe('совместная граница сохранения state и контактов', () => {
  it('сначала сверяет и перечитывает vault, затем сохраняет state без контактов', async () => {
    state.characters[0].contacts.password = 'PRIVATE-NEW';
    await storage.persist();
    const names = invoke.mock.calls.map(([command]) => command);
    expect(names).toEqual([
      'secrets_available',
      'secrets_get_many',
      'secrets_get_many',
      'secrets_set_many',
      'secrets_get_many'
    ]);
    expect(JSON.parse(entries.get('hero')).password).toBe('PRIVATE-NEW');
    expect(adapter.saveState).toHaveBeenCalledTimes(1);
    expect(adapter.saveState.mock.calls[0][0].characters[0].contacts).toBeNull();
    expect(JSON.stringify(adapter.saveState.mock.calls[0][0])).not.toContain('PRIVATE-NEW');
    expect(events).toEqual([]);
  });

  it('блокирует последующие записи и восстановление, если state отклонён после изменения vault', async () => {
    state.characters[0].contacts.password = 'PRIVATE-NEW';
    adapter.saveState.mockRejectedValueOnce(new Error('TF_STATE_WRITE_UNCHANGED: PRIVATE-PATH'));
    const error = await storage.persist().catch(e => e);
    expect(error.message).toContain('TF_VAULT_WRITE_UNCERTAIN:');
    expect(error.message).not.toContain('PRIVATE');
    expect(JSON.parse(entries.get('hero')).password).toBe('PRIVATE-NEW');
    expect(events).toEqual([{ source: 'vault' }]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    expect(adapter.saveState).toHaveBeenCalledTimes(1);
    expect(adapter.restoreBackup).not.toHaveBeenCalled();
  });

  it('не пишет state, если vault изменился после загрузки', async () => {
    state.characters[0].contacts.password = 'PRIVATE-LOCAL';
    entries.set('hero', json('external@example.test', 'PRIVATE-EXTERNAL'));
    await expect(storage.persist()).rejects.toThrow('TF_VAULT_WRITE_UNCERTAIN:');
    expect(adapter.saveState).not.toHaveBeenCalled();
    expect(JSON.parse(entries.get('hero')).password).toBe('PRIVATE-EXTERNAL');
    expect(events).toEqual([{ source: 'vault' }]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не повторяет неизвестную частичную запись vault и не посылает снимок state', async () => {
    secrets.__setInvoke(async (command, args) => {
      if (command === 'secrets_available') return true;
      if (command === 'secrets_get_many')
        return Object.fromEntries(args.keys.filter(id => entries.has(id)).map(id => [id, entries.get(id)]));
      if (command === 'secrets_set_many') {
        for (const [id, value] of Object.entries(args.items)) entries.set(id, value);
        throw new Error('PRIVATE-AFTER-WRITE');
      }
      return null;
    });
    await secrets.hydrateSecrets(state.characters, { requiresVault: true });
    state.characters[0].contacts.password = 'PRIVATE-NEW';
    await expect(storage.persist()).rejects.toThrow('TF_VAULT_WRITE_UNCERTAIN:');
    expect(adapter.saveState).not.toHaveBeenCalled();
    expect(JSON.parse(entries.get('hero')).password).toBe('PRIVATE-NEW');
    expect(events).toEqual([{ source: 'vault' }]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не блокирует обычный подтверждённый отказ state, если vault не менялся', async () => {
    adapter.saveState.mockRejectedValueOnce(new Error('TF_STATE_WRITE_UNCHANGED: no write'));
    await expect(storage.persist()).rejects.toThrow('no write');
    await expect(storage.persist()).resolves.toBeUndefined();
    expect(adapter.saveState).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });
});
