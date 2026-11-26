// @ts-check
// js/modules/externalApi/actions/mutate.js
// Изменение статов и проходок через внешний API (этап M2).
//
// Правила контракта (docs/EXTERNAL-API.md):
//   - меняются только явно переданные ключи, остальные не трогаются;
//   - значение — конечное число 0 ≤ v ≤ 1 000 000 000, проходки — целые;
//   - неизвестный ключ статов игнорируется (так исторически устроена нормализация),
//     неизвестный ключ верхнего уровня или проходок — ошибка `422 invalid_value`;
//   - перед изменением снимается снимок `rememberStatsBefore` — так же, как при
//     сохранении карточки персонажа;
//   - если запись состояния заблокирована защитой (`Сохранение остановлено`),
//     данные в памяти не меняются вовсе: сначала проверка, потом правка.
//
// Функции чистые: `persist` и `renderCharacters` приходят из моста, поэтому
// ошибку `423` и порядок «снимок → сохранение → перерисовка» можно проверить тестом.

import { DEFAULT_STATS } from '../../characters/stateManager.js';
import { rememberStatsBefore } from '../../characters/statsHistory.js';
import { entryStatusForDate, normalizePlannerEntry, setEntryStatusForDate } from '../../dashboard/planner.js';
import { CURRENCY_IDS, DEFAULT_CURRENCY, normalizeOperation } from '../../finance/model.js';
import { errorBody } from '../errors.js';

export const MAX_STAT_VALUE = 1_000_000_000;
export const MAX_BULK = 100;
export const PASS_KEYS = ['weapon', 'armor', 'relic'];
const STAT_KEYS = new Set(Object.keys(DEFAULT_STATS));

/** Ошибка для моста: код ответа и машиночитаемый код. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Формат ответа об ошибке — один на всё API: см. `errors.js`. Реэкспорт нужен,
// чтобы существующие вызовы `errorBody` из моста и тестов не менялись.
export { errorBody };

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkNumber(value, { integer = false, where = '' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(422, 'invalid_value', `${where}: значение должно быть числом`);
  }
  if (value < 0 || value > MAX_STAT_VALUE) {
    throw new ApiError(422, 'invalid_value', `${where}: допустимо 0…${MAX_STAT_VALUE}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ApiError(422, 'invalid_value', `${where}: проходки — целое число`);
  }
  return value;
}

/**
 * Проверить патч до любых изменений. Возвращает только разрешённые изменения.
 *
 * @param {any} patch тело запроса
 * @returns {{ stats: Record<string, number>, dungeonPasses: Record<string, number>, fields?: Record<string, any> }}
 */
export function validatePatch(patch) {
  if (!isPlainObject(patch)) throw new ApiError(422, 'invalid_value', 'Патч должен быть объектом');
  // Поля карточки (ник, класс, уровень, заметки, теги, небо, избранное) разрешены
  // здесь же: клиенту удобнее менять статы и ник одним запросом.
  const cardKeys = Object.keys(CHARACTER_PATCH_FIELDS);
  const allowed = new Set(['stats', 'dungeonPasses', ...cardKeys]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  const hasCard = cardKeys.some(key => patch[key] !== undefined);
  if (patch.stats === undefined && patch.dungeonPasses === undefined && !hasCard) {
    throw new ApiError(422, 'invalid_value', 'Нужен хотя бы один из ключей stats, dungeonPasses или поля карточки');
  }
  const stats = {};
  const dungeonPasses = {};
  if (patch.stats !== undefined) {
    if (!isPlainObject(patch.stats)) throw new ApiError(422, 'invalid_value', 'stats должен быть объектом');
    for (const [key, value] of Object.entries(patch.stats)) {
      // Неизвестные ключи статов молча пропускаются: набор статов в приложении
      // меняется, и старый клиент не должен на этом ломаться.
      if (!STAT_KEYS.has(key)) continue;
      stats[key] = checkNumber(value, { where: `stats.${key}` });
    }
  }
  if (patch.dungeonPasses !== undefined) {
    if (!isPlainObject(patch.dungeonPasses))
      throw new ApiError(422, 'invalid_value', 'dungeonPasses должен быть объектом');
    for (const [key, value] of Object.entries(patch.dungeonPasses)) {
      if (!PASS_KEYS.includes(key)) {
        throw new ApiError(422, 'invalid_value', `Неизвестная проходка «${key}»: допустимы ${PASS_KEYS.join(', ')}`);
      }
      dungeonPasses[key] = checkNumber(value, { integer: true, where: `dungeonPasses.${key}` });
    }
  }
  const fields = {};
  for (const key of cardKeys) {
    if (patch[key] !== undefined) fields[key] = CHARACTER_PATCH_FIELDS[key](patch[key]);
  }
  if (!Object.keys(stats).length && !Object.keys(dungeonPasses).length && !Object.keys(fields).length) {
    throw new ApiError(422, 'invalid_value', 'В патче нет ни одного известного поля');
  }
  // `fields` появляется только когда он есть: старый ответ `{stats, dungeonPasses}`
  // остаётся прежним, и клиенты, читающие его целиком, ничего не замечают.
  return Object.keys(fields).length ? { stats, dungeonPasses, fields } : { stats, dungeonPasses };
}

/**
 * Применить проверенный патч к персонажу. Возвращает список изменённых ключей
 * (`stats.hp`, `dungeonPasses.weapon`) — по нему строится ответ `changed`.
 */
export function applyPatch(character, { stats = {}, dungeonPasses = {}, fields = {} }) {
  if (!character.stats || typeof character.stats !== 'object') character.stats = { ...DEFAULT_STATS };
  if (!character.dungeonPasses || typeof character.dungeonPasses !== 'object')
    character.dungeonPasses = { weapon: 0, armor: 0, relic: 0 };
  const changed = [];
  for (const [key, value] of Object.entries(stats)) {
    if (Number(character.stats[key]) === value) continue;
    character.stats[key] = value;
    changed.push(`stats.${key}`);
  }
  for (const [key, value] of Object.entries(dungeonPasses)) {
    if (Number(character.dungeonPasses[key]) === value) continue;
    character.dungeonPasses[key] = value;
    changed.push(`dungeonPasses.${key}`);
  }
  // Поля карточки сравниваются по значению: ник «Маг» → «Маг» не считается правкой.
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(character[key] ?? null) === JSON.stringify(value)) continue;
    character[key] = value;
    changed.push(key);
  }
  return changed;
}

