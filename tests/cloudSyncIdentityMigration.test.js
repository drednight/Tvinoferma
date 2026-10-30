import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { isSyncId } from '../js/modules/cloudSync/envelope.js';

const time = '2026-10-28T12:00:00.000Z';
function fixture() {
  const normalized = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'hero',
        nick: 'Герой',
        partyIds: ['party-a'],
        mainPartyId: 'party-a',
        contacts: { password: 'частный пароль' }
      }
    ],
    archivedCharacters: [{ id: 'old', nick: 'Архив' }],
    parties: [{ id: 'party-a', name: 'Группа', order: 1 }],
    archivedParties: [
      { id: 'party-old', name: 'Архивная', order: 2, memberLinks: [{ characterId: 'old', isMain: true, order: 2 }] }
    ],
    marathons: [
      { id: 'series-1', schemaVersion: 2, kind: 'series', title: 'Серия', childIds: ['marathon-1'] },
      {
        id: 'marathon-1',
        schemaVersion: 2,
        kind: 'single',
        title: 'Марафон',
        seriesId: 'series-1',
        tasks: [{ id: 'task-1', title: 'Задание', rewards: [{ id: 'reward-1', threshold: 1 }] }],
        bonuses: [{ id: 'bonus-1', needTasks: 1, text: 'Бонус' }],
        participantIds: ['hero']
      }
    ],
    marathonTemplates: [{ id: 'template-1', name: 'Шаблон', tasks: [] }],
    plannerEntries: [{ id: 'planner-1', title: 'Дело', date: '2026-10-28' }],
    finance: {
      operations: [{ id: 'op-1', date: '2026-10-28', amount: 10, currency: 'gold', kind: 'in' }],
      shopItems: [{ id: 'shop-1', name: 'Пробный предмет', date: '2026-10-28', price: 5, qty: 2 }],
      loans: [
        {
          id: 'loan-1',
          who: 'Игрок',
          principal: 50,
          start: '2026-10-28',
          payments: [{ id: 'payment-1', date: '2026-10-28', amount: 5 }]
        }
      ],
      settings: {}
    },
    savedAt: time
  });
  const { ui, ...snapshot } = normalized;
  return snapshot;
}

function identities(s) {
  return [
    ...s.characters,
    ...s.archivedCharacters,
    ...s.parties,
    ...s.archivedParties,
    ...s.marathons,
    ...s.marathonTemplates,
    ...s.plannerEntries,
    ...s.finance.operations,
    ...s.finance.shopItems,
    ...s.finance.loans,
    ...s.finance.loans.flatMap(loan => loan.payments),
    ...s.marathons.flatMap(m => m.tasks || []),
    ...s.marathons.flatMap(m => (m.tasks || []).flatMap(task => task.rewards)),
    ...s.marathons.flatMap(m => m.bonuses || [])
  ];
}
const plan = snapshot => planSyncIdentities({ snapshot, cryptoSource: webcrypto });

