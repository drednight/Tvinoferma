import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'tvinoferma_state_v1';
const OLD =
  '{\n  "schemaVersion": 9, "characters": [{ "id": "hero", "nick": "Герой", "contacts": { "password": "PRIVATE" } }], "settings": { "eternals": { "enabled": true } }, "unrecognizedLegacy": "keep-in-backup"\n}';
const CHANGED = '{"schemaVersion":9,"characters":[{"id":"other","nick":"Другая запись"}]}';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const adapter = (await import('../js/core/storageAdapters/localStorageAdapter.js')).localStorageAdapter;
  const storage = await import('../js/core/storage.js');
  const { state, normalizeState } = await import('../js/core/state.js');
  const { migrateState } = await import('../js/core/migrations.js');
  localStorage.setItem(KEY, OLD);
  const loaded = await storage.loadData();
  const converted = migrateState(loaded);
  const applyInMemory = () => Object.assign(state, normalizeState(converted.state));
  return { adapter, storage, loaded, converted, state, applyInMemory };
}

async function oldBackup(adapter) {
  return adapter.createBackup({ maxCount: 99 });
}

describe('защита стартовой миграции браузерного состояния', () => {
  it('сначала сохраняет точную копию без ротации, затем подтверждает замену исходных данных', async () => {
    const { adapter, storage, loaded, applyInMemory } = await fixture();
    const first = await oldBackup(adapter);
    const second = await oldBackup(adapter);
    const notified = vi.fn();
    window.addEventListener('tf-persisted', notified);
    try {
      const backup = await storage.beginGuardedMigration(loaded, 'pre-migration-v9');
      expect(localStorage.getItem(backup)).toBe(OLD);
      expect(await adapter.listBackups()).toEqual(expect.arrayContaining([first, second, backup]));
      expect(await adapter.listBackups()).toHaveLength(3);
      await expect(storage.persist()).rejects.toThrow('Запись остановлена');
      await expect(storage.loadData()).rejects.toThrow('Запись остановлена');
      await expect(storage.restoreStoredBackup(first)).rejects.toThrow('Запись остановлена');
      await expect(storage.createBackup()).rejects.toThrow('Запись остановлена');
      expect(localStorage.getItem(KEY)).toBe(OLD);
      applyInMemory();
      await storage.commitGuardedMigration();
      const saved = JSON.parse(localStorage.getItem(KEY));
      expect(saved.schemaVersion).toBe(10);
      expect(saved.settings.guild.enabled).toBe(true);
      expect(saved.characters[0].contacts.password).toBe('PRIVATE');
      expect(localStorage.getItem(backup)).toBe(OLD);
      expect(notified).toHaveBeenCalledTimes(1);
      await expect(storage.persist()).resolves.toBeUndefined();
    } finally {
      window.removeEventListener('tf-persisted', notified);
    }
  });

  it('при нехватке места не меняет исходный файл, не трогает старые копии и разрешает восстановление', async () => {
    const { adapter, storage, loaded, applyInMemory } = await fixture();
    const old = await oldBackup(adapter);
    const set = Storage.prototype.setItem;
    const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('tvinoferma_backup_')) throw new DOMException('Quota', 'QuotaExceededError');
      return set.call(this, key, value);
    });
    await expect(storage.beginGuardedMigration(loaded, 'pre-migration-v9')).rejects.toThrow();
    applyInMemory();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    expect(localStorage.getItem(KEY)).toBe(OLD);
    expect(await adapter.listBackups()).toEqual([old]);
    mock.mockRestore();
    await expect(storage.restoreStoredBackup(old)).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe(OLD);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('останавливается, если загруженный объект изменился, не вызывая getter', async () => {
    const { adapter, storage, loaded } = await fixture();
    const getter = vi.fn(() => []);
    Object.defineProperty(loaded, 'characters', { enumerable: true, get: getter });
    await expect(storage.beginGuardedMigration(loaded, 'pre-migration-v9')).rejects.toThrow('изменились');
    expect(getter).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(OLD);
    expect(await adapter.listBackups()).toEqual([]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it.each([
    ['прототип объекта', snapshot => Object.setPrototypeOf(snapshot, null)],
    ['прототип вложенного массива', snapshot => Object.setPrototypeOf(snapshot.characters, null)],
    ['атрибуты свойства', snapshot => Object.defineProperty(snapshot, 'schemaVersion', { writable: false })],
    ['скрытый символ', snapshot => Object.defineProperty(snapshot, Symbol('hidden'), { value: 1 })]
  ])('не считает изменённый объект прежним: %s', async (_, mutate) => {
    const { adapter, storage, loaded } = await fixture();
    mutate(loaded);
    await expect(storage.beginGuardedMigration(loaded, 'pre-migration-v9')).rejects.toThrow('изменились');
    expect(localStorage.getItem(KEY)).toBe(OLD);
    expect(await adapter.listBackups()).toEqual([]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не принимает посторонний объект, даже если его JSON совпадает', async () => {
    const { adapter, storage, loaded } = await fixture();
    await expect(storage.beginGuardedMigration(structuredClone(loaded), 'pre-migration-v9')).rejects.toThrow(
      'Исходные данные недоступны'
    );
    expect(localStorage.getItem(KEY)).toBe(OLD);
    expect(await adapter.listBackups()).toEqual([]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не начинает миграцию, если файл изменился после чтения, даже только по пробелам', async () => {
    const { adapter, storage, loaded } = await fixture();
    const old = await oldBackup(adapter);
    const changedRaw = JSON.stringify(JSON.parse(OLD));
    expect(changedRaw).not.toBe(OLD);
    localStorage.setItem(KEY, changedRaw);
    await expect(storage.beginGuardedMigration(loaded, 'pre-migration-v9')).rejects.toThrow('изменились');
    expect(localStorage.getItem(KEY)).toBe(changedRaw);
    expect(await adapter.listBackups()).toEqual([old]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('сверяет исходные байты, даже если два больших числа одинаковы после разбора JavaScript', async () => {
    const { adapter, storage } = await fixture();
    const a = '{"schemaVersion":9,"large":9007199254740992}';
    const b = '{"schemaVersion":9,"large":9007199254740993}';
    localStorage.setItem(KEY, a);
    const snapshot = await storage.loadData();
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
    localStorage.setItem(KEY, b);
    await expect(storage.beginGuardedMigration(snapshot, 'pre-migration-v9')).rejects.toThrow('изменились');
    expect(localStorage.getItem(KEY)).toBe(b);
    expect(await adapter.listBackups()).toEqual([]);
  });

  it('отменяет копирование, если исходник изменился во время проверки новой копии', async () => {
    const { adapter, storage, loaded } = await fixture();
    const old = await oldBackup(adapter);
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      const result = set.call(this, key, value);
      if (key.startsWith('tvinoferma_backup_')) set.call(this, KEY, CHANGED);
      return result;
    });
    await expect(storage.beginGuardedMigration(loaded, 'pre-migration-v9')).rejects.toThrow('данные изменились');
    expect(localStorage.getItem(KEY)).toBe(CHANGED);
    expect(localStorage.getItem(old)).toBe(OLD);
    expect(await adapter.listBackups()).toEqual([old]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('после копирования не перезаписывает другие данные, появившиеся до сохранения', async () => {
    const { adapter, storage, loaded, applyInMemory } = await fixture();
    const backup = await storage.beginGuardedMigration(loaded, 'pre-migration-v9');
    applyInMemory();
    localStorage.setItem(KEY, CHANGED);
    await expect(storage.commitGuardedMigration()).rejects.toThrow('изменились');
    expect(localStorage.getItem(KEY)).toBe(CHANGED);
    expect(localStorage.getItem(backup)).toBe(OLD);
    expect(await adapter.listBackups()).toContain(backup);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup(backup)).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe(OLD);
  });

  it('дожидается уже запланированной записи и не мигрирует устаревшее чтение', async () => {
    const { adapter, storage, loaded, applyInMemory } = await fixture();
    applyInMemory();
    const saving = storage.persist();
    const starting = storage.beginGuardedMigration(loaded, 'pre-migration-v9');
    await saving;
    const newState = localStorage.getItem(KEY);
    expect(newState).not.toBe(OLD);
    await expect(starting).rejects.toThrow('изменились');
    expect(localStorage.getItem(KEY)).toBe(newState);
    expect(await adapter.listBackups()).toEqual([]);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не повторяет запись и не разрешает восстановление при неизвестном исходе', async () => {
    const { storage, loaded, applyInMemory } = await fixture();
    const backup = await storage.beginGuardedMigration(loaded, 'pre-migration-v9');
    applyInMemory();
    const set = Storage.prototype.setItem;
    let stateWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      const result = set.call(this, key, value);
      if (key === KEY) {
        stateWrites++;
        throw new Error('Ответ после записи потерян');
      }
      return result;
    });
    const uncertain = vi.fn();
    window.addEventListener('tf-storage-uncertain', uncertain);
    try {
      await expect(storage.commitGuardedMigration()).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
      expect(JSON.parse(localStorage.getItem(KEY)).schemaVersion).toBe(10);
      expect(localStorage.getItem(backup)).toBe(OLD);
      await expect(storage.persist()).rejects.toThrow('Запись остановлена');
      await expect(storage.restoreStoredBackup(backup)).rejects.toThrow('Запись остановлена');
      expect(stateWrites).toBe(1);
      expect(uncertain).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('tf-storage-uncertain', uncertain);
    }
  });

  it('после аварийной отмены позволяет восстановить копию, но не обычную запись', async () => {
    const { storage, loaded } = await fixture();
    const backup = await storage.beginGuardedMigration(loaded, 'pre-migration-v9');
    storage.abortGuardedMigration();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.commitGuardedMigration()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup(backup)).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe(OLD);
  });
});
