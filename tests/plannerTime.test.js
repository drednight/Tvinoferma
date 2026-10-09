// Отображение календаря с раскладкой по времени (js/modules/dashboard/plannerView.js):
// месячная сетка с мини-шкалой дня, полная шкала 00:00–24:00 в окне дня, постоянные ивенты без правки.
// Вид «Неделя» и переключатель проверяются отдельно — в tests/plannerWeek.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

let state, plannerHtml, openPlannerDay, plannerEventsForDate, entry;
// Октябрь 2026: 5-е — понедельник, 7-е — среда
const NOW = new Date('2026-10-05T12:00:00Z');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ plannerHtml, openPlannerDay } = await import('../js/modules/dashboard/plannerView.js'));
  ({ plannerEventsForDate, normalizePlannerEntry: entry } = await import('../js/modules/dashboard/planner.js'));
  // Здесь проверяется месячная сетка: вид задаём явно, иначе по умолчанию откроется неделя
  state.settings = { freshness: {}, ui: { plannerView: 'month' } };
  state.plannerEntries = [];
  state.marathons = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Ячейка календаря для даты. */
const cell = (html, date) => {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return doc.querySelector(`[data-planner-date="${date}"]`);
};

describe('календарь: записи в ячейке месяца', () => {
  // В клетке месяца только названия записей; шкалу времени с точными блоками показывает окно дня
  const chips = day => [...day.querySelectorAll('.planner-chip')].map(c => c.textContent.trim());

  it('своя запись со временем показана названием, а время — в подсказке клетки', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Своё дело', date: '2026-10-05', time: '12:00', durationMinutes: 120, color: 'blue' })];
    const day = cell(plannerHtml(state), '2026-10-05');
    expect(chips(day)).toEqual(expect.arrayContaining(['Своё дело']));
    expect(day.getAttribute('title')).toContain('12:00 Своё дело');
    // Мини-шкалы и блоков в месячной клетке нет
    expect(day.querySelector('.planner-block')).toBeNull();
  });

  it('запись без времени показана названием, подсказка без времени', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Без времени', date: '2026-10-06', time: '', color: 'green' })];
    const day = cell(plannerHtml(state), '2026-10-06');
    expect(chips(day)).toEqual(['Без времени']);
    expect(day.getAttribute('title')).toContain('Без времени');
    expect(day.getAttribute('title')).not.toMatch(/\d\d:\d\d Без времени/);
  });

  it('марафон занимает весь день и показан отдельной меткой', () => {
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Лето', status: 'active', startDate: '2026-10-01', endDate: '2026-10-10' }];
    const day = cell(plannerHtml(state), '2026-10-06');
    const chip = day.querySelector('.planner-chip.is-marathon');
    expect(chip.textContent).toContain('Лето');
  });

  it('постоянный ивент попадает в ячейку своего дня со временем', () => {
    // 2026-10-07 — среда: Ритм Гильдии 19:30 и Запретное учение 20:00
    const day = cell(plannerHtml(state), '2026-10-07');
    const titles = chips(day);
    expect(titles.some(t => t.includes('Ритм Гильдии'))).toBe(true);
    expect(titles.some(t => t.includes('Запретное учение'))).toBe(true);
    expect(day.getAttribute('title')).toContain('19:30 Ритм Гильдии');
    expect(day.getAttribute('title')).toContain('20:00 Запретное учение');
  });

  it('в понедельник идёт Битва Династий, в субботу — ничего', () => {
    const mon = cell(plannerHtml(state), '2026-10-05');
    expect(chips(mon).join(' ')).toContain('Битва Династий');
    const sat = cell(plannerHtml(state), '2026-10-10');
    expect(sat.querySelector('.planner-chip')).toBeNull();
  });

  it('пустой день не рисует меток', () => {
    const day = cell(plannerHtml(state), '2026-10-11');
    expect(day.querySelectorAll('.planner-chip')).toHaveLength(0);
  });

  it('подсказка клетки перечисляет записи со временем', () => {
    const mon = cell(plannerHtml(state), '2026-10-05');
    expect(mon.getAttribute('title')).toContain('20:20 Битва Династий');
  });

  it('метка «сегодня» и подсказка «сейчас» (МСК) есть только в клетке сегодняшнего дня', () => {
    // 12:00 UTC = 15:00 МСК
    const today = cell(plannerHtml(state), '2026-10-05');
    expect(today.classList.contains('is-today')).toBe(true);
    expect(today.getAttribute('title')).toContain('сейчас 15:00');
    const other = cell(plannerHtml(state), '2026-10-06');
    expect(other.classList.contains('is-today')).toBe(false);
    expect(other.getAttribute('title')).not.toContain('сейчас');
  });

  it('легенды не занимают место над календарём: времени нет ни в одном виде', () => {
    // Недельный вид сам всё показывает (шкала, полоски, линия «сейчас»), а в месячном
    // клетки без шкалы — легенда только отнимала высоту
    for (const view of ['week', 'month']) {
      state.settings.ui.plannerView = view;
      const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
      expect(doc.querySelector('.planner-legend-time'), view).toBeNull();
    }
  });

  it('в месячном остаётся легенда данжа дня — без неё не читается цвет клетки', () => {
    const doc = new DOMParser().parseFromString(plannerHtml(state), 'text/html');
    const legend = doc.querySelector('.planner-legend');
    expect(legend.textContent).toContain('Данж дня');
    expect(legend.querySelectorAll('.planner-legend-item').length).toBeGreaterThanOrEqual(3);
  });

  it('в недельном виде легенды нет вовсе: вид и так читается', () => {
    state.settings.ui.plannerView = 'week';
    const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
    expect(doc.querySelector('.planner-legend')).toBeNull();
  });

  it('длинное пояснение под «Календарь» убрано: место занимает сетка', () => {
    const doc = new DOMParser().parseFromString(plannerHtml(state), 'text/html');
    const head = doc.querySelector('.planner-head');
    expect(head.querySelector('p')).toBeNull();
    expect(head.querySelector('h3').textContent).toBe('Календарь');
  });
});