/**
 * Проверка перед правкой: запись состояния не остановлена защитой.
 * @param {() => void} assertStateWriteAvailable
 */
export function assertWritable(assertStateWriteAvailable) {
  try {
    assertStateWriteAvailable();
  } catch {
    throw new ApiError(423, 'storage_blocked', 'Сохранение состояния остановлено защитой: изменения не принимаются');
  }
}

/**
 * Найти персонажа по id (включая архивных: они тоже видны в API как обычные).
 * @param {{ characters?: any[], archivedCharacters?: any[] }} state
 * @param {string} id
 */
export function findCharacter(state, id) {
  const wanted = String(id);
  const all = [...(state.characters || []), ...(state.archivedCharacters || [])];
  return all.find(char => String(char.id) === wanted) || null;
}

/**
 * Сохранение состояния. Отказ `persist()` — это не «запись остановлена»: проверка
 * `assertWritable` уже прошла, изменение осталось в памяти и видно в интерфейсе,
 * но на диск не легло. Отвечаем отдельным кодом, чтобы внешняя программа не
 * считала изменение применённым к файлу.
 */
async function persistOrThrow(deps) {
  try {
    await deps.persist();
  } catch {
    throw new ApiError(
      500,
      'save_failed',
      'Изменение сделано в памяти, но сохранить его на диск не удалось: проверьте «Сохранение остановлено» и резервные копии'
    );
  }
}

/**
 * Изменение одного персонажа. Мутирует `state`, затем сохраняет и перерисовывает.
 * Если менять нечего (значения уже такие) — ничего не пишет и отвечает `changed: []`.
 *
 * @param {any} state состояние приложения
 * @param {string} id
 * @param {any} patch
 * @param {{
 *   persist: () => Promise<void>,
 *   renderCharacters?: () => void,
 *   now?: () => string,
 *   assertStateWriteAvailable: () => void
 * }} deps
 */
export async function patchCharacter(state, id, patch, deps) {
  const parsed = validatePatch(patch);
  assertWritable(deps.assertStateWriteAvailable);
  const character = findCharacter(state, id);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  // Снимок «было» делается до правки: rememberStatsBefore сравнивает переданные
  // прежние значения с уже новыми — так же, как это делает форма персонажа.
  const before = { ...(character.stats || {}) };
  const changed = applyPatch(character, parsed);
  const at = (deps.now || (() => new Date().toISOString()))();
  const statsChanged = changed.some(key => key.startsWith('stats.'));
  if (changed.length) {
    if (statsChanged) rememberStatsBefore(character, before, at);
    character.updatedAt = at;
    await persistOrThrow(deps);
    deps.renderCharacters?.();
  }
  return {
    character: {
      id: character.id,
      nick: character.nick,
      class: character.class,
      level: character.level,
      favorite: character.favorite === true,
      tags: Array.isArray(character.tags) ? [...character.tags] : [],
      stats: { ...character.stats },
      dungeonPasses: { ...character.dungeonPasses },
      updatedAt: character.updatedAt
    },
    changed,
    statsHistoryAdded: statsChanged
  };
}

/**
 * Массовое изменение: до 100 персонажей за раз, частичный успех — нормальный ответ.
 * `ids` проверяются целиком до правок: дубликаты и пустые строки — `422`.
 *
 * @param {any} state
 * @param {any} body `{ ids: string[], patch: any }`
 * @param {Parameters<typeof patchCharacter>[3]} deps
 */
