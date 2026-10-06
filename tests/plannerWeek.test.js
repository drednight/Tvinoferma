// Вид календаря «Неделя» (js/modules/dashboard/weekView.js):
// полоса из 7 дней, раскладка по времени в пикселях, сплошные полосы марафона.
// Сутки показаны целиком, без прокрутки, поэтому высота часа невелика.
import { describe, expect, it } from 'vitest';
import {
  weekDays, weekRangeTitle, weekLayout, weekAllDaySpans, packAllDayRows, allDayHeight,
  weekHours, nowLineTop, HOUR_HEIGHT, CELL_HEIGHT, ALLDAY_ROW_HEIGHT, WEEK_DAYS, DAY_MINUTES
} from '../js/modules/dashboard/weekView.js';
import { timelineBlocks } from '../js/modules/dashboard/timeline.js';

// 2026-10-07 — среда
const WED = '2026-10-07';

describe('полоса недели', () => {
  it('семь дней, начиная со вчера', () => {
    const days = weekDays(WED);
    expect(days).toHaveLength(WEEK_DAYS);
    expect(days.map(d => d.date)).toEqual([
      '2026-10-06', // вт — вчера
      '2026-10-07', // ср — сегодня
      '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'
    ]);
  });

  it('сегодняшний день помечен, выходные отмечены', () => {
    const days = weekDays(WED);
    expect(days.find(d => d.isToday)?.date).toBe(WED);
    expect(days.filter(d => d.isWeekend).map(d => d.date)).toEqual(['2026-10-10', '2026-10-11']);
  });

  it('день недели в подписи совпадает с датой', () => {
    const days = weekDays(WED);
    const names = Object.fromEntries(days.map(d => [d.date, d.weekdayName]));
    expect(names['2026-10-06']).toBe('вт');
    expect(names['2026-10-07']).toBe('ср');
    expect(names['2026-10-12']).toBe('пн');
  });

  it('полоса переходит через границу месяца и года', () => {
    expect(weekDays('2026-11-01').map(d => d.date)).toEqual([
      '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'
    ]);
    expect(weekDays('2026-01-01')[0].date).toBe('2025-12-31');
  });

  it('заголовок полосы: один месяц и переход через месяц', () => {
    expect(weekRangeTitle(weekDays(WED))).toBe('6 — 12 октября 2026');
    expect(weekRangeTitle(weekDays('2026-11-01'))).toBe('31 октября — 6 ноября 2026');
  });
});

describe('раскладка недели', () => {
  const ev = (time, extra = {}) => ({ id: time, title: `T${time}`, time, color: 'blue', source: 'manual', ...extra });

  it('блок стоит по времени начала, высота — по длительности', () => {
    const [day] = weekLayout([[ev('12:00', { durationMinutes: 120 })]]);
    // 12:00 = 12 часов × 40 px
    expect(day.blocks[0].top).toBe(12 * HOUR_HEIGHT);
    expect(day.blocks[0].height).toBe(2 * HOUR_HEIGHT);
    expect(day.blocks[0].startTime).toBe('12:00');
    expect(day.blocks[0].endTime).toBe('14:00');
  });

  it('короткая запись не схлопывается в волосок', () => {
    const [day] = weekLayout([[ev('12:00', { durationMinutes: 5 })]]);
    expect(day.blocks[0].height).toBeGreaterThanOrEqual(14);
  });

  it('запись от полуночи стоит в самом верху', () => {
    const [day] = weekLayout([[ev('00:00', { durationMinutes: 60 })]]);
    expect(day.blocks[0].top).toBe(0);
    expect(day.blocks[0].height).toBe(HOUR_HEIGHT);
  });

  it('наложения разводятся по дорожкам — та же логика, что в месяце', () => {
    const events = [ev('19:00', { durationMinutes: 120 }), ev('19:30', { durationMinutes: 30 })];
    const [day] = weekLayout([events]);
    const month = timelineBlocks(events);
    expect(day.blocks.map(b => b.leftPct)).toEqual(month.blocks.map(b => b.leftPct));
    expect(day.blocks[0].widthPct).toBe(50);
  });

  it('марафон и записи без времени уходят в «весь день», а не на шкалу', () => {
    const [day] = weekLayout([[
      ev('20:00'),
      ev('', { title: 'Без времени' }),
      { id: 'm', title: 'Марафон', source: 'marathon', color: 'purple' }
    ]]);
    expect(day.allDay.map(e => e.title).sort()).toEqual(['Без времени', 'Марафон']);
    expect(day.blocks).toHaveLength(1);
  });

  it('пустые дни и мусор не ломают раскладку', () => {
    const out = weekLayout([[], null, undefined]);
    expect(out[0]).toEqual({ allDay: [], blocks: [] });
    expect(weekLayout(undefined)).toEqual([]);
  });

  it('высота суток согласована и не требует прокрутки', () => {
    const cells = weekHours();
    // Ячейка 1,5 ч: между двумя подписями ровно две ячейки
    expect(cells).toHaveLength(16);
    expect(cells[0].label).toBe('00:00');
    expect(cells[1].label).toBe('');
    expect(cells[2].label).toBe('03:00');
    expect(cells.filter(h => h.isMajor).map(h => h.label)).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
    // Сутки целиком укладываются в 624 px: неделя видна одним взглядом, без прокрутки часов
    expect(24 * HOUR_HEIGHT).toBe(624);
    expect(cells.length * CELL_HEIGHT).toBe(624);
    expect(HOUR_HEIGHT).toBeLessThan(30);
  });
});

