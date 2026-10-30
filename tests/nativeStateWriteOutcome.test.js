import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { tauriAdapter } from '../js/core/storageAdapters/tauriAdapter.js';
import { isUncertainStateWrite } from '../js/core/stateWriteOutcome.js';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('граница результата desktop-записи', () => {
  it('сохраняет и восстанавливает при подтверждённом ответе', async () => {
    await expect(tauriAdapter.saveState({ test: 1 })).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('save_state', { payload: { test: 1 } });
    await expect(tauriAdapter.restoreBackup('backup.json')).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('restore_backup', { fileName: 'backup.json' });
  });

  it('подтверждает имя созданной копии только ожидаемым ответом IPC', async () => {
    invoke.mockResolvedValueOnce('state.backup-123-before-delete-parties-45-67.json');
    await expect(tauriAdapter.createBackup({ label: 'before-delete-parties' })).resolves.toBe(
      'state.backup-123-before-delete-parties-45-67.json'
    );
    expect(invoke).toHaveBeenCalledWith('create_backup', { maxCount: null, label: 'before-delete-parties' });
  });

  it.each([null, undefined, false, '', '../state.backup-1.json', 'state.backup-invalid/name.json', 'PRIVATE-DETAIL'])(
    'не подтверждает создание копии по неверному ответу IPC: %s',
    async name => {
      invoke.mockResolvedValueOnce(name);
      const error = await tauriAdapter.createBackup().catch(e => e);
      expect(error.message).toContain('Не удалось подтвердить резервную копию');
      expect(error.message).not.toContain('PRIVATE-DETAIL');
    }
  );

  it('не раскрывает сообщение IPC при неподтверждённом создании копии', async () => {
    invoke.mockRejectedValueOnce(new Error('PRIVATE-DETAIL'));
    const error = await tauriAdapter.createBackup().catch(e => e);
    expect(error.message).toContain('проверьте список копий');
    expect(error.message).not.toContain('PRIVATE-DETAIL');
  });

  it.each([null, undefined])('подтверждает удаление копии только пустым ответом IPC: %s', async response => {
    invoke.mockResolvedValue(response);
    await expect(tauriAdapter.deleteBackup('backup.json')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('delete_backup', { fileName: 'backup.json' });
  });

  it.each([false, 'PRIVATE-DETAIL', { private: 'PRIVATE-DETAIL' }])(
    'не утверждает удаление копии по постороннему ответу',
    async response => {
      invoke.mockResolvedValue(response);
      const error = await tauriAdapter.deleteBackup('backup.json').catch(e => e);
      expect(error.message).toContain('Результат удаления копии не подтверждён');
      expect(error.message).not.toContain('PRIVATE-DETAIL');
    }
  );

  it('не раскрывает сообщение IPC при потерянном ответе удаления копии', async () => {
    invoke.mockRejectedValue(new Error('PRIVATE-DETAIL'));
    const error = await tauriAdapter.deleteBackup('backup.json').catch(e => e);
    expect(error.message).toContain('проверьте её наличие');
    expect(error.message).not.toContain('PRIVATE-DETAIL');
  });

  it.each(['save', 'restore'])('считает потерянный ответ IPC неизвестным исходом: %s', async operation => {
    invoke.mockRejectedValue(new Error('channel disconnected'));
    const call = operation === 'save' ? tauriAdapter.saveState({ test: 1 }) : tauriAdapter.restoreBackup('backup.json');
    await expect(call.catch(isUncertainStateWrite)).resolves.toBe(true);
  });

  it.each(['save', 'restore'])('разрешает обработать подтверждённый отказ до замены: %s', async operation => {
    invoke.mockRejectedValue('TF_STATE_WRITE_UNCHANGED: Не удалось подготовить запись');
    const call = operation === 'save' ? tauriAdapter.saveState({ test: 1 }) : tauriAdapter.restoreBackup('backup.json');
    await expect(call).rejects.toThrow('Не удалось подготовить запись');
    expect(isUncertainStateWrite(new Error('Не удалось подготовить запись'))).toBe(false);
  });

  it('не раскрывает исходное сообщение IPC, если исход неизвестен', async () => {
    invoke.mockRejectedValue('TF_STATE_WRITE_UNCERTAIN: содержит внутренние детали');
    await expect(tauriAdapter.saveState({ test: 1 })).rejects.toThrow('Состояние могло измениться');
  });

  it.each(['save', 'restore'])('не считает посторонний ответ IPC подтверждением операции: %s', async operation => {
    invoke.mockResolvedValue({ result: 'PRIVATE-DETAIL' });
    const call = operation === 'save' ? tauriAdapter.saveState({ test: 1 }) : tauriAdapter.restoreBackup('backup.json');
    const error = await call.catch(e => e);
    expect(isUncertainStateWrite(error)).toBe(true);
    expect(String(error)).not.toContain('PRIVATE-DETAIL');
  });
});

describe('desktop-свидетельство загруженного состояния и миграция', () => {
  const raw = '{\n  "schemaVersion": 9, "secret": "PRIVATE"\n}';

  it('передаёт точный исходный JSON только в проверенные локальные IPC-команды', async () => {
    invoke.mockResolvedValueOnce(raw).mockResolvedValueOnce('state.backup-test.json').mockResolvedValueOnce(undefined);
    const snapshot = await tauriAdapter.loadState();
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_state_raw');
    await expect(tauriAdapter.createMigrationBackup(snapshot, 'pre-migration-v9')).resolves.toBe(
      'state.backup-test.json'
    );
    expect(invoke).toHaveBeenNthCalledWith(2, 'create_migration_backup', {
      expectedRaw: raw,
      label: 'pre-migration-v9'
    });
    await expect(tauriAdapter.saveMigratedState(snapshot, { schemaVersion: 10 })).resolves.toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(3, 'save_state_if_unchanged', {
      expectedRaw: raw,
      payload: { schemaVersion: 10 }
    });
    tauriAdapter.forgetLoadedState(snapshot);
    await expect(tauriAdapter.createMigrationBackup(snapshot, 'test')).rejects.toThrow('недоступны');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it.each([null, undefined, false, '', '../state.backup-1.json', 'state.backup-invalid/name.json'])(
    'не считает некорректное имя подтверждением копии: %s',
    async name => {
      invoke.mockResolvedValueOnce(raw).mockResolvedValueOnce(name);
      const snapshot = await tauriAdapter.loadState();
      await expect(tauriAdapter.createMigrationBackup(snapshot, 'test')).rejects.toThrow('Не удалось подтвердить');
      expect(invoke).toHaveBeenCalledTimes(2);
    }
  );

  it.each([false, 'unexpected', { saved: true }])(
    'не считает неверный ответ подтверждением записи: %s',
    async response => {
      invoke.mockResolvedValueOnce(raw).mockResolvedValueOnce(response);
      const snapshot = await tauriAdapter.loadState();
      const result = await tauriAdapter.saveMigratedState(snapshot, {}).catch(e => e);
      expect(isUncertainStateWrite(result)).toBe(true);
    }
  );

  it('не отправляет IPC, если загруженный объект изменён', async () => {
    invoke.mockResolvedValueOnce(raw);
    const snapshot = await tauriAdapter.loadState();
    snapshot.secret = 'different';
    await expect(tauriAdapter.createMigrationBackup(snapshot, 'test')).rejects.toThrow('изменились');
    await expect(tauriAdapter.saveMigratedState(snapshot, {})).rejects.toThrow('изменились');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['TF_STATE_WRITE_UNCHANGED: Исходник изменён', false],
    ['channel disconnected with PRIVATE detail', true],
    ['TF_STATE_WRITE_UNCERTAIN: PRIVATE', true]
  ])('различает отказ до записи и потерянный ответ: %s', async (error, uncertain) => {
    invoke.mockResolvedValueOnce(raw);
    const snapshot = await tauriAdapter.loadState();
    invoke.mockRejectedValueOnce(error);
    const result = await tauriAdapter.saveMigratedState(snapshot, {}).catch(e => e);
    expect(isUncertainStateWrite(result)).toBe(uncertain);
    if (uncertain) expect(result.message).not.toContain('PRIVATE');
  });

  it.each(['{"private":"PRIVATE",', '[]', 'null', '"PRIVATE"'])('не выводит повреждённый JSON в ошибке', async bad => {
    invoke.mockResolvedValueOnce(bad);
    const result = await tauriAdapter.loadState().catch(e => e);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toContain('PRIVATE');
  });

  it('сохраняет отсутствие файла как отсутствие данных', async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(tauriAdapter.loadState()).resolves.toBeNull();
  });
});