describe('окно дня: полная шкала 00:00–24:00', () => {
  it('рисует часы и блоки записей по длительности', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Рейд', date: '2026-10-05', time: '20:00', durationMinutes: 90, color: 'red' })];
    openPlannerDay('2026-10-05', {});
    const root = document.getElementById('modal-root');
    expect(root.querySelectorAll('.planner-scale-mark')).toHaveLength(5);
    expect(root.querySelector('.planner-scale-marks').textContent).toContain('00:00');
    expect(root.querySelector('.planner-scale-marks').textContent).toContain('18:00');
    const block = [...root.querySelectorAll('.planner-scale-block')].find(b => b.textContent.includes('Рейд'));
    expect(block.getAttribute('title')).toContain('20:00–21:30');
    expect(block.querySelector('b').textContent).toBe('Рейд');
    expect(block.querySelector('small').textContent).toBe('20:00–21:30');
  });

  it('постоянный ивент в окне дня без кнопок правки: только расписание', () => {
    openPlannerDay('2026-10-07', {});
    const root = document.getElementById('modal-root');
    const row = [...root.querySelectorAll('.planner-day-row')].find(r => r.textContent.includes('Ритм Гильдии'));
    expect(row.textContent).toContain('Постоянный ивент');
    expect(row.querySelector('[data-planner-delete]')).toBeNull();
    expect(row.querySelector('[data-planner-done]')).toBeNull();
    expect(row.querySelector('.planner-lock').textContent).toBe('расписание');
  });

  it('своя запись в окне дня правится и удаляется как раньше', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Своё дело', date: '2026-10-07', time: '10:00', durationMinutes: 60 })];
    openPlannerDay('2026-10-07', {});
    const row = [...document.querySelectorAll('.planner-day-row')].find(r => r.textContent.includes('Своё дело'));
    expect(row.querySelector('[data-planner-delete]')).not.toBeNull();
    expect(row.querySelector('[data-planner-done]')).not.toBeNull();
    // Время показано как диапазон старт–окончание
    expect(row.textContent).toContain('10:00–11:00');
  });

  it('пустой день говорит об этом прямо', () => {
    openPlannerDay('2026-10-11', {});
    expect(document.getElementById('modal-root').textContent).toContain('На этот день записей нет');
  });
});

describe('план дня собирается из всех источников', () => {
  it('ручные записи, постоянные ивенты и марафоны видны вместе', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Своё', date: '2026-10-07', time: '10:00', durationMinutes: 60 })];
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Лето', status: 'active', startDate: '2026-10-01', endDate: '2026-10-10' }];
    const all = plannerEventsForDate(state, '2026-10-07');
    expect(all.map(e => e.title)).toEqual(expect.arrayContaining(['Своё', 'Ритм Гильдии', 'Запретное учение', 'Лето']));
    expect(all.some(e => e.source === 'marathon')).toBe(true);
    expect(all.some(e => e.source === 'recurring')).toBe(true);
  });
});

