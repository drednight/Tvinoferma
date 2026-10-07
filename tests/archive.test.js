import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../js/core/state.js';

const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
vi.mock('../js/modules/characters/list.js', () => ({ renderCharacters: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));

const character = (id, partyIds = [], mainPartyId = null) => ({
  id, nick: id, partyIds, mainPartyId, partyOrder: {}, updatedAt: 'old'
});

beforeEach(() => {
  state.characters = [character('active')];
  state.archivedCharacters = [];
  state.parties = [];
  state.archivedParties = [];
  mocks.persist.mockClear();
  mocks.persist.mockResolvedValue(undefined);
  mocks.toast.mockClear();
});

describe('архив персонажей', () => {
  it('перемещает персонажа из активного списка и восстанавливает без потери данных', async () => {
    const char = character('c1');
    char.contacts = { email: 'login@example.com', password: 'pw' };
    char.notes = 'сохранить';
    state.characters = [char];
    const { archiveCharacters, restoreCharacter } = await import('../js/modules/archive/archive.js');

    await archiveCharacters(['c1']);
    expect(state.characters).toEqual([]);
    expect(state.archivedCharacters[0]).toMatchObject({ id: 'c1', notes: 'сохранить', contacts: char.contacts });

    await restoreCharacter('c1');
    expect(state.archivedCharacters).toEqual([]);
    expect(state.characters[0]).toMatchObject({ id: 'c1', notes: 'сохранить', contacts: char.contacts });
  });

  it('при ошибке сохранения возвращает исходные списки', async () => {
    const original = state.characters;
    mocks.persist.mockRejectedValueOnce(new Error('disk error'));
    const { archiveCharacters } = await import('../js/modules/archive/archive.js');

    await expect(archiveCharacters(['active'])).rejects.toThrow('disk error');
    expect(state.characters).toBe(original);
    expect(state.archivedCharacters).toEqual([]);
  });
});

describe('архив пати', () => {
  it('сохраняет состав, основную пати и порядок и возвращает их при восстановлении', async () => {
    const member = character('member', ['p1', 'p2'], 'p1');
    member.partyOrder = { p1: 3, p2: 1 };
    const archivedMember = character('archived-member', ['p1'], 'p1');
    state.characters = [member];
    state.archivedCharacters = [archivedMember];
    state.parties = [{ id: 'p1', name: 'Основная', order: 1 }, { id: 'p2', name: 'Другая', order: 2 }];
    const { archiveParty, restoreParty } = await import('../js/modules/archive/archive.js');

    await archiveParty('p1');
    expect(state.parties.map(party => party.id)).toEqual(['p2']);
    expect(state.characters[0]).toMatchObject({ partyIds: ['p2'], mainPartyId: 'p2', partyOrder: { p2: 1 } });
    expect(state.archivedParties[0].memberLinks).toEqual([
      { characterId: 'member', isMain: true, order: 3 },
      { characterId: 'archived-member', isMain: true, order: null }
    ]);
    expect(state.archivedCharacters[0].partyIds).toEqual([]);

    await restoreParty('p1');
    expect(state.archivedParties).toEqual([]);
    expect(state.characters[0]).toMatchObject({ partyIds: ['p2', 'p1'], mainPartyId: 'p1', partyOrder: { p2: 1, p1: 3 } });
    expect(state.archivedCharacters[0]).toMatchObject({ partyIds: ['p1'], mainPartyId: 'p1' });
  });
});
