// js/modules/dashboard/weekView.js
// @ts-check
// Компактный вид календаря «Неделя»: 7 колонок (вчера, сегодня, +5 дней) и время сверху вниз.
//
// Зачем отдельный вид: месячная сетка из 31 мини-шкалы мелкая, и по ней нельзя сравнить дни —
// непонятно, где окна свободны. Здесь время общее для всех колонок (как в Google Calendar
// и Outlook), поэтому видно и загруженность дня, и свободные часы.
//
// Модуль без DOM: на вход даты и записи, на выход геометрия колонок. Поэтому он покрыт тестами.
// Раскладку блоков внутри дня считает `timeline.js` — один владелец этой логики на оба вида.

import { timelineBlocks, timeToMinutes, eventEndTime, hourMarks, DAY_MINUTES } from './timeline.js';
import { shiftDate } from '../dungeons/schedule.js';
import { weekdayOfDate } from '../../core/msk.js';

// Реэкспорт для потребителей вида: им нужны те же константы, что и раскладке,
// иначе высота оси и блоков начнёт расходиться
export { DAY_MINUTES, hourMarks, timeToMinutes };

/**
 * Сколько дней показывает полоса недели: вчера, сегодня и три дня вперёд.
 *
 * Раньше было семь, но колонки получались узкими: на обычном экране на день выходило
 * около 95 px, и подписи вида «Битва Династий / 20:20–22:20» обрезались. Пяти дней
 * хватает, чтобы увидеть ближайшие события, а колонка становится заметно шире.
 */
export const WEEK_DAYS = 5;
/** Первый день полосы: вчера — чтобы видеть, что было, не листая назад. */
export const WEEK_FIRST_OFFSET = -1;

/**
 * Высота одного часа в пикселях. Общая для оси времени и всех колонок — иначе блоки «поедут».
 *
 * Сутки показываются целиком и без прокрутки: неделя должна читаться одним взглядом.
 * Поэтому час ниже, чем в окне дня (там важна точность, здесь — общая картина недели).
 *
 * 17px вместо 15px: сетка в две часовые ячейки выглядела слишком тесно, а подписи блоков
 * («Битва Династий / 15:00–16:00») наезжали на линии часов. Цена — неделя выше на 48px.
 */
export const HOUR_HEIGHT = 17;

/** Высота одной дорожки «без конкретного времени»: марафон и записи без времени.
 *  Две строки текста: в колонке пятидневного календаря название задачи не помещалось
 *  на одной строке и обрезалось многоточием — а узнать, какое это дело, было нельзя. */
export const ALLDAY_ROW_HEIGHT = 34;

/**
 * Минимальная высота блока, px: короче этой записи текст не показать.
 *
 * Раньше здесь стояли 14 px при высоте часа 15 px, и это порождало наложения: короткая
 * запись (например, 5 минут = 1.25 px) растягивалась до 14 px — то есть почти на час
 * шкалы, — и накрывала следующую запись, начинавшуюся в 12:05. Дорожки считаются по
 * реальным интервалам, поэтому растянутый блок перекрывал соседа по дорожке.
 *
 * Теперь 10 px (хватает на строку названия в 0.62rem с полями 2px), а главное — растянутый
 * блок не вылезает за пределы свободного места до следующего в этой дорожке (см. `weekLayout`).
 */
export const MIN_BLOCK_HEIGHT = 11;

/** Отступ сверху и снизу в области «без конкретного времени». */
export const ALLDAY_PAD = 6;

/**
 * Сколько дорожек показывать, прежде чем полоса начнёт прокручиваться.
 *
 * Без ограничения одиннадцать задач без времени растягивали полосу на 374 px — треть
 * календаря, и шкала суток начиналась с середины экрана. Три дорожки — это компромисс:
 * обычно дел без времени немного, а когда их много, область просто прокручивается.
 */
export const MAX_ALLDAY_ROWS = 3;

/**
 * Полная высота области «без конкретного времени» для n дорожек.
 * Меньше одной дорожки места не бывает, больше `MAX_ALLDAY_ROWS` не растягивается.
 * @param {number} rows сколько задач попало в полосу
 */
