// tests/externalApi.read.test.js
// GET-часть внешнего API: белый список полей и отсутствие секретов в ответе.
//
// Главная проверка — не «поля на месте», а «секретов нет». Контакты, пароли,
// токены GameCenter и куки не должны попадать в ответ даже если их добавят
// в объект персонажа позже: ответ собирается по белому списку, а не копией.
import { describe, it, expect } from 'vitest';
import {
  LIST_OMITTED,
  publicCharacter,
  publicCharacters,
  publicCharacterStats,
  publicParties,
  publicWindows,
  runningByCharId,
  characterFilter,
  CHARACTER_FIELD_NAMES,
  unknownFields
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
    // По умолчанию — все персонажи, отсортированные по id (так просил пользователь).
    const all = publicCharacters(state());
    expect(all.characters.map(c => c.id)).toEqual(['Luchnik_2', 'Mag_1', 'Zhrets_3']);
    const byName = publicCharacters(state(), 'party=Основа');
    expect(byName.characters.map(c => c.id)).toEqual(['Luchnik_2', 'Mag_1']);
    const byId = publicCharacters(state(), 'party=p-farm');
    expect(byId.characters.map(c => c.id)).toEqual(['Mag_1', 'Zhrets_3']);
    const light = publicCharacters(state(), 'party=p-farm&fields=nick,stats');
    expect(Object.keys(light.characters[0]).sort()).toEqual(['id', 'nick', 'stats']);
  });

  it('список по умолчанию — краткий: id и ник, а не карточка на каждого', () => {
    // «Показать список всех персонажей» — это «кто есть на ферме». Полный ответ на
    // 28 персонажей приносил несколько килобайт, из которых в списке не нужно ничего,
    // кроме имени: детали спрашиваются отдельно, `detail` или `fields`.
    const list = publicCharacters(state());
    expect(list.characters.length).toBe(3);
    expect(list.characters.map(row => Object.keys(row))).toEqual([
      ['id', 'nick'],
      ['id', 'nick'],
      ['id', 'nick']
    ]);
    const row = list.characters.find(c => c.id === 'Mag_1');
    expect(row).toEqual({ id: 'Mag_1', nick: 'Маг' });
    // Сокращение видно из ответа, и в нём же сказано, как получить больше.
    expect(list.detail).toBe('brief');
    expect(list.omitted).toContain('stats');
    expect(list.omitted).toContain('level');
    expect(list.detailHint).toContain('detail=list');
    expect(list.detailHint).toContain('/characters.stats');
  });

  it('detail=list — прежний лёгкий список, detail=full и full=true — карточки целиком', () => {
    const list = publicCharacters(state(), 'detail=list');
    const row = list.characters.find(c => c.id === 'Mag_1');
    // Что в списке остаётся: опознавательные поля, проходки, пати, окно.
    expect(row).toMatchObject({ id: 'Mag_1', nick: 'Маг', class: 'Маг', level: 100 });
    // Что не приезжает: два десятка статов, заметки и история монет на каждого.
    for (const key of LIST_OMITTED) expect(row).not.toHaveProperty(key);
    expect(list).toMatchObject({ detail: 'list', omitted: [...LIST_OMITTED] });
    expect(list.fullHint).toContain('full=true');

    // `full=true` — та же карточка, что и раньше (обратная совместимость по флагу).
    const full = publicCharacters(state(), 'full=true');
    expect(full.detail).toBe('full');
    expect(full.characters.find(c => c.id === 'Mag_1').stats.physAttack).toBe(12000);
    expect(full.characters.find(c => c.id === 'Mag_1')).toHaveProperty('notes');
    expect(full.omitted).toBeUndefined();
    expect(publicCharacters(state(), 'detail=full').detail).toBe('full');

    // `fields` перекрывает правило: попросил stats — получил stats.
    const asked = publicCharacters(state(), 'fields=id,stats');
    expect(Object.keys(asked.characters[0]).sort()).toEqual(['id', 'stats']);
    expect(asked.detail).toBe('picked');
  });

  it('characters.stats — статы и проходки у всех одной таблицей, с суммами', () => {
    const stats = publicCharacterStats(state());
    expect(stats.detail).toBe('stats');
    expect(stats.characters.map(row => row.id)).toEqual(['Luchnik_2', 'Mag_1', 'Zhrets_3']);
    const mag = stats.characters.find(row => row.id === 'Mag_1');
    expect(mag.nick).toBe('Маг');
    expect(mag.level).toBe(100);
    expect(mag.stats.physAttack).toBe(12000);
    expect(mag.dungeonPasses).toMatchObject({ weapon: 3 });
    // Заметок и истории монет в таблице нет: за ними — /characters?detail=full.
    expect(mag).not.toHaveProperty('notes');
    expect(mag).not.toHaveProperty('coinHistory');
    // Суммы на весь список и по пати считаются по тому же отбору, что и строки:
    // «сколько оружия у фермы» и «сколько оружия у пати» не расходятся с таблицей.
    const sumOf = rows =>
      rows.reduce(
        (n, row) => n + ['weapon', 'armor', 'relic'].reduce((m, p) => m + (Number(row.dungeonPasses?.[p]) || 0), 0),
        0
      );
    expect(stats.totals.sum).toBe(sumOf(stats.characters));
    expect(stats.totals.weapon).toBe(
      stats.characters.reduce((n, row) => n + (Number(row.dungeonPasses?.weapon) || 0), 0)
    );
    const oneParty = publicCharacterStats(state(), 'party=p-farm');
    expect(oneParty.characters.map(row => row.id)).toEqual(['Mag_1', 'Zhrets_3']);
    expect(oneParty.totals.sum).toBe(sumOf(oneParty.characters));
    expect(oneParty.totals.sum).toBeLessThanOrEqual(stats.totals.sum);
    // Порядок и подписи — как у списка: два ответа склеиваются по id.
    expect(publicCharacterStats(state(), 'sort=nick').characters[0].id).toBe('Zhrets_3'); // «Жрец» по-русски раньше всех
    const ru = publicCharacterStats(state(), 'lang=ru');
    expect(ru.characters[0]['Ник']).toBeTruthy();
  });

  it('один запрос отдаёт несколько полей сразу — включая проходки', () => {
    // Именно этот набор просил пользователь: id, класс, уровень и проходки.
    const one = publicCharacters(state(), 'fields=id,class,level,dungeonPasses');
    expect(Object.keys(one.characters[0])).toEqual(['id', 'class', 'level', 'dungeonPasses']);
    const row = one.characters.find(c => c.id === 'Mag_1');
    expect(row.class).toBe('Маг');
    expect(typeof row.level).toBe('number');
    expect(row.dungeonPasses.weapon).toBeGreaterThanOrEqual(0);
    expect(one.fields).toEqual(['id', 'class', 'level', 'dungeonPasses']);
    expect(one.count).toBe(3);
    // Точечные проходки — плоским ключом, как в pandas/Excel.
    const flat = publicCharacters(state(), 'fields=dungeonPasses.weapon,dungeonPasses.armor');
    expect(Object.keys(flat.characters[0]).sort()).toEqual(['dungeonPasses.armor', 'dungeonPasses.weapon', 'id']);
    // Вложенный вид — по явному запросу. Персонажа ищем по id: список
    // отсортирован по id, и позиция в нём ничего не значит.
    const nested = publicCharacters(state(), 'fields=dungeonPasses.weapon&flat=false');
    const mag = nested.characters.find(c => c.id === 'Mag_1');
    expect(mag.dungeonPasses).toEqual({ weapon: 3 });
    // Статы — так же, по имени, без потери id. Отсутствующий стат — `null`,
    // а не пропущенный ключ: строка одинаковая у всех персонажей.
    const attack = publicCharacters(state(), 'fields=stats.physAttack');
    expect(attack.characters.find(c => c.id === 'Mag_1')['stats.physAttack']).toBe(12000);
    expect(attack.characters.find(c => c.id === 'Luchnik_2')['stats.physAttack']).toBeNull();
    expect(attack.characters.every(c => typeof c.id === 'string')).toBe(true);
  });

  it('все допустимые поля перечислены в ответе-ошибке и работают', () => {
    // Мусор в `fields` отсекается, а список допустимых — из одного места.
    expect(unknownFields(['id', 'hp', 'статы'])).toEqual(['hp', 'статы']);
    for (const field of CHARACTER_FIELD_NAMES) expect(unknownFields([field])).toEqual([]);
    // Вложенные поля есть в списке, иначе их нельзя было бы попросить.
    for (const field of ['stats.hp', 'dungeonPasses.weapon', 'dungeonPasses.armor', 'dungeonPasses.relic']) {
      expect(CHARACTER_FIELD_NAMES).toContain(field);
    }
  });

  it('`lang=ru` подписывает поля по-русски и не теряет id', () => {
    const ru = publicCharacters(state(), 'fields=class,level,dungeonPasses.weapon&lang=ru');
    const row = ru.characters.find(c => c.id === 'Mag_1');
    expect(row).toBeTruthy();
    if (!row) return;
    expect(Object.keys(row)).toEqual(['id', 'Класс', 'Уровень', 'Проходки: оружие']);
    expect(row['Класс']).toBe('Маг');
    expect(row['Проходки: оружие']).toEqual(expect.any(Number));
    // Вложенный вид тоже подписывается (иначе значение терялось бы).
    const nested = publicCharacters(state(), 'fields=dungeonPasses.weapon&flat=false&lang=ru');
    expect(nested.characters.find(c => c.id === 'Mag_1')?.['Проходки: оружие']).toBe(3);
    // Полная карточка (`full=true`): вложенные объекты разворачиваются в подписи,
    // id остаётся. Без `full` список статов не отдаёт — см. отдельный тест ниже.
    const full = publicCharacters(state(), 'lang=ru&full=true');
    const card = full.characters.find(c => c.id === 'Mag_1');
    expect(card).toBeTruthy();
    if (!card) return;
    expect(card.id).toBe('Mag_1');
    // Статы разворачиваются в подписи: в фикстуре есть только эти два.
    expect(card['Физ. атака']).toBe(12000);
    expect(card['Крит, %']).toBe(18);
    // Ключ, которого у персонажа нет, в полную карточку не попадает — иначе
    // ответ раздувался бы нулями.
    expect(card).not.toHaveProperty('HP');
    expect(card['Ник']).toBeTruthy();
  });

  it('сортировка: по id по умолчанию, явно — по нику и уровню, `none` — порядок хранения', () => {
    const base = publicCharacters(state());
    expect(base.characters.map(c => c.id)).toEqual([...base.characters.map(c => c.id)].sort());
    const byNick = publicCharacters(state(), 'sort=nick');
    expect(byNick.characters.map(c => c.nick)).toEqual(
      ['Лучник', 'Маг', 'Жрец'].sort((a, b) => a.localeCompare(b, 'ru'))
    );
    const desc = publicCharacters(state(), 'sort=level&order=desc&detail=list');
    const levels = desc.characters.map(c => c.level);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
    expect(publicCharacters(state(), 'sort=none').characters.length).toBe(3);
  });

  it('параметры списка разбираются без падения на мусоре', () => {
    // Значения по умолчанию: по id, по возрастанию, плоские поля, английские ключи.
    expect(characterFilter(state(), '')).toEqual({
      party: '',
      fields: [],
      lang: 'en',
      flat: true,
      sort: 'id',
      order: 'asc',
      full: false,
      detail: ''
    });
    // `detail` — только одно из трёх; мусор не ошибка, а «как не просили» (краткий список).
    expect(characterFilter(state(), 'detail=list')).toMatchObject({ detail: 'list' });
    expect(characterFilter(state(), 'detail=МНОГО')).toMatchObject({ detail: '' });
    expect(characterFilter(state(), 'party=%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%B0&fields=nick,')).toEqual({
      party: 'Основа',
      fields: ['nick'],
      lang: 'en',
      flat: true,
      detail: '',
      sort: 'id',
      order: 'asc',
      full: false
    });
    // `full` — только явное «да»: `full=1|true|yes|да|full`.
    expect(characterFilter(state(), 'full=1')).toMatchObject({ full: true });
    expect(characterFilter(state(), 'full=%D0%B4%D0%B0')).toMatchObject({ full: true });
    expect(characterFilter(state(), 'full=maybe')).toMatchObject({ full: false });
    // Мусор в параметрах не ломает разбор: берутся безопасные значения.
    expect(characterFilter(state(), 'sort=что&order=вверх&lang=fr&flat=может')).toMatchObject({
      lang: 'en',
      flat: true,
      sort: 'id',
      order: 'asc'
    });
    expect(characterFilter(state(), 'sort=level&order=desc&lang=ru&flat=false')).toMatchObject({
      lang: 'ru',
      flat: false,
      sort: 'level',
      order: 'desc'
    });
  });

  it('`running` берётся из строк окон и только для известных, а не угаданных окон', () => {
    const rows = [
      { pid: 111, title: 'Маг — Маг', known: true, charId: 'Mag_1', nick: 'Маг' },
      { pid: 222, title: 'Perfect World', known: false, charId: null }
    ];
    const map = runningByCharId(rows);
    expect(map.size).toBe(1);
    const list = publicCharacters(state(), 'detail=list', { running: map });
    const byId = Object.fromEntries(list.characters.map(row => [row.id, row]));
    expect(byId.Mag_1.running).toEqual({ pid: 111, title: 'Маг — Маг' });
    expect(byId.Luchnik_2.running).toBeNull();
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
