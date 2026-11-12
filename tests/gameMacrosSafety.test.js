import { beforeEach, expect, it } from 'vitest';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
import {
  exportCommands,
  importCommandPlan,
  deleteCommandPlan,
  restoreDeletedCommand
} from '../js/modules/gameMacros/transfer.js';
import { recordLabVerdict, labVerdict } from '../js/modules/gameMacros/labResults.js';
import { readDraft, writeDraft, clearDraft } from '../js/modules/gameMacros/drafts.js';
import {
  startExecutionTrace,
  executionStage,
  finishExecutionTrace,
  executionHistory,
  clearExecutionHistory,
  explainBackgroundResult
} from '../js/modules/gameMacros/trace.js';
import { reviewCommand } from '../js/modules/gameMacros/review.js';
import { showModal, closeModal } from '../js/core/ui.js';
const config = () =>
  normalizeGameMacros({
    commands: [
      { id: 'a', name: 'Test', action: 'sequence', sequence: 'B', delivery: 'background', hotkey: 'CTRL+ALT+F8' }
    ]
  });
beforeEach(() => {
  localStorage.clear();
  clearExecutionHistory();
  document.body.innerHTML = '<div id="modal-root"></div>';
});
it('imports as a safe copy with explicit configuration gate and cleared launch chord', () => {
  const c = config(),
    result = importCommandPlan(exportCommands(c), c, 'copy', () => 'new');
  expect(result.patch.commands).toHaveLength(2);
  expect(result.patch.commands[1]).toMatchObject({
    id: 'new',
    hotkey: '',
    needsConfiguration: true,
    strictTargets: true,
    resourceAllowed: false
  });
  expect(result.patch.commands[1].name).not.toBe('Test');
  expect(c.commands).toHaveLength(1);
});
it('replacement is explicit and rejects ambiguous names and malformed input', () => {
  const c = config();
  expect(importCommandPlan(exportCommands(c), c, 'replace').patch.commands).toHaveLength(1);
  expect(() =>
    importCommandPlan(exportCommands(c), { ...c, commands: [...c.commands, { ...c.commands[0], id: 'b' }] }, 'replace')
  ).toThrow(/неоднозначно/);
  expect(() => importCommandPlan('{', c)).toThrow();
  expect(() =>
    importCommandPlan(JSON.stringify({ kind: 'tvinoferma-macros', schema: 1, commands: [null] }), c)
  ).toThrow();
  expect(() => importCommandPlan('x'.repeat(512001), c)).toThrow(/500/);
});
it('excludes private settings, drafts, manual results and undo history from export', () => {
  const text = exportCommands({
    ...config(),
    password: 'secret',
    labResults: [{ notes: 'private' }],
    deletedCommands: [{ secret: true }]
  });
  expect(text).not.toMatch(/secret|private|labResults|deletedCommands/);
});
it('undo restores a removed command and clears colliding hotkeys', () => {
  const c = config(),
    deleted = { ...c, ...deleteCommandPlan(c, 'a') };
  expect(deleted.commands).toHaveLength(0);
  expect(restoreDeletedCommand(deleted).commands[0].id).toBe('a');
  const restored = restoreDeletedCommand({ ...deleted, commands: [{ ...c.commands[0], id: 'b' }] });
  expect(restored.commands[1].hotkey).toBe('');
});
it('manual game result is invalidated by physical changes, not rename', () => {
  const c = config(),
    command = c.commands[0];
  c.labResults = recordLabVerdict(c, command, 'failed', 'No action');
  expect(labVerdict(c, { ...command, name: 'Renamed' }).verdict).toBe('failed');
  expect(labVerdict(c, { ...command, sequence: 'F2' })).toBeNull();
  expect(() => recordLabVerdict(c, command, 'automatic', '')).toThrow();
});
it('draft recovery rejects malformed records and supports explicit removal', () => {
  expect(writeDraft('a', [['name', 'Test']], [], 'base')).toBe(true);
  expect(readDraft('a').fields).toEqual([['name', 'Test']]);
  clearDraft('a');
  expect(readDraft('a')).toBeNull();
  for (const fields of [{}, [null], [['name']], [['name', {}]]]) {
    localStorage.setItem('tvinoferma.macro-draft.v1.a', JSON.stringify({ schema: 1, fields, blocks: [] }));
    expect(readDraft('a')).toBeNull();
  }
});
it('bounds trace history and events, exports copies and records no arbitrary payload', () => {
  const c = config();
  startExecutionTrace(c.commands[0]);
  for (let n = 0; n < 400; n++)
    executionStage('stage', 'ok', { count: n, password: 'secret', payload: { token: 'secret' } });
  finishExecutionTrace('finished');
  const history = executionHistory();
  expect(history[0].events).toHaveLength(250);
  expect(history[0].omitted).toBe(150);
  expect(history[0].events[0].details).toEqual({ count: 0 });
  expect(history[0].events.at(-1).details.count).toBe(399);
  expect(JSON.stringify(history)).not.toContain('secret');
  history[0].state = 'changed';
  expect(executionHistory()[0].state).toBe('finished');
  for (let n = 0; n < 30; n++) {
    startExecutionTrace(c.commands[0]);
    finishExecutionTrace('stopped');
  }
  expect(executionHistory()).toHaveLength(20);
});
it('never treats API acceptance as game acceptance and reports distinct blocking stages', () => {
  expect(explainBackgroundResult({ ok: true })).toContain('GAME_UNKNOWN');
  expect(explainBackgroundResult({ error: 1460 })).toContain('TIMEOUT');
  expect(explainBackgroundResult({ error: 5 })).toContain('ACCESS_DENIED');
  expect(explainBackgroundResult({ ok: true, foregroundChanged: true })).toContain('FOREGROUND_CHANGED');
});
it('hybrid party review does not warn about all-window fallback', () => {
  const c = config();
  const hybrid = { ...c.commands[0], backgroundMethod: 'hybrid-party', hybridConsent: true };
  const review = reviewCommand(hybrid, c, { parties: [], characters: [] });
  expect(review.issues.some(issue => issue.field === 'targets')).toBe(false);
});
it('configuration review catches duplicate chord and stays pure', () => {
  const c = config();
  c.commands.push({ ...c.commands[0], id: 'b' });
  const before = JSON.stringify(c);
  const review = reviewCommand(c.commands[0], c, { parties: [], characters: [] });
  expect(review.issues.some(issue => issue.field === 'hotkey')).toBe(true);
  expect(review.lines.join(' ')).toContain('Клавиша B');
  expect(JSON.stringify(c)).toBe(before);
});
it('opt-in close guard blocks cancellation and replacement until released', () => {
  let allowed = false;
  showModal({ title: 'Draft', content: 'Original', beforeClose: () => allowed, submitText: null });
  closeModal();
  expect(document.body.textContent).toContain('Original');
  showModal({ title: 'Replacement', content: 'New' });
  expect(document.body.textContent).toContain('Original');
  expect(document.body.textContent).not.toContain('New');
  allowed = true;
  closeModal();
  expect(document.body.textContent).not.toContain('Original');
});
it('invalidates manual evidence after leader, point or party context changes', () => {
  const c = config(),
    command = c.commands[0];
  c.labResults = recordLabVerdict(c, command, 'worked', 'Observed');
  expect(labVerdict({ ...c, partyId: 'different' }, command)).toBeNull();
  expect(labVerdict({ ...c, leaders: { p: 'another' } }, command)).toBeNull();
  expect(labVerdict({ ...c, points: [{ id: 'point', x: 1 }] }, command)).toBeNull();
});
