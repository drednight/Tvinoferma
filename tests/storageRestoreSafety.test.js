import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveState: vi.fn(),
  loadState: vi.fn(),
  restoreBackup: vi.fn(),
  createBackup: vi.fn(),
  createMigrationBackup: vi.fn(),
  saveMigratedState: vi.fn(),
  forgetLoadedState: vi.fn(),
  prepareForDisk: vi.fn(),
  serializeState: vi.fn()
}));

vi.mock('../js/core/state.js', () => ({
  serializeState: mocks.serializeState,
  state: { settings: {} }
}));
vi.mock('../js/core/secrets.js', () => ({ prepareForDisk: mocks.prepareForDisk }));
vi.mock('../js/core/storageAdapters/tauriAdapter.js', () => ({
  tauriAdapter: {
    saveState: mocks.saveState,
    loadState: mocks.loadState,
    restoreBackup: mocks.restoreBackup,
    createBackup: mocks.createBackup,
    createMigrationBackup: mocks.createMigrationBackup,
    saveMigratedState: mocks.saveMigratedState,
    forgetLoadedState: mocks.forgetLoadedState
  }
}));
vi.mock('../js/core/storageAdapters/localStorageAdapter.js', () => ({
  localStorageAdapter: {
    saveState: mocks.saveState,
    loadState: mocks.loadState,
    restoreBackup: mocks.restoreBackup,
    createBackup: mocks.createBackup,
    createMigrationBackup: mocks.createMigrationBackup,
    saveMigratedState: mocks.saveMigratedState,
    forgetLoadedState: mocks.forgetLoadedState
  }
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.serializeState.mockReturnValue({ revision: 1 });
  mocks.prepareForDisk.mockImplementation(async data => data);
  mocks.saveState.mockResolvedValue(true);
  mocks.loadState.mockResolvedValue({ characters: [] });
  mocks.restoreBackup.mockResolvedValue(true);
  mocks.createBackup.mockResolvedValue('manual');
  mocks.createMigrationBackup.mockResolvedValue('pre-migration');
  mocks.saveMigratedState.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('координация сохранения и восстановления', () => {
  it('не перезаписывает несовместимую схему, но позволяет восстановить резервную копию', async () => {
    const { loadData, persist, protectIncompatibleState, restoreStoredBackup } = await import('../js/core/storage.js');
    await loadData();
    protectIncompatibleState();
    await expect(persist()).rejects.toThrow('Запись остановлена');
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
    await expect(restoreStoredBackup('selected')).resolves.toBeUndefined();
    expect(mocks.restoreBackup).toHaveBeenCalledExactlyOnceWith('selected');
  });

  it('останавливает подготовленное сохранение, если схема стала несовместимой до записи', async () => {
    const preparing = deferred();
    mocks.prepareForDisk.mockReturnValueOnce(preparing.promise);
    const { persist, protectIncompatibleState } = await import('../js/core/storage.js');
    const saving = persist();
    await vi.waitFor(() => expect(mocks.prepareForDisk).toHaveBeenCalledTimes(1));
    protectIncompatibleState();
    const rejected = expect(saving).rejects.toThrow('Запись остановлена');
    preparing.resolve({ revision: 1 });
    await rejected;
    expect(mocks.saveState).not.toHaveBeenCalled();
  });

  it('не записывает значения по умолчанию после ошибки чтения и разрешает восстановление', async () => {
    mocks.loadState.mockRejectedValueOnce(new Error('Файл повреждён'));
    const { loadData, persist, restoreStoredBackup } = await import('../js/core/storage.js');
    await expect(loadData()).rejects.toThrow('Файл повреждён');
    await expect(persist()).rejects.toThrow('Запись остановлена');
    await expect(loadData()).rejects.toThrow('Запись остановлена');
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
    await expect(restoreStoredBackup('selected')).resolves.toBeUndefined();
    expect(mocks.restoreBackup).toHaveBeenCalledExactlyOnceWith('selected');
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('не записывает и не восстанавливает состояние, пока продолжается его загрузка', async () => {
    const read = deferred();
    mocks.loadState.mockReturnValueOnce(read.promise);
    const { loadData, persist, restoreStoredBackup } = await import('../js/core/storage.js');
    const loading = loadData();
    await vi.waitFor(() => expect(mocks.loadState).toHaveBeenCalledTimes(1));
    await expect(persist()).rejects.toThrow('Запись остановлена');
    await expect(restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    read.resolve({ characters: [] });
    await expect(loading).resolves.toEqual({ characters: [] });
    await expect(persist()).resolves.toBeUndefined();
  });

  it('перед загрузкой дожидается ранее поставленного сохранения', async () => {
    const first = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    const { loadData, persist } = await import('../js/core/storage.js');
    const saving = persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const loading = loadData();
    expect(mocks.loadState).not.toHaveBeenCalled();
    first.resolve(true);
    await saving;
    await expect(loading).resolves.toEqual({ characters: [] });
    expect(mocks.loadState).toHaveBeenCalledTimes(1);
  });

  it('после обычной ошибки подготовки допускает следующую попытку', async () => {
    mocks.saveState.mockRejectedValueOnce(new Error('Не удалось подготовить сохранение'));
    const { persist } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('подготовить');
    await expect(persist()).resolves.toBeUndefined();
    expect(mocks.saveState).toHaveBeenCalledTimes(2);
  });

  it.each(['save', 'restore'])('не считает неподтверждённый ответ адаптера успехом: %s', async action => {
    const storage = await import('../js/core/storage.js');
    if (action === 'save') mocks.saveState.mockResolvedValueOnce(undefined);
    else mocks.restoreBackup.mockResolvedValueOnce(false);
    const operation = action === 'save' ? storage.persist() : storage.restoreStoredBackup('backup');
    await expect(operation).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('при неопределённом исходе останавливает уже поставленную в очередь запись и подготовку vault', async () => {
    const first = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    const onUncertain = vi.fn();
    const onPersisted = vi.fn();
    window.addEventListener('tf-storage-uncertain', onUncertain);
    window.addEventListener('tf-persisted', onPersisted);
    try {
      const { persist } = await import('../js/core/storage.js');
      const saving = persist();
      await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
      const queued = persist();
      const firstFailure = expect(saving).rejects.toMatch('TF_STATE_WRITE_UNCERTAIN:');
      const queuedFailure = expect(queued).rejects.toThrow('Запись остановлена');
      first.reject('TF_STATE_WRITE_UNCERTAIN: Файл мог измениться');
      await Promise.all([firstFailure, queuedFailure]);
      await expect(persist()).rejects.toThrow('Запись остановлена');
      expect(mocks.saveState).toHaveBeenCalledTimes(1);
      expect(mocks.prepareForDisk).toHaveBeenCalledTimes(1);
      expect(onUncertain).toHaveBeenCalledTimes(1);
      expect(onPersisted).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('tf-storage-uncertain', onUncertain);
      window.removeEventListener('tf-persisted', onPersisted);
    }
  });

  it('перед восстановлением ждёт запланированную запись, запрещает новые и не сохраняет значения по умолчанию', async () => {
    const first = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
    const saving = persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const restoring = restoreStoredBackup('selected');
    await expect(persist()).rejects.toThrow('Запись остановлена');
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
    first.resolve(true);
    await saving;
    await restoring;
    expect(mocks.restoreBackup).toHaveBeenCalledExactlyOnceWith('selected');
    expect(mocks.saveState).toHaveBeenCalledTimes(1);
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('восстанавливает без принудительного сохранения, когда ранее ничего не было запланировано', async () => {
    const { restoreStoredBackup } = await import('../js/core/storage.js');
    await restoreStoredBackup('selected');
    expect(mocks.saveState).not.toHaveBeenCalled();
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.restoreBackup).toHaveBeenCalledExactlyOnceWith('selected');
  });

  it('разблокирует запись при подтверждённом отказе до замены', async () => {
    mocks.restoreBackup.mockRejectedValueOnce(new Error('Не удалось создать копию'));
    const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
    await expect(restoreStoredBackup('selected')).rejects.toThrow('создать копию');
    await expect(persist()).resolves.toBeUndefined();
    expect(mocks.saveState).toHaveBeenCalledTimes(1);
  });

  it('не повторяет запись или восстановление после неопределённого исхода', async () => {
    mocks.restoreBackup.mockRejectedValueOnce(new Error('TF_STATE_WRITE_UNCERTAIN: не подтверждено'));
    const onUncertain = vi.fn();
    window.addEventListener('tf-storage-uncertain', onUncertain);
    try {
      const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
      await expect(restoreStoredBackup('selected')).rejects.toThrow('не подтверждено');
      await expect(persist()).rejects.toThrow('Запись остановлена');
      await expect(restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
      expect(onUncertain).toHaveBeenCalledTimes(1);
      expect(mocks.saveState).not.toHaveBeenCalled();
      expect(mocks.restoreBackup).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('tf-storage-uncertain', onUncertain);
    }
  });

  it('отказывает в восстановлении, если ожидавшаяся запись завершилась неопределённо', async () => {
    const first = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
    const saving = persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const restoring = restoreStoredBackup('selected');
    const saveFailure = expect(saving).rejects.toMatch('TF_STATE_WRITE_UNCERTAIN:');
    const restoreFailure = expect(restoring).rejects.toThrow('Запись остановлена');
    first.reject('TF_STATE_WRITE_UNCERTAIN: не подтверждено');
    await Promise.all([saveFailure, restoreFailure]);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });
});

describe('координация обязательной копии и миграции', () => {
  it('не готовит vault и не допускает других операций до подтверждения копии и сохранения', async () => {
    const copy = deferred();
    const save = deferred();
    mocks.createMigrationBackup.mockReturnValueOnce(copy.promise);
    mocks.saveMigratedState.mockReturnValueOnce(save.promise);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    const beginning = storage.beginGuardedMigration(snapshot, 'pre-migration');
    await vi.waitFor(() => expect(mocks.createMigrationBackup).toHaveBeenCalledTimes(1));
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.loadData()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
    copy.resolve('pre-migration');
    await beginning;
    const committing = storage.commitGuardedMigration();
    await vi.waitFor(() => expect(mocks.saveMigratedState).toHaveBeenCalledTimes(1));
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    save.resolve(true);
    await committing;
    expect(mocks.createMigrationBackup).toHaveBeenCalledExactlyOnceWith(snapshot, 'pre-migration');
    expect(mocks.saveMigratedState).toHaveBeenCalledExactlyOnceWith(snapshot, { revision: 1 });
    expect(mocks.forgetLoadedState).toHaveBeenCalledExactlyOnceWith(snapshot);
    await expect(storage.persist()).resolves.toBeUndefined();
  });

  it('не готовит vault после отказа создания копии, а обычная запись остаётся запрещена', async () => {
    mocks.createMigrationBackup.mockRejectedValueOnce(new Error('нет места'));
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    await expect(storage.beginGuardedMigration(snapshot, 'pre-migration')).rejects.toThrow('нет места');
    await expect(storage.commitGuardedMigration()).rejects.toThrow('Запись остановлена');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
    expect(mocks.saveMigratedState).not.toHaveBeenCalled();
    expect(mocks.forgetLoadedState).toHaveBeenCalledExactlyOnceWith(snapshot);
    await expect(storage.restoreStoredBackup('selected')).resolves.toBeUndefined();
  });

  it('не продолжает без подтверждённого имени созданной копии', async () => {
    mocks.createMigrationBackup.mockResolvedValueOnce(undefined);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    await expect(storage.beginGuardedMigration(snapshot, 'pre-migration')).rejects.toThrow('Не удалось подтвердить');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveMigratedState).not.toHaveBeenCalled();
  });

  it('после ошибки подготовки не записывает и удерживает защиту, даже когда копия уже есть', async () => {
    mocks.prepareForDisk.mockRejectedValueOnce(new Error('vault недоступен'));
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    await storage.beginGuardedMigration(snapshot, 'pre-migration');
    await expect(storage.commitGuardedMigration()).rejects.toThrow('vault недоступен');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    expect(mocks.saveMigratedState).not.toHaveBeenCalled();
    expect(mocks.forgetLoadedState).toHaveBeenCalledExactlyOnceWith(snapshot);
    await expect(storage.restoreStoredBackup('selected')).resolves.toBeUndefined();
  });

  it('после неизвестного исхода не повторяет запись и не разрешает восстановление до перезапуска', async () => {
    mocks.saveMigratedState.mockRejectedValueOnce(new Error('TF_STATE_WRITE_UNCERTAIN: ответ потерян'));
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    await storage.beginGuardedMigration(snapshot, 'pre-migration');
    await expect(storage.commitGuardedMigration()).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    expect(mocks.saveMigratedState).toHaveBeenCalledTimes(1);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it('считает отсутствие подтверждения адаптера неизвестным исходом записи', async () => {
    mocks.saveMigratedState.mockResolvedValueOnce(undefined);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    await storage.beginGuardedMigration(snapshot, 'pre-migration');
    await expect(storage.commitGuardedMigration()).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    expect(mocks.saveMigratedState).toHaveBeenCalledTimes(1);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it('при отмене во время копирования не продолжает после позднего ответа и не готовит vault', async () => {
    const copy = deferred();
    mocks.createMigrationBackup.mockReturnValueOnce(copy.promise);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    const beginning = storage.beginGuardedMigration(snapshot, 'pre-migration');
    await vi.waitFor(() => expect(mocks.createMigrationBackup).toHaveBeenCalledTimes(1));
    storage.abortGuardedMigration();
    await expect(storage.restoreStoredBackup('selected')).rejects.toThrow('Запись остановлена');
    const rejected = expect(beginning).rejects.toThrow('Запись остановлена');
    copy.resolve('pre-migration');
    await rejected;
    expect(mocks.prepareForDisk).not.toHaveBeenCalled();
    expect(mocks.saveMigratedState).not.toHaveBeenCalled();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).resolves.toBeUndefined();
  });

  it('не продолжает миграцию после ошибки ранее запланированной записи', async () => {
    const pending = deferred();
    mocks.saveState.mockReturnValueOnce(pending.promise);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    const saving = storage.persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const beginning = storage.beginGuardedMigration(snapshot, 'pre-migration');
    const saveError = expect(saving).rejects.toThrow('не сохранено');
    const migrationError = expect(beginning).rejects.toThrow('не сохранено');
    pending.reject(new Error('не сохранено'));
    await Promise.all([saveError, migrationError]);
    expect(mocks.createMigrationBackup).not.toHaveBeenCalled();
    expect(mocks.saveMigratedState).not.toHaveBeenCalled();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('selected')).resolves.toBeUndefined();
  });

  it('не запускает миграцию, пока обычная копия ещё может вращать старые', async () => {
    const copy = deferred();
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const storage = await import('../js/core/storage.js');
    const snapshot = await storage.loadData();
    const regular = storage.createBackup('manual');
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledTimes(1));
    await expect(storage.beginGuardedMigration(snapshot, 'pre-migration')).rejects.toThrow('Запись остановлена');
    expect(mocks.createMigrationBackup).not.toHaveBeenCalled();
    copy.resolve('manual');
    await regular;
  });
});
