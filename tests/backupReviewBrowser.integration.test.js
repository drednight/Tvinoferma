import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STATE_KEY = 'tvinoferma_state_v1';
const PRIVATE = 'PRIVATE-VALUE-не-в-журнал';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

async function setup(current = JSON.stringify({ schemaVersion: 10, characters: [{ id: 'local' }] })) {
  const { localStorageAdapter: adapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
  const storage = await import('../js/core/storage.js');
  const backup = JSON.stringify({
    schemaVersion: 10,
    secretsInVault: true,
    characters: [{ id: 'hero', contacts: { password: PRIVATE } }],
    archivedCharacters: [{ id: 'old' }],
    plannerEntries: [{ id: 'today' }, { id: 'tomorrow' }]
  });
  localStorage.setItem(STATE_KEY, backup);
  const key = await adapter.createBackup();
  if (current === null) localStorage.removeItem(STATE_KEY);
  else localStorage.setItem(STATE_KEY, current);
  return { adapter, storage, key, backup, current };
}

describe('предпросмотр и восстановление локальной копии в браузере', () => {
  it('отдаёт только сводку, без паролей, raw и скрытого свидетельства', async () => {
    const { storage, key } = await setup();
    const review = await storage.inspectStoredBackup(key);
    expect(review).toEqual({
      schemaVersion: 10,
      characters: 1,
      archivedCharacters: 1,
      plannerEntries: 2,
      vaultReference: 'os-referenced',
      currentState: 'readable'
    });
    expect(Object.isFrozen(review)).toBe(true);
    expect(JSON.stringify(review)).not.toContain(PRIVATE);
    expect(Reflect.ownKeys(review)).toHaveLength(6);
    storage.forgetStoredBackupInspection(review);
  });

  it.each(['current', 'backup', 'appearance'])(
    'останавливает устаревшее подтверждение до создания новой копии: %s',
    async kind => {
      const { storage, adapter, key, backup } = await setup(kind === 'appearance' ? null : undefined);
      const review = await storage.inspectStoredBackup(key);
      const beforeKeys = await adapter.listBackups();
      if (kind === 'backup') localStorage.setItem(key, '{"schemaVersion":10,"characters":[]}');
      else localStorage.setItem(STATE_KEY, '{"external":true}');
      const beforeState = localStorage.getItem(STATE_KEY);
      const beforeBackup = localStorage.getItem(key);
      await expect(storage.restoreStoredBackup(key, review, () => true)).rejects.toThrow('изменились после просмотра');
      expect(localStorage.getItem(STATE_KEY)).toBe(beforeState);
      expect(localStorage.getItem(key)).toBe(beforeBackup);
      expect(await adapter.listBackups()).toEqual(beforeKeys);
      expect(kind === 'backup' ? beforeBackup !== backup : true).toBe(true);
      // A review is one-use even when it turns out to be stale.
      await expect(storage.restoreStoredBackup(key, review, () => true)).rejects.toThrow('Не удалось проверить');
    }
  );

  it('останавливается, если память изменилась после просмотра, не создавая копий и не заменяя файл', async () => {
    const { storage, adapter, key, current } = await setup();
    const review = await storage.inspectStoredBackup(key);
    const beforeKeys = await adapter.listBackups();
    await expect(storage.restoreStoredBackup(key, review, () => false)).rejects.toThrow('изменились после просмотра');
    expect(localStorage.getItem(STATE_KEY)).toBe(current);
    expect(await adapter.listBackups()).toEqual(beforeKeys);
    storage.forgetStoredBackupInspection(review);
    await expect(storage.restoreStoredBackup(key, review, () => true)).rejects.toThrow('Не удалось проверить');
  });

  it('сохраняет повреждённое состояние перед заменой и блокирует запись до перезапуска', async () => {
    const damaged = '{broken';
    const { storage, adapter, key, backup } = await setup(damaged);
    await expect(storage.loadData()).rejects.toThrow('повреждены');
    const before = await adapter.listBackups();
    const review = await storage.inspectStoredBackup(key);
    expect(review.currentState).toBe('damaged');
    await storage.restoreStoredBackup(key, review, () => true);
    expect(localStorage.getItem(STATE_KEY)).toBe(backup);
    const all = await adapter.listBackups();
    expect(all).toHaveLength(before.length + 1);
    expect(localStorage.getItem(all.find(name => !before.includes(name)))).toBe(damaged);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it.each(['current', 'backup'])(
    'не затирает изменения во время создания копии перед восстановлением: %s',
    async kind => {
      const { storage, adapter, key, current } = await setup();
      const review = await storage.inspectStoredBackup(key);
      const realSet = Storage.prototype.setItem;
      let injected = false;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
        const result = realSet.call(this, name, value);
        if (!injected && name.startsWith('tvinoferma_backup_') && name !== key) {
          injected = true;
          realSet.call(this, kind === 'current' ? STATE_KEY : key, '{"external":true}');
        }
        return result;
      });
      await expect(storage.restoreStoredBackup(key, review, () => true)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(localStorage.getItem(STATE_KEY)).toBe(kind === 'current' ? '{"external":true}' : current);
      if (kind === 'backup') expect(localStorage.getItem(key)).toBe('{"external":true}');
      expect((await adapter.listBackups()).length).toBeGreaterThanOrEqual(1);
    }
  );

  it('не принимает поддельное, забытое или относящееся к другой копии подтверждение', async () => {
    const { storage, adapter, key, current } = await setup();
    const review = await storage.inspectStoredBackup(key);
    const before = await adapter.listBackups();
    await expect(storage.restoreStoredBackup(key, { ...review }, () => true)).rejects.toThrow('Не удалось проверить');
    await expect(storage.restoreStoredBackup('tvinoferma_backup_other', review, () => true)).rejects.toThrow(
      'Не удалось проверить'
    );
    storage.forgetStoredBackupInspection(review);
    await expect(storage.restoreStoredBackup(key, review, () => true)).rejects.toThrow('Не удалось проверить');
    expect(localStorage.getItem(STATE_KEY)).toBe(current);
    expect(await adapter.listBackups()).toEqual(before);
  });

  it('безопасно отказывает для повреждённой копии и не показывает детали с секретом', async () => {
    const { storage, key, current } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(key, `{"password":"${PRIVATE}"`);
    const err = await storage.inspectStoredBackup(key).catch(error => error);
    expect(err.message).not.toContain(PRIVATE);
    expect(localStorage.getItem(STATE_KEY)).toBe(current);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
  });

  it('отмечает неизвестную схему и не утверждает отсутствие старых записей ОС', async () => {
    const { adapter, key } = await setup();
    localStorage.setItem(key, '{"schemaVersion":{},"characters":[],"secretsInVault":"unknown"}');
    const review = await adapter.inspectBackup(key);
    expect(review.schemaVersion).toBeNull();
    expect(review.vaultReference).toBe('unknown');
    adapter.forgetBackupInspection(review);
    localStorage.setItem(key, '{"characters":[]}');
    const old = await adapter.inspectBackup(key);
    expect(old.schemaVersion).toBe(1);
    expect(old.vaultReference).toBe('not-marked');
    adapter.forgetBackupInspection(old);
    localStorage.setItem(key, '{"schemaVersion":10,"secretsInVault":null}');
    const malformed = await adapter.inspectBackup(key);
    expect(malformed.vaultReference).toBe('unknown');
  });
});
