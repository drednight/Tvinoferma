import { it, expect } from 'vitest';
import {
  BACKGROUND_METHODS,
  backgroundVariants,
  backgroundMethod,
  validateActivityCommand
} from '../js/modules/gameMacros/background.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
import { compileComposition } from '../js/modules/gameMacros/composition.js';
it('creates three separate opt-in commands without triggers, changing neither source nor existing commands', () => {
  const original = {
    id: 'old',
    name: 'Проба',
    action: 'sequence',
    sequence: 'CTRL+F9',
    hotkey: 'F8',
    target: 'others',
    partyId: 'p',
    switchMs: 30,
    holdMs: 40
  };
  let id = 0;
  const rows = backgroundVariants(original, [original], () => `test-${++id}`);
  expect(rows.map(c => c.backgroundMethod)).toEqual(['post', 'send-timeout', 'notify']);
  expect(new Set(rows.map(c => c.id)).size).toBe(3);
  for (const row of rows)
    expect(row).toMatchObject({
      hotkey: '',
      delivery: 'background',
      sequence: 'CTRL+F9',
      partyId: 'p',
      target: 'others',
      holdMs: 40
    });
  expect(original).toMatchObject({ id: 'old', hotkey: 'F8' });
  expect(original.delivery).toBeUndefined();
});
it('rejects unsupported actions/capacity and preserves a valid selected method', () => {
  expect(() => backgroundVariants({ action: 'click' }, [])).toThrow();
  expect(() => backgroundVariants({ action: 'sequence' }, Array(62).fill({}))).toThrow();
  expect(backgroundMethod('SendInput')).toBe('post');
  for (const method of Object.keys(BACKGROUND_METHODS)) {
    const c = normalizeGameMacros({ commands: [{ id: 'test', action: 'sequence', backgroundMethod: method }] })
      .commands[0];
    expect(c.backgroundMethod).toBe(method);
  }
});
it('carries each block method to its compiled keyboard actions', () => {
  for (const backgroundMethod of Object.keys(BACKGROUND_METHODS)) {
    const cmd = {
      id: 'root',
      action: 'composite',
      blocks: [{ delivery: 'background', backgroundMethod, steps: [{ type: 'keys', value: 'F8' }] }]
    };
    const plan = compileComposition(cmd, { commands: [cmd] });
    expect(JSON.stringify(plan)).toContain(`"backgroundMethod":"${backgroundMethod}"`);
  }
});

it('allows bounded modifier sequences but not composition or mouse activity delivery', () => {
  const valid = { action: 'sequence', sequence: 'F8', delivery: 'background', backgroundMethod: 'activity' };
  expect(() => validateActivityCommand(valid)).not.toThrow();
  for (const sequence of ['CTRL+B', 'SHIFT+1\nF2', 'wait 100\nB', 'SHIFT+F8'])
    expect(() => validateActivityCommand({ ...valid, sequence })).not.toThrow();
  expect(() => validateActivityCommand({ ...valid, sequence: 'SHIFT+SHIFT+1' })).toThrow();
  for (const action of ['f6f1', 'mirror', 'mouse-mirror', 'composite', 'click'])
    expect(() => validateActivityCommand({ ...valid, action })).toThrow();
  expect(() => validateActivityCommand(valid, true)).toThrow();
});
it('accepts wait 100 between complete activity chords', () => {
  expect(() =>
    validateActivityCommand({
      action: 'sequence',
      delivery: 'background',
      backgroundMethod: 'activity',
      sequence: 'SHIFT+1\nwait 100\nF2'
    })
  ).not.toThrow();
});

it('activity keyboard sequences accept the same extended vocabulary without enabling mouse or continuous repeat', () => {
  const sequence = [
    'F24',
    'CTRL+NUMPAD9',
    'DELETE',
    'SHIFT+PAGEUP',
    'ESC',
    'BACKSPACE',
    'END',
    'INSERT',
    'DIVIDE',
    'SEMICOLON'
  ].join('\n');
  expect(() =>
    validateActivityCommand({ action: 'sequence', delivery: 'background', backgroundMethod: 'activity', sequence })
  ).not.toThrow();
  for (const action of ['follow', 'click', 'mirror', 'mouse-mirror'])
    expect(() =>
      validateActivityCommand({ action, delivery: 'background', backgroundMethod: 'activity', sequence })
    ).toThrow();
});

it('prepares five independent single-recipient experiments with no hotkeys, no focus restoration and no fallback', async () => {
  const { backgroundExperiments, EXPERIMENT_METHODS } = await import('../js/modules/gameMacros/background.js');
  let id = 0;
  const rows = backgroundExperiments({ key: 'SHIFT+1', charId: 'b', partyId: 'p' }, [], () => `lab-${++id}`);
  expect(rows.map(r => r.backgroundMethod)).toEqual(EXPERIMENT_METHODS);
  expect(new Set(rows.map(r => r.id)).size).toBe(5);
  for (const row of rows) {
    expect(row).toMatchObject({
      strictTargets: true,
      target: 'subset',
      charIds: ['b'],
      partyId: 'p',
      sequence: 'SHIFT+1',
      hotkey: '',
      returnTo: 'last'
    });
    expect(normalizeGameMacros({ commands: [row] }).commands[0].strictTargets).toBe(true);
  }
  expect(() => backgroundExperiments({ key: 'B\nF2', charId: 'b', partyId: 'p' }, [])).toThrow();
  expect(() => backgroundExperiments({ key: 'B', charId: '', partyId: 'p' }, [])).toThrow();
  expect(() => backgroundExperiments({ key: 'B', charId: 'b', partyId: 'p' }, Array(60).fill({}))).toThrow();
});
it('keeps every activity variant isolated from composition, mouse and repeat', async () => {
  const { isActivityMethod } = await import('../js/modules/gameMacros/background.js');
  for (const backgroundMethod of ['activity', 'activity-window', 'activity-notify']) {
    expect(isActivityMethod(backgroundMethod)).toBe(true);
    expect(() =>
      validateActivityCommand({ action: 'sequence', sequence: 'B', delivery: 'background', backgroundMethod })
    ).not.toThrow();
    expect(() =>
      validateActivityCommand({ action: 'click', sequence: 'B', delivery: 'background', backgroundMethod })
    ).toThrow();
    expect(() =>
      validateActivityCommand({ action: 'sequence', sequence: 'B', delivery: 'background', backgroundMethod }, true)
    ).toThrow();
  }
});
