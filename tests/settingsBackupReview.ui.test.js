// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  inspect: vi.fn(),
  forget: vi.fn(),
  restore: vi.fn(),
  saveNow: vi.fn(),
  isTauri: vi.fn(),
  vaultStatus: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../js/core/storage.js', async original => ({
  ...(await original()),
  getAdapter: mocks.getAdapter,
  inspectStoredBackup: mocks.inspect,
  forgetStoredBackupInspection: mocks.forget,
  restoreStoredBackup: mocks.restore,
  saveNow: mocks.saveNow,
  isTauri: mocks.isTauri
}));
vi.mock('../js/core/secrets.js', async original => ({ ...(await original()), vaultStatus: mocks.vaultStatus }));
vi.mock('../js/core/ui.js', async original => ({
  ...(await original()),
  confirmModal: mocks.confirm,
  toast: mocks.toast
}));

const name = 'state.backup-example.json';
const review = {
  schemaVersion: 10,
  characters: 2,
  archivedCharacters: 1,
  plannerEntries: 3,
  vaultReference: 'os-referenced',
  currentState: 'readable'
};
let state;
let restoreButton;
let exportButton;
let previousObjectUrl;
let previousRevoke;

function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}

beforeAll(async () => {
  document.body.innerHTML = `<button data-backup-restore="${name}">Восстановить</button><button id="export-all-btn">Экспорт</button>`;
  restoreButton = document.querySelector('[data-backup-restore]');
  exportButton = document.getElementById('export-all-btn');
  previousObjectUrl = URL.createObjectURL;
  previousRevoke = URL.revokeObjectURL;
  ({ state } = await import('../js/core/state.js'));
  const { bindSettings } = await import('../js/settings/settings.js');
  bindSettings();
});

afterAll(() => {
  URL.createObjectURL = previousObjectUrl;
  URL.revokeObjectURL = previousRevoke;
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAdapter.mockReturnValue({});
  mocks.inspect.mockResolvedValue({ ...review });
  mocks.restore.mockResolvedValue(undefined);
  mocks.saveNow.mockResolvedValue(undefined);
  mocks.isTauri.mockReturnValue(true);
  mocks.vaultStatus.mockReturnValue({ ready: true, blocked: false });
  mocks.confirm.mockResolvedValue(false);
  state.characters = [{ id: 'x', contacts: { email: 'private@example.test', password: 'private-password' } }];
  state.settings.security = { useVault: true };
  URL.createObjectURL = vi.fn(() => 'blob:example');
  URL.revokeObjectURL = vi.fn();
});

describe('просмотр копии перед восстановлением', () => {
  it('показывает только сводку и границы копии, отмена не запускает запись', async () => {
    restoreButton.click();
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledOnce());
    const shown = mocks.confirm.mock.calls[0][0].text;
    expect(shown).toContain('персонажей: 2');
    expect(shown).toContain('контактов ОС в ней нет');
    expect(shown).toContain('Контакты ОС после восстановления останутся прежними');
    expect(shown).not.toContain('private-password');
    expect(shown).not.toContain('private@example.test');
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...review, schemaVersion: null }, 'Не удалось определить версию'],
    [{ ...review, schemaVersion: 999 }, 'более новой версией'],
    [{ ...review, vaultReference: 'unknown' }, 'Не удалось проверить отметку']
  ])('останавливается до подтверждения для неподдерживаемой копии', async (value, message) => {
    mocks.inspect.mockResolvedValue(value);
    restoreButton.click();
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledOnce());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining(message), 'error', 60000);
  });

  it('не подтверждает прежнюю сводку, если данные изменились во время проверки', async () => {
    const wait = deferred();
    mocks.inspect.mockReturnValue(wait.promise);
    restoreButton.click();
    state.characters[0].contacts.email = 'changed@example.test';
    wait.resolve({ ...review });
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledOnce());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('изменились'), 'warning', 60000);
  });

  it('передаёт после подтверждения защиту от изменений памяти в очередь восстановления', async () => {
    const wait = deferred();
    mocks.confirm.mockReturnValue(wait.promise);
    mocks.restore.mockImplementation((_name, _review, stillMatches) => {
      expect(stillMatches()).toBe(false);
      throw new Error('Данные изменились после просмотра; откройте копию заново');
    });
    restoreButton.click();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    state.characters[0].contacts.password = 'changed-password';
    wait.resolve(true);
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledOnce());
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('изменились'), 'error', 60000);
  });
});

describe('предупреждение полного открытого JSON', () => {
  it('отмена ничего не сохраняет и не создаёт файл', async () => {
    exportButton.click();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    const shown = mocks.confirm.mock.calls[0][0].text;
    expect(shown).toContain('открытым текстом');
    expect(shown).toContain('не шифруется');
    expect(shown).not.toContain('private-password');
    expect(mocks.saveNow).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('не открывает подтверждение при недоступном vault', async () => {
    mocks.vaultStatus.mockReturnValue({ ready: false, blocked: true });
    exportButton.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.saveNow).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('не выгружает изменившиеся данные после подтверждения', async () => {
    const wait = deferred();
    mocks.confirm.mockReturnValue(wait.promise);
    exportButton.click();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    state.characters[0].contacts.password = 'changed-password';
    wait.resolve(true);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.saveNow).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('не выгружает файл, если данные изменились во время сохранения', async () => {
    const wait = deferred();
    mocks.confirm.mockResolvedValue(true);
    mocks.saveNow.mockReturnValue(wait.promise);
    exportButton.click();
    await vi.waitFor(() => expect(mocks.saveNow).toHaveBeenCalledOnce());
    state.characters[0].contacts.email = 'changed@example.test';
    wait.resolve();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('не выдаёт текст ошибки сохранения с личными данными', async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.saveNow.mockRejectedValue(new Error('private-password'));
    exportButton.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('private-password');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
