import { it, expect, beforeEach, vi } from 'vitest';
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), confirmModal: vi.fn(async () => false) }));
import { state } from '../js/core/state.js';
import { openPromoDialog } from '../js/modules/automation/promo.js';
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  localStorage.clear();
  state.characters = [
    { id: 'a', nick: 'А', className: 'Воин', partyId: 'p', isLoggedIn: true },
    { id: 'b', nick: 'Б', isLoggedIn: false }
  ];
  state.parties = [{ id: 'p', name: 'Пати', members: ['a'] }];
});
it('promotes split layout and separate draft picker; cancel keeps the actual plan unchanged', () => {
  const dlg = openPromoDialog();
  expect(dlg.body.querySelector('.sp-side')).toBeTruthy();
  expect(dlg.body.querySelector('.sp-main')).toBeTruthy();
  dlg.body.querySelector('[data-script-picker]').click();
  const picker = document.querySelector('.cp-dialog');
  expect(picker).toBeTruthy();
  picker.querySelector('[data-picker-id=a]').click();
  picker.querySelector('[data-picker-cancel]').click();
  expect(dlg.body.querySelector('[data-script-picker]').textContent).toContain('(0)');
  dlg.body.querySelector('[data-script-picker]').click();
  document.querySelector('[data-picker-id=b]').click();
  document.querySelector('[data-picker-save]').click();
  expect(dlg.body.querySelector('[data-script-picker]').textContent).toContain('(1)');
  expect(dlg.body.querySelector('#promo-list input[data-id=b]').checked).toBe(true);
  dlg.close();
});
it('party mode starts without a guessed party and only reveals the party selector on demand', () => {
  const dlg = openPromoDialog({ ids: ['a'] });
  expect(dlg.body.querySelector('[data-script-party]').hidden).toBe(true);
  dlg.body.querySelector('input[value=party]').click();
  expect(dlg.body.querySelector('[data-script-party]').hidden).toBe(false);
  expect(dlg.body.querySelector('[data-script-party]').value).toBe('');
  expect(dlg.body.querySelector('#promo-count').textContent).toContain('0');
  dlg.close();
});
