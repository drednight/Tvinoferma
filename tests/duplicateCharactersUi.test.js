import { beforeEach, expect, it, vi } from 'vitest';
const openCharacterProfile = vi.fn();
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile }));
import { state } from '../js/core/state.js';
import { openDuplicateCharacters } from '../js/settings/duplicateCharacters.js';
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  openCharacterProfile.mockClear();
  state.characters = [
    { id: 'a', nick: 'Same', class: 'Воин' },
    { id: 'b', nick: 'same', class: '<Маг>' }
  ];
  state.archivedCharacters = [{ id: 'c', nick: 'SAME' }];
});
it('counts candidate pairs and unique characters including archives and escapes displayed classes', () => {
  const ov = openDuplicateCharacters();
  const count = ov.body.querySelector('[data-duplicate-count]');
  expect(count.textContent).toContain('пар-кандидатов: 3');
  expect(count.textContent).toContain('Персонажей в них: 3');
  const classes = [...ov.body.querySelectorAll('[data-classes]')].map(n => n.textContent).join(' ');
  expect(classes).toContain('Воин');
  expect(classes).toContain('<Маг>');
  expect(classes).toContain('Класс не выбран');
  expect(ov.body.querySelector('маг')).toBeNull();
  ov.close();
});
it.each(['a', 'b'])('opens card %s independently of the primary merge selection', async side => {
  const ov = openDuplicateCharacters();
  const row = ov.body.querySelector('section');
  row.querySelector('select').value = side === 'a' ? 'b' : 'a';
  row.querySelector(`[data-profile="${side}"]`).click();
  await vi.waitFor(() =>
    expect(openCharacterProfile).toHaveBeenCalledWith(
      state.characters[side === 'a' ? 0 : 1],
      expect.objectContaining({ onClose: expect.any(Function) })
    )
  );
  expect(ov.el.isConnected).toBe(false);
  openCharacterProfile.mock.calls[0][1].onClose();
  expect(ov.el.isConnected).toBe(true);
  expect(row.querySelector('select').value).toBe(side === 'a' ? 'b' : 'a');
  ov.close();
});
it('shows a zero count when no candidates match', () => {
  state.characters = [
    { id: 'a', nick: 'A' },
    { id: 'b', nick: 'B' }
  ];
  state.archivedCharacters = [];
  const ov = openDuplicateCharacters();
  expect(ov.body.querySelector('[data-duplicate-count]').textContent).toContain('пар-кандидатов: 0');
  expect(ov.body.textContent).toContain('Совпадений не найдено');
  ov.close();
});
