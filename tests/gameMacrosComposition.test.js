import { it, expect, vi } from 'vitest';
import {
  compileComposition,
  normalizeComposition,
  executeComposition,
  compositionActions
} from '../js/modules/gameMacros/composition.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
const block = (steps, extra = {}) => ({
  steps,
  target: 'others',
  scope: 'party',
  partyId: 'p',
  delivery: 'background',
  ...extra
});
const make = (blocks, extra = {}) => ({ id: 'plan', action: 'composite', blocks, ...extra });
const config = (commands = [], extra = {}) => ({ commands, points: [], profiles: [], ...extra });
it('preserves old commands and rejects damaged composition without executing a default', () => {
  const c = normalizeGameMacros({
    commands: [
      { id: 'old', action: 'f6f1' },
      { id: 'broken', action: 'composite', blocks: [{ steps: [] }] }
    ]
  });
  expect(c.commands[0].action).toBe('f6f1');
  expect(c.commands[1].planError).toBeTruthy();
  expect(() => compileComposition(c.commands[1], c)).toThrow();
});
it('compiles every primitive and preserves block recipients and absolute mouse modifiers', () => {
  const cmd = make(
    [
      block([
        { type: 'keys', value: 'SHIFT+1' },
        { type: 'screen', x: -12, y: 40, button: 'right', count: 2, modifiers: ['ALT', 'CTRL'] },
        { type: 'point', pointId: 'pt', button: 'left' },
        { type: 'profile', profileId: 'pr' },
        { type: 'resize', width: 900, height: 700 },
        { type: 'launch', partyId: 'other' },
        { type: 'focus', direction: 'leader' }
      ])
    ],
    { resourceAllowed: true }
  );
  const a = compositionActions(
    compileComposition(cmd, config([], { points: [{ id: 'pt' }], profiles: [{ id: 'pr' }] }))
  );
  expect(a.map(c => c.action)).toEqual(['sequence', 'screen', 'click', 'layout', 'resize', 'launch', 'leader']);
  expect(a[1]).toMatchObject({
    x: -12,
    y: 40,
    count: 2,
    modifiers: ['ALT', 'CTRL'],
    target: 'others',
    delivery: 'background',
    partyId: 'p'
  });
  expect(a[5].partyId).toBe('other');
});
it('requires click consent, existing points/profiles and valid bounded data', () => {
  const b = [block([{ type: 'screen', button: 'left', x: 1, y: 2 }])];
  expect(() => compileComposition(make(b), config())).toThrow(/Разрешите/);
  expect(() => normalizeComposition([block([{ type: 'wait', ms: 10001 }])])).toThrow();
  expect(() => normalizeComposition([block([{ type: 'keys', value: 'WIN+R' }])])).toThrow();
  expect(() => normalizeComposition(Array.from({ length: 9 }, () => block([{ type: 'keys', value: 'F8' }])))).toThrow();
  expect(() => compileComposition(make([block([{ type: 'profile', profileId: 'gone' }])]), config())).toThrow(/удалён/);
});
it('uses live command references and blocks deletion/cycles/unsafe toggle references', () => {
  const plan = make([block([{ type: 'command', commandId: 'saved' }])]);
  const saved = { id: 'saved', action: 'sequence', sequence: 'F9', target: 'leader', partyId: 'x' };
  expect(compositionActions(compileComposition(plan, config([saved])))[0]).toEqual(saved);
  expect(() => compileComposition(plan, config())).toThrow(/удалена/);
  expect(() => compileComposition(plan, config([{ id: 'saved', action: 'mirror' }]))).toThrow();
  expect(() =>
    compileComposition(plan, config([make([block([{ type: 'command', commandId: 'plan' }])], { id: 'saved' }), plan]))
  ).toThrow(/Цикл/);
});
it('starts branches concurrently but never overlaps actions', async () => {
  const plan = make([
    block([
      { type: 'wait', ms: 50 },
      { type: 'keys', value: 'F8' }
    ]),
    block([{ type: 'keys', value: 'F9' }], { parallel: true })
  ]);
  const seen = [];
  let busy = false,
    release;
  const pending = new Promise(r => (release = r));
  const run = executeComposition(compileComposition(plan, config()), {
    checkpoint: async () => {},
    pause: async () => {},
    wait: async () => pending,
    action: async c => {
      expect(busy).toBe(false);
      busy = true;
      seen.push(c.sequence);
      await Promise.resolve();
      busy = false;
    }
  });
  await vi.waitFor(() => expect(seen).toEqual(['F9']));
  release();
  await run;
  expect(seen).toEqual(['F9', 'F8']);
});
it('failure prevents queued actions and settles branches', async () => {
  const plan = make([
    block([
      { type: 'keys', value: 'F8' },
      { type: 'keys', value: 'F7' }
    ]),
    block([{ type: 'keys', value: 'F9' }], { parallel: true })
  ]);
  const action = vi.fn(async () => {
    throw new Error('failed');
  });
  await expect(
    executeComposition(compileComposition(plan, config()), {
      checkpoint: async () => {},
      pause: async () => {},
      wait: async () => {},
      action
    })
  ).rejects.toThrow();
  expect(action).toHaveBeenCalledTimes(1);
});
