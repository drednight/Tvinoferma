import { describe, it, expect, beforeEach } from 'vitest';
import { fillClassFilter, fillPartyFilter, filterCharacters } from '../js/modules/characters/filters.js';

const ch = (nick, over = {}) => ({ id: nick, nick, class: '', partyIds: [], tags: [], isLoggedIn: false, ...over });
const values = (select) => [...select.options].map(o => o.value);

describe('фильтр по классам (issue #2)', () => {
  let select;
  beforeEach(() => { document.body.innerHTML = '<select id="c"></select>'; select = document.getElementById('c'); });

  it('новый класс сразу появляется в списке вариантов', () => {
    const chars = [ch('A', { class: 'Маг' })];
    fillClassFilter(select, chars);
    expect(values(select)).toEqual(['', 'Маг']);
    chars.push(ch('B', { class: 'Воин' }));
    fillClassFilter(select, chars);
    expect(values(select)).toEqual(['', 'Воин', 'Маг']);
  });

  it('выбранный фильтр сохраняется, пока класс ещё есть', () => {
    const chars = [ch('A', { class: 'Маг' }), ch('B', { class: 'Воин' })];
    fillClassFilter(select, chars);
    select.value = 'Маг';
    chars.push(ch('C', { class: 'Лучник' }));
    expect(fillClassFilter(select, chars)).toBe('Маг');
    expect(select.value).toBe('Маг');
  });

  it('если выбранного класса больше нет, фильтр сбрасывается на «Все классы»', () => {
    const chars = [ch('A', { class: 'Маг' }), ch('B', { class: 'Воин' })];
    fillClassFilter(select, chars);
    select.value = 'Воин';
    chars.pop();
    expect(fillClassFilter(select, chars)).toBe('');
    expect(select.value).toBe('');
  });

  it('при добавлении персонажа под активный фильтр он виден сразу, не подходящий не виден', () => {
    const chars = [ch('A', { class: 'Маг' })];
    fillClassFilter(select, chars);
    select.value = 'Маг';
    chars.push(ch('B', { class: 'Маг' }), ch('C', { class: 'Воин' }));
    const cls = fillClassFilter(select, chars);
    expect(filterCharacters(chars, { cls }).map(c => c.nick)).toEqual(['A', 'B']);
  });

  it('экранирует названия в options', () => {
    fillClassFilter(select, [ch('A', { class: 'Маг "X" <b>' })]);
    expect(select.options[1].value).toBe('Маг "X" <b>');
  });

  it('DOM не пересобирается, если список вариантов не менялся', () => {
    const chars = [ch('A', { class: 'Маг' })];
    fillClassFilter(select, chars);
    const firstOption = select.options[1];
    fillClassFilter(select, chars);
    expect(select.options[1]).toBe(firstOption);
  });
});

describe('фильтр по пати', () => {
  it('«Без пати» всегда на месте, новые пати появляются, удалённая сбрасывает фильтр', () => {
    document.body.innerHTML = '<select id="p"></select>';
    const select = document.getElementById('p');
    const parties = [{ id: 'p1', name: 'Основа', order: 1 }];
    fillPartyFilter(select, parties);
    expect(values(select)).toEqual(['', '__none__', 'p1']);
    expect(select.options[2].textContent).toBe('Основа');
    select.value = 'p1';
    parties.push({ id: 'p2', name: 'Крипочки', order: 2 });
    expect(fillPartyFilter(select, parties)).toBe('p1');
    parties.shift();
    expect(fillPartyFilter(select, parties)).toBe('');
    expect(values(select)).toEqual(['', '__none__', 'p2']);
  });
});

describe('filterCharacters', () => {
  const chars = [
    ch('Alpha', { class: 'Маг', partyIds: ['P1'], tags: ['фарм'], isLoggedIn: true }),
    ch('Beta', { class: 'Воин', partyIds: [], tags: [] }),
    ch('Gamma', { class: 'Маг', partyIds: ['P2', 'P1'], tags: ['Фарм'] })
  ];
  const nicks = (f) => filterCharacters(chars, f).map(c => c.nick);
  it('без фильтров — все', () => expect(nicks({})).toEqual(['Alpha', 'Beta', 'Gamma']));
  it('класс', () => expect(nicks({ cls: 'Маг' })).toEqual(['Alpha', 'Gamma']));
  it('пати: персонаж входит в выбранную пати; «Без пати»', () => {
    expect(nicks({ party: 'P2' })).toEqual(['Gamma']);
    expect(nicks({ party: 'P1' })).toEqual(['Alpha', 'Gamma']); // Gamma состоит в двух пати
    expect(nicks({ party: '__none__' })).toEqual(['Beta']);
  });
  it('тег без учёта регистра и «Без тегов»', () => { expect(nicks({ tag: 'фарм' })).toEqual(['Alpha', 'Gamma']); expect(nicks({ tag: '__none__' })).toEqual(['Beta']); });
  it('статус входа', () => { expect(nicks({ auth: 'online' })).toEqual(['Alpha']); expect(nicks({ auth: 'offline' })).toEqual(['Beta', 'Gamma']); });
  it('поиск по нику и #тегу', () => { expect(nicks({ search: 'bet' })).toEqual(['Beta']); expect(nicks({ search: '#фарм' })).toEqual(['Alpha', 'Gamma']); });
  it('комбинация фильтров', () => expect(nicks({ cls: 'Маг', party: 'P2' })).toEqual(['Gamma']));
});
