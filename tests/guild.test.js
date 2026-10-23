// tests/guild.test.js
// Разбор страницы профиля кланового сайта (pw-eternals.ru).
//
// Разбор живёт в двух местах: js/modules/guild/core.js (эталон, используется приложением
// при чтении кэша) и src-tauri/src/scripts/guild.js (работает в окне сайта). Здесь
// проверяются оба на одной фикстуре, чтобы правки одного не разошлись с другим.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseProfileDocument, parseParties, parseEvents, normalizeGuildData,
  unansweredEvents, responseText, summaryText,
  partyNicks, allPartyNicks, isSelfNick,
  parseEventWhen, plannerEntryFor, wantedClanEntries, CLAN_ENTRY_PREFIX,
  RESPONSE_YES, RESPONSE_NO
} from '../js/modules/guild/core.js';
import { planClanEntries } from '../js/modules/guild/plannerBridge.js';
import { msToMskMidnight } from '../js/modules/guild/page.js';
import { normalizeState } from '../js/core/state.js';

const html = readFileSync('tests/fixtures/site-guild-profile.html', 'utf8');
const doc = () => new DOMParser().parseFromString(html, 'text/html');
const profile = () => parseProfileDocument(doc());

/** Тот же скрипт, что Rust вшивает в окно клана, на фикстуре. */
function runWindowScript() {
  delete window.__tfGuildInstalled;
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/index.php');
  new Function(readFileSync('src-tauri/src/scripts/guild.js', 'utf8'))();
  return JSON.parse(decodeURIComponent(window.location.hash.replace('#TFETE1_', '')));
}

describe('разбор профиля', () => {
  it('берёт свой ник из «Информации о персонаже»', () => {
    expect(profile().selfNick).toBe('#Дреднайт');
  });

  it('читает события с их текущим ответом', () => {
    const events = profile().events;
    expect(events.map(e => e.id)).toEqual(['462', '464']);
    expect(events[0]).toMatchObject({
      title: 'ГВГ атака - ГВГ ЧТ',
      when: '15 октября (четверг) в 22:00',
      comment: 'Сбор за 20 минут до начала!',
      response: RESPONSE_YES
    });
    expect(events[1]).toMatchObject({ title: 'Садеман - Садэман', response: '' });
  });

  it('читает пати: название без «(5 чел.)», участники с иконкой класса', () => {
    const parties = profile().parties;
    expect(parties.map(p => p.name)).toEqual(['МТВ - Пати 2', 'ГВГ атака - Пати 1']);
    expect(parties[0].members.map(m => m.nick)).toEqual(['#Дреднайт', '#Ohayo', '#Μακαο', '#тирс', 'Rakohammа']);
    expect(parties[0].members[0]).toEqual({ nick: '#Дреднайт', cls: 'luk', title: 'Лучник' });
    expect(parties[0].members[3]).toEqual({ nick: '#тирс', cls: 'tank', title: 'Оборотень' });
  });

  it('отбрасывает хвост «(ПЛ)» после ника', () => {
    expect(profile().parties[0].members[0].nick).not.toContain('ПЛ');
  });

  it('если таблицы нет, берёт ники из data-users', () => {
    const second = profile().parties[1];
    expect(second.members.map(m => m.nick)).toEqual(['#Дреднайт', '#Сомандор']);
    expect(second.members[0].cls).toBe('');
  });

  it('без колонки пати возвращает пустой список, а не падает', () => {
    const empty = new DOMParser().parseFromString('<div class="user__col"><div class="title">Прочее</div></div>', 'text/html');
    expect(parseParties(empty.querySelector('.user__col'))).toEqual([]);
    expect(parseParties(null)).toEqual([]);
  });

  it('без формы событий возвращает пустой список', () => {
    const empty = new DOMParser().parseFromString('<div class="user__col"></div>', 'text/html');
    expect(parseEvents(empty)).toEqual([]);
  });
});

describe('скрипт окна совпадает с эталоном', () => {
  let window_report;

  beforeEach(() => {
    window_report = runWindowScript();
  });

  it('кладёт в hash те же события, что и core.js', () => {
    expect(window_report.error).toBeNull();
    expect(window_report.data.events).toEqual(profile().events);
  });

  it('кладёт в hash те же пати и тот же свой ник', () => {
    expect(window_report.data.parties).toEqual(profile().parties);
    expect(window_report.data.selfNick).toBe(profile().selfNick);
  });
});

