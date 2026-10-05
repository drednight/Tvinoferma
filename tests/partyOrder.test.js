// Порядок персонажей внутри пати (js/modules/parties/membership.js):
// задаётся перетаскиванием, хранится у персонажа (char.partyOrder) и переживает перезапуск приложения.
import { describe, it, expect } from 'vitest';

import {
  charactersInPartyOrdered, applyPartyOrder, movePartyMember, partyOrderOf
} from '../js/modules/parties/membership.js';
import { normalizeState } from '../js/core/state.js';

const chars = () => [
  { id: 'a', nick: 'Аа', partyIds: ['p1'], mainPartyId: 'p1' },
  { id: 'b', nick: 'Бб', partyIds: ['p1'], mainPartyId: 'p1' },
  { id: 'c', nick: 'Вв', partyIds: ['p1'], mainPartyId: 'p1' },
  { id: 'd', nick: 'Гг', partyIds: ['p2'], mainPartyId: 'p2' }
];

const order = (list, partyId = 'p1') => charactersInPartyOrdered(list, partyId).map(c => c.id);

describe('порядок участников пати', () => {
  it('без заданного порядка участники идут по алфавиту', () => {
    expect(order(chars())).toEqual(['a', 'b', 'c']);
  });

  it('порядок из данных важнее алфавита, а кто без порядка — после них', () => {
    const list = chars();
    applyPartyOrder(list, 'p1', ['c', 'a']);
    expect(order(list)).toEqual(['c', 'a', 'b']);
  });

  it('порядок считается отдельно для каждой пати', () => {
    const list = [
      { id: 'x', nick: 'Икс', partyIds: ['p1', 'p2'], mainPartyId: 'p1' },
      { id: 'y', nick: 'Игрек', partyIds: ['p1', 'p2'], mainPartyId: 'p1' }
    ];
    applyPartyOrder(list, 'p1', ['y', 'x']);
    applyPartyOrder(list, 'p2', ['x', 'y']);
    expect(order(list, 'p1')).toEqual(['y', 'x']);
    expect(order(list, 'p2')).toEqual(['x', 'y']);
  });

  it('персонаж встаёт на место того, на кого навели, а тот сдвигается (а не вставляется под ним)', () => {
    const list = chars();
    // «a» тащим на «c»: «a» занимает его место, «c» сдвигается вниз
    expect(movePartyMember(list, 'p1', 'a', 'c')).toBe(true);
    expect(order(list)).toEqual(['b', 'a', 'c']);
    // Номера непрерывные: 1, 2, 3
    expect(order(list).map(id => partyOrderOf(list.find(c => c.id === id), 'p1'))).toEqual([1, 2, 3]);
  });

  it('наведение на нижнюю половину строки ставит персонажа после неё', () => {
    const list = chars();
    // Так перетаскивание вниз на соседнюю строку сдвигает на одну позицию, а не бросает в конец
    expect(movePartyMember(list, 'p1', 'a', 'b', { after: true })).toBe(true);
    expect(order(list)).toEqual(['b', 'a', 'c']);
  });

  it('перенос вверх тоже работает и тоже смещает цель вниз', () => {
    const list = chars();
    movePartyMember(list, 'p1', 'c', 'a');
    expect(order(list)).toEqual(['c', 'a', 'b']);
  });

  it('перетаскивание вниз на соседнюю строку меняет местами, а не переносит в конец', () => {
    const list = chars();
    // «a» наводит на верхнюю половину «b»: встаёт перед ним, то есть они меняются местами
    movePartyMember(list, 'p1', 'a', 'b');
    expect(order(list)).toEqual(['a', 'b', 'c']);
    // А наведение на нижнюю половину «b» уводит «a» за него
    movePartyMember(list, 'p1', 'a', 'b', { after: true });
    expect(order(list)).toEqual(['b', 'a', 'c']);
  });

  it('бессмысленный перенос ничего не меняет', () => {
    const list = chars();
    expect(movePartyMember(list, 'p1', 'a', 'a')).toBe(false);
    expect(movePartyMember(list, 'p1', 'нет', 'a')).toBe(false);
    expect(movePartyMember(list, 'p1', 'a', 'd')).toBe(false);   // «d» не в этой пати
  });

  it('персонаж из другой пати в порядок не попадает', () => {
    const list = chars();
    applyPartyOrder(list, 'p1', ['d']);
    expect(partyOrderOf(list.find(c => c.id === 'd'), 'p1')).toBe(1);
    expect(order(list)).toEqual(['a', 'b', 'c']);   // список пати p1 не изменился
  });
});

describe('порядок переживает сохранение и загрузку', () => {
  it('partyOrder сохраняется и нормализуется', () => {
    const saved = {
      characters: [
        { id: 'a', nick: 'Аа', partyIds: ['p1'], mainPartyId: 'p1', partyOrder: { p1: 2 } },
        { id: 'b', nick: 'Бб', partyIds: ['p1'], mainPartyId: 'p1', partyOrder: { p1: 1 } }
      ],
      parties: [{ id: 'p1', name: 'Основа', order: 1 }]
    };
    const state = normalizeState(saved);
    expect(state.characters[0].partyOrder).toEqual({ p1: 2 });
    // Порядок применяется: «Бб» с номером 1 идёт первым
    expect(charactersInPartyOrdered(state.characters, 'p1').map(c => c.nick)).toEqual(['Бб', 'Аа']);
  });

  it('мусор в partyOrder отбрасывается, а не ломает порядок', () => {
    const state = normalizeState({
      characters: [{ id: 'a', nick: 'Аа', partyIds: ['p1'], mainPartyId: 'p1', partyOrder: { p1: 0, p2: -3, p3: 'abc', p4: 2.6 } }],
      parties: [{ id: 'p1', name: 'P', order: 1 }]
    });
    expect(state.characters[0].partyOrder).toEqual({ p4: 3 });
  });

  it('без partyOrder персонаж загружается как раньше', () => {
    const state = normalizeState({ characters: [{ id: 'a', nick: 'Аа', partyIds: [], mainPartyId: null }], parties: [] });
    expect(state.characters[0].partyOrder).toEqual({});
  });
});