describe('подготовка миграции устойчивых sync-ID', () => {
  it('создаёт отдельные случайные ID для записей и не изменяет исходное состояние', () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const result = plan(snapshot);
    expect(result.changed).toBe(true);
    expect(result.assigned).toEqual({
      characters: 2,
      parties: 2,
      marathons: 2,
      marathonTemplates: 1,
      plannerEntries: 1,
      financeOperations: 1,
      financeShopItems: 1,
      financeLoans: 1,
      financePayments: 1,
      marathonTasks: 1,
      marathonRewards: 1,
      marathonBonuses: 1
    });
    const all = identities(result.snapshot);
    expect(all).toHaveLength(15);
    expect(new Set(all.map(row => row.syncId)).size).toBe(all.length);
    for (const row of all) {
      expect(isSyncId(row.syncId)).toBe(true);
      expect(row.syncId).not.toBe(row.id);
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(result.snapshot.characters[0].contacts.password).toBe('частный пароль');
  });

  it('сохраняет назначенные ID после JSON-перезапуска и нормализации всех разделов', () => {
    const first = plan(fixture()).snapshot;
    const expected = identities(first).map(row => row.syncId);
    const afterReload = normalizeState(JSON.parse(JSON.stringify(first)));
    expect(identities(afterReload).map(row => row.syncId)).toEqual(expected);
    const { ui, ...snapshot } = afterReload;
    const second = plan(snapshot);
    expect(second.changed).toBe(false);
    expect(Object.values(second.assigned).every(count => count === 0)).toBe(true);
    expect(identities(second.snapshot).map(row => row.syncId)).toEqual(expected);
  });

  it('оставляет старые ID при переименовании персонажа и назначает только новым записям', () => {
    const first = plan(fixture()).snapshot;
    const charId = first.characters[0].syncId;
    const partyId = first.parties[0].syncId;
    first.characters[0].id = 'renamed-hero';
    first.characters[0].nick = 'Другое имя';
    first.characters.push({ ...first.characters[0], id: 'second', nick: 'Новый', syncId: undefined });
    delete first.characters.at(-1).syncId;
    const result = plan(first);
    expect(result.assigned.characters).toBe(1);
    expect(result.snapshot.characters[0].syncId).toBe(charId);
    expect(result.snapshot.characters.at(-1).syncId).not.toBe(charId);
    expect(result.snapshot.parties[0].syncId).toBe(partyId);
  });

  it('сохраняет ID при переносе персонажа и пати в архив', () => {
    const first = plan(fixture()).snapshot;
    const char = first.characters.shift();
    const party = first.parties.shift();
    first.archivedCharacters.push(char);
    first.archivedParties.push({ ...party, memberLinks: [] });
    const result = plan(first);
    expect(result.changed).toBe(false);
    expect(result.snapshot.archivedCharacters.at(-1).syncId).toBe(char.syncId);
    expect(result.snapshot.archivedParties.at(-1).syncId).toBe(party.syncId);
  });

  it('отклоняет повтор sync-ID между разными типами и не меняет ни одну запись', () => {
    const first = plan(fixture()).snapshot;
    first.parties[0].syncId = first.characters[0].syncId;
    const before = JSON.stringify(first);
    expect(() => plan(first)).toThrow('повторяются');
    expect(JSON.stringify(first)).toBe(before);
  });

  it('различает одинаковые локальные id заданий в разных марафонах, но не внутри одного', () => {
    const snapshot = fixture();
    const first = snapshot.marathons[1];
    const another = structuredClone(first);
    another.id = 'marathon-2';
    snapshot.marathons.push(another);
    const result = plan(snapshot);
    expect(result.assigned.marathonTasks).toBe(2);
    expect(result.snapshot.marathons[1].tasks[0].syncId).not.toBe(result.snapshot.marathons[2].tasks[0].syncId);
    snapshot.marathons[1].tasks.push(structuredClone(snapshot.marathons[1].tasks[0]));
    expect(() => plan(snapshot)).toThrow('повторяются');
  });

  it('отклоняет повтор локального id между активными и архивными записями', () => {
    const snapshot = fixture();
    snapshot.archivedCharacters[0].id = 'HERO';
    expect(() => plan(snapshot)).toThrow('повторяются');
  });

  it.each([null, '', 'old-id', 42])('не перегенерирует повреждённый sync-ID %#', value => {
    const snapshot = fixture();
    snapshot.characters[0].syncId = value;
    expect(() => plan(snapshot)).toThrow();
    expect(snapshot.characters[0].syncId).toBe(value);
  });

  it('не считает отсутствие данных пустым списком и не запускает частичную миграцию', () => {
    const snapshot = fixture();
    delete snapshot.finance.loans;
    const before = JSON.stringify(snapshot);
    expect(() => plan(snapshot)).toThrow('данные неполны');
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('не назначает sync-ID, совпадающий с локальным ID другой сущности', () => {
    const snapshot = fixture();
    snapshot.finance.operations[0].id = '00000000-0000-4000-8000-000000000000';
    let step = 0;
    const cryptoSource = {
      subtle: {},
      getRandomValues(bytes) {
        bytes.fill(step++);
        return bytes;
      }
    };
    const result = planSyncIdentities({ snapshot, cryptoSource });
    expect(result.snapshot.characters[0].syncId).not.toBe(snapshot.finance.operations[0].id);
    const first = plan(fixture()).snapshot;
    first.characters[0].id = '00000000-0000-4000-8000-000000000000';
    first.parties[0].syncId = first.characters[0].id;
    expect(() => plan(first)).toThrow();
  });

  it('отклоняет один и тот же объект в разных категориях вместо двойного назначения', () => {
    const snapshot = fixture();
    snapshot.parties[0] = snapshot.characters[0];
    expect(() => plan(snapshot)).toThrow('повторяются');
  });

  it('не использует случайность Math.random и не продолжает при повторяющемся генераторе', () => {
    const cryptoSource = {
      subtle: {},
      getRandomValues(bytes) {
        bytes.fill(0);
        return bytes;
      }
    };
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    expect(() => planSyncIdentities({ snapshot, cryptoSource })).toThrow('уникальный');
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('не выполняет getters и не показывает секреты в ошибке', () => {
    const snapshot = fixture();
    let touched = false;
    Object.defineProperty(snapshot.characters[0], 'secret', {
      enumerable: true,
      get() {
        touched = true;
        return 'скрыто';
      }
    });
    expect(() => plan(snapshot)).toThrow();
    expect(touched).toBe(false);
    snapshot.characters[0] = { id: '', nick: 'СКРЫТЫЙ ТЕКСТ' };
    try {
      plan(snapshot);
    } catch (error) {
      expect(String(error)).not.toContain('СКРЫТЫЙ ТЕКСТ');
    }
  });

  it('отдаёт независимую копию, а не ссылки на локальные данные', () => {
    const snapshot = fixture();
    const result = plan(snapshot);
    result.snapshot.characters[0].contacts.password = 'изменено в плане';
    expect(snapshot.characters[0].contacts.password).toBe('частный пароль');
  });
});
