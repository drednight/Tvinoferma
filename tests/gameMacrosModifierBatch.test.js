import { beforeEach, expect, it, vi } from 'vitest';
import { validateModifierBatch, openModifierBatch } from '../js/modules/gameMacros/modifierBatch.js';
const state = {
  characters: [
    { id: 'a', nick: 'Alpha' },
    { id: 'b', nick: 'Beta' }
  ]
};
const plan = (extra = {}) => ({
  charIds: ['a', 'b'],
  sequence: 'SHIFT+1\nCTRL+2\nALT+3\nCTRL+ALT+SHIFT+F8\nNUMPAD1\nwait 100',
  method: 'hybrid',
  consent: true,
  riskConsent: true,
  ...extra
});
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  localStorage.clear();
});
it('accepts multiple clients and mixed modifiers, plain keys and bounded waits', () => {
  const result = validateModifierBatch(plan(), state);
  expect(result.steps).toHaveLength(6);
  expect(result.steps[3].key).toBe('CTRL+ALT+SHIFT+F8');
});
it.each([
  { charIds: [] },
  { charIds: ['a', 'a'] },
  { charIds: ['missing'] },
  { consent: false },
  { riskConsent: false },
  { method: 'isolated' },
  { sequence: 'ALT+F4' },
  { sequence: 'CTRL+ALT+DELETE' },
  { sequence: 'WIN+1' },
  { sequence: 'wait 100' },
  { sequence: 'SHIFT+1\n'.repeat(9) },
  { sequence: 'wait 3001' }
])('rejects unsafe or unbounded plan %j', extra => {
  expect(() => validateModifierBatch(plan(extra), state)).toThrow();
});
it('renders per-client per-command observations and requests a single packet only', async () => {
  const run = vi.fn(async () => ({
    runId: 'batch',
    method: 'hybrid',
    ok: true,
    results: [
      { charId: 'a', index: 0, key: 'CTRL+1', details: { ok: true } },
      { charId: 'b', index: 0, key: 'CTRL+1', details: { ok: true } }
    ]
  }));
  const stop = vi.fn();
  const ov = openModifierBatch({ state, run, stop });
  const q = n => ov.body.querySelector(`[data-${n}]`);
  ov.body.querySelector('[data-char]').checked = true;
  q('sequence').value = 'CTRL+1';
  q('consent').checked = true;
  q('risk').checked = true;
  q('run').click();
  await vi.waitFor(() => expect(q('observations').disabled).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
  expect(q('consent').checked).toBe(false);
  expect(q('risk').checked).toBe(false);
  expect(ov.body.querySelectorAll('[data-verdict]')).toHaveLength(2);
  ov.close();
});
