import { describe, it, expect } from 'vitest';
import { AHK_PRESETS, installAhkPresets } from '../js/modules/gameMacros/presets.js';
import { normalizeGameMacros, chord, steps } from '../js/modules/gameMacros/model.js';
import { mergeSettings } from '../js/core/state/settings.js';
describe('StanislavFist AHK command migration', () => {
  it('installs every command once, does not read tokens and never enables hotkeys', () => {
    const c = mergeSettings({ gameMacros: { enabled: true } }).gameMacros;
    expect(c.commands).toHaveLength(13);
    expect(c.enabled).toBe(false);
    expect(c.commands.find(c => c.id === 'ahk-assist')).toMatchObject({
      hotkey: 'CTRL+X',
      target: 'others',
      sequence: 'SHIFT+1\nwait 60\nF7'
    });
    expect(c.commands.find(c => c.id === 'ahk-buff')).toMatchObject({
      hotkey: 'CTRL+F2',
      scope: 'buff',
      sequence: 'F8'
    });
    expect(c.commands.find(c => c.id === 'ahk-resurrect')).toMatchObject({
      scope: 'managed',
      resourceAllowed: false,
      pointId: ''
    });
    expect(c.commands.find(c => c.id === 'ahk-follow')).toMatchObject({
      pointId: '',
      menuPointId: '',
      resourceAllowed: false
    });
    expect(c.leaderWidth).toBe(3440);
    expect(c.otherHeight).toBe(1200);
    expect(c.points).toEqual([]);
    expect(mergeSettings({ gameMacros: c }).gameMacros.commands).toEqual(c.commands);
  });
  it('preserves existing customization and deletion after the one-time migration', () => {
    const existing = { id: 'ahk-assist', name: 'custom', action: 'sequence', target: 'all', sequence: 'F3' };
    const migrated = normalizeGameMacros(installAhkPresets({ commands: [existing] }));
    expect(migrated.commands[0].name).toBe('custom');
    const deleted = { ...migrated, commands: migrated.commands.filter(c => c.id !== 'ahk-assist') };
    expect(installAhkPresets(deleted).commands.some(c => c.id === 'ahk-assist')).toBe(false);
    expect(new Set(migrated.commands.map(c => c.id)).size).toBe(migrated.commands.length);
  });
  it('keeps wheel combinations as triggers only, not injectable key steps', () => {
    expect(chord('CTRL+WHEELDOWN')).toBe('CTRL+WHEELDOWN');
    expect(chord('CTRL+WHEELUP')).toBe('CTRL+WHEELUP');
    expect(() => steps('CTRL+WHEELDOWN')).toThrow();
    expect(AHK_PRESETS.find(c => c.id === 'ahk-f6f1').action).toBe('f6f1');
  });
});