export function allDayHeight(rows) {
  const count = Math.min(MAX_ALLDAY_ROWS, Math.max(1, Math.floor(Number(rows) || 0)));
  return count * ALLDAY_ROW_HEIGHT + ALLDAY_PAD * 2;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAY_NARROW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** Дата «1 октября» — для заголовка полосы недели. */
function shortDate(date) {
  const [, month, day] = String(date).split('-').map(Number);
  return `${day} ${MONTHS_SHORT[(month || 1) - 1]}`;
}

/**
 * Список дней полосы: 7 дат, начиная со вчера.
 * @param {string} today «ГГГГ-ММ-ДД»
 * @returns {Array<{ date: string, day: number, weekday: number, weekdayName: string, isToday: boolean, isWeekend: boolean, label: string }>}
 */
export function weekDays(today) {
  const out = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const date = shiftDate(today, WEEK_FIRST_OFFSET + i);
    if (!date) continue;
    const weekday = weekdayOfDate(date);
    out.push({
      date,
      day: Number(date.slice(-2)),
      weekday,
      weekdayName: WEEKDAY_NARROW[weekday] || '',
      isToday: date === today,
      isWeekend: weekday >= 5,
      label: shortDate(date)
    });
  }
  return out;
}

/** Заголовок полосы: «6 — 12 октября 2026». */
export function weekRangeTitle(days) {
  if (!days?.length) return '';
  const first = days[0].date;
  const last = days[days.length - 1].date;
  const year = last.slice(0, 4);
  const month = Number(last.slice(5, 7));
  const monthName = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][month - 1] || '';
  const firstDay = Number(first.slice(-2));
  const lastDay = Number(last.slice(-2));
  // Переход через месяц показываем явно: «30 сентября — 6 октября»
  if (first.slice(0, 7) !== last.slice(0, 7)) {
    const firstMonth = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][Number(first.slice(5, 7)) - 1] || '';
    return `${firstDay} ${firstMonth} — ${lastDay} ${monthName} ${year}`;
  }
  return `${firstDay} — ${lastDay} ${monthName} ${year}`;
}

/**
 * Раскладка недели: по каждому дню — блоки с координатами в пикселях и записи «весь день».
 *
 * Пиксели, а не проценты: высота недели фиксирована (24 × `HOUR_HEIGHT`), поэтому и ось,
 * и блоки считаются от одной величины и не разъезжаются при изменении масштаба.
 *
 * @param {Array<any>} eventsByDate записи каждого дня по порядку `weekDays`
 * @returns {Array<{ allDay: Array<any>, blocks: Array<any> }>}
 */
