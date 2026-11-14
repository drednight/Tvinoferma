import { describe, it, expect } from 'vitest';
import {
  chord,
  steps,
  normalizeGameMacros,
  resolveTargets,
  commandPoint,
  validPoint
} from '../js/modules/gameMacros/model.js';
const state = {
  characters: [
    { id: 'a', nick: 'Alpha', partyIds: ['p'] },
    { id: 'b', nick: 'Beta', partyIds: ['p'] },
    { id: 'c', nick: 'Other', partyIds: ['q'] }
  ]
};
const config = { partyId: 'p', leaders: { p: 'a' } };
const rows = ['a', 'b', 'c'].map((charId, i) => ({
  charId,
  known: true,
  pid: i + 10,
  startedAt: 100,
  hwnd: i + 100,
  elevated: false
}));
describe('bounded game command model', () => {
  it('canonicalizes modifiers and rejects unsupported/duplicate keys', () => {
    expect(chord(' shift + ctrl + f8 ')).toBe('CTRL+SHIFT+F8');
    for (const key of ['CTRL+CTRL+A', 'WIN+A', 'F25', 'A+B', 'ALT+', 'shell:abc']) expect(chord(key)).toBe('');
  });
  it('parses only bounded key and wait steps', () => {
    expect(steps('SHIFT+1\nwait 100\nF7')).toEqual([{ key: 'SHIFT+1' }, { wait: 100 }, { key: 'F7' }]);
    for (const value of ['', 'wait 49', 'wait 3001', 'sleep 100', Array(21).fill('F1').join('\n')])
      expect(() => steps(value)).toThrow();
  });
  it('starts disabled without a party, commands, leader or implicit global target', () => {
    expect(normalizeGameMacros(null)).toMatchObject({ enabled: false, partyId: '', commands: [], profiles: [] });
    const c = normalizeGameMacros({
      opacity: 0.1,
      commands: [{ id: 'x', action: 'sequence', sequence: 'F8', target: 'invalid', hotkey: 'WIN+X' }]
    });
    expect(c.opacity).toBe(0.1);
    expect(c.commands[0]).toMatchObject({ target: 'others', hotkey: '' });
  });
  it('discards executable text, unknown actions and malformed profiles', () => {
    const c = normalizeGameMacros({
      commands: [
        { id: 'x', action: 'sequence', sequence: 'exec evil' },
        { id: 'y', action: 'shell' }
      ],
      profiles: [null, { id: 'p', windows: [{ charId: 'a', x: 0, y: 0, width: 10, height: 10 }] }]
    });
    expect(c.commands).toEqual([]);
    expect(c.profiles[0].windows).toEqual([]);
  });
  it('resolves all, leader and others strictly within the selected party', () => {
    const ids = command => resolveTargets(state, config, command, rows).map(r => r.charId);
    expect(ids({ action: 'sequence', target: 'all' })).toEqual(['a', 'b']);
    expect(ids({ action: 'leader', target: 'all' })).toEqual(['a']);
    expect(ids({ action: 'sequence', target: 'leader' })).toEqual(['a']);
    expect(ids({ action: 'sequence', target: 'others' })).toEqual(['b']);
  });
  it('never treats an empty party or missing leader as all windows', () => {
    for (const c of [
      { partyId: '', leaders: {} },
      { partyId: 'p', leaders: {} },
      { partyId: 'p', leaders: { p: 'c' } }
    ])
      expect(() => resolveTargets(state, c, { target: 'others' }, rows)).toThrow();
  });
  it.each(['elevated', 'unknown access', 'unknown window', 'missing start', 'missing handle', 'ambiguous', 'missing'])(
    'fails closed for %s',
    kind => {
      let altered = rows.map(r => ({ ...r }));
      if (kind === 'elevated') altered[1].elevated = true;
      if (kind === 'unknown access') altered[1].elevated = null;
      if (kind === 'unknown window') altered[1].known = false;
      if (kind === 'missing start') altered[1].startedAt = null;
      if (kind === 'missing handle') altered[1].hwnd = null;
      if (kind === 'ambiguous') altered.push({ ...altered[1], pid: 999 });
      if (kind === 'missing') altered = altered.filter(r => r.charId !== 'b');
      expect(() => resolveTargets(state, config, { target: 'all' }, altered)).toThrow();
    }
  );
});

