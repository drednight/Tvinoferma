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
  expect(dlg.body.querySelector('[data-script-picker]').textContent).toContain('(1)');
  dlg.body.querySelector('[data-script-picker]').click();
  document.querySelector('[data-picker-id=a]').click();
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
it('renders the actual demo B matrix, class icons and login stripes, recalculating it on code changes', () => {
  state.characters[0].class = 'Воин';
  state.characters[1].class = 'Жрец';
  const dlg = openPromoDialog({ ids: ['a', 'b'] });
  const input = dlg.body.querySelector('#promo-code');
  input.value = 'CODE2026';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(dlg.body.querySelector('.sp-main [data-script-plan] th code').textContent).toBe('CODE2026');
  const rows = [...dlg.body.querySelectorAll('[data-script-plan] tbody tr')];
  expect(rows).toHaveLength(2);
  expect(rows[0].classList.contains('st-online')).toBe(true);
  expect(rows[1].classList.contains('st-offline')).toBe(true);
  expect(rows[0].querySelector('.char-class-ico').getAttribute('src')).toContain('var.webp');
  expect(rows[0].textContent).toContain('в плане');
  expect(dlg.body.querySelector('[data-script-summary]').textContent).toContain('2');
  expect(dlg.body.querySelector('.promo-dot')).toBeNull();
  dlg.close();
});

it('defaults to online characters immediately, does not broaden after rerender and preserves explicit offline presets', () => {
  const dlg = openPromoDialog();
  expect(dlg.body.querySelector('.sp-radio input[value=logged]').checked).toBe(true);
  expect(dlg.body.querySelector('#promo-list input[data-id=a]').checked).toBe(true);
  expect(dlg.body.querySelector('#promo-list input[data-id=b]').checked).toBe(false);
  const code = dlg.body.querySelector('#promo-code');
  code.value = 'CODE';
  code.dispatchEvent(new Event('input', { bubbles: true }));
  expect(dlg.body.querySelector('[data-script-summary]').textContent).toContain('1');
  dlg.close();
  const preset = openPromoDialog({ ids: ['b'] });
  expect(preset.body.querySelector('.sp-radio input[value=manual]').checked).toBe(true);
  expect(preset.body.querySelector('#promo-list input[data-id=b]').checked).toBe(true);
  preset.close();
});
