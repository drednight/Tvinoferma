import { beforeEach, expect, it, vi } from 'vitest';
const { saveNow, createBackup, forceRenderAndPersist } = vi.hoisted(() => ({
  saveNow: vi.fn(async () => {}),
  createBackup: vi.fn(async () => ({ id: 'backup' })),
  forceRenderAndPersist: vi.fn(async () => {})
}));
vi.mock('../js/core/storage.js', () => ({
  saveNow,
  createBackup,
  forceRenderAndPersist,
  assertStateWriteAvailable: vi.fn(),
  haltAfterPartialStateChange: vi.fn(),
  isTauri: () => false
}));
vi.mock('../js/core/secrets.js', () => ({ vaultStatus: () => ({ count: 0, blocked: false }) }));
import { state } from '../js/core/state.js';
import { openDuplicateCharacters } from '../js/settings/duplicateCharacters.js';
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  state.characters = [
    { id: 'a', nick: 'Same', contacts: { email: 'same@example.test' }, class: 'Воин', stats: { hp: 10 } },
    { id: 'b', nick: 'same', contacts: { email: 'same@example.test' }, class: 'Маг', stats: { mp: 20 } }
  ];
  state.archivedCharacters = [];
  state.archivedParties = [];
  state.marathons = [{ participantIds: ['a', 'b'], progress: { a: { t1: 1 }, b: { t2: 1 } } }];
  state.ui.authCheck = {};
  state.ui.revealedContacts = {};
  state.secretsInVault = false;
});
it('asks about a conflicting class, backs up and merges complementary data and references', async () => {
  const ov = openDuplicateCharacters();
  ov.body.querySelector('[data-merge]').click();
  const conflict = [...document.querySelectorAll('.modal-overlay')].at(-1);
  expect(conflict.textContent).toContain('class');
  conflict.querySelector('.modal-footer button').click();
  await vi.waitFor(() => expect(document.querySelector('.tf-confirm-overlay')).not.toBeNull());
  document.querySelector('.tf-confirm-overlay .btn.danger').click();
  await vi.waitFor(() => expect(forceRenderAndPersist).toHaveBeenCalledTimes(1));
  expect(createBackup).toHaveBeenCalledWith('before-merge-duplicates');
  expect(state.characters).toHaveLength(1);
  expect(state.characters[0]).toMatchObject({ id: 'a', class: 'Воин', stats: { hp: 10, mp: 20 } });
  expect(state.marathons[0]).toEqual({ participantIds: ['a'], progress: { a: { t1: 1, t2: 1 } } });
  ov.close();
});
it('cancelling a field choice leaves both characters untouched and creates no backup', async () => {
  const before = JSON.stringify(state.characters);
  const ov = openDuplicateCharacters();
  ov.body.querySelector('[data-merge]').click();
  const conflict = [...document.querySelectorAll('.modal-overlay')].at(-1);
  [...conflict.querySelectorAll('button')].find(b => b.textContent === 'Отмена').click();
  await Promise.resolve();
  expect(JSON.stringify(state.characters)).toBe(before);
  expect(createBackup).not.toHaveBeenCalled();
  ov.close();
});
