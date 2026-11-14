import { beforeEach, expect, it, vi } from 'vitest';
import {
  openModifierExperiments,
  validateModifierExperiment,
  MODIFIER_EXPERIMENTS
} from '../js/modules/gameMacros/modifierExperiments.js';
const state = { characters: [{ id: 'a', nick: 'Alpha' }] };
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  localStorage.clear();
});
it('restricts every mode to one Shift chord and requires separate consent for global input', () => {
  for (const method of Object.keys(MODIFIER_EXPERIMENTS)) {
    const selection = { charId: 'a', key: 'shift+1', method, consent: true, riskConsent: true };
    expect(validateModifierExperiment(selection, state).key).toBe('SHIFT+1');
    expect(() => validateModifierExperiment({ ...selection, consent: false }, state)).toThrow();
    if (method !== 'isolated')
      expect(() => validateModifierExperiment({ ...selection, riskConsent: false }, state)).toThrow();
    for (const key of ['1', 'CTRL+1', 'ALT+F4', 'SHIFT+F25', 'SHIFT+ENTER', 'SHIFT+1\nSHIFT+2'])
      expect(() => validateModifierExperiment({ ...selection, key }, state)).toThrow();
  }
  expect(() =>
    validateModifierExperiment({ charId: 'a', key: 'SHIFT+1', method: 'unknown', consent: true }, state)
  ).toThrow();
});
it.each(['isolated', 'hybrid', 'activate'])(
  'runs %s only once and journals the manually observed base-only effect separately',
  async method => {
    const run = vi.fn(async (_, countdown) => {
      countdown(0);
      return { runId: 'r', ok: true };
    });
    const ov = openModifierExperiments({ state, run, stop: vi.fn() });
    const q = name => ov.body.querySelector(`[data-${name}]`);
    q('char').value = 'a';
    q('method').value = method;
    q('method').dispatchEvent(new Event('change'));
    q('run').click();
    expect(run).not.toHaveBeenCalled();
    q('consent').checked = true;
    if (method !== 'isolated') {
      q('run').click();
      expect(run).not.toHaveBeenCalled();
      q('risk').checked = true;
    }
    q('run').click();
    await vi.waitFor(() => expect(q('observations').disabled).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ charId: 'a', key: 'SHIFT+1', method });
    expect(q('consent').checked).toBe(false);
    expect(q('risk').checked).toBe(false);
    q('verdict').value = 'base-only';
    q('save').click();
    const saved = JSON.parse(localStorage.getItem('tvinoferma.background-journal.v1'));
    expect(JSON.stringify(saved)).toContain('base-only');
    expect(JSON.stringify(saved)).toContain(method);
    expect(run).toHaveBeenCalledTimes(1);
    ov.close();
  }
);
it('requests stop on close and clears consent on a changed method or key', () => {
  const run = vi.fn(() => new Promise(() => {})),
    stop = vi.fn();
  const ov = openModifierExperiments({ state, run, stop });
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('consent').checked = true;
  q('risk').checked = true;
  q('key').dispatchEvent(new Event('input'));
  expect(q('consent').checked).toBe(false);
  expect(q('risk').checked).toBe(false);
  q('char').value = 'a';
  q('consent').checked = true;
  q('run').click();
  ov.close();
  expect(run).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});
it('shows unconfirmed release as a warning, not a successful game effect', async () => {
  const ov = openModifierExperiments({
    state,
    stop: vi.fn(),
    run: async (_, countdown) => {
      countdown(0);
      return { runId: 'r', ok: false, releaseUnconfirmed: true };
    }
  });
  ov.body.querySelector('[data-char]').value = 'a';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() => expect(ov.body.querySelector('[data-status]').textContent).toContain('не подтверждено'));
  ov.close();
});
it('blocks the dialog from another attempt after an unconfirmed release', async () => {
  const ov = openModifierExperiments({
    state,
    stop: vi.fn(),
    run: async (_, countdown) => {
      countdown(0);
      return { runId: 'r', ok: false, releaseUnconfirmed: true };
    }
  });
  ov.body.querySelector('[data-char]').value = 'a';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() =>
    expect(ov.body.querySelector('[data-status]').textContent).toContain('Новые опыты заблокированы')
  );
  expect(ov.body.querySelector('[data-run]').disabled).toBe(true);
  ov.close();
});