describe('переключатель вида календаря', () => {
  it('по умолчанию открывается компактная неделя', async () => {
    state.settings = { freshness: {}, ui: {} };
    const html = plannerHtml(state);
    expect(html).toContain('data-view="week"');
    expect(html).toContain('class="cal-week"');
    // Месячной сетки в этом виде нет — она появляется только при выборе «Месяц»
    expect(html).not.toContain('planner-grid');
  });

  it('вид «Месяц» рисует прежнюю сетку', () => {
    state.settings = { freshness: {}, ui: { plannerView: 'month' } };
    const html = plannerHtml(state);
    expect(html).toContain('data-view="month"');
    expect(html).toContain('planner-grid');
    expect(html).not.toContain('cal-week');
  });

  it('в шапке есть обе кнопки, выбранная помечена', () => {
    state.settings = { freshness: {}, ui: {} };
    const week = plannerHtml(state);
    expect(week).toContain('data-planner-view="week"');
    expect(week).toContain('data-planner-view="month"');
    // Нажатая кнопка отмечена и доступна для чтения скринридером
    expect(week).toMatch(/data-planner-view="week"[^>]*aria-pressed="true"/);
    expect(week).toMatch(/data-planner-view="month"[^>]*aria-pressed="false"/);
  });

  it('в неделе нет стрелок месяца, а в месяце они есть', () => {
    state.settings = { freshness: {}, ui: {} };
    expect(plannerHtml(state)).not.toContain('data-planner-nav');
    state.settings = { freshness: {}, ui: { plannerView: 'month' } };
    expect(plannerHtml(state)).toContain('data-planner-nav="-1"');
    expect(plannerHtml(state)).toContain('data-planner-nav="1"');
  });

  it('неделя показывает заголовок полосы дней', () => {
    state.settings = { freshness: {}, ui: {} };
    const html = plannerHtml(state);
    // 2026-10-05 — «сегодня», полоса начинается со вчера: 4 — 8 октября
    // 2026-10-05 — «сегодня», полоса из 5 дней начинается со вчера: 4 — 8 октября
    expect(html).toContain('4 — 8 октября 2026');
  });
});

describe('неделя: «весь день» подписан под датой', () => {
  const dayCol = (html, date) => {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    return doc.querySelector(`.cal-day-head[data-planner-date="${date}"]`).closest('.cal-day');
  };

  it('марафон и запись без времени — плашки под датой, колонку дня не заливают', () => {
    state.settings.ui.plannerView = 'week';
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Лето', status: 'active', startDate: '2026-10-01', endDate: '2026-10-10' }];
    state.plannerEntries = [entry({ id: 'p1', title: 'Без времени', date: '2026-10-06', time: '', color: 'green' })];
    const col = dayCol(plannerHtml(state), '2026-10-06');
    const chips = [...col.querySelectorAll('.cal-day-allday .cal-chip')].map(c => c.textContent.trim());
    expect(chips).toEqual(['🏁 Лето', 'Без времени']);
    expect(col.querySelector('.cal-marathon')).toBeNull();
    expect(col.querySelector('.cal-day-track .cal-chip')).toBeNull();
  });

  it('ось времени подписана каждые 6 часов, между подписями три ячейки', () => {
    state.settings.ui.plannerView = 'week';
    const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
    const labels = [...doc.querySelectorAll('.cal-hour')].map(h => h.textContent.trim()).filter(Boolean);
    expect(labels).toEqual(['00:00', '06:00', '12:00', '18:00']);
  });

  it('ячейка «весь день» над 00:00 скрыта, если на неделе нет таких записей', () => {
    state.settings.ui.plannerView = 'week';
    const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
    expect(doc.querySelector('.cal-week-allday')).toBeNull();
    expect(doc.querySelector('.cal-day-allday')).toBeNull();
    expect(doc.querySelectorAll('.cal-line')).toHaveLength(5 * 12);   // 5 колонок по 12 ячеек сетки
  });

  it('ячейка «весь день» появляется, когда есть марафон или запись без времени', () => {
    state.settings.ui.plannerView = 'week';
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Лето', status: 'active', startDate: '2026-10-01', endDate: '2026-10-10' }];
    const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
    expect(doc.querySelector('.cal-week-allday')).not.toBeNull();
    expect(doc.querySelectorAll('.cal-day-allday')).toHaveLength(5);   // столько же, сколько колонок
  });
});
