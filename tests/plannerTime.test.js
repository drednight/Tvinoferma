// Отображение календаря с раскладкой по времени (js/modules/dashboard/plannerView.js):
// мини-шкала дня в ячейке, полная шкала 00:00–24:00 в окне дня, постоянные ивенты без правки.
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
  state.settings = { freshness: {} };
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

describe('календарь: раскладка записей по времени', () => {
  it('запись со временем стоит на шкале по началу, а не строкой сверху', () => {
    // 12:00 = 720 из 1440 минут → ровно половина шкалы; 120 минут = 8.333% высоты
    state.plannerEntries = [entry({ id: 'p1', title: 'Своё дело', date: '2026-10-05', time: '12:00', durationMinutes: 120, color: 'blue' })];
    const day = cell(plannerHtml(state), '2026-10-05');
    const blocks = [...day.querySelectorAll('.planner-block')];
    const block = blocks.find(b => b.getAttribute('title').includes('Своё дело'));
    expect(block).not.toBeNull();
    expect(block.getAttribute('style')).toContain('top:50.000%');
    expect(block.getAttribute('style')).toContain('height:8.333%');
    // В этот день идёт ещё и постоянный ивент — он тоже на шкале, но своей дорожкой времени
    expect(blocks.map(b => b.getAttribute('title'))).toEqual(expect.arrayContaining([expect.stringContaining('Битва Династий')]));
    expect(day.querySelector('.planner-day-allday').textContent.trim()).toBe('');
  });

  it('запись без времени идёт сверху, а не на шкале', () => {
    // 2026-10-06 — вторник: постоянных ивентов нет, на шкале ничего лишнего
    state.plannerEntries = [entry({ id: 'p1', title: 'Без времени', date: '2026-10-06', time: '', color: 'green' })];
    const day = cell(plannerHtml(state), '2026-10-06');
    expect(day.querySelector('.planner-day-allday').textContent).toContain('Без времени');
    expect(day.querySelector('.planner-block')).toBeNull();
  });

  it('марафон занимает весь день и показан отдельной меткой', () => {
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Лето', status: 'active', startDate: '2026-10-01', endDate: '2026-10-10' }];
    const day = cell(plannerHtml(state), '2026-10-06');
    const chip = day.querySelector('.planner-chip.is-marathon');
    expect(chip.textContent).toContain('Лето');
    expect([...day.querySelectorAll('.planner-block')].some(b => b.getAttribute('title').includes('Лето'))).toBe(false);
  });

  it('постоянный ивент попадает в ячейку своего дня со временем', () => {
    // 2026-10-07 — среда: Ритм Гильдии 19:30 и Запретное учение 20:00
    const day = cell(plannerHtml(state), '2026-10-07');
    const titles = [...day.querySelectorAll('.planner-block')].map(b => b.getAttribute('title'));
    expect(titles.some(t => t.includes('Ритм Гильдии') && t.includes('19:30'))).toBe(true);
    expect(titles.some(t => t.includes('Запретное учение') && t.includes('20:00'))).toBe(true);
  });

  it('в понедельник идёт Битва Династий, в субботу — ничего', () => {
    const mon = cell(plannerHtml(state), '2026-10-05');
    expect(mon.querySelector('.planner-block').getAttribute('title')).toContain('Битва Династий');
    const sat = cell(plannerHtml(state), '2026-10-10');
    expect(sat.querySelector('.planner-block')).toBeNull();
    expect(sat.querySelector('.planner-chip')).toBeNull();
  });

  it('пустой день не рисует ни блоков, ни меток', () => {
    const day = cell(plannerHtml(state), '2026-10-11');
    expect(day.querySelectorAll('.planner-block')).toHaveLength(0);
    expect(day.querySelectorAll('.planner-chip')).toHaveLength(0);
  });

  it('мини-шкала подписана часами 00 / 06 / 12 / 18, а подсказка клетки перечисляет записи со временем', () => {
    const mon = cell(plannerHtml(state), '2026-10-05');
    expect([...mon.querySelectorAll('.planner-scale-ticks i')].map(i => i.textContent)).toEqual(['00', '06', '12', '18']);
    expect(mon.getAttribute('title')).toContain('20:20–22:20 Битва Династий');
  });

  it('линия «сейчас» (МСК) есть только в клетке сегодняшнего дня', () => {
    // 12:00 UTC = 15:00 МСК = 900 из 1440 минут = 62.5% шкалы
    const today = cell(plannerHtml(state), '2026-10-05');
    expect(today.querySelector('.planner-now').getAttribute('style')).toContain('top:62.500%');
    expect(cell(plannerHtml(state), '2026-10-06').querySelector('.planner-now')).toBeNull();
  });

  it('над сеткой есть легенда полосок: как читать шкалу, свои записи, расписание, «сейчас»', () => {
    const doc = new DOMParser().parseFromString(`<div>${plannerHtml(state)}</div>`, 'text/html');
    const legend = doc.querySelector('.planner-legend-time');
    expect(legend.textContent).toContain('сутки сверху вниз');
    expect(legend.querySelector('.planner-legend-sample.is-recurring')).not.toBeNull();
    expect(legend.querySelector('.planner-legend-now')).not.toBeNull();
  });
});

describe('окно дня: полная шкала 00:00–24:00', () => {
  it('рисует часы и блоки записей по длительности', () => {
    state.plannerEntries = [entry({ id: 'p1', title: 'Рейд', date: '2026-10-05', time: '20:00', durationMinutes: 90, color: 'red' })];
    openPlannerDay('2026-10-05', {});
    const root = document.getElementById('modal-root');
    expect(root.querySelectorAll('.planner-scale-mark')).toHaveLength(9);
    expect(root.querySelector('.planner-scale-marks').textContent).toContain('00:00');
    expect(root.querySelector('.planner-scale-marks').textContent).toContain('21:00');
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
