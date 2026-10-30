import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveState: vi.fn(),
  loadState: vi.fn(),
  restoreBackup: vi.fn(),
  createBackup: vi.fn(),
  deleteBackup: vi.fn(),
  prepareForDisk: vi.fn(),
  serializeState: vi.fn()
}));
vi.mock('../js/core/state.js', () => ({ serializeState: mocks.serializeState, state: { settings: {} } }));
vi.mock('../js/core/secrets.js', () => ({ prepareForDisk: mocks.prepareForDisk }));
vi.mock('../js/core/storageAdapters/tauriAdapter.js', () => ({
  tauriAdapter: {
    saveState: mocks.saveState,
    loadState: mocks.loadState,
    restoreBackup: mocks.restoreBackup,
    createBackup: mocks.createBackup,
    deleteBackup: mocks.deleteBackup
  }
}));
vi.mock('../js/core/storageAdapters/localStorageAdapter.js', () => ({
  localStorageAdapter: {
    saveState: mocks.saveState,
    loadState: mocks.loadState,
    restoreBackup: mocks.restoreBackup,
    createBackup: mocks.createBackup,
    deleteBackup: mocks.deleteBackup
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

let storage;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.serializeState.mockReturnValue({ revision: 1 });
  mocks.prepareForDisk.mockImplementation(async data => data);
  mocks.saveState.mockResolvedValue(true);
  mocks.loadState.mockResolvedValue({ characters: [] });
  mocks.restoreBackup.mockResolvedValue(true);
  mocks.createBackup.mockResolvedValue('backup');
  mocks.deleteBackup.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  storage = await import('../js/core/storage.js');
});
afterEach(() => vi.restoreAllMocks());

describe('очередь записи и операции с резервными копиями', () => {
  it('сначала завершает старое сохранение, затем копию, затем новое сохранение', async () => {
    const first = deferred();
    const copy = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    mocks.createBackup.mockReturnValueOnce(copy.promise);

    const saving = storage.persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const copying = storage.createBackup('manual');
    mocks.serializeState.mockReturnValue({ revision: 2 });
    const next = storage.persist();
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.saveState).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await saving;
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledTimes(1));
    expect(mocks.saveState).toHaveBeenCalledTimes(1);
    copy.resolve('backup');
    await expect(copying).resolves.toBe('backup');
    await next;
    expect(mocks.saveState).toHaveBeenCalledTimes(2);
    expect(mocks.saveState.mock.calls[0][0]).toEqual({ revision: 1 });
    expect(mocks.saveState.mock.calls[1][0]).toEqual({ revision: 2 });
    expect(mocks.saveState.mock.invocationCallOrder[0]).toBeLessThan(mocks.createBackup.mock.invocationCallOrder[0]);
    expect(mocks.createBackup.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveState.mock.invocationCallOrder[1]);
  });

  it('не делает копию, если предыдущая запись не завершилась; ожидающее новое сохранение может повториться', async () => {
    const first = deferred();
    mocks.saveState.mockReturnValueOnce(first.promise);
    const saving = storage.persist();
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledTimes(1));
    const copying = storage.createBackup('manual');
    const next = storage.persist();
    const firstError = expect(saving).rejects.toThrow('PRIVATE');
    const copyError = copying.catch(error => error);
    first.reject(new Error('PRIVATE-SAVE-ERROR'));
    await firstError;
    const error = await copyError;
    expect(error.message).toContain('Предыдущее сохранение не подтверждено');
    expect(error.message).not.toContain('PRIVATE');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
    expect(mocks.createBackup).not.toHaveBeenCalled();
    await expect(next).resolves.toBeUndefined();
    expect(mocks.saveState).toHaveBeenCalledTimes(2);
  });

  it('не схлопывает сохранение после начала копии с ещё не начавшейся прежней записью', async () => {
    const write = deferred();
    const copy = deferred();
    mocks.saveState.mockReturnValueOnce(write.promise);
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const first = storage.persist();
    const copying = storage.createBackup('manual');
    const afterCopy = storage.persist();
    expect(afterCopy).not.toBe(first);
    await vi.waitFor(() => expect(mocks.saveState).toHaveBeenCalledOnce());
    write.resolve(true);
    await first;
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
    // Прежняя запись завершилась, но новые запросы всё ещё присоединяются к ожидающей записи.
    expect(storage.persist()).toBe(afterCopy);
    expect(mocks.saveState).toHaveBeenCalledOnce();
    copy.resolve('backup');
    await copying;
    await afterCopy;
    expect(mocks.saveState).toHaveBeenCalledTimes(2);
  });

  it('не подмешивает в выполняющуюся запись вложенные изменения во время ожидания vault', async () => {
    const preparation = deferred();
    const copy = deferred();
    const { state } = await import('../js/core/state.js');
    state.characters = [{ id: 'example', nick: 'До', contacts: { email: 'old@example.invalid' } }];
    mocks.serializeState.mockImplementation(() => ({ characters: state.characters }));
    mocks.prepareForDisk.mockImplementationOnce(async snapshot => {
      await preparation.promise;
      return snapshot;
    });
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const first = storage.persist();
    await vi.waitFor(() => expect(mocks.prepareForDisk).toHaveBeenCalledOnce());
    state.characters[0].nick = 'После';
    state.characters[0].contacts.email = 'new@example.invalid';
    const copying = storage.createBackup('manual');
    const afterCopy = storage.persist();
    preparation.resolve();
    await first;
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
    expect(mocks.saveState.mock.calls[0][0].characters[0]).toMatchObject({
      nick: 'До',
      contacts: { email: 'old@example.invalid' }
    });
    copy.resolve('backup');
    await copying;
    await afterCopy;
    expect(mocks.saveState.mock.calls[1][0].characters[0]).toMatchObject({
      nick: 'После',
      contacts: { email: 'new@example.invalid' }
    });
  });

  it('освобождает очередь после отказа копии и не теряет ожидающее сохранение', async () => {
    const copy = deferred();
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const copying = storage.createBackup('manual');
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
    const next = storage.persist();
    expect(mocks.saveState).not.toHaveBeenCalled();
    const failed = copying.catch(error => error);
    copy.reject(new Error('PRIVATE-DISK-DETAIL'));
    const error = await failed;
    expect(error.message).toContain('Создание резервной копии не подтверждено');
    expect(error.message).not.toContain('PRIVATE');
    await expect(next).resolves.toBeUndefined();
    expect(mocks.saveState).toHaveBeenCalledOnce();
  });

  it('не создаёт вторую копию и не удаляет, не восстанавливает и не загружает данные во время первой', async () => {
    const copy = deferred();
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const copying = storage.createBackup('manual');
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
    await expect(storage.createBackup('second')).rejects.toThrow('Запись остановлена');
    await expect(storage.deleteStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    await expect(storage.loadData()).rejects.toThrow('Запись остановлена');
    expect(mocks.deleteBackup).not.toHaveBeenCalled();
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
    expect(mocks.loadState).not.toHaveBeenCalled();
    copy.resolve('backup');
    await copying;
    await expect(storage.deleteStoredBackup('backup')).resolves.toBeUndefined();
  });

  it('не создаёт и не восстанавливает копию, пока другая копия удаляется', async () => {
    const deletion = deferred();
    mocks.deleteBackup.mockReturnValueOnce(deletion.promise);
    const deleting = storage.deleteStoredBackup('backup');
    await vi.waitFor(() => expect(mocks.deleteBackup).toHaveBeenCalledOnce());
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    await expect(storage.deleteStoredBackup('other')).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    deletion.resolve(true);
    await deleting;
    await expect(storage.createBackup('manual')).resolves.toBe('backup');
  });

  it('не создаёт копию во время восстановления и после успешного восстановления до перезапуска', async () => {
    const restore = deferred();
    mocks.restoreBackup.mockReturnValueOnce(restore.promise);
    const restoring = storage.restoreStoredBackup('backup');
    await vi.waitFor(() => expect(mocks.restoreBackup).toHaveBeenCalledOnce());
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    restore.resolve(true);
    await restoring;
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
  });

  it('не создаёт копию параллельно загрузке', async () => {
    const load = deferred();
    mocks.loadState.mockReturnValueOnce(load.promise);
    const loading = storage.loadData();
    await vi.waitFor(() => expect(mocks.loadState).toHaveBeenCalledOnce());
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    load.resolve({ characters: [] });
    await loading;
    await expect(storage.createBackup('manual')).resolves.toBe('backup');
  });

  it.each([undefined, null, false, '', '   ', {}])('не подтверждает неверный ответ копии: %s', async reply => {
    mocks.createBackup.mockResolvedValueOnce(reply);
    await expect(storage.createBackup('manual')).rejects.toThrow('не подтверждено');
    await expect(storage.persist()).resolves.toBeUndefined();
  });

  it('не продолжает копирование и ожидающую запись после сообщения о частичном изменении', async () => {
    const copy = deferred();
    mocks.createBackup.mockReturnValueOnce(copy.promise);
    const events = [];
    const listener = event => events.push(event.detail);
    window.addEventListener('tf-storage-uncertain', listener);
    try {
      const copying = storage.createBackup('manual');
      await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
      const saving = storage.persist();
      const saveFailure = expect(saving).rejects.toThrow('Запись остановлена');
      storage.haltAfterPartialStateChange();
      storage.haltAfterPartialStateChange();
      copy.resolve('backup');
      await expect(copying).rejects.toThrow('Запись остановлена');
      await saveFailure;
      expect(events).toEqual([{ source: 'state' }]);
      expect(mocks.saveState).not.toHaveBeenCalled();
      await expect(storage.persist()).rejects.toThrow('Запись остановлена');
      await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    } finally {
      window.removeEventListener('tf-storage-uncertain', listener);
    }
  });

  it('допускает копирование файла после ошибки загрузки, не сохраняя пустое состояние из памяти', async () => {
    mocks.loadState.mockRejectedValueOnce(new Error('corrupt'));
    await expect(storage.loadData()).rejects.toThrow('corrupt');
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.createBackup('manual')).resolves.toBe('backup');
    expect(mocks.saveState).not.toHaveBeenCalled();
  });
});