describe('копирование ников', () => {
  const data = profile();

  it('узнаёт свой ник независимо от # и регистра', () => {
    expect(isSelfNick('#дреднайт', '#Дреднайт')).toBe(true);
    expect(isSelfNick('Дреднайт', '#Дреднайт')).toBe(true);
    expect(isSelfNick('#Ohayo', '#Дреднайт')).toBe(false);
    expect(isSelfNick('#Ohayo', '')).toBe(false);
  });

  it('из ников пати выбрасывает свой', () => {
    expect(partyNicks(data.parties[0], data.selfNick)).toEqual(['#Ohayo', '#Μακαο', '#тирс', 'Rakohammа']);
    expect(partyNicks(data.parties[1], data.selfNick)).toEqual(['#Сомандор']);
  });

  it('собирает все ники через пробел, с решёткой — как на сайте', () => {
    expect(allPartyNicks(data)).toEqual(['#Ohayo', '#Μακαο', '#тирс', 'Rakohammа', '#Сомандор']);
    expect(allPartyNicks(data).join(' ')).toBe('#Ohayo #Μακαο #тирс Rakohammа #Сомандор');
  });

  it('повторов между пати не делает, регистр и # не важны', () => {
    const twice = {
      ...data,
      parties: [data.parties[0], { name: 'Ещё', members: [{ nick: 'oHAYO', cls: '', title: '' }] }, data.parties[1], data.parties[0]]
    };
    expect(allPartyNicks(twice)).toEqual(['#Ohayo', '#Μακαο', '#тирс', 'Rakohammа', '#Сомандор']);
  });

  it('без своего ника копирует всех', () => {
    // 5 участников первой пати + 2 второй, но #Дреднайт есть в обеих — повтор схлопывается
    expect(allPartyNicks({ ...data, selfNick: '' })).toEqual([
      '#Дреднайт', '#Ohayo', '#Μακαο', '#тирс', 'Rakohammа', '#Сомандор'
    ]);
  });
});

describe('нормализация кэша', () => {
  it('мусор в state.json не ломает данные', () => {
    const raw = normalizeGuildData({
      events: [{ id: ' 1 ', title: ' X ', response: 'maybe' }, { title: 'без id' }, 'нет объекта'],
      parties: [{ name: 'Основа', members: [{ nick: '#Аня', cls: '../../etc/passwd' }, { cls: 'luk' }] }, { members: [] }],
      selfNick: ' #Дреднайт ',
      syncedAt: -1
    });
    expect(raw.events).toEqual([{ id: '1', title: 'X', when: '', comment: '', response: '' }]);
    expect(raw.parties).toEqual([{ name: 'Основа', members: [{ nick: '#Аня', cls: '', title: '' }] }]);
    expect(raw.selfNick).toBe('#Дреднайт');
    expect(raw.syncedAt).toBeNull();
  });

  it('пустое значение даёт пустую сводку', () => {
    expect(normalizeGuildData(undefined)).toEqual({ events: [], parties: [], selfNick: '', syncedAt: null });
  });
});

describe('список событий', () => {
  const data = { ...profile(), syncedAt: 1 };

  it('ответивший ивент остаётся в данных с нужным ответом', () => {
    const events = normalizeGuildData({ ...data, events: [...data.events, { id: '465', title: 'ГВГ деф', response: RESPONSE_NO }] });
    expect(events.events.map(e => e.id)).toEqual(['462', '464', '465']);
    expect(events.events[2].response).toBe(RESPONSE_NO);
    expect(unansweredEvents(events).map(e => e.id)).toEqual(['464']);
  });

  it('подпись ответа', () => {
    expect(responseText(RESPONSE_YES)).toBe('отмечен');
    expect(responseText(RESPONSE_NO)).toBe('не идёт');
    expect(responseText('')).toBe('без ответа');
  });

  it('сводка называет ивенты и пати, но не состав', () => {
    expect(summaryText(data)).toBe('ивентов 2, отмечен 1, ждёт ответа 1 · пати: МТВ - Пати 2, ГВГ атака - Пати 1');
    expect(summaryText({ ...data, syncedAt: null })).toBe('');
  });
});

describe('разбор даты события', () => {
  const today = '2026-10-13'; // фикстура сделана на середине октября

  it('читает «15 октября (четверг) в 22:00»', () => {
    expect(parseEventWhen('15 октября (четверг) в 22:00', today)).toEqual({ date: '2026-10-15', time: '22:00' });
  });

  it('читает дату без времени', () => {
    expect(parseEventWhen('18 октября (воскресенье)', today)).toEqual({ date: '2026-10-18', time: '' });
  });

  it('берёт год по Москве и переносит прошедшую дату на следующий', () => {
    expect(parseEventWhen('28 декабря (понедельник) в 21:00', '2026-12-20')).toEqual({ date: '2026-12-28', time: '21:00' });
    expect(parseEventWhen('2 января (пятница) в 21:00', '2026-12-28')).toEqual({ date: '2027-01-02', time: '21:00' });
  });

  it('чужая или пустая строка не даёт записи', () => {
    expect(parseEventWhen('', today)).toBeNull();
    expect(parseEventWhen('Скоро', today)).toBeNull();
    expect(parseEventWhen('31 февраля (вторник) в 20:00', today)).toBeNull();
  });
});

