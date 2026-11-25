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

/** Код ошибки для статуса — единое место, чтобы ответы не расходились. */
export function errorBody(error) {
  const status = Number(error?.status) || 500;
  // Текст произвольного исключения наружу не отдаём: в нём бывают пути и значения
  // полей. Клиент получает код и общее сообщение, подробности — в журнале приложения.
  const known = error?.code && typeof error.code === 'string' && status !== 500;
  return {
    status,
    body: {
      error: {
        code: String(error?.code || 'internal_error'),
        message: known ? String(error.message || 'Ошибка') : 'Внутренняя ошибка приложения'
      }
    }
  };
}

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
 * @returns {{ stats: Record<string, number>, dungeonPasses: Record<string, number> }}
 */
export function validatePatch(patch) {
  if (!isPlainObject(patch)) throw new ApiError(422, 'invalid_value', 'Патч должен быть объектом');
  const allowed = new Set(['stats', 'dungeonPasses']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  if (patch.stats === undefined && patch.dungeonPasses === undefined) {
    throw new ApiError(422, 'invalid_value', 'Нужен хотя бы один из ключей stats или dungeonPasses');
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
  if (!Object.keys(stats).length && !Object.keys(dungeonPasses).length) {
    throw new ApiError(422, 'invalid_value', 'В патче нет ни одного известного поля');
  }
  return { stats, dungeonPasses };
}

/**
 * Применить проверенный патч к персонажу. Возвращает список изменённых ключей
 * (`stats.hp`, `dungeonPasses.weapon`) — по нему строится ответ `changed`.
 */
export function applyPatch(character, { stats = {}, dungeonPasses = {} }) {
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
