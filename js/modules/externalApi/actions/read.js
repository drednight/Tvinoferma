// @ts-check
// js/modules/externalApi/actions/read.js
// Чтение данных для внешнего API: ответы собираются здесь и только здесь.
//
// Правило безопасности: в ответ попадает белый список полей. Контакты, пароли,
// токены GameCenter, куки, `launch.*` и облачные ключи не попадают в ответ никогда —
// даже если их случайно добавят в объект персонажа позже.
//
// Функции не читают DOM и не зовут Tauri сами: всё, что нужно, приходит аргументами
// (state, список окон). Поэтому их можно проверить тестами без приложения.

import { DEFAULT_STATS } from '../../characters/stateManager.js';

/** Поля персонажа, которые видит внешняя программа. */
const CHARACTER_FIELDS = [
  'id',
  'nick',
  'class',
  'level',
  'favorite',
  'sky',
  'partyIds',
  'mainPartyId',
  'stats',
  'dungeonPasses',
  'ancientCoins',
  'isLoggedIn',
  'lastLoginCheck',
  'updatedAt',
  'notes',
  'tags',
  'coinHistory',
  'createdAt'
];

/** Звёздное небо: только имя и уровень. */
function publicSky(sky) {
  if (!sky || typeof sky !== 'object') return { name: null, level: null };
  return {
    name: sky.name ?? null,
    level: Number.isFinite(Number(sky.level)) ? Number(sky.level) : null
  };
}

/** Статы и проходки: числа, ничего лишнего. */
function publicStats(stats) {
  if (!stats || typeof stats !== 'object') return {};
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value) || 0]));
}

function publicPasses(passes) {
  if (!passes || typeof passes !== 'object') return {};
  return Object.fromEntries(Object.entries(passes).map(([key, value]) => [key, Number(value) || 0]));
}

/**
 * Окно игры для строки персонажа. `rows` — результат `windowRows` (по pid и charId),
 * `byCharId` — заранее собранная карта, чтобы не искать в списке на каждого персонажа.
 */
function runningOf(charId, byCharId) {
  const row = byCharId.get(String(charId));
  if (!row) return null;
  return { pid: row.pid, title: row.title || '' };
}

/** История Древних монет: дата и число, без внутренних полей парсера. */
function coinHistoryOf(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(entry => entry && typeof entry === 'object')
    .slice(0, 20)
    .map(entry => ({
      at: entry.at ?? null,
      coins: Number(entry.coins) || 0
    }));
}

/** Карта `charId → строка окна` по списку строк `windowRows`. */
export function runningByCharId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row && row.known && row.charId) map.set(String(row.charId), row);
  }
  return map;
}

/**
 * Один персонаж для ответа API.
 * @param {any} char персонаж из state
 * @param {{ running?: Map<string, any> | null }} [options] окна игры (Map по charId)
 */
export function publicCharacter(char, { running = null } = {}) {
  if (!char || typeof char.id !== 'string') return null;
  const out = {};
  for (const field of CHARACTER_FIELDS) {
    if (field === 'sky') out.sky = publicSky(char.sky);
    else if (field === 'stats') out.stats = publicStats(char.stats);
    else if (field === 'dungeonPasses') out.dungeonPasses = publicPasses(char.dungeonPasses);
    else if (field === 'partyIds') out.partyIds = Array.isArray(char.partyIds) ? [...char.partyIds] : [];
    else if (field === 'favorite') out.favorite = char.favorite === true;
    else if (field === 'isLoggedIn') out.isLoggedIn = char.isLoggedIn === true;
    else if (field === 'level') out.level = Number(char.level) || 0;
    else if (field === 'ancientCoins') out.ancientCoins = Number(char.ancientCoins) || 0;
    else if (field === 'mainPartyId') out.mainPartyId = char.mainPartyId ?? null;
    else if (field === 'notes') out.notes = String(char.notes || '');
    else if (field === 'tags') out.tags = Array.isArray(char.tags) ? char.tags.map(String) : [];
    else if (field === 'coinHistory') out.coinHistory = coinHistoryOf(char.coinHistory);
    else out[field] = char[field] ?? null;
  }
  out.running = running ? runningOf(char.id, running) : null;
  return out;
}

/**
 * Что НЕ попадает в `GET /characters` по умолчанию.
 *
 * Список запрашивают, чтобы увидеть, кто есть на ферме и до чего дожил: два десятка
 * статов, заметки и история монет на каждого персонажа делают ответ втрое длиннее и
 * в списке почти никогда не нужны. Полную карточку просят явно — `?full=true`,
 * адресным маршрутом (`GET /characters/{id}`, `/stats`) или списком полей
 * (`?fields=stats.hp`). `fields` перекрывает это правило: если статы назвали — они придут.
 */
