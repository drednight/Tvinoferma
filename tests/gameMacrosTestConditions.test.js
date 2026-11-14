import { beforeEach, it, expect, vi } from 'vitest';
import { normalizeConditions, conditionsSummary } from '../js/modules/gameMacros/testConditions.js';
import { normalizeTrials } from '../js/modules/gameMacros/trialRecords.js';
import { nativeResultStatus } from '../js/modules/gameMacros/nativeStatus.js';
import { mirrorObservation, openMirrorObservation } from '../js/modules/gameMacros/mirrorObservation.js';
import { exportTrialBundle } from '../js/modules/gameMacros/evidenceBundle.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
const state = { parties: [{ id: 'p' }], characters: [{ id: 'a', nick: 'Alpha', partyIds: ['p'] }] };
let c;
beforeEach(() => {
  c = normalizeGameMacros({ partyId: 'p' });
  document.body.innerHTML = '<div id="modal-root"></div>';
});
it('normalizes manual context without inferring missing old evidence', () => {
  expect(normalizeConditions(null)).toMatchObject({ purpose: 'unknown', chat: 'unknown', physical: 'unknown' });
  expect(normalizeConditions({ purpose: 'game', chat: 'closed', binding: 'x'.repeat(200) }).binding).toHaveLength(160);
  expect(conditionsSummary({ purpose: 'chat', chat: 'open' })).toContain('Ввод в чат');
});
it('does not call normal waiting and successful inactive-state replies blocked', () => {
  expect(nativeResultStatus('game_macro_input_idle', false)).toBe('waiting');
  expect(nativeResultStatus('game_macro_mirror', false)).toBe('inactive');
  expect(nativeResultStatus('game_macro_mirror', true)).toBe('active');
  expect(nativeResultStatus('game_macro_action', { ok: false })).toBe('blocked');
});
it('stores a separate manual mirror observation with conditions, never a fabricated technical receipt', () => {
  const row = mirrorObservation(
    { charId: 'a', key: 'B', verdict: 'failed', conditions: { purpose: 'game', chat: 'closed' } },
    c,
    state
  );
  const saved = normalizeTrials([row])[0];
  expect(saved).toMatchObject({
    method: 'mirror-post',
    conditions: { purpose: 'game', chat: 'closed' },
    technical: { state: 'manual-observation', trace: null, runId: '' }
  });
  const exported = JSON.parse(exportTrialBundle([row], [row.id]));
  expect(exported.records[0].technical.runId).toBe('');
  expect(exported.records[0].conditions.chat).toBe('closed');
  expect(() => mirrorObservation({ charId: 'missing', key: 'B', verdict: 'failed' }, c, state)).toThrow();
  expect(() => mirrorObservation({ charId: 'a', key: 'B\nF8', verdict: 'failed' }, c, state)).toThrow();
});
it('records the global-input candidate as a separate manual observation method', () => {
  const hybrid = normalizeGameMacros({ partyId: 'p', mirrorKeyboardMethod: 'cache-hybrid' });
  const row = mirrorObservation({ charId: 'a', key: 'B', verdict: 'failed' }, hybrid, state);
  expect(row.method).toBe('mirror-cache-hybrid');
  expect(normalizeTrials([row])[0]).toMatchObject({ method: 'mirror-cache-hybrid', verdict: 'failed' });
});

it('manual observation requires confirmation, saves once and does not switch input modes', async () => {
  const save = vi.fn(async patch => {
    c = normalizeGameMacros({ ...c, ...patch });
  });
  openMirrorObservation({ getConfig: () => c, state, save });
  document.querySelector('[name="charId"]').value = 'a';
  document.querySelector('[name="key"]').value = 'B';
  document.querySelector('[name="verdict"]').value = 'worked';
  document.querySelector('[data-condition="purpose"]').value = 'chat';
  document.querySelector('[data-condition="chat"]').value = 'open';
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-mirror-observation-status]').textContent).toContain('Подтвердите')
  );
  expect(save).not.toHaveBeenCalled();
  document.querySelector('[name="observed"]').checked = true;
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(c.backgroundTrials[0]).toMatchObject({
    method: 'mirror-post',
    conditions: { purpose: 'chat', chat: 'open' },
    verdict: 'worked'
  });
  expect(c.commands).toHaveLength(0);
});