describe('explicit subsets and calibrated points', () => {
  it('never promotes an empty or stale subset to all recipients', () => {
    for (const charIds of [[], ['c'], ['a', 'deleted']])
      expect(() => resolveTargets(state, config, { target: 'subset', charIds }, rows)).toThrow();
    expect(
      resolveTargets(state, { ...config, leaders: {} }, { target: 'subset', charIds: ['b'] }, rows).map(r => r.charId)
    ).toEqual(['b']);
  });
  it('keeps subset and point authorizations explicit through normalization', () => {
    const c = normalizeGameMacros({
      commands: [{ id: 'click', action: 'click', target: 'subset', charIds: ['a', 'a'], pointId: 'point' }]
    });
    expect(c.commands[0]).toMatchObject({ target: 'subset', charIds: ['a'], pointId: 'point', resourceAllowed: false });
  });
});

describe('calibration validation', () => {
  const point = { id: 'point', name: 'test', uiScale: '100%', x: 10, y: 20, width: 800, height: 600, dpi: 96 };
  it('requires valid client geometry and a UI scale label', () => {
    expect(validPoint(point)).toBe(true);
    for (const patch of [
      { x: -1 },
      { x: 800 },
      { y: 600 },
      { dpi: 0 },
      { width: Infinity },
      { x: 1.5 },
      { uiScale: '' }
    ])
      expect(validPoint({ ...point, ...patch })).toBe(false);
  });
  it('can preview without resource permission but cannot execute', () => {
    const c = { points: [point] },
      command = { pointId: 'point', resourceAllowed: false };
    expect(commandPoint(c, command, false)).toEqual(point);
    expect(() => commandPoint(c, command)).toThrow();
    expect(commandPoint(c, { ...command, resourceAllowed: true })).toEqual(point);
    expect(() => commandPoint(c, { pointId: 'deleted', resourceAllowed: true })).toThrow();
  });
});

it('migrates only legacy default F11 sizes and preserves customized sizes', () => {
  const legacy = normalizeGameMacros({ leaderWidth: 3440, leaderHeight: 1440, otherWidth: 1920, otherHeight: 1200 });
  expect([legacy.leaderWidth, legacy.leaderHeight, legacy.otherWidth, legacy.otherHeight]).toEqual([
    2560, 1400, 2560, 1400
  ]);
  const custom = normalizeGameMacros({ leaderWidth: 1920, leaderHeight: 1080, otherWidth: 1600, otherHeight: 900 });
  expect([custom.leaderWidth, custom.leaderHeight, custom.otherWidth, custom.otherHeight]).toEqual([
    1920, 1080, 1600, 900
  ]);
  expect(
    normalizeGameMacros({ ...legacy, leaderWidth: 3440, leaderHeight: 1440, otherWidth: 1920, otherHeight: 1200 })
      .leaderWidth
  ).toBe(3440);
});

it('distinguishes an unrecognized game window from an elevated one without assuming either is safe', () => {
  expect(() => resolveTargets(state, config, { target: 'leader', action: 'leader' }, [])).toThrow('не распознано');
  expect(() =>
    resolveTargets(state, config, { target: 'leader', action: 'leader' }, [{ ...rows[0], elevated: true }])
  ).toThrow('от администратора');
  expect(() =>
    resolveTargets(state, config, { target: 'leader', action: 'leader' }, [{ ...rows[0], elevated: null }])
  ).toThrow('Не удалось проверить процесс');
  expect(() =>
    resolveTargets(state, config, { target: 'leader', action: 'leader' }, [
      rows[0],
      { ...rows[0], pid: 999, startedAt: null }
    ])
  ).toThrow();
});

it('allows an elevated game only when the live application privilege probe also confirms elevation', () => {
  const command = { target: 'leader', action: 'leader' };
  expect(resolveTargets(state, config, command, [{ ...rows[0], elevated: true, selfElevated: true }])).toHaveLength(1);
  expect(() => resolveTargets(state, config, command, [{ ...rows[0], elevated: true, selfElevated: false }])).toThrow(
    'Твиноферма'
  );
  expect(() => resolveTargets(state, config, command, [{ ...rows[0], elevated: null, selfElevated: true }])).toThrow();
  expect(normalizeGameMacros({ opacity: 0.1 }).opacity).toBe(0.1);
});