export const LIST_OMITTED = ['stats', 'notes', 'coinHistory'];

/** Проходки — свои ключи; статы перечислены в `DEFAULT_STATS`. */
export const PASS_FIELDS = ['weapon', 'armor', 'relic'];

/**
 * Поля персонажа, которые можно спросить в `fields`. Вложенные — через точку:
 * `stats.hp`, `dungeonPasses.weapon`. `running` — окно игры (может быть null).
 *
 * Статы и проходки перечислены по отдельности и берутся из тех же списков, что
 * адресные маршруты (`DEFAULT_STATS`, `PASS_FIELDS`): новый стат появляется в
 * API сам, без правки второй таблицы. Первым идёт `id` — по нему строки
 * различимы, поэтому он добавляется в ответ всегда.
 */
export const CHARACTER_FIELD_NAMES = [
  'id',
  'nick',
  'class',
  'level',
  'favorite',
  'sky',
  'sky.name',
  'sky.level',
  'partyIds',
  'mainPartyId',
  'stats',
  ...Object.keys(DEFAULT_STATS).map(key => `stats.${key}`),
  'dungeonPasses',
  ...PASS_FIELDS.map(key => `dungeonPasses.${key}`),
  'ancientCoins',
  'isLoggedIn',
  'lastLoginCheck',
  'updatedAt',
  'notes',
  'tags',
  'coinHistory',
  'createdAt',
  'running',
  'running.pid',
  'running.title'
];

/**
 * Краткий список (`GET /characters` по умолчанию): списка персонажей достаточно,
 * чтобы выбрать, о ком дальше идёт речь. Всё остальное просят явно — `detail`,
 * `fields` или `/characters.stats` (числа у всех разом).
 */
export const BRIEF_FIELDS = ['id', 'nick'];

/** Что не вошло в краткий список — называется в ответе, чтобы «почему пусто» не было загадкой. */
export const BRIEF_OMITTED = CHARACTER_FIELD_NAMES.filter(name => !name.includes('.') && !BRIEF_FIELDS.includes(name));

/** Русские подписи для отчётов и страницы (`fields=hp` → `{ "HP": 120 }`). */
const RUSSIAN_FIELD_LABELS = {
  id: 'id',
  nick: 'Ник',
  class: 'Класс',
  level: 'Уровень',
  favorite: 'Избранный',
  sky: 'Небо',
  'sky.name': 'Небо',
  'sky.level': 'Уровень неба',
  partyIds: 'Пати',
  mainPartyId: 'Основная пати',
  ancientCoins: 'Древние монеты',
  isLoggedIn: 'Вход проверен',
  lastLoginCheck: 'Проверка входа',
  updatedAt: 'Обновлён',
  notes: 'Заметки',
  tags: 'Теги',
  coinHistory: 'История монет',
  createdAt: 'Создан',
  running: 'Окно игры',
  'running.pid': 'PID окна',
  'running.title': 'Заголовок окна'
};

const STAT_LABELS = {
  endurance: 'Выносливость',
  intelligence: 'Интеллект',
  strength: 'Сила',
  agility: 'Ловкость',
  hp: 'HP',
  mp: 'MP',
  levelBonus: 'Бонус уровня',
  physAttack: 'Физ. атака',
  physDefense: 'Физ. защита',
  magAttack: 'Маг. атака',
  magDefense: 'Маг. защита',
  critChance: 'Крит, %',
  critDamage: 'Крит. урон',
  atkSpeed: 'Скорость атаки',
  evasion: 'Уклонение',
  accuracy: 'Меткость',
  pa: 'PA',
  pz: 'PZ',
  morale: 'Дух',
  pvePa: 'PvE PA',
  pvePz: 'PvE PZ',
  physPenetration: 'Физ. пробивание',
  magPenetration: 'Маг. пробивание'
};

/** Является ли поле вложенным (`stats.hp`). */
function isNestedField(field) {
  return String(field).includes('.');
}

/**
 * Значение поля по имени: `stats.hp`, `dungeonPasses.weapon`, `sky.name`.
 * Отсутствующее значение — `null`, а не `undefined`: в JSON это различимо.
 */
function fieldValue(row, field) {
  let current = row;
  for (const part of String(field).split('.')) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current === undefined ? null : current;
}

/**
 * Русская подпись поля — настоящая, а не транслитерация:
 * `stats.hp` → «HP», `dungeonPasses.weapon` → «Проходки: оружие».
 * @param {string} field
 */