export async function bulkUpdate(state, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['ids', 'patch']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  if (!Array.isArray(body.ids) || !body.ids.length)
    throw new ApiError(422, 'invalid_value', 'ids должен быть непустым массивом');
  if (body.ids.length > MAX_BULK)
    throw new ApiError(422, 'invalid_value', `За один раз можно изменить не больше ${MAX_BULK} персонажей`);
  const ids = body.ids.map(id => String(id).trim());
  if (ids.some(id => !id)) throw new ApiError(422, 'invalid_value', 'В ids есть пустая строка');
  if (new Set(ids).size !== ids.length) throw new ApiError(422, 'invalid_value', 'В ids есть повторяющиеся персонажи');
  // Патч проверяется один раз: если он неверный, менять никого не нужно.
  validatePatch(body.patch);
  assertWritable(deps.assertStateWriteAvailable);

  const updated = [];
  const failed = [];
  const at = (deps.now || (() => new Date().toISOString()))();
  let touched = false;
  for (const id of ids) {
    const character = findCharacter(state, id);
    if (!character) {
      failed.push({ id, code: 'no_such_character', message: 'Персонаж не найден' });
      continue;
    }
    const parsed = validatePatch(body.patch);
    const before = { ...(character.stats || {}) };
    const changed = applyPatch(character, parsed);
    if (!changed.length) {
      updated.push({ id, changed: [], nickname: character.nick });
      continue;
    }
    if (changed.some(key => key.startsWith('stats.'))) rememberStatsBefore(character, before, at);
    // `touched` уже выставлен выше: любое изменение (статы, проходки или поля карточки)
    // требует сохранения и перерисовки.
    character.updatedAt = at;
    touched = true;
    updated.push({ id, nick: character.nick, changed });
  }
  if (touched) {
    await persistOrThrow(deps);
    deps.renderCharacters?.();
  }
  return { updated, failed };
}

/* ------------------------------------------------------------------ */
/*  Проходки отдельным вызовом                                        */
/* ------------------------------------------------------------------ */

/**
 * `PATCH /dungeon-passes/{id}`: только проходки, без статов и без истории.
 * Отдельный маршрут нужен для простых клиентов (Excel, PowerShell), которым
 * неудобно собирать вложенный патч — но правила те же, что у `PATCH /characters`.
 */
export async function patchDungeonPasses(state, id, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  assertWritable(deps.assertStateWriteAvailable);
  const character = findCharacter(state, id);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  // Передаём как `{ dungeonPasses: body }` — проверка и применение те же, что в PATCH.
  const parsed = validatePatch({ dungeonPasses: body });
  const before = { dungeonPasses: { ...(character.dungeonPasses || {}) } };
  const changed = applyPatch(character, parsed);
  if (changed.length) {
    const at = (deps.now || (() => new Date().toISOString()))();
    character.updatedAt = at;
    await persistOrThrow(deps);
    deps.renderCharacters?.();
  }
  return {
    id: String(character.id),
    nick: String(character.nick || ''),
    dungeonPasses: { ...character.dungeonPasses },
    previous: before.dungeonPasses,
    changed
  };
}

/* ------------------------------------------------------------------ */
/*  Карточка персонажа: создание и изменение полей                    */
/* ------------------------------------------------------------------ */

/** Поля персонажа, которые можно менять целиком (не статы и не проходки). */
const CHARACTER_PATCH_FIELDS = {
  nick: value =>
    String(value || '')
      .trim()
      .slice(0, 120),
  class: value =>
    String(value || '')
      .trim()
      .slice(0, 80),
  level: value => clampInt(value, 0, 1000),
  notes: value => String(value || '').slice(0, 5000),
  tags: value => normalizeTagsInput(value),
  favorite: value => value === true,
  sky: value => ({
    name: value?.name ? String(value.name).slice(0, 80) : null,
    level: Number.isFinite(Number(value?.level)) ? clampInt(value.level, 0, 1000) : null
  })
};

function clampInt(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

/** Теги: строки без пустых, без дублей, без учёта регистра — как в интерфейсе. */
function normalizeTagsInput(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  return list
    .map(item =>
      String(item || '')
        .trim()
        .replace(/\s+/g, ' ')
    )
    .filter(item => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);
}

/** Проверить поля карточки: неизвестный ключ — `422`, а не тихое игнорирование. */
export function validateCharacterFields(body) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const apply = CHARACTER_PATCH_FIELDS[key];
    if (!apply) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
    out[key] = apply(value);
  }
  if (!Object.keys(out).length) throw new ApiError(422, 'invalid_value', 'Не передано ни одного поля');
  return out;
}

/**
 * `PATCH /characters/{id}` с полями карточки. Статы и проходки идут прежним путём
 * (`stats`, `dungeonPasses`), а ник, класс, уровень, заметки, теги, небо и избранное
 * меняются здесь. Снимок истории статов не нужен: статы не меняются.
 */
