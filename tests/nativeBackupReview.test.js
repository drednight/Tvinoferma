import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const PRIVATE = 'PRIVATE-CONTENT-DO-NOT-LOG';
const metadata = () => ({
  schemaVersion: 10,
  characters: 2,
  archivedCharacters: 1,
  plannerEntries: 3,
  vaultReference: 'os-referenced',
  currentState: 'readable',
  witness: { backupSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) }
});
let adapter;
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  ({ tauriAdapter: adapter } = await import('../js/core/storageAdapters/tauriAdapter.js'));
});
afterEach(() => vi.restoreAllMocks());

describe('desktop: просмотр копии и одноразовое подтверждение', () => {
  it('не показывает отпечатки и передаёт ровно проверенное свидетельство при восстановлении', async () => {
    const reply = metadata();
    invoke.mockResolvedValueOnce(reply).mockResolvedValueOnce(null);
    const review = await adapter.inspectBackup('state.backup-test.json');
    expect(invoke).toHaveBeenNthCalledWith(1, 'inspect_backup', { fileName: 'state.backup-test.json' });
    expect(review).toEqual({
      schemaVersion: 10,
      characters: 2,
      archivedCharacters: 1,
      plannerEntries: 3,
      vaultReference: 'os-referenced',
      currentState: 'readable'
    });
    expect(JSON.stringify(review)).not.toContain('a'.repeat(64));
    // The native response may be mutated after the review; the witness is copied.
    reply.witness.backupSha256 = 'c'.repeat(64);
    await expect(adapter.restoreBackup('state.backup-test.json', review)).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('restore_backup', {
      fileName: 'state.backup-test.json',
      witness: { backupSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) }
    });
    await expect(adapter.restoreBackup('state.backup-test.json', review)).rejects.toThrow('Не удалось проверить');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('не позволяет подставить другую копию или заменить объект сводки', async () => {
    invoke.mockResolvedValueOnce(metadata());
    const review = await adapter.inspectBackup('state.backup-test.json');
    await expect(adapter.restoreBackup('state.backup-other.json', review)).rejects.toThrow('Не удалось проверить');
    await expect(adapter.restoreBackup('state.backup-test.json', { ...review })).rejects.toThrow(
      'Не удалось проверить'
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    adapter.forgetBackupInspection(review);
    await expect(adapter.restoreBackup('state.backup-test.json', review)).rejects.toThrow('Не удалось проверить');
  });

  it.each([
    ['неверный отпечаток', value => (value.witness.backupSha256 = PRIVATE)],
    ['лишнее поле witness', value => (value.witness.private = PRIVATE)],
    ['неверный current', value => (value.witness.currentSha256 = '')],
    ['неверное количество', value => (value.characters = -1)],
    ['неизвестный статус', value => (value.vaultReference = PRIVATE)],
    [
      'метаданные через getter',
      value => Object.defineProperty(value, 'plannerEntries', { enumerable: true, get: () => PRIVATE })
    ]
  ])('отклоняет некорректный ответ IPC (%s) без утечки подробностей', async (_, alter) => {
    const value = metadata();
    alter(value);
    invoke.mockResolvedValueOnce(value);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = await adapter.inspectBackup('state.backup-test.json').catch(e => e);
    expect(error.message).toContain('Не удалось проверить');
    expect(error.message).not.toContain(PRIVATE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('при потере ответа восстановления не заявляет, что запись не произошла', async () => {
    invoke.mockResolvedValueOnce(metadata()).mockRejectedValueOnce(new Error(PRIVATE));
    const review = await adapter.inspectBackup('state.backup-test.json');
    const error = await adapter.restoreBackup('state.backup-test.json', review).catch(e => e);
    expect(error.message).toContain('TF_STATE_WRITE_UNCERTAIN:');
    expect(error.message).not.toContain(PRIVATE);
    await expect(adapter.restoreBackup('state.backup-test.json', review)).rejects.toThrow('Не удалось проверить');
  });

  it('при подтверждённой ошибке до замены не считает исход неизвестным', async () => {
    invoke.mockResolvedValueOnce(metadata()).mockRejectedValueOnce('TF_STATE_WRITE_UNCHANGED: Данные изменились');
    const review = await adapter.inspectBackup('state.backup-test.json');
    const error = await adapter.restoreBackup('state.backup-test.json', review).catch(e => e);
    expect(error.message).toBe('Данные изменились');
    expect(error.message).not.toContain('TF_STATE_WRITE_UNCERTAIN');
  });
});
