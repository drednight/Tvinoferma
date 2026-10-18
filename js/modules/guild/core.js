// js/modules/guild/core.js
// Клановый сайт (скрытая фича): разбор страницы профиля и сводка для экрана «Сегодня».
//
// Модуль без DOM и без Tauri: на вход разметка (уже прогнанная через DOMParser), на выход
// данные. Поэтому он покрыт тестами и работает в браузере и в Node.
//
// Разбор повторяет src-tauri/src/scripts/guild.js — там та же логика, потому что она
// выполняется в окне сайта, где модули приложения недоступны. Расхождение видно на тестах
// по фикстуре tests/fixtures/site-guild-profile.html.
//
// Из страницы берём только две вещи: предстоящие события и «Пати в которых вы состоите».
// Ники, твины и состав клана приложению не нужны.

import { mskDate } from '../../core/msk.js';

/** Отметка на ивенте: значения радио на сайте. */
export const RESPONSE_YES = 'yes';
export const RESPONSE_NO = 'no';
/** Пустой ответ: радио не нажато. */
export const RESPONSE_NONE = '';

/** Префикс id записей клана в календаре: по нему они отличаются от своих записей. */
export const CLAN_ENTRY_PREFIX = 'guild-';
/** На сколько длится отмеченный клановый ивент в календаре. */
export const CLAN_EVENT_MINUTES = 60;
/** Месяцы в родительном падеже — так их пишет сайт («15 октября»). */
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** Сколько дней назад дата ещё считается «этим годом», а не прошлым. */
const YEAR_SLACK_DAYS = 7;

/**
 * @typedef {{ nick: string, cls: string, title: string }} GuildMember
 * @typedef {{ name: string, members: GuildMember[] }} GuildParty
 * @typedef {{ id: string, title: string, when: string, comment: string, response: string }} GuildEvent
 * @typedef {{ events: GuildEvent[], parties: GuildParty[], selfNick: string, syncedAt: number | null }} GuildData
 */

