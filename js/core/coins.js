// @ts-check
// js/core/coins.js
// Древние монеты: разбор текста с сайта (округление вниз до 0,1), формат вывода и история.
// ВАЖНО: функция parseCoins продублирована в src-tauri/src/scripts/balance.js
// (скрипт внедряется на страницу и не может делать import). Совпадение проверяет tests/coins.test.js.

/*PARSE_START*/
function parseCoins(text) {
  let s = String(text == null ? '' : text).replace(/[\s\u00a0\u202f\u2009]/g, '').replace(/[^0-9.,]/g, '');
  if (!/[0-9]/.test(s)) return NaN;
  s = s.replace(/[.,]+$/, '').replace(/^[.,]/, '0$&');
  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;
  let num;
  if (hasDot && hasComma) {
    // Оба знака: десятичным считается тот, что стоит последним ("1.285,5" и "1,285.5" → 1285.5)
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousands = dec === '.' ? ',' : '.';
    if (s.split(dec).length > 2) return NaN;
    const groups = s.slice(0, s.lastIndexOf(dec)).split(thousands);
    if (!groups.slice(1).every((g) => g.length === 3)) return NaN;
    num = s.split(thousands).join('').replace(dec, '.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // Несколько одинаковых знаков — это разделители тысяч ("1,285,000"); группы по 3 цифры
      if (!parts.slice(1).every((p) => p.length === 3)) return NaN;
      num = parts.join('');
    } else if (parts[1].length === 3 && parts[0] !== '' && parts[0] !== '0' && parts[0].length <= 3) {
      // Ровно 3 цифры после знака и 1–3 цифры перед ним: "1,285" — тысячи
      num = parts.join('');
    } else {
      // Иначе дробная часть: "28,5", "28,50", "0,285"
      num = parts[0] + '.' + parts[1];
    }
  } else {
    num = s;
  }
  const v = parseFloat(num);
  // Лишние знаки после первого отбрасываются (округление вниз): 0,285 → 0,2
  return isFinite(v) ? Math.floor(v * 10 + 1e-6) / 10 : NaN;
}
/*PARSE_END*/

export { parseCoins };

/** Округление до одного знака после запятой (убирает хвосты вида 28.499999). */
export function roundCoins(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

/** 285 → "285", 28.5 → "28,5", 1285.5 → "1 285,5". Целые без «,0». */
export function formatCoins(value) {
  const n = roundCoins(value);
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

/** "+2,5" / "-256,5" / "+0" (для истории). */
export function formatDelta(delta) {
  const n = roundCoins(delta);
  return `${n > 0 ? '+' : ''}${formatCoins(n)}`;
}

/** История: без записей «+0», новые сверху. Количество записей не ограничено. */
export function normalizeCoinHistory(list) {
  if (!Array.isArray(list)) return [];
  const time = (h) => new Date(h?.date || h?.createdAt).getTime() || 0;
  return list
    .filter((h) => h && Number(h.delta) !== 0)
    .map((h) => ({ ...h, delta: roundCoins(h.delta), ...(h.balanceAfter != null ? { balanceAfter: roundCoins(h.balanceAfter) } : {}) }))
    .sort((a, b) => time(b) - time(a));
}

/**
 * Версия разбора баланса. До v2 значение «28,5» читалось как 285 (запятая удалялась), поэтому
 * баланс и история, записанные раньше, могли быть неверными: такие данные помечаются как
 * «требуют перепроверки», пока баланс не будет прочитан с сайта заново.
 */
export const COIN_PARSER_VERSION = 2;

/** Баланс записан старым разбором (или не проверялся после исправления) и мог быть испорчен. */
export function needsCoinRecheck(char) {
  if (!char) return false;
  const synced = !!char.lastCoinUpdate || (Array.isArray(char.coinHistory) && char.coinHistory.length > 0);
  return synced && (Number(char.coinsParserV) || 0) < COIN_PARSER_VERSION;
}

/**
 * Записывает новый баланс в персонажа (мутирует char).
 * - lastCoinUpdate обновляется всегда (это «дата последней проверки»);
 * - запись в историю добавляется только если баланс изменился (никаких «+0»);
 * Возвращает { changed, delta }.
 * @param {any} char
 * @param {number} balance
 * @param {{ note?: string | null, now?: string }} [opts]
 */
export function applyCoinBalance(char, balance, { note, now = new Date().toISOString() } = {}) {
  // Первая проверка после исправления разбора: пометка в истории, чтобы было видно, почему значение «скакнуло»
  if (note == null) note = needsCoinRecheck(char) ? 'Перепроверка после исправления разбора баланса' : 'Автосинхронизация PW Online';
  char.coinsParserV = COIN_PARSER_VERSION;
  const oldBalance = roundCoins(char.ancientCoins || 0);
  const newBalance = roundCoins(balance);
  char.lastCoinUpdate = now;
  if (oldBalance === newBalance) {
    char.ancientCoins = newBalance;
    return { changed: false, delta: 0 };
  }
  const delta = roundCoins(newBalance - oldBalance);
  char.ancientCoins = newBalance;
  char.coinHistory = normalizeCoinHistory([
    { id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `h-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: now, delta, note, balanceAfter: newBalance },
    ...(char.coinHistory || [])
  ]);
  return { changed: true, delta };
}
