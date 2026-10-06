// js/modules/dashboard/timeline.js
// @ts-check
// Раскладка записей дня по времени (Roadmap: «3. Распределение записей по времени»).
//
// Зачем: календарь показывал записи списком — по нему нельзя было понять, что во сколько начинается.
// Здесь записи превращаются в блоки на шкале суток: сверху — записи без времени, ниже — по времени
// начала, высота блока — длительность. Марафон охватывает весь день.
//
// Модуль без DOM: на вход записи дня, на выход геометрия блоков. Поэтому он покрыт тестами.

/** Сколько минут в сутках — знаменатель всех долей шкалы. */
export const DAY_MINUTES = 1440;

/** Длительность по умолчанию, если у записи не задана (форма предлагает её же). */
export const DEFAULT_DURATION_MINUTES = 60;

/** «ЧЧ:ММ» → минуты от полуночи. Неверная строка → null (запись уйдёт в блок «без времени»). */
export function timeToMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Минуты от полуночи → «ЧЧ:ММ» (значение по модулю суток). */
export function minutesToTime(minutes) {
  const total = ((Math.round(Number(minutes) || 0) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Марафон занимает весь день; остальное — по длительности записи. */
export function isAllDayEvent(event) {
  return event?.source === 'marathon';
}

/**
 * Длительность записи в минутах: явное поле, иначе значение по умолчанию.
 * Марафону длительность не нужна — он и так на весь день.
 */
export function eventDuration(event) {
  const value = Number(event?.durationMinutes);
  if (Number.isFinite(value) && value > 0) return Math.min(Math.round(value), DAY_MINUTES);
  return DEFAULT_DURATION_MINUTES;
}

/**
 * Время окончания записи в минутах (может выйти за сутки — блок обрежется по шкале).
 */
export function eventEndMinutes(event) {
  const start = timeToMinutes(event?.time);
  if (start === null) return null;
  return start + eventDuration(event);
}

/**
 * Время окончания «ЧЧ:ММ» для показа в списках: явное `endTime` или рассчитанное из длительности.
 * Единственный владелец этого расчёта — иначе список дня и блок на шкале показывали бы разное.
 * Запись, уходящая за полночь, заканчивается в «24:00», а не «00:30»: так её читают люди.
 */
export function eventEndTime(event) {
  const start = timeToMinutes(event?.time);
  if (start === null) return '';
  if (event?.endTime) return String(event.endTime);
  const end = Math.min(start + eventDuration(event), DAY_MINUTES);
  return end >= DAY_MINUTES ? '24:00' : minutesToTime(end);
}

/** Дорожка для блока: соседние по времени блоки встают рядом, а не перекрывают друг друга. */
function pickLane(lanes, start, end) {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] <= start) { lanes[i] = end; return i; }
  }
  lanes.push(end);
  return lanes.length - 1;
}

/**
 * Раскладка записей дня по шкале 00:00–24:00.
 *
 * Блоки с временем получают доли шкалы: `topPct` — начало, `heightPct` — длительность.
 * Наложения по времени разводятся по дорожкам (`lane`), поэтому две записи в 20:00 видны рядом,
 * а не одна поверх другой. Записи без времени и марафоны идут отдельными группами.
 *
 * @param {Array<any>} events записи дня (см. plannerEventsForDate)
 * @returns {{ allDay: Array<any>, blocks: Array<any>, lanes: number }}
 */
export function timelineBlocks(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  /** @type {Array<any>} */
  const allDay = [];
  /** @type {Array<any>} */
  const timed = [];

  for (const event of list) {
    if (isAllDayEvent(event) || timeToMinutes(event?.time) === null) {
      allDay.push({ event, full: isAllDayEvent(event) });
    } else {
      timed.push(event);
    }
  }

  // Сначала по началу, затем по длительности: одинаковая сортировка даёт устойчивые дорожки
  timed.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time) || eventDuration(b) - eventDuration(a));

  /** @type {number[]} */
  const lanes = [];
  const laid = timed.map(event => {
    const start = /** @type {number} */ (timeToMinutes(event.time));
    const end = Math.min(eventEndMinutes(event) || start + DEFAULT_DURATION_MINUTES, DAY_MINUTES);
    const lane = pickLane(lanes, start, end);
    return { event, start, end, lane };
  });

  const laneCount = Math.max(1, lanes.length);
  const blocks = laid.map(({ event, start, end, lane }) => ({
    event,
    start,
    end,
    startTime: minutesToTime(start),
    endTime: minutesToTime(end % DAY_MINUTES),
    topPct: (start / DAY_MINUTES) * 100,
    heightPct: Math.max(((end - start) / DAY_MINUTES) * 100, 0.7),   // минимальная высота, чтобы блок читался
    lane,
    laneCount,
    leftPct: (lane / laneCount) * 100,
    widthPct: 100 / laneCount
  }));

  return { allDay, blocks, lanes: laneCount };
}

/** Часы для подписей шкалы: 00:00, 03:00, … 24:00. */
export function hourMarks(stepHours = 3) {
  const step = Math.max(1, Math.round(Number(stepHours) || 3));
  /** @type {string[]} */
  const out = [];
  for (let h = 0; h <= 24; h += step) out.push(`${String(h % 24).padStart(2, '0')}:00`);
  return out;
}
