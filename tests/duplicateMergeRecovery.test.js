import { beforeEach, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  forget: vi.fn(),
  contacts: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../js/core/storage.js', () => ({
  inspectStoredBackup: mocks.inspect,
  forgetStoredBackupInspection: mocks.forget
}));
vi.mock('../js/settings/duplicateContactBackup.js', () => ({ openDuplicateContactBackup: mocks.contacts }));
vi.mock('../js/core/ui.js', async original => ({
  ...(await original()),
  confirmModal: mocks.confirm,
  toast: mocks.toast
}));
import { beginDuplicateMergeJournal, readDuplicateMergeJournal } from '../js/core/duplicateMergeJournal.js';
import { attachDuplicateMergeRecovery } from '../js/settings/duplicateMergeRecovery.js';

const name = 'state.backup-123-dup-0123456789abcdef01234567-42-1.json';
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  document.body.innerHTML = '<div id="storage-readonly-banner"></div><div id="modal-root"></div>';
  beginDuplicateMergeJournal(name);
  mocks.inspect.mockResolvedValue({
    schemaVersion: 10,
    characters: 2,
    archivedCharacters: 0,
    vaultReference: 'os-referenced'
  });
  mocks.contacts.mockResolvedValue({});
  mocks.confirm.mockResolvedValue(false);
});

it('requires both inspections before acknowledgement, and cancellation keeps the marker', async () => {
  attachDuplicateMergeRecovery(readDuplicateMergeJournal());
  document.querySelector('#storage-readonly-banner button').click();
  const overlay = document.querySelector('.modal-overlay');
  const buttons = overlay.querySelectorAll('button.btn');
  expect(buttons[2].disabled).toBe(true);
  buttons[0].click();
  await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledOnce());
  expect(buttons[2].disabled).toBe(true);
  buttons[1].click();
  await vi.waitFor(() => expect(buttons[2].disabled).toBe(false));
  expect(mocks.inspect).toHaveBeenCalledWith(name);
  expect(mocks.contacts).toHaveBeenCalledWith(name);
  buttons[2].click();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(readDuplicateMergeJournal().status).toBe('pending');
  expect(mocks.confirm.mock.calls[0][0].text).toContain('не восстанавливает контакты');
});

it('keeps acknowledgement disabled when either copy cannot be inspected', async () => {
  mocks.inspect.mockRejectedValue(new Error('PRIVATE error'));
  attachDuplicateMergeRecovery(readDuplicateMergeJournal());
  document.querySelector('#storage-readonly-banner button').click();
  const overlay = document.querySelector('.modal-overlay');
  const buttons = overlay.querySelectorAll('button.btn');
  buttons[0].click();
  buttons[1].click();
  await vi.waitFor(() => expect(overlay.textContent).toContain('Не удалось проверить копию'));
  expect(buttons[2].disabled).toBe(true);
  expect(overlay.textContent).not.toContain('PRIVATE');
  expect(readDuplicateMergeJournal().status).toBe('pending');
});
