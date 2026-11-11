import { beforeEach, it, expect, vi } from 'vitest';
import { validateMultiTrial, openMultiInputTrial } from '../js/modules/gameMacros/multiInputTrial.js';
const state = {
  characters: [
    { id: 'a', nick: 'Alpha' },
    { id: 'b', nick: 'Beta' }
  ]
};
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  localStorage.clear();
});
it('accepts bounded multi-client chords/waits, without a delivery fallback', () => {
  expect(validateMultiTrial({ charIds: ['a', 'b'], sequence: 'B\nwait 500\nshift+1\nCTRL+B' }, state)).toEqual({
    charIds: ['a', 'b'],
    method: 'inactive-activity-notify',
    steps: [{ key: 'B' }, { wait: 500 }, { key: 'SHIFT+1' }, { key: 'CTRL+B' }]
  });
  for (const sequence of [
    'ALT+F4',
    'WIN+B',
    'ENTER',
    'wait 1501\nB',
    Array(11).fill('B').join('\n'),
    Array(7).fill('wait 1500').join('\n') + '\nB'
  ])
    expect(() => validateMultiTrial({ charIds: ['a', 'b'], sequence }, state)).toThrow();
  for (const charIds of [['a'], ['a', 'a'], ['a', 'unknown']])
    expect(() => validateMultiTrial({ charIds, sequence: 'B' }, state)).toThrow();
});
it('requires explicit consent and saves separate observations for each selected character', async () => {
  const run = vi.fn(async () => ({ runId: 'multi', ok: true, recipients: [] }));
  const ov = openMultiInputTrial({ state, run, stop: vi.fn() });
  ov.body.querySelectorAll('[data-char]').forEach(n => (n.checked = true));
  ov.body.querySelector('[data-sequence]').value = 'B\nwait 500\nC';
  ov.body.querySelector('[data-run]').click();
  expect(run).not.toHaveBeenCalled();
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() => expect(ov.body.querySelectorAll('[data-verdict]')).toHaveLength(2));
  expect(run).toHaveBeenCalledOnce();
  expect(ov.body.querySelector('[data-consent]').checked).toBe(false);
  ov.body.querySelector('[data-verdict="a"]').value = 'worked';
  ov.body.querySelector('[data-verdict="b"]').value = 'failed';
  ov.body.querySelector('[data-save]').click();
  const { backgroundJournalEntries } = await import('../js/modules/gameMacros/backgroundJournal.js');
  expect(
    backgroundJournalEntries()
      .filter(r => r.stage === 'multi-user-observation')
      .map(r => r.details)
  ).toEqual([
    { runId: 'multi', charId: 'a', status: 'worked', foregroundChanged: false, leak: false },
    { runId: 'multi', charId: 'b', status: 'failed', foregroundChanged: false, leak: false }
  ]);
  ov.close();
});
it('closing during countdown/operation requests stop, never schedules a retry', () => {
  const run = vi.fn(() => new Promise(() => {})),
    stop = vi.fn();
  const ov = openMultiInputTrial({ state, run, stop });
  ov.body.querySelectorAll('[data-char]').forEach(n => (n.checked = true));
  ov.body.querySelector('[data-sequence]').value = 'B';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  ov.close();
  expect(stop).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
});
