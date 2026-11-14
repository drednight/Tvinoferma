import { beforeEach, it, expect, vi } from 'vitest';
import { validateMultiTrial, openMultiInputTrial, trialOutcome } from '../js/modules/gameMacros/multiInputTrial.js';
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
    timing: { timeoutMs: 25, modifierGapMs: 0 },
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
  for (const charIds of [[], ['a', 'unknown']])
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
    {
      runId: 'multi',
      charId: 'a',
      status: 'worked',
      timing: { timeoutMs: 25, modifierGapMs: 0 },
      foregroundChanged: false,
      leak: false
    },
    {
      runId: 'multi',
      charId: 'b',
      status: 'failed',
      timing: { timeoutMs: 25, modifierGapMs: 0 },
      foregroundChanged: false,
      leak: false
    }
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

it('accepts one recipient and explicit timings, rejects unsafe budgets and counts modifier gaps', () => {
  expect(
    validateMultiTrial({ charIds: ['a'], sequence: 'SHIFT+1', timing: { timeoutMs: 100, modifierGapMs: 50 } }, state)
  ).toMatchObject({ charIds: ['a'], timing: { timeoutMs: 100, modifierGapMs: 50 } });
  for (const timing of [{ timeoutMs: 0 }, { timeoutMs: 1000 }, { modifierGapMs: 999 }, { timeoutMs: NaN }])
    expect(() => validateMultiTrial({ charIds: ['a'], sequence: 'SHIFT+1', timing }, state)).toThrow();
  const sequence = Array(6).fill('wait 1500').concat(Array(5).fill('SHIFT+1')).join('\n');
  expect(() => validateMultiTrial({ charIds: ['a'], sequence, timing: { modifierGapMs: 200 } }, state)).toThrow();
});
it('distinguishes uncertain delivery and unconfirmed release from technical success', () => {
  expect(trialOutcome({ ok: true })).toContain('не подтверждение реакции');
  expect(trialOutcome({ ok: false, timedOut: true })).toContain('Доставка неопределённа');
  expect(trialOutcome({ ok: false, recipients: [{ releaseUnconfirmed: true }] })).toContain('Отпускание');
  expect(trialOutcome({ ok: false })).toContain('прерван/отклонён');
});
it('passes selected budgets to one-client run and displays release warning without retry', async () => {
  const run = vi.fn(async () => ({
    runId: 'one',
    ok: false,
    releaseUnconfirmed: true,
    recipients: [{ ok: false, releaseUnconfirmed: true }]
  }));
  const ov = openMultiInputTrial({ state, run, stop: vi.fn() });
  ov.body.querySelector('[data-char]').checked = true;
  ov.body.querySelector('[data-sequence]').value = 'SHIFT+1';
  ov.body.querySelector('[data-timeout]').value = '250';
  ov.body.querySelector('[data-gap]').value = '100';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() => expect(ov.body.querySelector('[data-status]').textContent).toContain('Отпускание'));
  expect(run.mock.calls[0][0]).toMatchObject({ charIds: ['a'], timing: { timeoutMs: 250, modifierGapMs: 100 } });
  expect(run).toHaveBeenCalledOnce();
  expect(ov.body.querySelectorAll('[data-verdict]')).toHaveLength(1);
  ov.close();
});
it('warns before sending that message-only modifiers can trigger the base action', () => {
  const ov = openMultiInputTrial({ state, run: vi.fn(), stop: vi.fn() });
  const warning = ov.body.querySelector('[data-modifier-warning]');
  expect(warning.hidden).toBe(false);
  expect(warning.textContent).toContain('обычная 1');
  expect(warning.textContent).toContain('состояние клавиатуры игры не меняется');
  ov.close();
});
it('allows only explicit generic/left/right Shift variants and preserves legacy defaults', () => {
  for (const shiftVk of [160, 161])
    expect(validateMultiTrial({ charIds: ['a'], sequence: 'SHIFT+1', timing: { shiftVk } }, state).timing.shiftVk).toBe(
      shiftVk
    );
  expect(validateMultiTrial({ charIds: ['a'], sequence: 'SHIFT+1' }, state).timing.shiftVk).toBeUndefined();
  for (const shiftVk of [0, 17, 162, 'invalid'])
    expect(() => validateMultiTrial({ charIds: ['a'], sequence: 'SHIFT+1', timing: { shiftVk } }, state)).toThrow();
});
it('inserts a keyboard choice into the current sequence line without dispatching input', () => {
  const run = vi.fn();
  const ov = openMultiInputTrial({ state, run, stop: vi.fn() });
  const input = ov.body.querySelector('[data-sequence]');
  input.value = 'B\nSHIFT+1\nwait 100';
  input.setSelectionRange(4, 4);
  [...ov.body.querySelectorAll('button')].find(b => b.textContent.includes('Полная клавиатура')).click();
  const picker = document.querySelector('.gm-keyboard-picker');
  picker.querySelector('[data-key="F8"]').click();
  picker.querySelector('[data-apply]').click();
  expect(input.value).toBe('B\nSHIFT+F8\nwait 100');
  expect(run).not.toHaveBeenCalled();
  expect(ov.el.isConnected).toBe(true);
  ov.close();
});
