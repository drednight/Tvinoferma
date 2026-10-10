// Вид календаря «Неделя» (js/modules/dashboard/weekView.js):
// полоса из 5 дней (вчера + сегодня + 3), раскладка по времени в пикселях, сплошные полосы марафона.
// Сутки показаны целиком, без прокрутки, поэтому высота часа невелика.
import { describe, expect, it } from 'vitest';
import {
  weekDays, weekRangeTitle, weekLayout, weekAllDaySpans, packAllDayRows, allDayHeight,
  weekHours, nowLineTop, nowLinePct, HOUR_HEIGHT, CELL_HEIGHT, ALLDAY_ROW_HEIGHT, ALLDAY_BAND_HEIGHT, WEEK_DAYS, DAY_MINUTES, MIN_BLOCK_HEIGHT
} from '../js/modules/dashboard/weekView.js';

// 2026-10-07 — среда
const WED = '2026-10-07';

describe('полоса недели', () => {
  it('пять дней, начиная со вчера: вчера, сегодня и три вперёд', () => {
    const days = weekDays(WED);
    // Пять колонок вместо семи: на семи подписи вида «Битва Династий / 20:20–22:20»
    // обрезались, колонка на обычном экране выходила около 95 px
    expect(WEEK_DAYS).toBe(5);
    expect(days).toHaveLength(WEEK_DAYS);
    expect(days.map(d => d.date)).toEqual([
      '2026-10-06', // вт — вчера
      '2026-10-07', // ср — сегодня
      '2026-10-08', '2026-10-09', '2026-10-10'
    ]);
  });

  it('сегодняшний день помечен, выходные отмечены', () => {
    const days = weekDays(WED);
    expect(days.find(d => d.isToday)?.date).toBe(WED);
    expect(days.filter(d => d.isWeekend).map(d => d.date)).toEqual(['2026-10-10']);
  });

  it('день недели в подписи совпадает с датой', () => {
    const days = weekDays(WED);
    const names = Object.fromEntries(days.map(d => [d.date, d.weekdayName]));
    expect(names['2026-10-06']).toBe('вт');
    expect(names['2026-10-07']).toBe('ср');
    expect(names['2026-10-10']).toBe('сб');
  });

  it('полоса переходит через границу месяца и года', () => {
    expect(weekDays('2026-11-01').map(d => d.date)).toEqual([
      '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'
    ]);
    expect(weekDays('2026-01-01')[0].date).toBe('2025-12-31');
  });

  it('заголовок полосы: один месяц и переход через месяц', () => {
    expect(weekRangeTitle(weekDays(WED))).toBe('6 — 10 октября 2026');
    expect(weekRangeTitle(weekDays('2026-11-01'))).toBe('31 октября — 4 ноября 2026');
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
    expect(day.blocks[0].height).toBeGreaterThanOrEqual(MIN_BLOCK_HEIGHT);
  });

  it('короткая запись не накрывает следующую: растянутый блок уводит соседа в другую дорожку', () => {
    // Причина жалобы: минимум 14 px при часе 15 px растягивал запись на 5 минут почти на час
    // шкалы, и она закрывала всё, что начиналось сразу после неё. Обрезать до свободных
    // 2.5 px тоже нельзя — подпись пропадала, поэтому дорожки считаются по видимым высотам.
    const [day] = weekLayout([[
      ev('12:00', { durationMinutes: 5 }),
      ev('12:10', { durationMinutes: 30 })
    ]]);
    const [short, next] = day.blocks;
    expect(short.height).toBe(MIN_BLOCK_HEIGHT);        // читаемо
    expect(next.leftPct).toBe(50);                      // но не поверх: вторая дорожка
    expect(short.leftPct).toBe(0);
  });

  it('дорожки считаются по видимым высотам: наложение по времени тоже разводится', () => {
    const [day] = weekLayout([[
      ev('12:00', { durationMinutes: 5 }),
      ev('12:02', { durationMinutes: 30 })
    ]]);
    const [a, b] = day.blocks;
    expect(a.leftPct).toBe(0);
    expect(b.leftPct).toBe(50);
    // Ни один блок не выходит за пределы своей половины колонки
    expect(a.leftPct + a.widthPct).toBeLessThanOrEqual(50);
    expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100);
  });

  it('нижняя граница суток: полоса не должна вылезать за них даже с минимумом', () => {
    const [day] = weekLayout([[ev('23:30', { durationMinutes: 30 })]]);
    const b = day.blocks[0];
    // Полоса может упереться в полночь, но не за её пределы: иначе она налезает на «сейчас»
    expect(b.top + b.height).toBeLessThanOrEqual(24 * HOUR_HEIGHT);
  });

  it('запись от полуночи стоит в самом верху', () => {
    const [day] = weekLayout([[ev('00:00', { durationMinutes: 60 })]]);
    expect(day.blocks[0].top).toBe(0);
    expect(day.blocks[0].height).toBe(HOUR_HEIGHT);
  });

  it('наложения разводятся по дорожкам', () => {
    const events = [ev('19:00', { durationMinutes: 120 }), ev('19:30', { durationMinutes: 30 })];
    const [day] = weekLayout([events]);
    expect(day.blocks.map(b => b.leftPct)).toEqual([0, 50]);
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
    // Ячейка 2 ч: между двумя подписями ровно три ячейки
    expect(cells).toHaveLength(12);
    expect(cells[0].label).toBe('00:00');
    expect(cells[1].label).toBe('');
    expect(cells[2].label).toBe('');
    expect(cells[3].label).toBe('06:00');
    expect(cells.filter(h => h.isMajor).map(h => h.label)).toEqual(['00:00', '06:00', '12:00', '18:00']);
    // Сутки целиком укладываются в 408 px (час 17px): неделя видна одним взглядом, без прокрутки часов
    expect(24 * HOUR_HEIGHT).toBe(408);
    expect(cells.length * CELL_HEIGHT).toBe(408);
    // Час остаётся достаточно низким, чтобы сутки поместились в экран без прокрутки часов
    expect(HOUR_HEIGHT).toBeLessThanOrEqual(24);
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

  it('высота области «без конкретного времени» постоянна: 100 px при любом числе задач', () => {
    // Полоса не должна зависеть от загрузки дня: иначе колонка с шестью делами выше
    // колонки без дел, и полоса отжимает шкалу суток. Пять дел видно, дальше прокрутка.
    expect(ALLDAY_BAND_HEIGHT).toBe(100);
    for (const n of [0, 1, 2, 3, 5, 6, 11, 50]) {
      expect(allDayHeight(n)).toBe(ALLDAY_BAND_HEIGHT);
    }
    // Дорожка осталась в несколько строк — ею пользуется окно дня, у которого своя шкала
    expect(ALLDAY_ROW_HEIGHT).toBeGreaterThanOrEqual(32);
  });

  it('блок задачи в неделе стоит в долях суток: календарь растягивается, время остаётся', () => {
    // Пиксели при растяжении разъехались бы с линиями часов, поэтому у блока есть доля суток
    const at = (time, extra = {}) => ({ id: time, title: `T${time}`, time, color: 'blue', source: 'manual', ...extra });
    const [day] = weekLayout([[at('12:00', { durationMinutes: 120 })]]);
    const block = day.blocks[0];
    expect(block.topPct).toBeCloseTo(50, 1);
    expect(block.heightPct).toBeCloseTo((120 / 1440) * 100, 1);
    expect(block.leftPct).toBeCloseTo(0, 5);
    // Линия «сейчас» тоже в долях суток
    expect(nowLinePct(360)).toBeCloseTo(25, 1);
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
