import { expect, it } from 'vitest';
import { duplicateReasons, mergeDuplicateData } from '../js/settings/duplicateCharacters.js';
it('finds candidates by non-password contacts and never treats shared passwords as duplicates', () => {
  expect(
    duplicateReasons(
      { nick: 'A', contacts: { email: ' X@Y ', password: 'secret' } },
      { nick: 'B', contacts: { email: 'x@y', password: 'secret' } }
    )
  ).toEqual(['почта / логин']);
  expect(duplicateReasons({ contacts: { password: 'Secret' } }, { contacts: { password: 'secret' } })).toEqual([]);
  expect(
    duplicateReasons({ nick: 'A', contacts: { password: 'same' } }, { nick: 'B', contacts: { password: 'same' } })
  ).toEqual([]);
  expect(duplicateReasons({}, {})).toEqual([]);
});
it('matches only nonempty email or login, regardless of nickname, case or surrounding spaces', () => {
  expect(
    duplicateReasons({ nick: 'Same', contacts: { email: 'a' } }, { nick: 'same', contacts: { email: 'b' } })
  ).toEqual([]);
  expect(
    duplicateReasons({ nick: 'Same', contacts: { email: '  ' } }, { nick: 'same', contacts: { email: '' } })
  ).toEqual([]);
  expect(
    duplicateReasons({ nick: 'one', contacts: { email: '  LOGIN  ' } }, { nick: 'two', contacts: { email: 'login' } })
  ).toEqual(['почта / логин']);
  expect(
    duplicateReasons({ nick: 'same', contacts: { email: 'x' } }, { nick: 'same', contacts: { email: 'x' } })
  ).toEqual(['почта / логин']);
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
it('does not read passwords when searching candidates, even if present as a getter', () => {
  const contacts = {
    get password() {
      throw new Error('Password must not participate in candidate matching');
    }
  };
  expect(duplicateReasons({ nick: 'A', contacts }, { nick: 'B', contacts })).toEqual([]);
  expect(duplicateReasons({ nick: 'Same', contacts }, { nick: 'same', contacts })).toEqual([]);
});

it('ignores shared recovery emails and never reads them when matching candidates', () => {
  expect(
    duplicateReasons(
      { nick: 'A', contacts: { recoveryEmail: 'same@example.com' } },
      { nick: 'B', contacts: { recoveryEmail: 'same@example.com' } }
    )
  ).toEqual([]);
  const contacts = {
    email: 'main@example.com',
    get recoveryEmail() {
      throw new Error('Recovery email must not participate in candidate matching');
    }
  };
  expect(duplicateReasons({ nick: 'A', contacts }, { nick: 'B', contacts })).toEqual(['почта / логин']);
});
it('ignores shared phones and never reads them when matching candidates', () => {
  expect(duplicateReasons({ contacts: { phone: '123' } }, { contacts: { phone: '123' } })).toEqual([]);
  const contacts = {
    email: 'main@example.com',
    get phone() {
      throw new Error('Phone must not participate in candidate matching');
    }
  };
  expect(duplicateReasons({ contacts }, { contacts })).toEqual(['почта / логин']);
});
it('deep-merges complementary fields and resolves differing values only with an explicit choice', () => {
  const a = { id: 'a', class: 'Воин', stats: { hp: 10 }, contacts: { email: 'main' } };
  const b = { id: 'b', class: 'Маг', stats: { mp: 20 }, contacts: { phone: '123' } };
  expect(() => mergeDuplicateData(a, b)).toThrow('class');
  expect(mergeDuplicateData(a, b, { class: 'primary' })).toMatchObject({
    id: 'a',
    class: 'Воин',
    stats: { hp: 10, mp: 20 },
    contacts: { email: 'main', phone: '123' }
  });
  expect(mergeDuplicateData(a, b, { class: 'duplicate' }).class).toBe('Маг');
  expect(a.stats).toEqual({ hp: 10 });
});
