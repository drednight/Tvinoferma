import { describe, it, expect } from 'vitest';
import { chord, steps, normalizeGameMacros, resolveTargets } from '../js/modules/gameMacros/model.js';
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
    for (const key of ['CTRL+CTRL+A', 'WIN+A', 'F13', 'A+B', 'ALT+', 'shell:abc']) expect(chord(key)).toBe('');
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
    expect(c.opacity).toBe(0.3);
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
