import { beforeEach, expect, it, vi } from 'vitest';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
import { buildTrial, summarizeExecution } from '../js/modules/gameMacros/trialEvidence.js';
import { normalizeTrials, trialTrace } from '../js/modules/gameMacros/trialRecords.js';
import { openTrialWizard, openTrialComparison } from '../js/modules/gameMacros/trialWizard.js';
const state = {
  parties: [{ id: 'p', name: 'Party' }],
  characters: [
    { id: 'lead', nick: 'Leader', partyIds: ['p'] },
    { id: 'twin', nick: '<Twin>', partyIds: ['p'] }
  ]
};
let c, save, diagnose, runTrial;
const selection = { partyId: 'p', charId: 'twin', key: 'B', method: 'post' };
const run = { runId: 'run', state: 'finished', stage: 'execution-complete', events: [] };
const q = field => document.querySelector(`[data-trial-${field}]`);
function open() {
  openTrialWizard({ getConfig: () => c, state, save, diagnose, runTrial, stop: vi.fn() });
}
function choose() {
  q('char').value = 'twin';
  q('key').value = 'B';
}
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  c = normalizeGameMacros({ partyId: 'p', leaders: { p: 'lead' } });
  save = vi.fn(async patch => {
    c = normalizeGameMacros({ ...c, ...patch });
  });
  diagnose = vi.fn(async () => 'Window report');
  runTrial = vi.fn(async () => run);
});
it('builds only one strict keyboard trial with no persistence or automatic fallback', () => {
  const trial = buildTrial(selection, c, state);
  expect(trial).toMatchObject({
    target: 'subset',
    charIds: ['twin'],
    strictTargets: true,
    hotkey: '',
    sequence: 'B',
    returnTo: 'last',
    delivery: 'background'
  });
  expect(c.commands).toHaveLength(0);
  for (const changed of [
    { charId: 'lead' },
    { charId: 'missing' },
    { partyId: 'other' },
    { key: 'B\nF8' },
    { method: 'unknown' }
  ])
    expect(() => buildTrial({ ...selection, ...changed }, c, state)).toThrow();
});
it('describes phase timeout without claiming no delivery or guessing an input API', () => {
  const result = summarizeExecution({
    ...run,
    state: 'failed',
    events: [{ stage: 'background-phase', status: 'blocked', details: { phase: 'activate-app', errorCode: 1460 } }]
  });
  expect(result.stage).toBe('activate-app');
  expect(result.known).toContain('не доказывает недоставку');
  expect(result.unknown).toContain('автоматически не определяются');
  expect(summarizeExecution(run).known).toContain('не подтверждение');
  expect(summarizeExecution(null).known).toContain('нет');
});
it('distinguishes access denial, focus change and cancelled execution', () => {
  expect(summarizeExecution({ ...run, events: [{ details: { errorCode: 5 } }] }).known).toContain('доступе');
  expect(summarizeExecution({ ...run, events: [{ details: { foregroundChanged: true } }] }).known).toContain(
    'активное окно'
  );
  expect(summarizeExecution({ ...run, state: 'stopped' }).known).toContain('не отменяется');
});
it('bounds persisted trials, diagnostics and arbitrary native details', () => {
  const trace = trialTrace({
    ...run,
    events: Array.from({ length: 100 }, () => ({
      stage: 'native:action',
      details: { pid: 1, password: 'secret', blockedBy: 'password=secret' }
    }))
  });
  expect(trace.events).toHaveLength(60);
  expect(trace.omitted).toBe(40);
  expect(JSON.stringify(trace)).not.toContain('secret');
  const rows = normalizeTrials(
    Array.from({ length: 50 }, () => ({ id: 'id', ...selection, technical: { trace }, notes: 'x'.repeat(1000) }))
  );
  expect(rows).toHaveLength(40);
  expect(rows[0].notes).toHaveLength(600);
  expect(normalizeTrials([null, {}])).toEqual([]);
});
it('never runs on opening or probing, requires consent and prevents a second send', async () => {
  open();
  choose();
  expect(runTrial).not.toHaveBeenCalled();
  q('check').click();
  await vi.waitFor(() => expect(q('consent').disabled).toBe(false));
  expect(diagnose).toHaveBeenCalledWith('twin', 'B');
  expect(runTrial).not.toHaveBeenCalled();
  expect(q('run').disabled).toBe(true);
  q('consent').checked = true;
  q('consent').dispatchEvent(new Event('change'));
  q('run').click();
  q('run').click();
  await vi.waitFor(() => expect(q('observation').hidden).toBe(false));
  expect(runTrial).toHaveBeenCalledTimes(1);
  expect(q('run').disabled).toBe(true);
  await vi.waitFor(() => expect(c.backgroundTrials).toHaveLength(1));
  expect(c.backgroundTrials[0].verdict).toBe('unverified');
  expect(c.backgroundTrials[0].technical.trace.runId).toBe('run');
  q('verdict').value = 'worked';
  q('save').click();
  expect(q('status').textContent).toContain('Подтвердите');
  q('observed').checked = true;
  q('notes').value = 'Observed';
  q('save').click();
  await vi.waitFor(() => expect(c.backgroundTrials[0].verdict).toBe('worked'));
  expect(runTrial).toHaveBeenCalledTimes(1);
});
it('invalidates consent after edits and blocks sending when probe fails', async () => {
  open();
  choose();
  diagnose.mockRejectedValueOnce(new Error('No window'));
  q('check').click();
  await vi.waitFor(() => expect(q('status').textContent).toContain('No window'));
  expect(q('run').disabled).toBe(true);
  q('check').click();
  await vi.waitFor(() => expect(q('consent').disabled).toBe(false));
  q('key').value = 'F8';
  q('key').dispatchEvent(new Event('input'));
  expect(q('consent').disabled).toBe(true);
  expect(q('run').disabled).toBe(true);
  expect(runTrial).not.toHaveBeenCalled();
});
it('offers retry of persistence without retrying input and escapes comparison notes', async () => {
  open();
  choose();
  q('check').click();
  await vi.waitFor(() => expect(q('consent').disabled).toBe(false));
  q('consent').checked = true;
  q('consent').dispatchEvent(new Event('change'));
  save.mockRejectedValueOnce(new Error('Disk'));
  q('run').click();
  await vi.waitFor(() => expect(q('status').textContent).toContain('Не удалось сохранить итог'));
  q('notes').value = '<img src=x onerror=alert(1)>';
  q('save').click();
  await vi.waitFor(() => expect(c.backgroundTrials).toHaveLength(1));
  expect(runTrial).toHaveBeenCalledTimes(1);
  openTrialComparison(c, state);
  expect(document.querySelector('img')).toBeNull();
  expect(document.body.textContent).toContain('<Twin>');
  expect(document.querySelector('[data-trial-details]')).not.toBeNull();
});
it('captures conditions before sending and invalidates agreement after a context edit', async () => {
  open();
  choose();
  const chat = document.querySelector('[data-condition="chat"]');
  chat.value = 'closed';
  q('check').click();
  await vi.waitFor(() => expect(q('consent').disabled).toBe(false));
  chat.value = 'open';
  chat.dispatchEvent(new Event('change', { bubbles: true }));
  expect(q('consent').disabled).toBe(true);
  q('check').click();
  await vi.waitFor(() => expect(q('consent').disabled).toBe(false));
  q('consent').checked = true;
  q('consent').dispatchEvent(new Event('change'));
  q('run').click();
  await vi.waitFor(() => expect(c.backgroundTrials).toHaveLength(1));
  expect(c.backgroundTrials[0].conditions.chat).toBe('open');
  expect(runTrial).toHaveBeenCalledTimes(1);
});