const PARTIES_TITLE = 'Пати в которых вы состоите';
/** Свой ник: поле «Ник» в блоке «Информация о персонаже». */
const SELF_NICK = '#updateUserInfoForm input[name="username"]';
/** Хвост вида «(ПЛ)» после ника в таблице пати — метка сайта, а не часть ника. */
const NICK_SUFFIX = /\s*\([^)]*\)\s*$/;
/** Имя файла иконки класса: `assets/img/classes/luk.png` → `luk`. */
const ICON_STEM = /\/classes\/([a-z0-9_-]+)\.[a-z0-9]+$/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Ключ для сравнения ников: без `#` и регистра. */
const nickKey = (nick) => clean(nick).replace(/^#+/, '').toLowerCase();

/** Имя файла иконки класса из `src`: у сайта `luk.png`, у нас `/assets/icons/classes/luk.webp`. */
function iconStem(src) {
  return clean(src).match(ICON_STEM)?.[1] || '';
}

/** Приводит участника к известной форме; мусор из state.json не должен ломать экран. */
function normalizeMember(m) {
  const nick = clean(m?.nick);
  if (!nick) return null;
  const cls = /^[a-z0-9_-]+$/i.test(String(m?.cls || '').trim()) ? String(m.cls).trim() : '';
  return { nick, cls, title: clean(m?.title) };
}

/**
 * Данные из state.json. Мусор не должен ломать экран «Сегодня», поэтому всё приводится
 * к известной форме: неизвестный ответ на ивент становится «без ответа».
 */
export function normalizeGuildData(raw) {
  const src = raw || {};
  return {
    events: (Array.isArray(src.events) ? src.events : [])
      .map((e) => {
        const response = e?.response === RESPONSE_YES || e?.response === RESPONSE_NO ? e.response : RESPONSE_NONE;
        return { id: clean(e?.id), title: clean(e?.title), when: clean(e?.when), comment: clean(e?.comment), response };
      })
      .filter((e) => e.id),
    parties: (Array.isArray(src.parties) ? src.parties : [])
      .map((p) => ({
        name: clean(p?.name),
        members: (Array.isArray(p?.members) ? p.members : []).map(normalizeMember).filter(Boolean)
      }))
      .filter((p) => p.name),
    selfNick: clean(src.selfNick),
    syncedAt: Number.isFinite(Number(src.syncedAt)) && Number(src.syncedAt) > 0 ? Number(src.syncedAt) : null
  };
}

/** Предстоящие события: у каждого свой data-event-id, текущий ответ — нажатое радио. */
export function parseEvents(document) {
  return [...document.querySelectorAll('.user__event')].map((el) => {
    const form = el.querySelector('form.event-response-form');
    const checked = el.querySelector('input[type="radio"]:checked');
    return {
      id: clean(form?.dataset?.eventId),
      title: clean(el.querySelector('.user__event-title')?.textContent),
      when: clean(el.querySelector('.user__event-date')?.textContent),
      comment: clean(el.querySelector('.user__event-comment')?.textContent),
      response: checked?.value === RESPONSE_YES || checked?.value === RESPONSE_NO ? checked.value : RESPONSE_NONE
    };
  }).filter((e) => e.id);
}

/** Название пати: собственный текст заголовка без «(5 чел.)» в подписи. */
function partyName(col) {
  const title = col.querySelector('.user__party-title');
  if (!title) return '';
  const own = [...title.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
  return clean(own) || clean(title.textContent);
}

/**
 * Участники пати: строки таблицы, где ник — ссылка `.table-username` с иконкой класса.
 * Если таблицы нет, ники берём из `data-users` у блока пати — без иконок, но лучше чем ничего.
 */
function partyMembers(col) {
  const members = [];
  for (const link of col.querySelectorAll('a.table-username')) {
    const nick = clean(link.textContent).replace(NICK_SUFFIX, '');
    if (!nick) continue;
    const img = link.querySelector('img');
    members.push({ nick, cls: iconStem(img?.getAttribute('src')), title: clean(img?.getAttribute('alt')) });
  }
  if (members.length) return members;
  const raw = clean(col.getAttribute?.('data-users'));
  return raw ? raw.split(/\s+/).map((nick) => ({ nick, cls: '', title: '' })) : [];
}

/**
 * Пати из колонки «Пати в которых вы состоите».
 *
 * Вёрстка сайта: `.user__col` → `.user__party` → `.user__party-col[data-users]` →
 * `.user__party-title` и таблица с `a.table-username` на каждого участника.
 * Всё, что не нашлось, остаётся пустым: сайт мог поменять разметку, и это не должно ронять
 * приложение.
 * @param {Element} column
 * @returns {GuildParty[]}
 */
export function parseParties(column) {
  if (!column) return [];
  const parties = [];
  for (const col of column.querySelectorAll('.user__party-col')) {
    const name = partyName(col);
    if (!name) continue;
    const members = partyMembers(col);
    if (!members.length && /нет активных пати/i.test(name)) continue;
    parties.push({ name, members });
  }
  return parties;
}

/**
 * Разбор страницы профиля.
 * @param {Document} document
 * @returns {GuildData}
 */
export function parseProfileDocument(document) {
  const partiesColumn = [...document.querySelectorAll('.user__col')]
    .find((el) => clean(el.querySelector('.title')?.textContent) === PARTIES_TITLE);
  return {
    events: parseEvents(document),
    parties: parseParties(partiesColumn),
    selfNick: clean(document.querySelector(SELF_NICK)?.value),
    syncedAt: null
  };
}

/** Ивенты, на которые человек ещё не ответил: их и показываем в первую очередь. */
export function unansweredEvents(data) {
  return (data?.events || []).filter((e) => e.response === RESPONSE_NONE);
}

/** Отметка одним словом — для подписи в интерфейсе. */
export function responseText(response) {
  if (response === RESPONSE_YES) return 'отмечен';
  if (response === RESPONSE_NO) return 'не идёт';
  return 'без ответа';
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
const isoOf = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;

/**
 * Дата и время события из строки сайта: «15 октября (четверг) в 22:00».
 *
 * Года на сайте нет: берём московский текущий, а если дата ушла дальше недели в прошлое —
 * переносим на следующий год, потому что сайт показывает только предстоящие события.
 * Время может отсутствовать — тогда запись попадёт в календарь «без конкретного времени».
 * @param {string} when
 * @param {string} today «ГГГГ-ММ-ДД» по Москве
 * @returns {{ date: string, time: string }|null}
 */
export function parseEventWhen(when, today = mskDate()) {
  const text = clean(when).toLowerCase();
  const head = text.match(/(\d{1,2})\s*([а-яё]+)/);
  const month = head ? MONTHS.indexOf(head[2]) : -1;
  if (!head || month < 0) return null;

  const year = Number(today.slice(0, 4));
  const day = Number(head[1]);
  // Дата должна существовать: «31 февраля» сайту нечего показать, это не наше дело
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;

  const thisYear = isoOf(year, month + 1, day);
  const date = isoDay(thisYear) < isoDay(today) - YEAR_SLACK_DAYS
    ? isoOf(year + 1, month + 1, day)
    : thisYear;

  const clock = text.match(/(\d{1,2}):(\d{2})/);
  const time = clock ? `${pad2(Number(clock[1]))}:${clock[2]}` : '';
  return { date, time };
}

/** id записи кланового события в календаре. */
export function clanEntryId(eventId) {
  return `${CLAN_ENTRY_PREFIX}${eventId}`;
}

/** Запись календаря для отмеченного кланового события: на час, цветом как свои записи. */
export function plannerEntryFor(event, today = mskDate()) {
  const when = parseEventWhen(event?.when, today);
  if (!when) return null;
  return {
    id: clanEntryId(event.id),
    title: clean(event.title) || 'Клановый ивент',
    date: when.date,
    time: when.time,
    durationMinutes: CLAN_EVENT_MINUTES,
    kind: 'event',
    color: 'blue',
    recurrence: 'none'
  };
}

/** Запись ли пришла с кланового сайта. */
export function isClanEntry(entry) {
  return String(entry?.id || '').startsWith(CLAN_ENTRY_PREFIX);
}

/**
 * Какие записи клана должны быть в календаре: у каждого события с ответом «Пойду» — своя
 * запись на час. «Не пойду» и без ответа записи не дают.
 * @param {GuildData} data
 * @returns {Map<string, object>}
 */
export function wantedClanEntries(data) {
  const wanted = new Map();
  for (const event of data?.events || []) {
    if (event.response !== RESPONSE_YES) continue;
    const entry = plannerEntryFor(event);
    if (entry) wanted.set(entry.id, entry);
  }
  return wanted;
}

/** Ники одной пати для копирования: свой ник выбрасываем — приглашать себя незачем. */
export function partyNicks(party, selfNick) {
  return (party?.members || []).map((m) => m.nick).filter((nick) => nick && !isSelfNick(nick, selfNick));
}

/** Тот ли это персонаж, что прописан на сайте в «Информации о персонаже». */
export function isSelfNick(nick, selfNick) {
  const self = nickKey(selfNick || '');
  return !!self && !!nick && nickKey(nick) === self;
}

/**
 * Все ники всех пати одной строкой через пробел, без запятых.
 * Ники оставлены такими же, как на сайте, — с ведущей `#` и в его порядке: ровно то,
 * что отдаёт кнопка «Копировать» на самом сайте. Повторы между пати схлопываются.
 */
export function allPartyNicks(data) {
  const seen = new Set();
  const out = [];
  for (const party of data?.parties || []) {
    for (const nick of partyNicks(party, data?.selfNick)) {
      const key = nickKey(nick);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(nick);
    }
  }
  return out;
}

/**
 * Строка сводки для экрана «Сегодня»: «ивентов 3, отмечен 2, ждёт ответа 1 · пати: Основа».
 * Пустая строка — сводки ещё не было.
 */
export function summaryText(data) {
  if (!data?.syncedAt) return '';
  const total = data.events.length;
  const done = data.events.filter((e) => e.response !== RESPONSE_NONE).length;
  const waiting = unansweredEvents(data).length;
  const parties = data.parties.length ? data.parties.map((p) => p.name).join(', ') : 'нет';
  const events = total ? `ивентов ${total}, отмечен ${done}${waiting ? `, ждёт ответа ${waiting}` : ''}` : 'ивентов нет';
  return `${events} · пати: ${parties}`;
}