export function fieldLabel(field) {
  const text = String(field);
  if (RUSSIAN_FIELD_LABELS[text]) return RUSSIAN_FIELD_LABELS[text];
  const [head, tail] = text.split('.');
  if (head === 'stats' && tail) return STAT_LABELS[tail] || `Стат: ${tail}`;
  if (head === 'dungeonPasses' && tail) return `Проходки: ${PASS_RU[tail] || tail}`;
  if (head === 'running' && tail) return RUSSIAN_FIELD_LABELS[`running.${tail}`] || `Окно: ${tail}`;
  return text;
}

/** Русские имена проходок строчными: «оружие», «доспех», «реликвия». */
const PASS_RU = { weapon: 'оружие', armor: 'доспех', relic: 'реликвия' };

/**
 * Строка персонажа только из запрошенных полей. `flat: true` — плоские ключи,
 * совпадающие с именами полей (`stats.hp`), удобно для pandas и Excel:
 * `{"id": "Mag_1", "stats.hp": 120}`. `flat: false` — вложенная форма
 * `{"id": "Mag_1", "stats": {"hp": 120}}`, как в полной карточке.
 */
export function pickCharacterFields(row, fields, { flat = true } = {}) {
  // `id` остаётся всегда: без него строки списка неразличимы, а остальные
  // запросы ссылаются на персонажа именно по нему.
  const requested = (Array.isArray(fields) ? fields : []).filter(field => field !== 'id');
  const list = requested.length ? ['id', ...requested] : CHARACTER_FIELD_NAMES;
  const out = {};
  for (const field of list) {
    const value = fieldValue(row, field);
    if (flat || !isNestedField(field)) {
      // `id` в плоском виде остаётся `id`: по нему склеиваются списки.
      out[field] = value;
      continue;
    }
    // `stats.hp` во вложенном виде: контейнер создаётся заранее, иначе цикл
    // собирал бы только `out.stats` без `hp` (порядок полей произвольный).
    const [head, tail] = field.split('.');
    if (!out[head] || typeof out[head] !== 'object') out[head] = {};
    if (tail !== undefined) out[head][tail] = value;
  }
  return out;
}

/**
 * Русская версия строки: `{"id": "Mag_1", "Класс": "Маг", "Проходки: оружие": 3}`.
 *
 * `values` — уже выбранные значения по полям (`{ "class": "Маг", … }`): подпись
 * ключа меняется, а значение остаётся тем же. `row` нужен, когда `values` нет.
 * `id` не переводим — на него ссылаются остальные запросы.
 */
export function localizeRow(row, fields, values = null) {
  const out = {};
  let list = Array.isArray(fields) && fields.length ? fields : null;
  const source = values || row || {};
  if (!list) {
    // Полная карточка: перечисляем поля так же, как они лежат в ответе. Вложенные
    // объекты, которые не подписаны по отдельности (`stats`, `dungeonPasses`,
    // `sky`), разворачиваем в точечные пути — иначе подпись им не находится.
    list = [];
    for (const key of Object.keys(source)) {
      const value = source[key];
      // Объект без своей подписи — это контейнер (`stats`, `dungeonPasses`, `sky`):
      // подписываем его содержимое. Пустой или null — оставляем одной строкой.
      const container = value && typeof value === 'object' && !Array.isArray(value) && !RUSSIAN_FIELD_LABELS[key];
      if (container && Object.keys(value).length) {
        for (const inner of Object.keys(value)) list.push(`${key}.${inner}`);
      } else list.push(key);
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'id') && !list.includes('id')) {
    list = ['id', ...list];
  }
  for (const field of list) {
    const key = field === 'id' ? 'id' : fieldLabel(field);
    if (Object.prototype.hasOwnProperty.call(source, field)) out[key] = source[field];
    else out[key] = fieldValue(source, field);
  }
  return out;
}

/** Неизвестные поля из запроса — чтобы ответить понятной ошибкой, а не молчанием. */
export function unknownFields(fields) {
  return (fields || []).filter(field => !CHARACTER_FIELD_NAMES.includes(String(field).trim()));
}

/**
 * Параметры списка персонажей:
 *
 * - `fields` — какие поля вернуть (через запятую, вложенные — через точку);
 * - `party` — id или название пати;
 * - `lang` — `en` (по умолчанию) или `ru`: подписи полей по-русски;
 * - `flat` — `true`/`false`: плоские ключи (`stats.hp`) или вложенные (`stats.hp` внутри `stats`);
 * - `sort` — `id` (по умолчанию), `nick`, `level` или `none` (порядок хранения);
 * - `order` — `asc` (по умолчанию) или `desc` для `sort`.
 *
 * @param {{ parties?: any[] }} state
 * @param {string} query строка запроса после `?` (уже без `?`)
 */
