// tests/characterGrouping.test.js
import { describe, it, expect } from 'vitest';
import { groupChars, applyManualOrder, moveChar, GROUP_PARTY, GROUP_CLASS, GROUP_NONE } from '../js/modules/characters/grouping.js';

const parties = [
  { id: 'p2', name: 'Вторая', order: 2 },
  { id: 'p1', name: 'Основа', order: 1 }
];

const chars = [
  { id: 'a', nick: 'Аня', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: true },
  { id: 'b', nick: 'Борис', class: 'Маг', partyIds: [], mainPartyId: null, isLoggedIn: false },
  { id: 'c', nick: 'Вика', class: 'Воин', partyIds: ['p2', 'p1'], mainPartyId: 'p2', isLoggedIn: true },
  { id: 'd', nick: 'Глеб', class: 'Лучник', partyIds: ['удалённая'], mainPartyId: null, isLoggedIn: false }
];

describe('groupChars', () => {
  it('без группировки возвращает один блок без заголовка', () => {
    const groups = groupChars(chars, GROUP_NONE, parties);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBeNull();
    expect(groups[0].chars.map(c => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('по пати: порядок партий, «Без пати» последней, основная пати решает группу', () => {
    const groups = groupChars(chars, GROUP_PARTY, parties);
    expect(groups.map(g => g.title)).toEqual(['Основа', 'Вторая', 'Без пати']);
    expect(groups[1].chars.map(c => c.id)).toEqual(['c']);
    expect(groups[2].chars.map(c => c.id)).toEqual(['b', 'd']);
  });

  it('по классу: алфавит, «Без класса» не нужен, пустые группы не возвращаются', () => {
    const groups = groupChars(chars.slice(0, 3), GROUP_CLASS, parties);
    expect(groups.map(g => g.title)).toEqual(['Воин', 'Маг']);
    expect(groups[0].chars.map(c => c.id)).toEqual(['a', 'c']);
    expect(groups[1].chars.map(c => c.id)).toEqual(['b']);
  });

  it('считает онлайн в группе', () => {
    const groups = groupChars(chars, GROUP_PARTY, parties);
    expect(groups[0].online).toBe(1);
    expect(groups[2].online).toBe(0);
  });

  it('пустой список — нет групп', () => {
    expect(groupChars([], GROUP_PARTY, parties)).toEqual([]);
  });
});

describe('applyManualOrder', () => {
  it('ставит персонажей в сохранённом порядке', () => {
    expect(applyManualOrder(chars, ['d', 'a']).map(c => c.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('новые персонажи уходят в конец в исходном порядке', () => {
    const extra = [...chars, { id: 'e', nick: 'Ева' }];
    expect(applyManualOrder(extra, ['c']).map(c => c.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('пустой порядок не меняет список', () => {
    expect(applyManualOrder(chars, []).map(c => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('moveChar', () => {
  it('переносит перед целью', () => {
    expect(moveChar(['a', 'b', 'c', 'd'], { dragId: 'd', targetId: 'b' })).toEqual(['a', 'd', 'b', 'c']);
  });

  it('перенос вниз тоже работает', () => {
    expect(moveChar(['a', 'b', 'c'], { dragId: 'a', targetId: 'c' })).toEqual(['b', 'a', 'c']);
  });

  it('с after вставляет после цели', () => {
    expect(moveChar(['a', 'b', 'c', 'd'], { dragId: 'a', targetId: 'c', after: true })).toEqual(['b', 'c', 'a', 'd']);
  });

  it('после последней цели — в самый конец', () => {
    expect(moveChar(['a', 'b', 'c'], { dragId: 'a', targetId: 'c', after: true })).toEqual(['b', 'c', 'a']);
  });

  it('без цели — в конец', () => {
    expect(moveChar(['a', 'b'], { dragId: 'a', targetId: null })).toEqual(['b', 'a']);
  });
});
