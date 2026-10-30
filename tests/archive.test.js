import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../js/core/state.js';

const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
vi.mock('../js/modules/characters/list.js', () => ({ renderCharacters: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));

const character = (id, partyIds = [], mainPartyId = null) => ({
  id,
  nick: id,
  partyIds,
  mainPartyId,
  partyOrder: {},
  updatedAt: 'old'
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
    char.syncId = 'a9115bf2-e834-444d-aeb6-7c3af1db8890';
    char.notes = 'сохранить';
    state.characters = [char];
    const { archiveCharacters, restoreCharacter } = await import('../js/modules/archive/archive.js');

    await archiveCharacters(['c1']);
    expect(state.characters).toEqual([]);
    expect(state.archivedCharacters[0]).toMatchObject({
      id: 'c1',
      syncId: char.syncId,
      notes: 'сохранить',
      contacts: char.contacts
    });

    await restoreCharacter('c1');
    expect(state.archivedCharacters).toEqual([]);
    expect(state.characters[0]).toMatchObject({
      id: 'c1',
      syncId: char.syncId,
      notes: 'сохранить',
      contacts: char.contacts
    });
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
    state.parties = [
      { id: 'p1', syncId: 'b9115bf2-e834-444d-aeb6-7c3af1db8890', name: 'Основная', order: 1 },
      { id: 'p2', name: 'Другая', order: 2 }
    ];
    const { archiveParty, restoreParty } = await import('../js/modules/archive/archive.js');

    await archiveParty('p1');
    expect(state.parties.map(party => party.id)).toEqual(['p2']);
    expect(state.characters[0]).toMatchObject({ partyIds: ['p2'], mainPartyId: 'p2', partyOrder: { p2: 1 } });
    expect(state.archivedParties[0].syncId).toBe('b9115bf2-e834-444d-aeb6-7c3af1db8890');
    expect(state.archivedParties[0].memberLinks).toEqual([
      { characterId: 'member', isMain: true, order: 3 },
      { characterId: 'archived-member', isMain: true, order: null }
    ]);
    expect(state.archivedCharacters[0].partyIds).toEqual([]);

    await restoreParty('p1');
    expect(state.archivedParties).toEqual([]);
    expect(state.parties.find(p => p.id === 'p1').syncId).toBe('b9115bf2-e834-444d-aeb6-7c3af1db8890');
    expect(state.characters[0]).toMatchObject({
      partyIds: ['p2', 'p1'],
      mainPartyId: 'p1',
      partyOrder: { p2: 1, p1: 3 }
    });
    expect(state.archivedCharacters[0]).toMatchObject({ partyIds: ['p1'], mainPartyId: 'p1' });
  });
});

describe('порядок пати в архиве совпадает с нормализацией при перезапуске', () => {
  it('сохраняет пати по order до записи, включая восстановление в начало', async () => {
    state.parties = [
      { id: 'p', name: 'Первая', order: 1 },
      { id: 'q', name: 'Вторая', order: 2 }
    ];
    state.archivedParties = [{ id: 'r', name: 'Третья', order: 3, memberLinks: [] }];
    const { archiveParty, restoreParty } = await import('../js/modules/archive/archive.js');
    await archiveParty('p');
    expect(state.archivedParties.map(row => row.id)).toEqual(['p', 'r']);
    await restoreParty('p');
    expect(state.parties.map(row => row.id)).toEqual(['p', 'q']);
  });
  it('при отказе сохранения возвращает исходные массивы и состав', async () => {
    state.parties = [{ id: 'p', name: 'Первая', order: 1 }];
    state.archivedParties = [{ id: 'r', name: 'Третья', order: 3, memberLinks: [] }];
    state.characters = [character('a', ['p'], 'p')];
    state.characters[0].partyOrder = { p: 7 };
    const before = { parties: state.parties, archive: state.archivedParties, characters: state.characters };
    mocks.persist.mockRejectedValueOnce(new Error('disk failure'));
    const { archiveParty } = await import('../js/modules/archive/archive.js');
    await expect(archiveParty('p')).rejects.toThrow();
    expect(state.parties).toBe(before.parties);
    expect(state.archivedParties).toBe(before.archive);
    expect(state.characters).toBe(before.characters);
  });
});
