// js/modules/characters/statsHistory.js
// История характеристик персонажа: какие значения были до последнего изменения.
//
// Зачем: характеристики набираются месяцами, а по одному текущему числу не видно, что
// именно выросло — приходилось держать в голове. Здесь хранится снимок значений *до*
// изменения, поэтому рядом с текущим числом можно показать и разницу («было 96 467,
// стало 96 587»), и дату, когда это было.
//
// Хранится у персонажа (`statsHistory`), а не в общем месте: история относится к нему.
// Снимков немного — 10 последних: за это время уже видно и рост, и просадку, а файл
// не растёт от каждого сохранения формы.

/** Сколько последних снимков держим. */
export const STATS_HISTORY_LIMIT = 10;

/** Значение как число: в state.json числа могут прийти строками. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Все ли характеристики совпадают — чтобы не писать снимок «без изменений». */
function sameStats(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if (num(a?.[key]) !== num(b?.[key])) return false;
  }
  return true;
}

/** Снимки приведены к виду `{ at, stats }` — старые и битые записи не ломают показ. */
export function statsHistory(char) {
  const list = char?.statsHistory;
  if (!Array.isArray(list)) return [];
  return list
    .filter(entry => entry && typeof entry.stats === 'object' && entry.stats !== null)
    .map(entry => ({
      at: entry.at || null,
      stats: Object.fromEntries(Object.entries(entry.stats).map(([key, value]) => [key, num(value)]))
    }));
}

/**
 * Запомнить состояние «до изменения».
 *
 * Вызывается после того, как у персонажа уже записаны новые характеристики, а
 * `previousStats` — те значения, которые были до этого. Если ничего не поменялось,
 * снимок не добавляется: иначе история забивалась бы одинаковыми записями.
 *
 * @param {object} char персонаж, у которого уже стоят новые `stats`
 * @param {object} previousStats значения, которые были до изменения
 * @param {string} [at] дата изменения (для тестов — задаётся явно)
 * @returns {object} тот же персонаж
 */
/** Приведение набора к числам: в state.json значения могут прийти строками. */
function numStats(input) {
  return Object.fromEntries(Object.entries(input || {}).map(([key, value]) => [key, num(value)]));
}

export function rememberStatsBefore(char, previousStats, at = new Date().toISOString()) {
  if (!char) return char;
  const before = numStats(previousStats);
  if (sameStats(before, char.stats)) return char;
  const list = statsHistory(char).slice(0, STATS_HISTORY_LIMIT - 1);
  // Кладём именно прежние значения: по ним и считается разница «было → стало»
  char.statsHistory = [{ at, stats: before }, ...list];
  return char;
}

/**
 * Прошлое значение характеристики: самое свежее из сохранённых снимков.
 *
 * Снимки могут перескакивать через характеристику (например, меняли только здоровье),
 * поэтому берём не первый снимок, а первый, где значение отличается от текущего.
 *
 * @returns {{ value: number, at: string|null } | null} `null` — истории по стату нет
 */
export function previousStat(char, key) {
  const current = num(char?.stats?.[key]);
  for (const entry of statsHistory(char)) {
    if (entry.stats[key] === undefined) continue;
    if (num(entry.stats[key]) === current) continue;
    return { value: num(entry.stats[key]), at: entry.at };
  }
  return null;
}

/**
 * Разница между текущим и прошлым значением.
 *
 * @returns {{ current: number, previous: number, delta: number, at: string|null } | null}
 *   `null` — истории нет или значение не менялось: показывать нечего
 */
export function statChange(char, key) {
  const previous = previousStat(char, key);
  if (!previous) return null;
  const current = num(char?.stats?.[key]);
  return { current, previous: previous.value, delta: current - previous.value, at: previous.at };
}

/**
 * Что изменилось между двумя наборами — для списка «последние изменения».
 *
 * Характеристика, которой нет в одном из наборов, пропускается: её отсутствие значит
 * «не знаем», а не «стала нулём» (в тестах и при импорте наборы бывают неполными).
 *
 * @returns {Array<{ key: string, from: number, to: number, delta: number }>}
 */
export function statsDiff(before, after) {
  const out = [];
  for (const key of Object.keys(before || {})) {
    if (!(key in (after || {}))) continue;
    const from = num(before[key]);
    const to = num(after[key]);
    if (from === to) continue;
    out.push({ key, from, to, delta: to - from });
  }
  return out;
}

/**
 * Последние изменения по датам: для панели «История характеристик».
 * @returns {Array<{ at: string|null, changes: Array<{ key: string, from: number, to: number, delta: number }> }>}
 */
export function statsChangeLog(char, limit = 6) {
  const entries = statsHistory(char);
  const log = [];
  let current = char?.stats || {};
  for (const entry of entries) {
    const changes = statsDiff(entry.stats, current);
    if (changes.length) log.push({ at: entry.at, changes });
    current = entry.stats;
    if (log.length >= limit) break;
  }
  return log;
}