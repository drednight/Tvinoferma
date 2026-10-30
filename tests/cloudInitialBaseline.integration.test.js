import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const KEY = 'tvinoferma_state_v1';
async function fixture({ identities = true } = {}) {
  vi.resetModules();
  localStorage.clear();
  const { state, normalizeState } = await import('../js/core/state.js');
  const storage = await import('../js/core/storage.js');
  const { localStorageAdapter: adapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
  const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
  const { captureInitialCloudBaseline } = await import('../js/modules/cloudSync/initialCloudBaseline.js');
  Object.assign(
    state,
    normalizeState({
      schemaVersion: 10,
      characters: [
        {
          id: 'local-hero',
          nick: 'Герой',
          notes: 'Локальная заметка',
          contacts: { password: 'PRIVATE_PASSWORD', email: 'private@example.test' },
          launch: { gcPath: '/private/local' }
        }
      ],
      plannerEntries: [{ id: 'local-task', title: 'Локальная задача', date: '2026-10-28', kind: 'task' }],
      settings: { security: { useVault: false } }
    })
  );
  if (identities) {
    const { ui, ...snapshot } = state;
    Object.assign(state, planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
  }
  await storage.saveNow();
  return { state, storage, adapter, captureInitialCloudBaseline, oldRaw: localStorage.getItem(KEY) };
}
beforeEach(() => vi.restoreAllMocks());

describe('точная локальная копия перед первичной настройкой облака', () => {
  it('делает копию точного сохранённого state, не включает контакты в снимок и разблокирует сохранение', async () => {
    const f = await fixture();
    const baseline = await f.captureInitialCloudBaseline();
    expect(baseline.status).toBe('ready');
    expect(localStorage.getItem(baseline.backup)).toBe(f.oldRaw);
    const publicText = JSON.stringify(baseline.getPublicSnapshot());
    expect(publicText).toContain('Локальная заметка');
    expect(publicText).not.toContain('PRIVATE_PASSWORD');
    expect(publicText).not.toContain('private@example.test');
    expect(publicText).not.toContain('/private/local');
    expect(await baseline.stillCurrentAndSaved()).toBe(true);
    baseline.close();
    expect(await baseline.stillCurrentAndSaved()).toBe(false);
    expect(() => baseline.getPublicSnapshot()).toThrow();
    f.state.characters[0].notes = 'После копии';
    await f.storage.saveNow();
    expect(JSON.parse(localStorage.getItem(KEY)).characters[0].notes).toBe('После копии');
  });

  it('отказывается от неподготовленных ID и отметки выборочного применения до копирования', async () => {
    const f = await fixture({ identities: false });
    expect(await f.captureInitialCloudBaseline()).toEqual({ status: 'data_unprepared' });
    expect(await f.adapter.listBackups()).toEqual([]);
    const { stageSyncIdentities } = await import('../js/modules/cloudSync/commitSyncIdentities.js');
    expect((await stageSyncIdentities({ cryptoSource: webcrypto }).operation.commit({ confirmed: true })).status).toBe(
      'applied'
    );
    const oldCopies = await f.adapter.listBackups();
    f.state.settings.cloudSyncPendingApply = { version: 999, events: [] };
    await f.storage.saveNow();
    expect(await f.captureInitialCloudBaseline()).toEqual({ status: 'data_unprepared' });
    expect(await f.adapter.listBackups()).toEqual(oldCopies);
  });

  it('не копирует несохранённую память или изменённый другой программой файл', async () => {
    const f = await fixture();
    f.state.characters[0].notes = 'Несохранённая правка';
    expect(await f.captureInitialCloudBaseline()).toEqual({ status: 'disk_changed_or_unsaved' });
    expect(await f.adapter.listBackups()).toEqual([]);
    f.state.characters[0].notes = 'Локальная заметка';
    const changed = JSON.parse(f.oldRaw);
    changed.characters[0].notes = 'Другой процесс';
    localStorage.setItem(KEY, JSON.stringify(changed));
    expect(await f.captureInitialCloudBaseline()).toEqual({ status: 'disk_changed_or_unsaved' });
    expect(await f.adapter.listBackups()).toEqual([]);
  });

  it('обнаруживает изменение памяти и диска после копирования', async () => {
    const f = await fixture();
    const first = await f.captureInitialCloudBaseline();
    expect(await first.stillCurrentAndSaved()).toBe(true);
    f.state.characters[0].notes = 'Поздняя правка';
    expect(await first.stillCurrentAndSaved()).toBe(false);
    f.state.characters[0].notes = 'Локальная заметка';
    const changed = JSON.parse(f.oldRaw);
    changed.characters[0].notes = 'Другой процесс';
    localStorage.setItem(KEY, JSON.stringify(changed));
    expect(await first.stillCurrentAndSaved()).toBe(false);
    first.close();
  });

  it('если копия не подтверждена, не возвращает снимок и останавливает запись до перезапуска', async () => {
    const f = await fixture();
    vi.spyOn(f.adapter, 'createMigrationBackup').mockRejectedValue(new Error('PRIVATE PATH'));
    expect(await f.captureInitialCloudBaseline()).toEqual({ status: 'backup_unconfirmed_restart' });
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    await expect(f.storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('если память меняется во время копирования, оставляет копию и останавливает запись', async () => {
    const f = await fixture();
    let release;
    let started;
    const began = new Promise(resolve => {
      started = resolve;
    });
    const wait = new Promise(resolve => {
      release = resolve;
    });
    const makeBackup = f.adapter.createMigrationBackup.bind(f.adapter);
    vi.spyOn(f.adapter, 'createMigrationBackup').mockImplementation(async (...args) => {
      const name = await makeBackup(...args);
      started();
      await wait;
      return name;
    });
    const pending = f.captureInitialCloudBaseline();
    await began;
    f.state.characters[0].notes = 'Несохранённая правка';
    release();
    const result = await pending;
    expect(result.status).toBe('state_changed_after_backup_restart');
    expect(localStorage.getItem(result.backup)).toBe(f.oldRaw);
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    await expect(f.storage.persist()).rejects.toThrow('Запись остановлена');
  });
});
