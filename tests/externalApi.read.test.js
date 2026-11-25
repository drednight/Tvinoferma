// tests/externalApi.read.test.js
// GET-часть внешнего API: белый список полей и отсутствие секретов в ответе.
//
// Главная проверка — не «поля на месте», а «секретов нет». Контакты, пароли,
// токены GameCenter и куки не должны попадать в ответ даже если их добавят
// в объект персонажа позже: ответ собирается по белому списку, а не копией.
import { describe, it, expect } from 'vitest';
import {
  publicCharacter,
  publicCharacters,
  publicParties,
  publicWindows,
  runningByCharId,
  characterFilter
} from '../js/modules/externalApi/actions/read.js';

const character = () => ({
  id: 'Mag_1',
  nick: 'Маг',
  class: 'Маг',
  level: 100,
  favorite: true,
  sky: { name: 'Небо предела', level: 10 },
  partyIds: ['p-osnova', 'p-farm'],
  mainPartyId: 'p-osnova',
  stats: { physAttack: 12000, magAttack: '96000', critChance: 18 },
  dungeonPasses: { weapon: 3, armor: 2, relic: '1' },
  ancientCoins: 120,
  isLoggedIn: true,
  lastLoginCheck: '2026-11-24T09:10:00.000Z',
  updatedAt: '2026-11-24T09:12:00.000Z',
  notes: 'основной',
  // Секреты и служебные поля: их не должно быть в ответе.
  contacts: { email: 'mag@example.ru', password: 'secret', phone: '+7 900 000-00-00' },
  launch: {
    gcPath: 'C:\\GameCenter.exe',
    gcAccounts: { 'gc-1': { nick: 'acc', token: 'token-1' } },
    gcIds: ['gc-1']
  },
  siteLogin: { mode: 'standard' },
  cookies: [{ name: 'pw', value: 'cookie-value' }]
});

const state = () => ({
  characters: [
    character(),
    {
      id: 'Luchnik_2',
      nick: 'Лучник',
      class: 'Лучник',
      level: 99,
      partyIds: ['p-osnova'],
      stats: {},
      dungeonPasses: {}
    },
    { id: 'Zhrets_3', nick: 'Жрец', class: 'Жрец', level: 98, partyIds: ['p-farm'], stats: {}, dungeonPasses: {} }
  ],
  parties: [
    { id: 'p-osnova', name: 'Основа', color: '#6e8ef8' },
    { id: 'p-farm', name: 'Фарм', color: null }
  ]
});

describe('внешний API: чтение персонажей', () => {
  it('ответ содержит согласованные поля и числа, а не строки', () => {
    const row = publicCharacter(character());
    expect(row).toMatchObject({
      id: 'Mag_1',
      nick: 'Маг',
      class: 'Маг',
      level: 100,
      favorite: true,
      partyIds: ['p-osnova', 'p-farm'],
      mainPartyId: 'p-osnova',
      ancientCoins: 120,
      isLoggedIn: true,
      running: null
    });
    expect(row.sky).toEqual({ name: 'Небо предела', level: 10 });
    expect(row.stats).toEqual({ physAttack: 12000, magAttack: 96000, critChance: 18 });
    expect(row.dungeonPasses).toEqual({ weapon: 3, armor: 2, relic: 1 });
  });

  it('секретов в ответе нет ни одного', () => {
    const json = JSON.stringify(publicCharacter(character()));
    for (const secret of [
      'mag@example.ru',
      'secret',
      'password',
      'contacts',
      'token-1',
      'cookie-value',
      'GameCenter.exe',
      'gcAccounts',
      'siteLogin',
      'cookies'
    ]) {
      expect(json, `в ответ попало «${secret}»`).not.toContain(secret);
    }
  });

  it('список: фильтр по названию и по id пати, выбор полей', () => {
    const all = publicCharacters(state());
    expect(all.characters.map(c => c.id)).toEqual(['Mag_1', 'Luchnik_2', 'Zhrets_3']);
    const byName = publicCharacters(state(), 'party=Основа');
    expect(byName.characters.map(c => c.id)).toEqual(['Mag_1', 'Luchnik_2']);
    const byId = publicCharacters(state(), 'party=p-farm');
    expect(byId.characters.map(c => c.id)).toEqual(['Mag_1', 'Zhrets_3']);
    const light = publicCharacters(state(), 'party=p-farm&fields=nick,stats');
    expect(Object.keys(light.characters[0]).sort()).toEqual(['id', 'nick', 'stats']);
  });

  it('параметры списка разбираются без падения на мусоре', () => {
    expect(characterFilter(state(), '')).toEqual({ party: '', fields: [] });
    expect(characterFilter(state(), 'party=%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%B0&fields=nick,')).toEqual({
      party: 'Основа',
      fields: ['nick']
    });
  });

  it('`running` берётся из строк окон и только для известных, а не угаданных окон', () => {
    const rows = [
      { pid: 111, title: 'Маг — Маг', known: true, charId: 'Mag_1', nick: 'Маг' },
      { pid: 222, title: 'Perfect World', known: false, charId: null }
    ];
    const map = runningByCharId(rows);
    expect(map.size).toBe(1);
    const list = publicCharacters(state(), '', { running: map });
    expect(list.characters[0].running).toEqual({ pid: 111, title: 'Маг — Маг' });
    expect(list.characters[1].running).toBeNull();
  });

  it('пати: участники в порядке запуска и цвет', () => {
    // «Порядок из карточки пати»: здесь намеренно не порядок state (Лучник раньше Мага).
    const ordered = (chars, partyId) => {
      const list = chars.filter(c => c.partyIds.includes(partyId));
      return [...list.filter(c => c.id === 'Luchnik_2'), ...list.filter(c => c.id !== 'Luchnik_2')];
    };
    const body = publicParties(state(), ordered);
    // Порядок участников задаёт `ordered`, а не порядок в state: так его определяет
    // перетаскивание в карточке пати, и API не пересчитывает его сам.
    expect(body.parties[0]).toEqual({
      id: 'p-osnova',
      name: 'Основа',
      color: '#6e8ef8',
      members: [
        { id: 'Luchnik_2', nick: 'Лучник', order: 1 },
        { id: 'Mag_1', nick: 'Маг', order: 2 }
      ]
    });
    // Маг состоит в двух пати сразу: это нормальное состояние, а не ошибка данных.
    expect(body.parties[1].members.map(m => m.id)).toEqual(['Mag_1', 'Zhrets_3']);
  });

  it('окна: чужие окна без charId, пид числа, elevated сохраняется', () => {
    const body = publicWindows(
      [
        { pid: '12345', title: 'Маг — Маг', known: true, charId: 'Mag_1', nick: 'Маг', cls: 'Маг', elevated: false },
        { pid: 23456, title: 'Element Client', known: false, charId: null, elevated: null }
      ],
      '2026-11-24T12:00:00.000Z'
    );
    expect(body.updatedAt).toBe('2026-11-24T12:00:00.000Z');
    expect(body.windows[0]).toMatchObject({ pid: 12345, charId: 'Mag_1', nick: 'Маг', class: 'Маг', elevated: false });
    expect(body.windows[1]).toMatchObject({ pid: 23456, charId: null, nick: null });
  });
});
