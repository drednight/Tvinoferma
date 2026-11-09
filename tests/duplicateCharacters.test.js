import { expect, it } from 'vitest';
import { duplicateReasons, mergeDuplicateData } from '../js/settings/duplicateCharacters.js';
it('finds candidates but returns reasons only, with exact nonempty password comparison', () => {
  expect(
    duplicateReasons(
      { nick: 'A', contacts: { email: ' X@Y ', password: 'secret' } },
      { nick: 'B', contacts: { email: 'x@y', password: 'secret' } }
    )
  ).toEqual(['почта / логин', 'пароль']);
  expect(duplicateReasons({ contacts: { password: 'Secret' } }, { contacts: { password: 'secret' } })).toEqual([]);
  expect(duplicateReasons({}, {})).toEqual([]);
});
it('fills missing compatible data, unions tags/memberships and preserves primary identity', () => {
  const a = { id: 'a', nick: 'A', tags: ['x'], partyIds: ['p'], contacts: { email: 'x' } };
  const b = { id: 'b', nick: 'B', tags: ['y'], partyIds: ['q'], contacts: { email: 'x', phone: '1' } };
  const out = mergeDuplicateData(a, b);
  expect(out).toMatchObject({
    id: 'a',
    nick: 'A',
    tags: ['x', 'y'],
    partyIds: ['p', 'q'],
    contacts: { email: 'x', phone: '1' }
  });
  expect(a.contacts.phone).toBeUndefined();
});
it('rejects conflicting values and launcher bindings without mutating inputs', () => {
  for (const b of [
    { coins: 2 },
    { contacts: { password: 'b' } },
    { launch: { gcIds: ['gc'] } },
    { mainPartyId: 'q' }
  ]) {
    const a = { id: 'a', nick: 'A', coins: 1, contacts: { password: 'a' }, mainPartyId: 'p' };
    const before = JSON.stringify(a);
    expect(() => mergeDuplicateData(a, b)).toThrow();
    expect(JSON.stringify(a)).toBe(before);
  }
});
