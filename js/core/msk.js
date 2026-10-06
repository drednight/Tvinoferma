// js/core/msk.js
// @ts-check
// Единый источник времени для всего приложения: московское время (UTC+3).
//
// Зачем отдельный модуль: расписание ивентов и данжей задано по Москве, а компьютер пользователя
// может стоять в любом часовом поясе. Раньше «сегодня» и «который час» брались из локального времени
// (`new Date().getHours()`), из-за чего у пользователя не в Москве ивент сдвигался на часы, а на границе
// суток уезжала и дата. Здесь всё считается через `Intl` в поясе `Europe/Moscow`, поэтому
// перевод часов на самой машине на это не влияет.
//
// Календарные даты («ГГГГ-ММ-ДД») в этом модуле считаются без часовых поясов: строка разбирается
// как UTC-полночь. Иначе арифметика дней уезжала бы на день назад к западу от Гринвича.

const ZONE = 'Europe/Moscow';

/** Москва — UTC+3 круглый год: перевода часов нет с 2014 года, смещение постоянно. */
const MSK_OFFSET_MINUTES = 180;

/** «ГГГГ-ММ-ДД» — единственная форма даты в проекте (совпадает с `input[type=date]`). */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Части московской даты и времени для момента `value`.
 * `hourCycle: 'h23'` — чтобы полночь была «00», а не «24».
 * @param {Date|number|string} [value]
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function mskParts(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);
  /** @type {Record<string, number>} */
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year || 0,
    month: out.month || 0,
    day: out.day || 0,
    hour: out.hour || 0,
    minute: out.minute || 0,
    second: out.second || 0
  };
}

/** Дата по Москве в виде «ГГГГ-ММ-ДД» (та же форма, что у `input[type=date]` и ключей календаря). */
export function mskDate(value = new Date()) {
  const p = mskParts(value);
  if (!p.year) return '';
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Время по Москве «ЧЧ:ММ». */
export function mskTime(value = new Date()) {
  const p = mskParts(value);
  if (!p.year) return '';
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Время по Москве «ЧЧ:ММ:СС» — для часов в боковой панели. */
export function mskTimeSeconds(value = new Date()) {
  const p = mskParts(value);
  if (!p.year) return '';
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

/** Минут от полуночи по Москве: по ним сравниваются «сейчас» и время начала события. */
export function mskMinutes(value = new Date()) {
  const p = mskParts(value);
  return p.hour * 60 + p.minute;
}

/**
 * День недели календарной даты «ГГГГ-ММ-ДД» в нумерации планировщика: 0 — понедельник … 6 — воскресенье.
 * Единственный владелец этого расчёта: и «сегодня» (через `mskWeekday`), и дата из календаря
 * считаются одинаково.
 */
export function weekdayOfDate(date) {
  const m = DATE_RE.exec(String(date || ''));
  if (!m) return -1;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return (day + 6) % 7;
}

/**
 * День недели по Москве в нумерации планировщика: 0 — понедельник … 6 — воскресенье.
 * Совпадает с `Date.getDay()`, пересчитанным от понедельника.
 */
export function mskWeekday(value = new Date()) {
  const date = mskDate(value);
  return date ? weekdayOfDate(date) : 0;
}

/**
 * Сдвиг московской даты на n дней.
 * @param {string} date «ГГГГ-ММ-ДД»
 * @param {number} n
 */
export function mskAddDays(date, n) {
  if (!DATE_RE.test(String(date || ''))) return '';
  const base = new Date(`${date}T00:00:00Z`);   // UTC: календарная арифметика без часовых поясов
  base.setUTCDate(base.getUTCDate() + (Number(n) || 0));
  return base.toISOString().slice(0, 10);
}

/**
 * Момент московского времени «дата + время» как `Date`.
 * Смещение постоянное (UTC+3), поэтому обратное преобразование однозначно и не требует таблиц поясов.
 * @param {string} date «ГГГГ-ММ-ДД»
 * @param {string} time «ЧЧ:ММ»
 */
export function mskDateTime(date, time) {
  if (!DATE_RE.test(String(date || ''))) return new Date(NaN);
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(stamp)) return new Date(NaN);
  return new Date(stamp + ((Number(h) || 0) * 60 + (Number(m) || 0) - MSK_OFFSET_MINUTES) * 60000);
}

/** Подпись московской даты и времени для логов и уведомлений: «ГГГГ-ММ-ДД ЧЧ:ММ». */
export function mskText(value = new Date()) {
  const date = mskDate(value);
  return date ? `${date} ${mskTime(value)}` : '';
}

/**
 * «02.10.2026 15:20» по Москве — для «проверено …», «следующая проверка …».
 * Дата и время берутся отдельными вызовами: `toLocaleString` в русской локали вставляет запятую.
 */
export function mskStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('ru-RU', { timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('ru-RU', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

/** То же, но с секундами — для журналов, где важна точность до секунды. */
export function mskStampSeconds(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('ru-RU', { timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('ru-RU', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${date} ${time}`;
}
