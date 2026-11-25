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
  'notes'
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
    else out[field] = char[field] ?? null;
  }
  out.running = running ? runningOf(char.id, running) : null;
  return out;
}

/**
 * Параметры списка персонажей: `party` (id или название) и `fields`.
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
  return { party, fields };
}

/**
 * Список персонажей для ответа API с фильтром по пати и выбором полей.
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {string} query
 * @param {{ running?: Map<string, any> | null }} [options]
 */
export function publicCharacters(state, query = '', options = {}) {
  const { party, fields } = characterFilter(state, query);
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  let list = characters;
  if (party) {
    // Пати ищется по id или названию (без регистра), как в меню трея.
    const parties = Array.isArray(state?.parties) ? state.parties : [];
    const found = parties.find(
      p =>
        String(p?.id) === party ||
        String(p?.name || '')
          .trim()
          .toLowerCase() === party.trim().toLowerCase()
    );
    const partyId = found ? String(found.id) : party;
    list = characters.filter(c => Array.isArray(c.partyIds) && c.partyIds.map(String).includes(partyId));
  }
  const running = options.running || null;
  const rows = list.map(char => publicCharacter(char, { running })).filter(Boolean);
  const picked = fields.length
    ? rows.map(row => {
        const out = { id: row.id };
        for (const field of fields) if (field in row) out[field] = row[field];
        return out;
      })
    : rows;
  return { characters: picked };
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