export function weekLayout(eventsByDate) {
  return (Array.isArray(eventsByDate) ? eventsByDate : []).map(events => {
    const { allDay, blocks } = timelineBlocks(events);
    /** @type {Array<{ event: any, top: number, natural: number, startTime: any, endTime: any, lane?: number, height?: number }>} */
    const laid = blocks.map(b => ({
      event: b.event,
      top: (b.start / DAY_MINUTES) * (DAY_MINUTES / 60) * HOUR_HEIGHT,
      natural: (b.end - b.start) / 60 * HOUR_HEIGHT,   // высота по реальному интервалу
      startTime: b.startTime,
      endTime: eventEndTime(b.event) || b.endTime
    })).sort((a, b) => a.top - b.top);

    // Дорожки считаем заново — по «видимым» интервалам, а не по времени.
    //
    // Раньше дорожки приходили из `timelineBlocks` (общий с месяцем) — по реальным
    // интервалам, а высота снизу поднималась до минимума ради читаемости. В неделе час
    // всего 15 px, и минимум в 14 px растягивал запись на 5 минут почти на час шкалы:
    // блок накрывал следующую запись в своей дорожке. Обрезать блок до свободного места
    // тоже нельзя — 10 минут разницы дают 2.5 px, и подпись пропадала.
    //
    // Поэтому дорожка назначается по фактической высоте блока: растянутый блок занимает
    // место до конца, и следующий уходит в другую дорожку. Ни наложений, ни нечитаемых блоков.
    const freeAt = [];
    for (const b of laid) {
      const height = Math.max(b.natural, MIN_BLOCK_HEIGHT);
      let lane = freeAt.findIndex(end => end <= b.top);
      if (lane === -1) lane = freeAt.push(b.top + height) - 1;
      else freeAt[lane] = b.top + height;
      b.lane = lane;
      b.height = height;
    }
    // Обрезаем по нижнему краю суток: запись у 23:59 с минимумом высоты уезжала бы за полночь.
    // Дорожки уже назначены, поэтому обрезка ничего не накладывает — только убирает лишнее.
    const dayBottom = 24 * HOUR_HEIGHT;
    for (const b of laid) b.height = Math.min(b.height, dayBottom - b.top);
    const laneCount = Math.max(1, freeAt.length);
    return {
      allDay: allDay.map(x => x.event),
      blocks: laid.map(b => ({
        event: b.event,
        top: b.top,
        height: b.height,
        leftPct: (b.lane / laneCount) * 100,
        widthPct: 100 / laneCount,
        startTime: b.startTime,
        endTime: b.endTime
      }))
    };
  });
}

/**
 * Сплошные полосы «весь день» на всю ширину недели.
 *
 * Марафон идёт несколько дней подряд, поэтому в неделе он показан **одной непрерывной полосой**,
 * а не семью отдельными плашками: по разорванным кусочкам нельзя понять, что событие одно и длится
 * всю неделю. Полоса занимает колонки от первого до последнего дня и не «перепрыгивает» разрыв,
 * если один марафон в середине недели закончился, а начался другой.
 *
 * @param {Array<Array<any>>} eventsByDate записи каждого дня полосы
 * @returns {Array<{ title: string, color: string, startIndex: number, span: number, source: string, id: string, done: boolean, marathonId?: string }>}
 */
export function weekAllDaySpans(eventsByDate) {
  const days = Array.isArray(eventsByDate) ? eventsByDate : [];
  /** @type {Map<string, any>} */
  const byKey = new Map();

  days.forEach((events, index) => {
    for (const event of (events || [])) {
      // В полосу идут только события «на весь день»: марафоны и записи без времени
      const allDay = event?.source === 'marathon' || timeToMinutes(event?.time) === null;
      if (!allDay) continue;
      const key = event.marathonId ? `marathon-${event.marathonId}` : `entry-${event.id}`;
      let span = byKey.get(key);
      if (!span) {
        span = {
          title: event.title,
          color: event.color || 'blue',
          source: event.source || 'manual',
          id: event.id,
          done: event.status === 'done',
          marathonId: event.marathonId,
          indices: []
        };
        byKey.set(key, span);
      }
      span.indices.push(index);
    }
  });

  const spans = [];
  for (const span of byKey.values()) {
    // Непрерывные отрезки: марафон может закончиться и снова начаться в другой половине недели
    let start = span.indices[0];
    let prev = span.indices[0];
    for (let i = 1; i <= span.indices.length; i++) {
      const current = span.indices[i];
      if (current !== prev + 1) {
        // `indices` — служебный список: он нужен только для нарезки, наружу не отдаём
        const rest = { ...span };
        delete rest.indices;
        spans.push({ ...rest, startIndex: start, span: prev - start + 1 });
        start = current;
      }
      prev = current;
    }
  }
  // Сначала длинные полосы: так они устойчиво укладываются дорожками и не рвутся
  return spans.sort((a, b) => a.startIndex - b.startIndex || b.span - a.span);
}

/**
 * Раскладка полос по дорожкам: длинные сверху, пересекающиеся по дням не накладываются.
 * @param {Array<any>} spans результат `weekAllDaySpans`
 */
