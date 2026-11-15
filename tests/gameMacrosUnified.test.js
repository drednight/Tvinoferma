import { it, expect } from 'vitest';
import { commandBlocks, unifiedCommand, materializeUnifiedCommand } from '../js/modules/gameMacros/unified.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
import { AHK_PRESETS } from '../js/modules/gameMacros/presets.js';
import { compileComposition, compositionActions, executeComposition } from '../js/modules/gameMacros/composition.js';
const config = normalizeGameMacros({
  partyId: 'p',
  leaderWidth: 1600,
  leaderHeight: 900,
  otherWidth: 800,
  otherHeight: 600
});
it('represents every finite preset as editable primitives without changing saved source data', () => {
  for (const raw of AHK_PRESETS.filter(c => c.action !== 'pause')) {
    const source = normalizeGameMacros({ commands: [raw] }).commands[0];
    const before = structuredClone(source);
    const unified = unifiedCommand(source, config);
    expect(unified.action).toBe('composite');
    expect(unified.blocks.length).toBeGreaterThan(0);
    expect(unified.blocks.flatMap(b => b.steps).some(s => s.type === 'command')).toBe(false);
    expect(source).toEqual(before);
    expect(unified.id).toBe(source.id);
    expect(unified.hotkey).toBe(source.hotkey);
  }
});
it('keeps two F6/F1 passes and window-by-window follow instead of exclusive macro steps', () => {
  const passes = commandBlocks({ action: 'f6f1', target: 'all' }, config);
  expect(passes.map(b => [b.target, b.steps[0].value])).toEqual([
    ['others', 'F6'],
    ['all', 'F1']
  ]);
  const follow = commandBlocks(
    {
      action: 'follow',
      target: 'others',
      pointId: 'portrait',
      menuPointId: 'menu',
      followSequence: 'F2',
      followButton: 'left',
      followMenuButton: 'right'
    },
    config
  )[0];
  expect(follow.perWindow).toBe(true);
  expect(follow.steps.filter(s => s.type === 'point').map(s => [s.pointId, s.button])).toEqual([
    ['portrait', 'left'],
    ['menu', 'right']
  ]);
  expect(follow.steps[0]).toEqual({ type: 'keys', value: 'F2' });
});
it('keeps calibrated click variants and modifier/count choices in editable click steps', () => {
  const block = commandBlocks(
    { action: 'click', pointId: 'main', pointIds: ['small'], button: 'right', count: 2, modifiers: ['CTRL'] },
    config
  )[0];
  const root = { id: 'root', action: 'composite', resourceAllowed: true, blocks: [block] };
  const tree = compileComposition(root, { ...config, commands: [root], points: [{ id: 'main' }, { id: 'small' }] });
  expect(compositionActions(tree)[0]).toMatchObject({
    action: 'click',
    pointId: 'main',
    pointIds: ['small'],
    button: 'right',
    count: 2,
    modifiers: ['CTRL']
  });
});
it('keeps activity isolated as a single bounded keyboard sequence using the same editor', () => {
  const raw = {
    id: 'keys',
    name: 'Тест',
    action: 'sequence',
    sequence: 'SHIFT+1\nwait 200\nF2',
    delivery: 'background',
    backgroundMethod: 'activity',
    target: 'others'
  };
  const entry = unifiedCommand(raw, config);
  entry.blocks[0].repeat = 1;
  expect(materializeUnifiedCommand(entry)).toMatchObject({
    id: 'keys',
    name: 'Тест',
    action: 'sequence',
    sequence: raw.sequence,
    backgroundMethod: 'activity',
    target: 'others',
    delivery: 'background',
    blocks: []
  });
  for (const patch of [
    { repeat: 2 },
    { steps: [{ type: 'screen', x: 1, y: 2, button: 'left', count: 1 }] },
    { steps: [{ type: 'repeat', device: 'keyboard', mode: 'on' }] }
  ]) {
    const changed = structuredClone(entry);
    Object.assign(changed.blocks[0], patch);
    expect(() => materializeUnifiedCommand(changed)).toThrow(/активности/);
  }
});
it('preserves standalone keyboard delivery/fallback compatibility when a legacy key plan is saved unchanged', () => {
  const raw = {
    id: 'keys',
    name: 'Клавиши',
    action: 'sequence',
    sequence: 'F7\nF2',
    target: 'all',
    delivery: 'foreground'
  };
  const entry = unifiedCommand(raw, config);
  entry.blocks[0].repeat = 1;
  expect(materializeUnifiedCommand(entry)).toMatchObject({ action: 'sequence', sequence: raw.sequence });
});
it('executes per-window primitives in recipient order and stops before subsequent recipients on failure', async () => {
  const command = {
    id: 'root',
    action: 'composite',
    blocks: [
      {
        partyId: 'p',
        target: 'all',
        perWindow: true,
        steps: [
          { type: 'keys', value: 'F1' },
          { type: 'keys', value: 'F2' }
        ]
      }
    ]
  };
  const tree = compileComposition(command, { ...config, commands: [command] });
  const seen = [];
  await executeComposition(tree, {
    targets: async () => ['a', 'b'],
    action: async (cmd, row) => seen.push(`${row}:${cmd.sequence}`),
    checkpoint: async () => {},
    wait: async () => {},
    pause: async () => {}
  });
  expect(seen).toEqual(['a:F1', 'a:F2', 'b:F1', 'b:F2']);
  seen.length = 0;
  await expect(
    executeComposition(tree, {
      targets: async () => ['a', 'b'],
      action: async (cmd, row) => {
        seen.push(`${row}:${cmd.sequence}`);
        if (cmd.sequence === 'F2') throw Error('failed');
      },
      checkpoint: async () => {},
      wait: async () => {},
      pause: async () => {}
    })
  ).rejects.toThrow('failed');
  expect(seen).toEqual(['a:F1', 'a:F2']);
});
it('refuses cross-party or mode-changing steps inside a per-window block before execution', () => {
  for (const step of [
    { type: 'launch', partyId: 'p' },
    { type: 'repeat', device: 'keyboard', mode: 'on' },
    { type: 'focus', direction: 'leader' }
  ]) {
    expect(() =>
      compileComposition({ id: 'root', action: 'composite', blocks: [{ perWindow: true, steps: [step] }] }, config)
    ).toThrow(/Обход по окнам/);
  }
});
