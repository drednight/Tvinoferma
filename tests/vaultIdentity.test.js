import { describe, expect, it } from 'vitest';
import { hasSafeVaultCharacterMapping } from '../js/core/vaultIdentity.js';

const char = id => ({ id });
const check = (active, archived, remap, normalizedActive, normalizedArchived = archived) =>
  hasSafeVaultCharacterMapping(
    { secretsInVault: true, characters: active.map(char), archivedCharacters: archived.map(char) },
    { idRemap: remap },
    { characters: normalizedActive.map(char), archivedCharacters: normalizedArchived.map(char) }
  );

describe('соответствие персонажей и ключей vault на старте', () => {
  it('допускает однозначную замену ID и архив с неизменёнными ключами', () => {
    expect(check(['old', 'other'], ['archive'], { old: 'hero' }, ['hero', 'other'])).toBe(true);
  });

  it('отклоняет совпадающие исходные ID, даже если нормализация их исправила', () => {
    expect(check(['x', 'X'], [], {}, ['x', 'other'])).toBe(false);
    expect(check(['x'], ['x'], {}, ['x'], ['archive'])).toBe(false);
  });

  it('отклоняет цепочки и перестановки старых и новых ID', () => {
    expect(check(['a', 'b'], [], { a: 'b', b: 'c' }, ['b', 'c'])).toBe(false);
    expect(check(['a', 'b'], [], { a: 'b', b: 'a' }, ['b', 'a'])).toBe(false);
    expect(check(['a'], ['b'], { a: 'b' }, ['b'], ['b-2'])).toBe(false);
    expect(check(['Hero'], [], { Hero: 'hero' }, ['hero'])).toBe(false);
  });

  it('отклоняет неявные изменения при нормализации и чужие записи карты', () => {
    expect(check(['a'], [], {}, ['new'])).toBe(false);
    expect(check(['a'], [], { stranger: 'new' }, ['a'])).toBe(false);
    expect(check(['a', 'b'], [], { a: 'c', b: 'c' }, ['c', 'c'])).toBe(false);
  });

  it('не считает повреждённые или отсутствующие списки и ID безопасными', () => {
    expect(check([''], [], {}, ['new'])).toBe(false);
    expect(
      hasSafeVaultCharacterMapping(
        { secretsInVault: true },
        { idRemap: {} },
        { characters: [], archivedCharacters: [] }
      )
    ).toBe(false);
    expect(
      hasSafeVaultCharacterMapping(
        { characters: [{}] },
        { idRemap: {} },
        { characters: [char('new')], archivedCharacters: [] }
      )
    ).toBe(false);
    expect(
      hasSafeVaultCharacterMapping({ characters: 'bad' }, { idRemap: {} }, { characters: [], archivedCharacters: [] })
    ).toBe(false);
    for (const contacts of ['bad', { email: 123 }, { future: 'value' }]) {
      expect(
        hasSafeVaultCharacterMapping(
          { characters: [{ id: 'hero', contacts }] },
          { idRemap: {} },
          { characters: [char('hero')], archivedCharacters: [] }
        )
      ).toBe(false);
    }
  });
});