it('preserves explicit delivery mode but defaults old commands to foreground', () => {
  const base = { id: 'x', action: 'sequence', sequence: 'F8' };
  expect(normalizeGameMacros({ commands: [base] }).commands[0].delivery).toBe('foreground');
  expect(normalizeGameMacros({ commands: [{ ...base, delivery: 'background' }] }).commands[0].delivery).toBe(
    'background'
  );
});
it('normalizes safe timing and completion defaults without changing old commands', () => {
  const old = normalizeGameMacros({
    commands: [
      { id: 'old', action: 'sequence' },
      { id: 'mix', action: 'composite' }
    ]
  }).commands;
  expect(old[0]).toMatchObject({ returnTo: 'leader', switchMs: 30, holdMs: 30 });
  expect(old[1].returnTo).toBe('last');
  const [tuned] = normalizeGameMacros({
    commands: [{ id: 'x', action: 'sequence', switchMs: -5, holdMs: 900, returnTo: 'last' }]
  }).commands;
  expect(tuned).toMatchObject({ switchMs: 0, holdMs: 200, returnTo: 'last' });
});
it('keeps the saved party route after normalization and reversed OS enumeration', async () => {
  const { orderManagedTargets } = await import('../js/modules/gameMacros/model.js');
  const restored = structuredClone(state);
  restored.characters[0].partyOrder = { p: 2 };
  restored.characters[1].partyOrder = { p: 1 };
  expect(
    resolveTargets(restored, config, { action: 'sequence', target: 'all' }, [...rows].reverse()).map(r => r.charId)
  ).toEqual(['b', 'a']);
  expect(orderManagedTargets(restored, config, [...rows].reverse()).map(r => r.charId)).toEqual(['b', 'a', 'c']);
});
it('preserves the order of other parties too when a command visits all recognized clients', async () => {
  const { orderManagedTargets } = await import('../js/modules/gameMacros/model.js');
  const s = {
    parties: [{ id: 'p' }, { id: 'q' }],
    characters: [
      { id: 'a', nick: 'Alpha', partyIds: ['p'], partyOrder: { p: 1 } },
      { id: 'b', nick: 'Beta', partyIds: ['q'], partyOrder: { q: 2 } },
      { id: 'c', nick: 'Zeta', partyIds: ['q'], partyOrder: { q: 1 } }
    ]
  };
  expect(
    orderManagedTargets(s, { partyId: 'p' }, [{ charId: 'b' }, { charId: 'a' }, { charId: 'c' }]).map(r => r.charId)
  ).toEqual(['a', 'c', 'b']);
});

it('normalizes the opt-in twins-only click modifier without enabling it for old or unsupported settings', () => {
  expect(normalizeGameMacros({}).mirrorTwinsModifier).toBe('');
  for (const value of ['CTRL', 'ALT', 'SHIFT', 'CTRL+ALT', 'CTRL+SHIFT', 'ALT+SHIFT', 'CTRL+ALT+SHIFT'])
    expect(normalizeGameMacros({ mirrorTwinsModifier: value }).mirrorTwinsModifier).toBe(value);
  for (const value of ['WIN', 'B', 'CTRL+B', true, null])
    expect(normalizeGameMacros({ mirrorTwinsModifier: value }).mirrorTwinsModifier).toBe('');
});
it('normalizes active-window mouse modifier without changing existing twins-only setting', () => {
  expect(normalizeGameMacros({ mirrorActiveModifier: 'SHIFT', mirrorTwinsModifier: 'CTRL' })).toMatchObject({
    mirrorActiveModifier: 'SHIFT',
    mirrorTwinsModifier: 'CTRL'
  });
  expect(normalizeGameMacros({ mirrorActiveModifier: 'WIN' }).mirrorActiveModifier).toBe('');
  expect(normalizeGameMacros({}).mirrorActiveModifier).toBe('');
});
