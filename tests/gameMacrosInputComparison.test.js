import { beforeEach, it, expect, vi } from 'vitest';
import {
  validateComparison,
  openInputComparison,
  COMPARISON_METHODS
} from '../js/modules/gameMacros/inputComparison.js';
const state = { characters: [{ id: 'a', nick: 'Alpha' }] };
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  localStorage.clear();
});
it('allows one bounded key and only explicit addressed modes, never inactive SendInput', () => {
  expect(validateComparison({ charId: 'a', key: 'b', method: 'active-send' }, state).key).toBe('B');
  for (const key of ['CTRL+B', 'B\nF8', 'ENTER', 'ALT+F4'])
    expect(() => validateComparison({ charId: 'a', key, method: 'active-post' }, state)).toThrow();
  expect(Object.keys(COMPARISON_METHODS)).not.toContain('inactive-send');
  expect(() => validateComparison({ charId: 'a', key: 'B', method: 'inactive-send' }, state)).toThrow();
  expect(() => validateComparison({ charId: 'unknown', key: 'B', method: 'active-post' }, state)).toThrow();
});
it('requires physical baseline and fresh consent; never starts on opening the dialog', async () => {
  const run = vi.fn(async () => ({ runId: 'r', ok: true }));
  const stop = vi.fn();
  const ov = openInputComparison({ state, run, stop });
  expect(run).not.toHaveBeenCalled();
  ov.body.querySelector('[data-char]').value = 'a';
  ov.body.querySelector('[data-key]').value = 'B';
  ov.body.querySelector('[data-run]').click();
  expect(run).not.toHaveBeenCalled();
  ov.body.querySelector('[data-physical]').value = 'worked';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(ov.body.querySelector('[data-run]').disabled).toBe(false));
  expect(ov.body.querySelector('[data-consent]').checked).toBe(false);
  ov.close();
});
it('close requests stop during an armed attempt and does not schedule another attempt', () => {
  const run = vi.fn(() => new Promise(() => {}));
  const stop = vi.fn();
  const ov = openInputComparison({ state, run, stop });
  ov.body.querySelector('[data-char]').value = 'a';
  ov.body.querySelector('[data-key]').value = 'F8';
  ov.body.querySelector('[data-physical]').value = 'worked';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  ov.close();
  expect(stop).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
});
