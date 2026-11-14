import { expect, it, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { openDuplicateCharacters } from '../js/settings/duplicateCharacters.js';
it('returns from a real character profile to the same duplicate list and selected primary card', async () => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  state.characters = [
    { id: 'a', nick: 'Same', contacts: { email: 'same@example.test' }, class: 'Воин' },
    { id: 'b', nick: 'same', contacts: { email: 'same@example.test' }, class: 'Маг' }
  ];
  state.archivedCharacters = [];
  state.parties = [];
  state.archivedParties = [];
  const ov = openDuplicateCharacters();
  const select = ov.body.querySelector('select');
  select.value = 'b';
  ov.body.querySelector('[data-profile="a"]').click();
  await vi.waitFor(() => expect(document.getElementById('btn-close-profile')).not.toBeNull());
  await vi.waitFor(() => expect(document.getElementById('btn-close-profile').onclick).toBeTypeOf('function'));
  document.getElementById('btn-close-profile').click();
  expect(ov.el.isConnected).toBe(true);
  expect(select.value).toBe('b');
  ov.close();
});
