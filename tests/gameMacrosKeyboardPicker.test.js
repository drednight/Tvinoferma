import { beforeEach, it, expect } from 'vitest';
import { KEYBOARD_ROWS, capturedChord, openKeyboardPicker } from '../js/modules/gameMacros/keyboardPicker.js';
import { selectCloseTargets } from '../js/modules/gameMacros/closeTargets.js';
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});
it('includes full alphanumeric, extended function, navigation and numpad keys', () => {
  const keys = KEYBOARD_ROWS.flat();
  for (const key of ['A', 'Z', 'F1', 'F24', 'PRINTSCREEN', 'NUMPAD0', 'NUMPAD9', 'HOME', 'LEFT', 'QUOTE'])
    expect(keys).toContain(key);
});
it('captures physical codes independently of the displayed layout and rejects unsupported/system keys', () => {
  expect(capturedChord({ code: 'KeyA', key: 'ф', ctrlKey: true })).toBe('CTRL+A');
  expect(capturedChord({ code: 'Numpad7' })).toBe('NUMPAD7');
  expect(capturedChord({ code: 'PrintScreen' })).toBe('PRINTSCREEN');
  expect(capturedChord({ code: 'Unidentified' })).toBe('');
  expect(capturedChord({ code: 'KeyA', metaKey: true })).toBe('');
});
it('chooses a single trigger, optional modifiers, and applies only after confirmation', () => {
  let chosen = '';
  const ov = openKeyboardPicker({
    onChoose: value => {
      chosen = value;
    }
  });
  const key = name => [...ov.body.querySelectorAll('button')].find(b => b.title === name);
  key('F8').click();
  expect(chosen).toBe('');
  key('CTRL').click();
  ov.foot.querySelector('[data-apply]').click();
  expect(chosen).toBe('CTRL+F8');
  expect(document.querySelector('.gm-keyboard-picker')).toBeNull();
});
it('captures only while armed and removes its listener when closed', () => {
  const ov = openKeyboardPicker({ onChoose: () => {} });
  ov.body.querySelector('[data-record]').click();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true, cancelable: true }));
  expect(ov.body.querySelector('output').textContent).toBe('B');
  ov.close();
  const event = new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
const rows = [
  { pid: 1, startedAt: 10, hwnd: 100, known: true, charId: 'pl' },
  { pid: 2, startedAt: 20, hwnd: 200, known: true, charId: 'twin' }
];
const config = { partyId: 'p', leaders: { p: 'pl' } };
const state = { parties: [{ id: 'p' }] };
it('closes only confirmed current targets, never broadens to new clients or a stale PID', () => {
  expect(selectCloseTargets(rows, { closeMode: 'selected', closeTargets: [rows[1]] }, config, state)).toEqual([
    rows[1]
  ]);
  expect(() =>
    selectCloseTargets(rows, { closeMode: 'selected', closeTargets: [{ ...rows[1], startedAt: 19 }] }, config, state)
  ).toThrow();
});
it('keeps exactly the verified PL and refuses ambiguity or an absent PL', () => {
  expect(selectCloseTargets(rows, { closeMode: 'except-leader', closeTargets: rows }, config, state)).toEqual([
    rows[1]
  ]);
  expect(() =>
    selectCloseTargets(rows, { closeMode: 'except-leader', closeTargets: rows }, { leaders: {} }, state)
  ).toThrow();
  expect(() =>
    selectCloseTargets(
      [...rows, { ...rows[0], pid: 3 }],
      { closeMode: 'except-leader', closeTargets: rows },
      config,
      state
    )
  ).toThrow();
});
