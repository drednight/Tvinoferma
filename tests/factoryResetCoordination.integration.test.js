import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {},
  save: vi.fn(),
  restore: vi.fn(),
  backup: vi.fn(),
  removeBackup: vi.fn(),
  load: vi.fn(),
  prepare: vi.fn(),
  invoke: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../js/core/state.js', () => ({ state: mocks.state, serializeState: () => ({ ...mocks.state }) }));
vi.mock('../js/core/secrets.js', () => ({ prepareForDisk: mocks.prepare }));
vi.mock('../js/core/storageAdapters/tauriAdapter.js', () => ({
  tauriAdapter: {
    saveState: mocks.save,
    loadState: mocks.load,
    restoreBackup: mocks.restore,
    createBackup: mocks.backup,
    deleteBackup: mocks.removeBackup
  }
}));
vi.mock('../js/core/storageAdapters/localStorageAdapter.js', () => ({
  localStorageAdapter: {
    saveState: mocks.save,
    loadState: mocks.load,
    restoreBackup: mocks.restore,
    createBackup: mocks.backup,
    deleteBackup: mocks.removeBackup
  }
}));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function success() {
  return {
    stateRemoved: true,
    backupsRemoved: 2,
    sessionsRemoved: true,
    profilesRemoved: true,
    secretsRemoved: 3,
    problems: [],
    message: 'Готово'
  };
}

let storage;
let reset;
let reload;
let priorInternals;
let errors;
let started;
function onError(event) {
  errors.push(event.detail);
}
function onStart() {
  started++;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.keys(mocks.state).forEach(key => delete mocks.state[key]);
  Object.assign(mocks.state, {
    characters: [
      { id: 'hero', nick: 'Hero', contacts: { password: 'FICTIONAL-PRIVATE' }, launch: { gcIds: ['gc-1'] } }
    ],
    archivedCharacters: [{ id: 'archive', launch: { gcAccounts: { 'gc-old': { legacy: true } } } }],
    parties: [],
    archivedParties: [],
    marathons: [],
    settings: { backups: { maxCount: 5 } }
  });
  mocks.prepare.mockImplementation(async data => data);
  mocks.save.mockResolvedValue(true);
  mocks.load.mockResolvedValue(null);
  mocks.restore.mockResolvedValue(true);
  mocks.backup.mockResolvedValue('backup');
  mocks.removeBackup.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async command => (command === 'load_state_raw' ? '{"fictional":true}' : success()));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  priorInternals = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {};
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  errors = [];
  started = 0;
  window.addEventListener('tf-storage-uncertain', onError);
  window.addEventListener('tf-factory-reset-started', onStart);
  storage = await import('../js/core/storage.js');
  reset = await import('../js/settings/factoryReset.js');
});