export async function patchCharacterFields(state, id, body, deps) {
  assertWritable(deps.assertStateWriteAvailable);
  const character = findCharacter(state, id);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  const fields = validateCharacterFields(body);
  const changed = [];
  for (const [key, value] of Object.entries(fields)) {
    const before = JSON.stringify(character[key] ?? null);
    character[key] = value;
    if (JSON.stringify(value) !== before) changed.push(key);
  }
  const at = (deps.now || (() => new Date().toISOString()))();
  if (changed.length) {
    character.updatedAt = at;
    await persistOrThrow(deps);
    deps.renderCharacters?.();
  }
  return { character: { id: character.id, nick: character.nick }, changed };
}

/**
 * `POST /characters`: новый персонаж. Обязателен только ник; id генерирует само
 * приложение (`crypto.randomUUID`), затем сработает обычная нормализация при загрузке.
 */
export async function createCharacter(state, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  assertWritable(deps.assertStateWriteAvailable);
  const fields = validateCharacterFields(body);
  const nick = String(fields.nick || '').trim();
  if (!nick) throw new ApiError(422, 'invalid_value', 'nick обязателен');
  // Два одинаковых ника допустимы (разные аккаунты), но предупредим вызывающего.
  const sameNick = (state.characters || []).some(char => String(char.nick).toLowerCase() === nick.toLowerCase());
  const id = `char_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const at = (deps.now || (() => new Date().toISOString()))();
  const character = {
    id,
    nick,
    favorite: fields.favorite === true,
    class: fields.class || '',
    partyIds: [],
    mainPartyId: null,
    partyOrder: {},
    notes: fields.notes || '',
    level: fields.level ?? 1,
    sky: fields.sky || { name: null, level: null },
    stats: {},
    dungeonPasses: {},
    statsHistory: [],
    tags: fields.tags || [],
    ancientCoins: 0,
    isLoggedIn: false,
    createdAt: at,
    updatedAt: at
  };
  state.characters = Array.isArray(state.characters) ? state.characters : [];
  state.characters.push(character);
  await persistOrThrow(deps);
  deps.renderCharacters?.();
  return { character: { id, nick, level: character.level, class: character.class }, duplicateNick: sameNick };
}

/* ------------------------------------------------------------------ */
/*  Пати                                                              */
/* ------------------------------------------------------------------ */

/** `PATCH /parties/{id}`: название и цвет. Состав меняется отдельными маршрутами. */
export async function patchParty(state, id, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  assertWritable(deps.assertStateWriteAvailable);
  const parties = Array.isArray(state.parties) ? state.parties : [];
  const party = parties.find(item => String(item.id) === String(id));
  if (!party) throw new ApiError(404, 'no_such_party', 'Пати не найдена');
  const allowed = new Set(['name', 'color']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  const changed = [];
  if (body.name !== undefined) {
    const name = String(body.name || '')
      .trim()
      .slice(0, 80);
    if (!name) throw new ApiError(422, 'invalid_value', 'name не может быть пустым');
    if (party.name !== name) {
      party.name = name;
      changed.push('name');
    }
  }
  if (body.color !== undefined) {
    const color = body.color === null ? null : String(body.color).trim().slice(0, 40);
    if (party.color !== color) {
      party.color = color;
      changed.push('color');
    }
  }
  if (changed.length) {
    await persistOrThrow(deps);
    deps.renderParties?.();
  }
  return { party: { id: party.id, name: party.name, color: party.color ?? null }, changed };
}

/* ------------------------------------------------------------------ */
/*  Марафоны: отметки и поправки                                      */
/* ------------------------------------------------------------------ */

function findMarathon(state, id) {
  const marathons = Array.isArray(state.marathons) ? state.marathons : [];
  return marathons.find(item => String(item.id) === String(id)) || null;
}

function findTask(marathon, taskId) {
  return (marathon.tasks || []).find(task => String(task.id) === String(taskId)) || null;
}

/**
 * Ячейка прогресса `progress[charId][taskId]`. Отметки и поправка живут здесь же,
 * где их пишет интерфейс марафонов, поэтому API не заводит своей структуры.
 */
function ensureCell(marathon, charId, taskId) {
  marathon.progress = marathon.progress && typeof marathon.progress === 'object' ? marathon.progress : {};
  marathon.progress[charId] =
    marathon.progress[charId] && typeof marathon.progress[charId] === 'object' ? marathon.progress[charId] : {};
  const cell = marathon.progress[charId][taskId] || {};
  cell.marks = Array.isArray(cell.marks) ? cell.marks : [];
  cell.adjust = Number(cell.adjust) || 0;
  marathon.progress[charId][taskId] = cell;
  return cell;
}

/**
 * `POST /marathons/{id}/marks`: поставить или снять ручную отметку дня.
 * Тело: `{ characterId, taskId, date: "YYYY-MM-DD", marked: true|false }`.
 * Дата обязана входить в сроки марафона — в чужие дни отметка не ставится.
 */
export async function setMarathonMark(state, id, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['characterId', 'taskId', 'date', 'marked']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  assertWritable(deps.assertStateWriteAvailable);
  const marathon = findMarathon(state, id);
  if (!marathon) throw new ApiError(404, 'no_such_marathon', 'Марафон не найден');
  if (marathon.kind === 'series')
    throw new ApiError(409, 'marathon_not_ready', 'У папки марафонов нет отметок: выберите марафон внутри неё');
  const characterId = String(body.characterId || '').trim();
  if (!characterId) throw new ApiError(422, 'invalid_value', 'characterId обязателен');
  const taskId = String(body.taskId || '').trim();
  if (!taskId) throw new ApiError(422, 'invalid_value', 'taskId обязателен');
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new ApiError(422, 'invalid_value', 'date должен быть в формате YYYY-MM-DD');
  if (marathon.startDate && date < marathon.startDate)
    throw new ApiError(422, 'invalid_value', 'Дата раньше начала марафона');
  if (marathon.endDate && date > marathon.endDate)
    throw new ApiError(422, 'invalid_value', 'Дата позже окончания марафона');
  if (!(marathon.participantIds || []).map(String).includes(characterId)) {
    throw new ApiError(422, 'invalid_value', 'Персонаж не участвует в этом марафоне');
  }
  if (!findTask(marathon, taskId)) throw new ApiError(404, 'no_such_task', 'Задание не найдено');
  const cell = ensureCell(marathon, characterId, taskId);
  const marked = body.marked !== false;
  const visibleMarks = cell.marks.map(String);
  const before = visibleMarks.includes(date);
  if (marked !== before) {
    cell.marks = marked ? [...visibleMarks, date] : visibleMarks.filter(item => item !== date);
    marathon.updatedAt = (deps.now || (() => new Date().toISOString()))();
    await persistOrThrow(deps);
    deps.renderMarathons?.();
  }
  return {
    marathonId: String(marathon.id),
    characterId,
    taskId,
    date,
    marked,
    changed: marked !== before,
    marks: cell.marks
  };
}

/**
 * `POST /marathons/{id}/adjust`: поправка к счётчику задания (например, +1 за
 * выполнение, которое не попало на сайт). Тело: `{ characterId, taskId, value }`,
 * `value` — абсолютное значение поправки, в том числе отрицательное.
 */
export async function adjustMarathonCell(state, id, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['characterId', 'taskId', 'value']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  assertWritable(deps.assertStateWriteAvailable);
  const marathon = findMarathon(state, id);
  if (!marathon) throw new ApiError(404, 'no_such_marathon', 'Марафон не найден');
  if (marathon.kind === 'series') throw new ApiError(409, 'marathon_not_ready', 'У папки марафонов нет прогресса');
  const characterId = String(body.characterId || '').trim();
  if (!characterId) throw new ApiError(422, 'invalid_value', 'characterId обязателен');
  const taskId = String(body.taskId || '').trim();
  if (!taskId) throw new ApiError(422, 'invalid_value', 'taskId обязателен');
  const value = Number(body.value);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ApiError(422, 'invalid_value', 'value должен быть целым числом');
  }
  if (value < -100000 || value > 100000) throw new ApiError(422, 'invalid_value', 'value вне допустимого диапазона');
  if (!(marathon.participantIds || []).map(String).includes(characterId)) {
    throw new ApiError(422, 'invalid_value', 'Персонаж не участвует в этом марафоне');
  }
  if (!findTask(marathon, taskId)) throw new ApiError(404, 'no_such_task', 'Задание не найдено');
  const cell = ensureCell(marathon, characterId, taskId);
  const before = Number(cell.adjust) || 0;
  // Если поправка та же, сохранять нечего: лишняя запись — лишний риск для файла.
  if (before !== value) {
    cell.adjust = value;
    marathon.updatedAt = (deps.now || (() => new Date().toISOString()))();
    await persistOrThrow(deps);
    deps.renderMarathons?.();
  }
  return {
    marathonId: String(marathon.id),
    characterId,
    taskId,
    adjust: cell.adjust,
    previous: before,
    changed: cell.adjust !== before
  };
}

/* ------------------------------------------------------------------ */
/*  Адресная запись: один стат или одна проходка в адресе              */
/* ------------------------------------------------------------------ */

/**
 * `PATCH /characters/{id}/stats/{stat}` — одно значение стата.
 *
 * Тело:
 * - `{ "value": 150 }` — явное значение, удобно для скриптов;
 * - `{ "mode": "inc", "by": 5 }` (или `dec`) — прибавка/вычитание, удобно для
 *   «+1 к опыту пати» и подобного. `by` по умолчанию 1.
 *
 * `mode: "set"` — то же, что отсутствие `mode`. Неизвестный стат — `422`.
 */
export async function patchCharacterStat(state, id, stat, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['value', 'mode', 'by']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  assertWritable(deps.assertStateWriteAvailable);
  const character = findCharacter(state, id);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  const key = String(stat || '').trim();
  if (!STAT_KEYS.has(key)) {
    throw new ApiError(
      422,
      'invalid_value',
      `Неизвестный стат «${key}»: помогите списком из GET /characters/${id}/stats`
    );
  }
  const mode = String(body.mode || 'set')
    .trim()
    .toLowerCase();
  if (!['set', 'inc', 'dec'].includes(mode)) {
    throw new ApiError(422, 'invalid_value', 'mode: set, inc или dec');
  }
  let value;
  if (mode === 'set') {
    if (body.value === undefined) throw new ApiError(422, 'invalid_value', 'Для mode=set нужен value');
    // Тот же диапазон, что у массового изменения: 0…1 000 000 000.
    value = checkNumber(body.value, { where: 'value' });
    if (body.by !== undefined) throw new ApiError(422, 'invalid_value', 'by используется только с mode=inc/dec');
  } else {
    if (body.value !== undefined)
      throw new ApiError(422, 'invalid_value', 'При mode=inc/dec указывайте by, а не value');
    const by = body.by === undefined ? 1 : checkNumber(body.by, { where: 'by' });
    const before = Number(character.stats?.[key]) || 0;
    value = mode === 'inc' ? before + by : before - by;
    if (value < 0) throw new ApiError(422, 'invalid_value', 'Стат не может стать отрицательным');
    if (value > MAX_STAT_VALUE) throw new ApiError(422, 'invalid_value', `Стат больше ${MAX_STAT_VALUE}`);
  }
  if (!character.stats || typeof character.stats !== 'object') character.stats = { ...DEFAULT_STATS };
  if (!character.statsHistory) character.statsHistory = [];
  const before = Number(character.stats[key]) || 0;
  if (before === value) {
    return { id: character.id, nick: character.nick, stat: key, value, before, changed: false };
  }
  const at = (deps.now || (() => new Date().toISOString()))();
  // Снимок «было»: rememberStatsBefore сравнивает переданные значения с текущими
  // и пишет их только если они разные. Значит вызывать его нужно ДО записи —
  // иначе сравнение увидит «было = стало» и снимка не будет.
  const previous = { ...character.stats };
  character.stats[key] = value;
  rememberStatsBefore(character, previous, at);
  character.updatedAt = at;
  await persistOrThrow(deps);
  deps.renderCharacters?.();
  return { id: character.id, nick: character.nick, stat: key, value, before, changed: true };
}

/**
 * `PATCH /characters/{id}/dungeon-passes/{pass}` — одно число проходок.
 *
 * Тело — либо `{ "value": 5 }`, либо просто `5` (голое число): так короче
 * в PowerShell и curl, где JSON-обёртка только мешает:
 * `curl -X PATCH .../dungeon-passes/оружие -d 5`.
 *
 * Имя проходки принимается по-русски и по-английски: `weapon`/`оружие`,
 * `armor`/`доспех`, `relic`/`реликвия`. Отрицательное значение — `422`.
 */
export async function patchCharacterPass(state, id, pass, body, deps) {
  const key = passKeyOf(pass);
  if (!key) {
    throw new ApiError(
      422,
      'invalid_value',
      `Неизвестная проходка «${pass}»: weapon/оружие, armor/доспех, relic/реликвия`
    );
  }
  // Голое число — законное тело: `-d 5` в curl не даёт JSON-объекта.
  const raw = body;
  if (!isPlainObject(raw) && typeof raw !== 'number') {
    throw new ApiError(422, 'invalid_value', 'Тело: {"value": число} или просто число');
  }
  let value;
  if (typeof raw === 'number') {
    value = checkNumber(raw, { integer: true, where: 'value' });
  } else {
    for (const key of Object.keys(raw)) {
      if (key !== 'value') throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
    }
    if (raw.value === undefined) throw new ApiError(422, 'invalid_value', 'Нужен value');
    value = checkNumber(raw.value, { integer: true, where: 'value' });
  }
  assertWritable(deps.assertStateWriteAvailable);
  const character = findCharacter(state, id);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  if (!character.dungeonPasses || typeof character.dungeonPasses !== 'object') {
    character.dungeonPasses = { weapon: 0, armor: 0, relic: 0 };
  }
  const before = Number(character.dungeonPasses[key]) || 0;
  if (before === value) {
    return { id: character.id, nick: character.nick, pass: key, value, before, changed: false };
  }
  character.dungeonPasses[key] = value;
  const at = (deps.now || (() => new Date().toISOString()))();
  character.updatedAt = at;
  await persistOrThrow(deps);
  deps.renderCharacters?.();
  const passes = character.dungeonPasses;
  return {
    id: character.id,
    nick: character.nick,
    pass: key,
    value,
    before,
    changed: true,
    dungeonPasses: { ...passes },
    total: PASS_KEYS.reduce((sum, name) => sum + (Number(passes[name]) || 0), 0)
  };
}

/** Имена проходок: по-русски и по-английски → ключ состояния. */
function passKeyOf(name) {
  const text = String(name || '')
    .trim()
    .toLowerCase();
  const map = {
    weapon: 'weapon',
    оружие: 'weapon',
    armor: 'armor',
    armour: 'armor',
    доспех: 'armor',
    relic: 'relic',
    реликвия: 'relic'
  };
  return map[text] || null;
}

/* ------------------------------------------------------------------ */
/*  Планировщик: правка и новая запись                                */
/* ------------------------------------------------------------------ */

/** Статусы записи в списке дел — те же, что у интерфейса. */
const PLANNER_STATUSES = new Set(['todo', 'doing', 'done']);
/** Дата в формате календаря планировщика. */
const PLANNER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Время в формате «ЧЧ:ММ». */
const PLANNER_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Найти запись планировщика по id.
 * @param {any} state
 * @param {string} id
 */
function findPlannerEntry(state, id) {
  const entries = Array.isArray(state.plannerEntries) ? state.plannerEntries : [];
  return entries.find(item => String(item.id) === String(id)) || null;
}

/**
 * `PATCH /planner/entries/{id}`: статус, название, время и перенос записи.
 *
 * Поля:
 * - `status` — статус записи (`todo`, `doing`, `done`);
 * - `date` — день, к которому относится статус. Для повторяющейся записи это
 *   конкретный день повтора: у неё своё состояние на каждый день, и «сделал вчера»
 *   не должен означать «сделал сегодня»;
 * - `moveToDate` — перенести запись на другой день (собственный день записи);
 * - `title`, `time` — текст записи.
 *
 * Статус меняется через модуль планировщика: завести здесь второе правило — значит
 * потом разойтись с интерфейсом.
 *
 * @param {any} state
 * @param {string} id
 * @param {any} body
 * @param {{
 *   persist: () => Promise<void>,
 *   renderPlanner?: () => void,
 *   now?: () => string,
 *   assertStateWriteAvailable: () => void
 * }} deps
 */
export async function patchPlannerEntry(state, id, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['status', 'date', 'moveToDate', 'title', 'time']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  if (!Object.keys(body).length) {
    throw new ApiError(422, 'invalid_value', 'Нужно хотя бы одно поле: status, date, moveToDate, title или time');
  }
  assertWritable(deps.assertStateWriteAvailable);
  const entry = findPlannerEntry(state, id);
  if (!entry) throw new ApiError(404, 'no_such_entry', 'Запись планировщика не найдена');
  const changed = [];
  // День, к которому относится статус: явно заданный или собственный день записи.
  // У повторов состояние своё на каждый день, поэтому в ответе оно идёт отдельно.
  let statusDate = String(entry.date || '');
  if (body.moveToDate !== undefined) {
    const date = String(body.moveToDate || '');
    if (!PLANNER_DATE_RE.test(date)) {
      throw new ApiError(422, 'invalid_value', 'moveToDate: ожидается YYYY-MM-DD');
    }
    statusDate = date;
    if (entry.date !== date) {
      entry.date = date;
      changed.push('date');
    }
  }
  if (body.title !== undefined) {
    const title = String(body.title || '')
      .trim()
      .slice(0, 160);
    if (!title) throw new ApiError(422, 'invalid_value', 'title не может быть пустым');
    if (entry.title !== title) {
      entry.title = title;
      changed.push('title');
    }
  }
  if (body.time !== undefined) {
    const time = String(body.time || '');
    if (time && !PLANNER_TIME_RE.test(time)) {
      throw new ApiError(422, 'invalid_value', 'time: ожидается ЧЧ:ММ или пустая строка');
    }
    if (String(entry.time || '') !== time) {
      entry.time = time;
      changed.push('time');
    }
  }
  if (body.status !== undefined) {
    const status = String(body.status || '');
    if (!PLANNER_STATUSES.has(status)) {
      throw new ApiError(422, 'invalid_value', 'status: todo, doing или done');
    }
    const date = body.date !== undefined ? String(body.date) : String(entry.date || '');
    if (body.date !== undefined && !PLANNER_DATE_RE.test(date)) {
      throw new ApiError(422, 'invalid_value', 'date: ожидается YYYY-MM-DD');
    }
    statusDate = date;
    if (setEntryStatusForDate(entry, date, status)) changed.push('status');
  }
  if (changed.length) {
    entry.updatedAt = (deps.now || (() => new Date().toISOString()))();
    await persistOrThrow(deps);
    deps.renderPlanner?.();
  }
  return {
    entry: {
      id: String(entry.id),
      title: String(entry.title || ''),
      date: entry.date ?? null,
      time: entry.time ?? '',
      status: entry.status ?? null
    },
    // Состояние на запрошенный день: у повтора оно своё, поэтому «сделано вчера»
    // не выглядит как «сделано сегодня».
    statusDate,
    statusValue: entryStatusForDate(entry, statusDate),
    changed
  };
}

/**
 * `POST /planner/entries`: новая запись в календаре.
 *
 * Запись создаётся тем же нормализатором, что и в интерфейсе: иначе у записей из API
 * были бы другие правила (дата по умолчанию, длительность, статус), и список дел
 * вёл бы себя по-разному в зависимости от того, откуда пришла запись.
 *
 * @param {any} state
 * @param {any} body
 * @param {{
 *   persist: () => Promise<void>,
 *   renderPlanner?: () => void,
 *   now?: () => string,
 *   assertStateWriteAvailable: () => void
 * }} deps
 */
export async function createPlannerEntry(state, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['title', 'date', 'time', 'durationMinutes', 'kind', 'priority', 'recurrence']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  const title = String(body.title || '')
    .trim()
    .slice(0, 160);
  if (!title) throw new ApiError(422, 'invalid_value', 'title обязателен');
  if (body.date !== undefined && !PLANNER_DATE_RE.test(String(body.date || ''))) {
    throw new ApiError(422, 'invalid_value', 'date: ожидается YYYY-MM-DD');
  }
  if (body.time !== undefined && String(body.time || '') && !PLANNER_TIME_RE.test(String(body.time))) {
    throw new ApiError(422, 'invalid_value', 'time: ожидается ЧЧ:ММ или пустая строка');
  }
  assertWritable(deps.assertStateWriteAvailable);
  const entry = normalizePlannerEntry({
    title,
    date: body.date ?? undefined,
    time: body.time ?? undefined,
    durationMinutes: body.durationMinutes ?? undefined,
    kind: body.kind ?? undefined,
    priority: body.priority ?? undefined,
    recurrence: body.recurrence ?? undefined
  });
  state.plannerEntries = Array.isArray(state.plannerEntries) ? state.plannerEntries : [];
  state.plannerEntries.push(entry);
  await persistOrThrow(deps);
  deps.renderPlanner?.();
  return {
    entry: {
      id: String(entry.id),
      title: String(entry.title || ''),
      date: entry.date ?? null,
      time: entry.time ?? '',
      status: entry.status ?? null
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Учёт: новая операция в реестре                                    */
/* ------------------------------------------------------------------ */

/**
 * `POST /finance/operations`: новая запись в реестре денег.
 *
 * Реестр — единственная правда о деньгах (см. js/modules/finance/model.js), поэтому
 * запись создаётся его же нормализатором: округление под валюту и запрет нулевой
 * суммы должны быть одинаковыми у записей из интерфейса и из API.
 *
 * @param {any} state
 * @param {any} body
 * @param {{
 *   persist: () => Promise<void>,
 *   renderFinance?: () => void,
 *   now?: () => string,
 *   assertStateWriteAvailable: () => void
 * }} deps
 */
export async function addFinanceOperation(state, body, deps) {
  if (!isPlainObject(body)) throw new ApiError(422, 'invalid_value', 'Тело запроса должно быть объектом');
  const allowed = new Set(['kind', 'amount', 'currency', 'date', 'counterparty', 'note', 'characterId']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  const kind = body.kind === undefined ? 'out' : String(body.kind);
  if (kind !== 'in' && kind !== 'out') {
    throw new ApiError(422, 'invalid_value', 'kind: in (приход) или out (расход)');
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(422, 'invalid_value', 'amount: сумма должна быть положительным числом');
  }
  const currency = body.currency === undefined ? DEFAULT_CURRENCY : String(body.currency);
  if (!CURRENCY_IDS.includes(currency)) {
    throw new ApiError(422, 'invalid_value', `currency: допустимо ${CURRENCY_IDS.join(', ')}`);
  }
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) {
    throw new ApiError(422, 'invalid_value', 'date: ожидается YYYY-MM-DD');
  }
  assertWritable(deps.assertStateWriteAvailable);
  const operation = normalizeOperation({
    kind,
    amount,
    currency,
    date: body.date ?? undefined,
    counterparty: body.counterparty ?? undefined,
    note: body.note ?? undefined,
    source: 'manual'
  });
  state.finance = state.finance && typeof state.finance === 'object' ? state.finance : {};
  state.finance.operations = Array.isArray(state.finance.operations) ? state.finance.operations : [];
  state.finance.operations.push(operation);
  await persistOrThrow(deps);
  deps.renderFinance?.();
  return {
    operation: {
      id: String(operation.id),
      kind: operation.kind,
      amount: Number(operation.amount) || 0,
      currency: operation.currency,
      date: operation.date ?? null,
      counterparty: String(operation.counterparty || ''),
      note: String(operation.note || '')
    }
  };
}