describe('сплошные полосы «весь день»: марафон одной линией', () => {
  const marathon = (id) => ({ id, title: `Марафон ${id}`, source: 'marathon', marathonId: id, color: 'purple' });
  const noTime = (id) => ({ id, title: `Заметка ${id}`, source: 'manual', color: 'blue' });

  it('марафон на четыре дня — одна полоса, а не четыре куска', () => {
    const spans = weekAllDaySpans([
      [], [marathon('m1')], [marathon('m1')], [marathon('m1')], [marathon('m1')], [], []
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ title: 'Марафон m1', startIndex: 1, span: 4 });
  });

  it('марафон во всю неделю тянется от первого дня до последнего', () => {
    const every = Array.from({ length: 7 }, () => [marathon('m1')]);
    const spans = weekAllDaySpans(every);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ startIndex: 0, span: 7 });
  });

  it('разрыв в середине недели не склеивается в одну полосу', () => {
    // Два разных марафона или один с паузой: между днями 1 и 4 нет событий
    const spans = weekAllDaySpans([
      [], [marathon('m1')], [marathon('m1')], [], [marathon('m2')], [marathon('m2')], []
    ]);
    expect(spans.map(s => ({ start: s.startIndex, span: s.span }))).toEqual([
      { start: 1, span: 2 }, { start: 4, span: 2 }
    ]);
  });

  it('записи без времени тоже идут полосами, но каждый день своей', () => {
    const spans = weekAllDaySpans([[], [noTime('a')], [noTime('b')], [], [], [], []]);
    expect(spans).toHaveLength(2);
    expect(spans.every(s => s.span === 1)).toBe(true);
  });

  it('события со временем в полосы не попадают — они на шкале', () => {
    const timed = { id: 't', title: 'Рейд', source: 'manual', time: '20:00', color: 'blue' };
    expect(weekAllDaySpans([[timed], [timed]])).toEqual([]);
  });

  it('пересекающиеся полосы раскладываются по дорожкам, а не накладываются', () => {
    const packed = packAllDayRows([
      { title: 'Длинный', startIndex: 0, span: 5 },
      { title: 'Короткий', startIndex: 1, span: 2 },
      { title: 'После', startIndex: 5, span: 1 }
    ]);
    const long = packed.spans.find(s => s.title === 'Длинный');
    const short = packed.spans.find(s => s.title === 'Короткий');
    const after = packed.spans.find(s => s.title === 'После');
    // Короткий пересекается с длинным — уходит на вторую дорожку
    expect(short.row).not.toBe(long.row);
    // «После» не пересекается с длинным — может лечь на первую дорожку
    expect(after.row).toBe(long.row);
    expect(packed.rows).toBe(2);
  });

  it('высота области «весь день» растёт с числом дорожек', () => {
    // Ноль дорожек даёт ровно одну: место под подпись «весь день» остаётся всегда,
    // иначе шапка дня прыгала бы по высоте между днями с событиями и без
    expect(allDayHeight(0)).toBe(allDayHeight(1));
    expect(allDayHeight(1)).toBe(ALLDAY_ROW_HEIGHT + 12);
    expect(allDayHeight(2)).toBe(allDayHeight(1) + ALLDAY_ROW_HEIGHT);
    expect(allDayHeight(3)).toBe(allDayHeight(2) + ALLDAY_ROW_HEIGHT);
  });

  it('пустой список не ломает раскладку полос', () => {
    expect(weekAllDaySpans([])).toEqual([]);
    expect(weekAllDaySpans(undefined)).toEqual([]);
    expect(packAllDayRows([])).toEqual({ rows: 0, spans: [] });
  });
});

describe('линия «сейчас»', () => {
  it('стоит по московскому времени', () => {
    expect(nowLineTop(0)).toBe(0);
    expect(nowLineTop(12 * 60)).toBe(12 * HOUR_HEIGHT);
    expect(nowLineTop(20 * 60 + 30)).toBe(20.5 * HOUR_HEIGHT);
  });

  it('12:00 — середина суток, а общее число минут в сутках не изменилось', () => {
    expect(nowLineTop(DAY_MINUTES / 2)).toBe(12 * HOUR_HEIGHT);
    expect(DAY_MINUTES).toBe(1440);
  });
});