afterEach(() => {
  window.removeEventListener('tf-storage-uncertain', onError);
  window.removeEventListener('tf-factory-reset-started', onStart);
  window.__TAURI_INTERNALS__ = priorInternals;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('полный сброс и очередь реального storage.js', () => {
  it('ждёт предыдущую запись, запрещает новые операции и сохраняет блокировку после успеха', async () => {
    const pending = deferred();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = storage.persist();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const plan = reset.prepareFactoryReset(mocks.state);
    expect(plan.summary.chars).toBe(2);
    const resetting = reset.performFactoryReset(mocks.state, plan);
    await vi.dynamicImportSettled();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.loadData()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    await expect(storage.deleteStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    expect(mocks.invoke).not.toHaveBeenCalled();
    pending.resolve(true);
    await saving;
    expect(await resetting).toBe(true);
    expect(started).toBe(1);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'load_state_raw');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'factory_reset', {
      keys: ['archive', 'hero'],
      accountKeys: ['archive', 'archive@gc-old', 'hero', 'hero@gc-1'],
      expectedRaw: '{"fictional":true}'
    });
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    expect(errors).toEqual([]);
  });

  it('не запускает сброс после отказа ожидавшей записи и разрешает исправить её', async () => {
    const pending = deferred();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = storage.persist();
    const saveFailure = expect(saving).rejects.toThrow('write failed');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const resetting = reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state));
    pending.reject(new Error('write failed'));
    await saveFailure;
    expect(await resetting).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(started).toBe(0);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('предыдущее сохранение'), 'error', 60000);
    await expect(storage.persist()).resolves.toBeUndefined();
  });

  it('не удаляет копии, если предыдущая запись могла завершиться частично', async () => {
    const pending = deferred();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = storage.persist();
    const failure = expect(saving).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const resetting = reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state));
    pending.reject(new Error('TF_STATE_WRITE_UNCERTAIN: UNKNOWN'));
    await failure;
    expect(await resetting).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    expect(errors).toEqual([{ source: 'state' }]);
  });

  it('не выполняет подтверждённый сброс, если данные изменились во время ожидания', async () => {
    const pending = deferred();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = storage.persist();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const plan = reset.prepareFactoryReset(mocks.state);
    const resetting = reset.performFactoryReset(mocks.state, plan);
    mocks.state.characters[0].contacts.password = 'FICTIONAL-NEW';
    pending.resolve(true);
    await saving;
    expect(await resetting).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(started).toBe(0);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringContaining('Данные изменились после подтверждения'),
      'error',
      60000
    );
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('FICTIONAL');
    mocks.state.characters[0].contacts.password = 'FICTIONAL-PRIVATE';
    expect(await reset.performFactoryReset(mocks.state, plan)).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await expect(storage.persist()).resolves.toBeUndefined();
  });

  it('повторно сверяет согласованное состояние после чтения файла', async () => {
    const reading = deferred();
    mocks.invoke.mockImplementation(command =>
      command === 'load_state_raw' ? reading.promise : Promise.resolve(success())
    );
    const performing = reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state));
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('load_state_raw'));
    mocks.state.characters[0].contacts.password = 'FICTIONAL-CHANGED-DURING-READ';
    reading.resolve('{"fictional":true}');
    expect(await performing).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'factory_reset')).toHaveLength(0);
    expect(started).toBe(0);
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('FICTIONAL');
    await expect(storage.persist()).resolves.toBeUndefined();
  });

  it.each([new Error('PRIVATE-PATH'), undefined, { unexpected: true }])(
    'блокирует запись при ошибке или неверном ответе чтения, не запуская удаление',
    async failure => {
      const onReadFailure = vi.fn();
      window.addEventListener('tf-factory-reset-read-failed', onReadFailure, { once: true });
      mocks.invoke.mockImplementation(async () => {
        if (failure instanceof Error) throw failure;
        return failure;
      });
      expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'factory_reset')).toHaveLength(0);
      expect(onReadFailure).toHaveBeenCalledOnce();
      expect(started).toBe(0);
      expect(errors).toEqual([]);
      await expect(storage.persist()).rejects.toThrow('Запись остановлена');
      // Результат удаления не неизвестен: восстановление из копии остаётся возможным.
      await expect(storage.restoreStoredBackup('backup')).resolves.toBeUndefined();
      expect(mocks.restore).toHaveBeenCalledWith('backup');
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE-PATH');
    }
  );

  it('не начинает сброс параллельно созданию или удалению копии', async () => {
    const pending = deferred();
    mocks.backup.mockReturnValueOnce(pending.promise);
    const copying = storage.createBackup('manual');
    await vi.waitFor(() => expect(mocks.backup).toHaveBeenCalledTimes(1));
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    pending.resolve('backup');
    await copying;
    const deletion = deferred();
    mocks.removeBackup.mockReturnValueOnce(deletion.promise);
    const deleting = storage.deleteStoredBackup('backup');
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    deletion.resolve(true);
    await deleting;
  });

  it('не сбрасывает защищённое или непрочитанное состояние', async () => {
    storage.protectIncompatibleState();
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(started).toBe(0);
  });

  it.each([
    ['частичный отчёт', { ...success(), problems: ['PRIVATE-PATH'] }],
    ['нет отчёта', null],
    ['отчёт без полей', { problems: [] }],
    ['неверный тип', { ...success(), backupsRemoved: '2' }]
  ])('не повторяет сброс после %s', async (_name, report) => {
    mocks.invoke.mockImplementation(async command => (command === 'load_state_raw' ? '{"fictional":true}' : report));
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    expect(errors).toEqual([{ source: 'reset' }]);
    expect(started).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    await expect(storage.createBackup('manual')).rejects.toThrow('Запись остановлена');
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'factory_reset')).toHaveLength(1);
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE-PATH');
  });

  it('не запускает второй сброс, пока первый ждёт ответа', async () => {
    const pending = deferred();
    mocks.invoke.mockImplementation(command =>
      command === 'load_state_raw' ? Promise.resolve('{"fictional":true}') : pending.promise
    );
    const first = reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state));
    await vi.waitFor(() =>
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'factory_reset')).toHaveLength(1)
    );
    expect(await reset.performFactoryReset(mocks.state, reset.prepareFactoryReset(mocks.state))).toBe(false);
    pending.resolve(success());
    expect(await first).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'factory_reset')).toHaveLength(1);
  });
});