export function packAllDayRows(spans) {
  /** @type {Array<any[]>} */
  const rows = [];
  const placed = spans.map(span => {
    let row = 0;
    for (; row < rows.length; row++) {
      const taken = rows[row];
      const overlaps = taken.some(s => span.startIndex < s.startIndex + s.span && s.startIndex < span.startIndex + span.span);
      if (!overlaps) break;
    }
    (rows[row] ||= []).push(span);
    return { ...span, row };
  });
  return { rows: rows.length, spans: placed };
}

/**
 * Марафоны по дням недели, разложенные по «дорожкам» внутри колонки.
 *
 * Марафон занимает **всю шкалу дня** — от отметки 00:00 и до конца суток, поэтому полоса
 * идёт вертикально внутри колонки, а не поверх шапки с датами (раньше она их перекрывала).
 * В соседних днях полосы стыкуются вплотную, поэтому один марафон выглядит сплошной линией
 * через все свои дни.
 *
 * Если в один день идёт несколько марафонов, они **делят колонку по ширине**: поровну,
 * как и записи, начинающиеся в одно время. Порядок дорожек задаётся первым появлением
 * марафона, поэтому полоса не «перескакивает» с места на место между днями.
 *
 * @param {Array<Array<any>>} eventsByDate записи каждого дня полосы
 * @returns {{ lanes: number, days: Array<Array<{ event: any, leftPct: number, widthPct: number }>> }}
 */
export function weekMarathonLanes(eventsByDate) {
  const days = Array.isArray(eventsByDate) ? eventsByDate : [];
  /** Порядок марафонов: по первому появлению, чтобы дорожки совпадали во всех днях. */
  const order = new Map();
  const perDay = days.map(events => {
    /** @type {Map<string, any>} */
    const found = new Map();
    for (const event of (events || [])) {
      if (event?.source !== 'marathon') continue;
      const key = String(event.marathonId || event.id);
      if (!order.has(key)) order.set(key, order.size);
      found.set(key, event);
    }
    return found;
  });

  const laneCount = Math.max(1, order.size);
  return {
    lanes: laneCount,
    days: perDay.map(found => [...found.entries()]
      // Дорожка у каждого марафона своя и одна и та же во всех днях
      .map(([key, event]) => ({ key, event, lane: order.get(key) }))
      .sort((a, b) => a.lane - b.lane)
      .map(({ event, lane }) => ({
        event,
        lane,
        leftPct: (lane / laneCount) * 100,
        widthPct: 100 / laneCount
      })))
  };
}

/** Шаг подписей оси времени в часах: 00:00, 06:00, 12:00, 18:00. */
export const HOUR_LABEL_STEP = 6;
/** Сколько ячеек лежит между двумя подписями оси. */
export const CELLS_PER_LABEL = 3;
/** Длительность одной ячейки сетки в часах (6 ч / 3 ячейки = 2 ч). */
export const CELL_HOURS = HOUR_LABEL_STEP / CELLS_PER_LABEL;
/** Высота одной ячейки сетки в пикселях. Сутки по-прежнему равны 24 × `HOUR_HEIGHT`. */
export const CELL_HEIGHT = CELL_HOURS * HOUR_HEIGHT;

/**
 * Ячейки сетки для оси времени и колонок: между подписями ровно `CELLS_PER_LABEL` ячейки.
 * Блоки записей считаются в пикселях от начала суток и от сетки не зависят.
 */
export function weekHours() {
  const count = Math.round(24 / CELL_HOURS);
  return Array.from({ length: count }, (_, i) => {
    const isMajor = i % CELLS_PER_LABEL === 0;
    return {
      hour: i * CELL_HOURS,
      label: isMajor ? `${String(i * CELL_HOURS).padStart(2, '0')}:00` : '',
      isMajor
    };
  });
}

/**
 * Позиция линии «сейчас» в пикселях от начала суток.
 *
 * Часовая шкала недели не прокручивается (сутки видны целиком), поэтому позиция нужна
 * только для линии, а не для прокрутки.
 */
export function nowLineTop(nowMinutes) {
  return ((Number(nowMinutes) || 0) / 60) * HOUR_HEIGHT;
}