describe('запись в календаре', () => {
  const today = '2026-10-13';
  const going = { id: '462', title: 'ГВГ атака - ГВГ ЧТ', when: '15 октября (четверг) в 22:00', response: RESPONSE_YES };

  it('заводит запись на час с id клана', () => {
    expect(plannerEntryFor(going, today)).toMatchObject({
      id: `${CLAN_ENTRY_PREFIX}462`,
      title: 'ГВГ атака - ГВГ ЧТ',
      date: '2026-10-15',
      time: '22:00',
      durationMinutes: 60,
      kind: 'event',
      recurrence: 'none'
    });
  });

  it('«Пойду» — запись есть, «Не пойду» и без ответа — нет', () => {
    const data = {
      events: [
        going,
        { ...going, id: '463', response: RESPONSE_NO },
        { ...going, id: '464', response: '' }
      ]
    };
    expect([...wantedClanEntries(data).keys()]).toEqual([`${CLAN_ENTRY_PREFIX}462`]);
  });
});

describe('сверка календаря с ответами на сайте', () => {
  const today = '2026-10-13';
  const event = (id, response) => ({ id, title: `Ивент ${id}`, when: '15 октября (четверг) в 22:00', response });
  const own = { id: 'p1', title: 'Своё дело', date: '2026-10-20', time: '12:00' };

  it('свои записи не трогает, клановые заводит', () => {
    const { entries, changed } = planClanEntries([own], { events: [event('462', RESPONSE_YES)] }, today);
    expect(changed).toBe(true);
    expect(entries[0]).toBe(own);
    expect(entries[1]).toMatchObject({ id: `${CLAN_ENTRY_PREFIX}462`, date: '2026-10-15', time: '22:00' });
  });

  it('повторная сверка ничего не меняет и не дублирует', () => {
    const first = planClanEntries([own], { events: [event('462', RESPONSE_YES)] });
    const second = planClanEntries(first.entries, { events: [event('462', RESPONSE_YES)] });
    expect(second.changed).toBe(false);
    expect(second.entries).toHaveLength(2);
  });

  it('«Не пойду» убирает запись из календаря', () => {
    const first = planClanEntries([], { events: [event('462', RESPONSE_YES)] });
    const after = planClanEntries(first.entries, { events: [event('462', RESPONSE_NO)] });
    expect(after.changed).toBe(true);
    expect(after.entries).toEqual([]);
  });

  it('переехавшее на сайте событие обновляет дату, но не трогает цвет и статус', () => {
    const first = planClanEntries([], { events: [event('462', RESPONSE_YES)] });
    const entry = { ...first.entries[0], color: 'green', status: 'done' };
    const moved = { events: [{ ...event('462', RESPONSE_YES), when: '16 октября (пятница) в 20:00' }] };
    const after = planClanEntries([entry], moved);
    expect(after.changed).toBe(true);
    expect(after.entries[0]).toMatchObject({ date: '2026-10-16', time: '20:00', color: 'green', status: 'done' });
  });

  it('пустой календарь и пустая сводка не ломаются', () => {
    expect(planClanEntries(undefined, { events: [] }).entries).toEqual([]);
    expect(planClanEntries([], null).changed).toBe(false);
  });

  it('дату парсит по московскому сегодняшнему дню', () => {
    expect(plannerEntryFor(event('462', RESPONSE_YES), today).date).toBe('2026-10-15');
  });
});

describe('расписание обновления', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const at = (iso) => Date.parse(iso);

  it('считает до 00:00 по Москве, а не по времени компьютера', () => {
    // Полночь МСК = 21:00 UTC предыдущего дня
    expect(msToMskMidnight(at('2026-10-14T21:00:00Z'))).toBe(DAY);
    expect(msToMskMidnight(at('2026-10-15T12:00:00Z'))).toBe(9 * 60 * 60 * 1000); // 15:00 МСК
    expect(msToMskMidnight(at('2026-10-15T20:59:59Z'))).toBe(1000); // 23:59:59 МСК
  });

  it('в полночь по Москве ждёт целые сутки, а не ноль', () => {
    expect(msToMskMidnight(at('2026-10-15T21:00:00Z'))).toBe(DAY);
  });

  it('не зависит от перехода на летнее время', () => {
    // Зима (15 декабря) и лето (15 июля) дают одинаковый остаток до полуночи
    const winter = msToMskMidnight(at('2026-12-15T12:00:00Z'));
    const summer = msToMskMidnight(at('2026-07-15T12:00:00Z'));
    expect(winter).toBe(summer);
  });
});

describe('перенос настроек при переименовании eternals → guild', () => {
  // Раздел переименовали, но ключ в сохранённых настройках у людей остался прежним.
  // Без чтения старого ключа у всех, кто уже включал страницу клана, сбросились бы
  // флаг и кэшированная сводка — молча, без ошибки.
  it('берёт настройки из старого ключа eternals', () => {
    const s = normalizeState({ settings: { eternals: { enabled: true, syncedAt: 1700000000000 } } });
    expect(s.settings.guild.enabled).toBe(true);
    expect(s.settings.guild.syncedAt).toBe(1700000000000);
  });

  it('новый ключ важнее старого', () => {
    const s = normalizeState({ settings: {
      guild: { enabled: true }, eternals: { enabled: false }
    } });
    expect(s.settings.guild.enabled).toBe(true);
  });

  it('без обоих ключей — умолчание', () => {
    expect(normalizeState({ settings: {} }).settings.guild.enabled).toBe(false);
  });
});