export function characterFilter(state, query) {
  const params = new URLSearchParams(query || '');
  const party = String(params.get('party') || '').trim();
  const fields = String(params.get('fields') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const lang =
    String(params.get('lang') || 'en')
      .trim()
      .toLowerCase() === 'ru'
      ? 'ru'
      : 'en';
  const flatParam = String(params.get('flat') || '')
    .trim()
    .toLowerCase();
  const flat = flatParam === '' ? true : !['false', '0', 'nested', 'no'].includes(flatParam);
  const sortParam = String(params.get('sort') || 'id')
    .trim()
    .toLowerCase();
  const sort = ['id', 'nick', 'level', 'none'].includes(sortParam) ? sortParam : 'id';
  // `full` — «верни полные карточки»: только явное «да», мусор трактуем как «нет».
  const full = ['1', 'true', 'yes', 'да', 'full'].includes(
    String(params.get('full') || '')
      .trim()
      .toLowerCase()
  );
  // `detail` — насколько подробно: `brief` (id и ник — по умолчанию), `list` (карточки
  // без статов, заметок и истории монет), `full` (карточка целиком). `?full=true` —
  // прежний способ сказать `full`, он работает и сейчас; неизвестное значение — не
  // ошибка, а «как не просили» (краткий список), чтобы `?detail=` из чужого скрипта
  // не обрывал выгрузку.
  const detailParam = String(params.get('detail') || '')
    .trim()
    .toLowerCase();
  const detail = ['brief', 'list', 'full'].includes(detailParam) ? detailParam : '';
  const order =
    String(params.get('order') || 'asc')
      .trim()
      .toLowerCase() === 'desc'
      ? 'desc'
      : 'asc';
  return { party, fields, lang, flat, sort, order, full, detail };
}

/** Сравнение значений для `sort`: числа — как числа, строки — без регистра. */
function compareValues(a, b, order) {
  let result;
  if (typeof a === 'number' && typeof b === 'number') result = a - b;
  else result = String(a ?? '').localeCompare(String(b ?? ''), 'ru', { numeric: true, sensitivity: 'base' });
  return order === 'desc' ? -result : result;
}

/**
 * Отбор и порядок строк списка: одно и то же для `GET /characters` и
 * `GET /characters.stats`. Копировать этот отбор во второй маршрут значило бы
 * развести «список» и «цифры списка»: они обязаны совпадать по составу и порядку.
 *
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {string} query
 * @param {{ running?: Map<string, any> | null }} [options]
 */
function listCharacterRows(state, query, options = {}) {
  const filter = characterFilter(state, query);
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  let list = characters;
  if (filter.party) {
    // Пати ищется по id или названию (без регистра), как в меню трея.
    const parties = Array.isArray(state?.parties) ? state.parties : [];
    const found = parties.find(
      p =>
        String(p?.id) === filter.party ||
        String(p?.name || '')
          .trim()
          .toLowerCase() === filter.party.trim().toLowerCase()
    );
    const partyId = found ? String(found.id) : filter.party;
    list = characters.filter(c => Array.isArray(c.partyIds) && c.partyIds.map(String).includes(partyId));
  }
  const running = options.running || null;
  const rows = list.map(char => publicCharacter(char, { running })).filter(Boolean);
  if (filter.sort !== 'none') {
    const key = filter.sort === 'id' ? row => String(row.id) : row => row[filter.sort];
    rows.sort((a, b) => compareValues(key(a), key(b), filter.order));
  }
  return { filter, rows };
}

/**
 * Список персонажей для ответа API.
 *
 * По умолчанию — **краткий** список: все персонажи, отсортированные по `id`, по каждой
 * строке `id` и `nick`. Это то, за чем идут в «список всех»: опознать, выбрать,
 * сослаться. Полный ответ карточкой — дорогое удовольствие (в 28 персонажей он упирался
 * в несколько килобайт на ровном месте), поэтому он прячется за явной просьбой:
 *
 * - `?detail=list` — карточки, но без тяжёлых полей (статы, заметки, история монет);
 * - `?detail=full` (или `?full=true`) — карточки целиком;
 * - `?fields=id,nick,level,stats.hp` — только названные поля, они перекрывают `detail`;
 * - `GET /characters.stats` — статы и проходки у всех одной таблицей, без карточек.
 *
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {string} query
 * @param {{ running?: Map<string, any> | null, forceFull?: boolean }} [options]
 *   `forceFull` — игнорирует `?full` и отдаёт карточки целиком: адресным маршрутам
 *   и выгрузке полнота нужна по смыслу, а `?full` — опция списка
 */
export function publicCharacters(state, query = '', options = {}) {
  const { filter, rows } = listCharacterRows(state, query, options);
  const { fields, lang, flat, full, detail } = filter;
  // Уровень подробности: явные `fields` важнее всего (человек назвал поля — его не
  // касается, что по умолчанию экономно), потом `detail`, потом старый `full=true`,
  // и только потом `forceFull` адресных маршрутов. По умолчанию — `brief`.
  const level = fields.length ? 'picked' : detail || (full ? 'full' : options.forceFull ? 'full' : 'brief');
  const base =
    level === 'brief'
      ? rows.map(row => {
          const out = {};
          for (const field of BRIEF_FIELDS) out[field] = row[field] ?? null;
          return out;
        })
      : level === 'list'
        ? rows.map(withoutListHeavy)
        : rows;
  const picked = fields.length ? base.map(row => pickCharacterFields(row, fields, { flat })) : base;
  // Подписи строятся по тем полям, что реально вернулись: в плоской строке ключи
  // уже собраны (`dungeonPasses.weapon` одним ключом), поэтому список берём из
  // значений и подписываем его, а не восстанавливаем из адреса запроса.
  const localized = lang === 'ru' ? picked.map(row => localizeRow(null, null, row)) : picked;
  return {
    characters: localized,
    count: localized.length,
    fields: fields.length ? fields : null,
    // Честный ответ на вопрос «почему тут нет статов»: режим списка виден, а не молчится.
    detail: level,
    ...(level === 'brief'
      ? {
          omitted: [...BRIEF_OMITTED],
          // Подсказка в ответе — вместо того же вопроса в чате: здесь названы все
          // способы получить больше, и адрес с числами для всех сразу.
          detailHint:
            'detail=list — карточки без статов, detail=full — целиком; fields=id,nick,level — что нужно; /characters.stats — статы и проходки у всех'
        }
      : level === 'list'
        ? { omitted: [...LIST_OMITTED], fullHint: '?full=true или ?detail=full — вернуть карточки целиком' }
        : {})
  };
}

/**
 * `GET /characters.stats` — числа у всех персонажей одной таблицей: уровень, небо,
 * статы, проходки и монеты. Отдельная команда нужна, потому что краткий список
 * этих полей не несёт, а `?detail=full` ради одной колонки тянет заметки, историю
 * монет и прочее — то, чего в таблице всё равно не будет.
 *
 * `totals` — суммы по проходкам на весь список: «сколько у фермы оружия» без
 * подсчётов на своей стороне.
 *
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {string} query `party`, `sort`, `order`, `lang` — как у `GET /characters`
 */
export function publicCharacterStats(state, query = '') {
  const { filter, rows } = listCharacterRows(state, query);
  const columns = ['id', 'nick', 'class', 'level', 'sky', 'stats', 'dungeonPasses', 'ancientCoins'];
  const list = rows.map(row => {
    const out = {};
    for (const field of columns) out[field] = row[field] ?? null;
    return out;
  });
  const totals = { weapon: 0, armor: 0, relic: 0, sum: 0 };
  for (const row of list) {
    const passes = row.dungeonPasses || {};
    for (const pass of PASS_FIELDS) {
      const value = Number(passes[pass]) || 0;
      totals[pass] += value;
      totals.sum += value;
    }
  }
  return {
    characters: filter.lang === 'ru' ? list.map(row => localizeRow(null, null, row)) : list,
    count: list.length,
    detail: 'stats',
    fields: null,
    totals
  };
}

/** Строка списка без тяжёлых полей: копия, а не мутация — `rows` отдают и другие. */
function withoutListHeavy(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!LIST_OMITTED.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Пати с участниками в порядке запуска (перетаскивание в карточке пати).
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {(chars: any[], partyId: string) => any[]} ordered участники в порядке пати
 */
export function publicParties(state, ordered) {
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const parties = Array.isArray(state?.parties) ? state.parties : [];
  return {
    parties: parties.map(party => {
      const members = ordered
        ? ordered(characters, String(party.id))
        : characters.filter(c => (c.partyIds || []).includes(party.id));
      return {
        id: party.id,
        name: party.name || '',
        color: party.color ?? null,
        members: members.map((member, index) => ({
          id: member.id,
          nick: member.nick || '',
          order: index + 1
        }))
      };
    })
  };
}

/**
 * Запущенные окна игры в том же виде, что `GET /windows`.
 * @param {any[]} rows строки `windowRows` (pid, title, known, charId, nick, elevated…)
 * @param {string} updatedAt ISO-время чтения списка
 */
export function publicWindows(rows, updatedAt = new Date().toISOString()) {
  const windows = (rows || []).map(row => ({
    pid: Number(row.pid) || 0,
    title: String(row.title || ''),
    charId: row.known && row.charId ? String(row.charId) : null,
    nick: row.known && row.charId ? String(row.nick || '') : null,
    class: row.known && row.charId ? String(row.cls || '') : null,
    elevated: row.elevated ?? null,
    startedAt: row.startedAt ?? null,
    ownershipSource: row.ownershipSource ?? 'unknown'
  }));
  return { updatedAt, windows };
}

/* ------------------------------------------------------------------ */
/*  Марафоны                                                          */
/* ------------------------------------------------------------------ */

/** Одно задание марафона: то, что нужно, чтобы показать прогресс и награды. */
function publicTask(task) {
  return {
    id: String(task.id),
    title: String(task.title || ''),
    siteTitle: task.siteTitle ?? null,
    description: String(task.description || ''),
    targetChecks: Number(task.targetChecks) || 0,
    schedule: {
      mode: task.schedule?.mode || 'everyDay',
      dates: Array.isArray(task.schedule?.dates) ? task.schedule.dates.map(String) : [],
      weekStartDay: Number(task.schedule?.weekStartDay ?? 1)
    },
    rewards: (task.rewards || []).map(reward => ({
      threshold: Number(reward.threshold) || 0,
      rewardText: String(reward.rewardText || ''),
      rewardCoins: Number(reward.rewardCoins) || 0
    }))
  };
}

/**
 * Прогресс одного персонажа по одному заданию: `progress[charId][taskId]` в state.
 * Ручные отметки и поправку берём как есть — их видит и интерфейс.
 */
function publicCellProgress(cell) {
  if (!cell || typeof cell !== 'object') return { marks: [], adjust: 0, site: null };
  return {
    marks: Array.isArray(cell.marks) ? cell.marks.map(String) : [],
    adjust: Number(cell.adjust) || 0,
    site: cell.site === null || cell.site === undefined ? null : Number(cell.site) || 0
  };
}

/**
 * Марафон в ответе API. `totals` считает `marathonTotals` из модели: если он не
 * передан, вместо цифр будет `null` — лучше пусто, чем вторая правда о прогрессе.
 */
export function publicMarathon(marathon, totals = null) {
  const progress = {};
  for (const [charId, tasks] of Object.entries(marathon.progress || {})) {
    progress[charId] = {};
    for (const [taskId, cell] of Object.entries(tasks || {})) {
      progress[charId][taskId] = publicCellProgress(cell);
    }
  }
  return {
    id: String(marathon.id),
    kind: marathon.kind === 'series' ? 'series' : 'single',
    seriesId: marathon.seriesId ?? null,
    title: String(marathon.title || ''),
    description: String(marathon.description || ''),
    startDate: marathon.startDate ?? null,
    endDate: marathon.endDate ?? null,
    status: marathon.status === 'completed' ? 'completed' : 'active',
    source: {
      type: marathon.source?.type || 'manual',
      url: marathon.source?.url ?? null,
      siteName: marathon.source?.siteName ?? null
    },
    participantIds: Array.isArray(marathon.participantIds) ? marathon.participantIds.map(String) : [],
    assignments: marathon.assignments ? JSON.parse(JSON.stringify(marathon.assignments)) : {},
    tasks: (marathon.tasks || []).map(publicTask),
    bonuses: (marathon.bonuses || []).map(bonus => ({
      needTasks: Number(bonus.needTasks) || 0,
      text: String(bonus.text || '')
    })),
    awards: (marathon.awards || []).map(award => ({
      characterId: award.characterId ?? null,
      charNick: String(award.charNick || ''),
      taskId: award.taskId ?? null,
      taskTitle: String(award.taskTitle || ''),
      rewardText: String(award.rewardText || ''),
      coins: Number(award.coins) || 0
    })),
    progress,
    totals,
    createdAt: marathon.createdAt ?? null,
    updatedAt: marathon.updatedAt ?? null,
    completedAt: marathon.completedAt ?? null
  };
}

/**
 * Итоги марафона: `null`, если функция не передана или упала на битых данных.
 * Один битый марафон не должен ронять список из пятидесяти.
 */
function safeTotals(totalsOf, marathon) {
  if (typeof totalsOf !== 'function') return null;
  try {
    return totalsOf(marathon);
  } catch {
    return null;
  }
}

/**
 * Список марафонов. `totalsOf(marathon)` — обычно `marathonTotals` из
 * `modules/marathons/model.js`: API не считает прогресс сам.
 * Папки-серии (`kind: 'series'`) отдаются без заданий: у них свой набор `childIds`.
 */
export function publicMarathons(state, totalsOf = null) {
  const marathons = Array.isArray(state?.marathons) ? state.marathons : [];
  return {
    marathons: marathons.map(marathon => {
      if (marathon.kind === 'series') {
        return {
          id: String(marathon.id),
          kind: 'series',
          title: String(marathon.title || ''),
          description: String(marathon.description || ''),
          childIds: Array.isArray(marathon.childIds) ? marathon.childIds.map(String) : [],
          createdAt: marathon.createdAt ?? null,
          updatedAt: marathon.updatedAt ?? null
        };
      }
      return publicMarathon(marathon, safeTotals(totalsOf, marathon));
    })
  };
}

/** Марафон по id: `{ marathon }` или `null`, если такого нет. */
export function publicMarathonById(state, id, totalsOf = null) {
  const all = Array.isArray(state?.marathons) ? state.marathons : [];
  const marathon = all.find(item => String(item.id) === String(id));
  if (!marathon) return null;
  if (marathon.kind === 'series') {
    return {
      id: String(marathon.id),
      kind: 'series',
      title: String(marathon.title || ''),
      description: String(marathon.description || ''),
      childIds: Array.isArray(marathon.childIds) ? marathon.childIds.map(String) : [],
      createdAt: marathon.createdAt ?? null,
      updatedAt: marathon.updatedAt ?? null
    };
  }
  return publicMarathon(marathon, safeTotals(totalsOf, marathon));
}

/** Пати и персонажи, участвующие в марафоне — удобно для отчётов. */
export function marathonParticipants(state, marathonId) {
  const marathon = (state?.marathons || []).find(item => String(item.id) === String(marathonId));
  if (!marathon) return null;
  const ids = new Set((marathon.participantIds || []).map(String));
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const parties = Array.isArray(state?.parties) ? state.parties : [];
  const members = characters.filter(char => ids.has(String(char.id)));
  const partyIds = new Set();
  for (const char of members) for (const partyId of char.partyIds || []) partyIds.add(String(partyId));
  return {
    marathonId: String(marathon.id),
    characters: members.map(char => ({ id: String(char.id), nick: String(char.nick || '') })),
    parties: parties
      .filter(party => partyIds.has(String(party.id)))
      .map(party => ({ id: String(party.id), name: String(party.name || '') }))
  };
}

/* ------------------------------------------------------------------ */
/*  Планировщик и учёт                                                */
/* ------------------------------------------------------------------ */

/** Запись планировщика: только то, что видно в календаре. */
export function publicPlanner(state) {
  const entries = Array.isArray(state?.plannerEntries) ? state.plannerEntries : [];
  return {
    entries: entries.map(entry => ({
      id: String(entry.id),
      title: String(entry.title || ''),
      date: entry.date ?? null,
      time: entry.time ?? '',
      durationMinutes: Number(entry.durationMinutes) || 0,
      kind: entry.kind ?? 'task',
      priority: entry.priority ?? 'normal',
      recurrence: entry.recurrence ?? 'none',
      status: entry.status ?? null,
      notes: String(entry.notes || '')
    }))
  };
}

/**
 * Учёт (раздел «Учёт»): движения денег, позиции магазина, долги и настройки.
 * Контакты и персонажи сюда не попадают — это отдельные сущности.
 */
export function publicFinance(state) {
  const finance = state?.finance || {};
  return {
    operations: (finance.operations || []).map(operation => ({
      id: String(operation.id),
      date: operation.date ?? null,
      currency: operation.currency ?? null,
      kind: operation.kind === 'in' ? 'in' : 'out',
      amount: Number(operation.amount) || 0,
      counterparty: String(operation.counterparty || ''),
      note: String(operation.note || ''),
      characterId: operation.characterId ?? null
    })),
    shopItems: (finance.shopItems || []).map(item => ({
      id: String(item.id),
      title: String(item.title || ''),
      quantity: Number(item.quantity) || 0,
      price: Number(item.price) || 0,
      currency: item.currency ?? null,
      status: item.status ?? null
    })),
    loans: (finance.loans || []).map(loan => ({
      id: String(loan.id),
      title: String(loan.title || ''),
      amount: Number(loan.amount) || 0,
      currency: loan.currency ?? null,
      direction: loan.direction ?? null,
      dueDate: loan.dueDate ?? null,
      closed: loan.closed === true
    })),
    settings: {
      goldRate: Number(finance.settings?.goldRate) || 0,
      commissionPct: Number(finance.settings?.commissionPct) || 0,
      goldRateAt: finance.settings?.goldRateAt ?? null,
      opening:
        finance.settings?.opening && typeof finance.settings.opening === 'object'
          ? Object.fromEntries(
              Object.entries(finance.settings.opening).map(([key, value]) => [key, Number(value) || 0])
            )
          : {}
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Адресные данные: поля и проходки по отдельности                     */
/* ------------------------------------------------------------------ */

/**
 * Карточка персонажа для адресных маршрутов: берём её целиком (с теми же
 * правилами белого списка), чтобы `running` и названия пати были как в `/characters`.
 */
function addressedCharacter(state, id, running) {
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const character = characters.find(char => String(char.id) === String(id));
  if (!character) return null;
  return publicCharacter(character, { running });
}

/**
 * `GET /characters/{id}/stats` — все статы разом, с подписями для человека.
 *
 * `labels` — необязательная функция `(key) => string` (её даёт мост, чтобы у
 * страницы и API была одна таблица названий). Без неё ключи остаются ключами.
 */
export function characterStats(state, id, { running = null, labels = null } = {}) {
  const character = addressedCharacter(state, id, running);
  if (!character) return null;
  const stats = character.stats || {};
  const row = { id: character.id, nick: character.nick };
  const list = [];
  for (const [key, value] of Object.entries(stats)) {
    row[key] = value;
    list.push({ key, label: labels ? labels(key) : null, value });
  }
  return { character: row, stats: list, count: list.length };
}

/**
 * `GET /characters/{id}/stats/{stat}` — одно значение стата.
 * Форма ответа повторяет адресный запрос: `{ id, nick, stat, label, value }`.
 */
export function characterStat(state, id, stat, { running = null, labels = null } = {}) {
  const character = addressedCharacter(state, id, running);
  if (!character) return null;
  const key = String(stat || '').trim();
  if (!Object.prototype.hasOwnProperty.call(character.stats || {}, key)) return { unknown: key };
  return {
    id: character.id,
    nick: character.nick,
    stat: key,
    label: labels ? labels(key) : null,
    value: Number(character.stats[key]) || 0
  };
}

/**
 * `GET /characters/{id}/dungeon-passes` — все проходки: сумма и каждая по отдельности.
 * `stats.dungeonPasses` в карточке персонажа — тот же объект; здесь он разложен
 * на строки, чтобы проще было писать отчёты.
 */
export function characterPasses(state, id, { running = null, labels = null } = {}) {
  const character = addressedCharacter(state, id, running);
  if (!character) return null;
  const passes = character.dungeonPasses || { weapon: 0, armor: 0, relic: 0 };
  const list = PASS_FIELDS.map(key => ({
    key,
    label: labels ? labels(key) : null,
    value: Number(passes[key]) || 0
  }));
  return {
    id: character.id,
    nick: character.nick,
    total: list.reduce((sum, row) => sum + row.value, 0),
    dungeonPasses: { ...passes },
    passes: list
  };
}

/**
 * `GET /characters/{id}/dungeon-passes/{pass}` — одно число проходок.
 * Имена проходам даны по-русски и по-английски (`weapon`/`оружие`), и это
 * не «магия API»: тот же перевод нужен и в `PATCH`.
 */
export function characterPass(state, id, pass, { running = null, labels = null } = {}) {
  const character = addressedCharacter(state, id, running);
  if (!character) return null;
  const key = passKey(pass);
  if (!key) return { unknown: String(pass || '') };
  return {
    id: character.id,
    nick: character.nick,
    pass: key,
    label: labels ? labels(key) : null,
    value: Number(character.dungeonPasses?.[key]) || 0
  };
}

/** Русские и английские имена проходок → ключ состояния. */
const PASS_ALIASES = {
  weapon: 'weapon',
  оружие: 'weapon',
  armor: 'armor',
  armour: 'armor',
  доспех: 'armor',
  armor_armor: 'armor',
  relic: 'relic',
  реликвия: 'relic'
};

/** Ключ проходки по имени из адреса или `null`, если имя неизвестно. */
export function passKey(name) {
  const text = String(name || '')
    .trim()
    .toLowerCase();
  return PASS_ALIASES[text] || null;
}
