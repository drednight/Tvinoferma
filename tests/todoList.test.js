// Туду лист на вкладке «Сегодня» (js/modules/dashboard/todayView.js):
// записи дня как список дел — чекбокс, название, статус.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/launcher/runningWindows.js', () => ({
  runningWindows: () => [], onRunningWindows: () => () => {}, refreshRunningWindows: vi.fn(async () => [])
}));

let state, todoListHtml, renderToday, normalizePlannerEntry;

const NOW = new Date('2026-10-05T12:00:00');
const TODAY = '2026-10-05';

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  document.body.innerHTML = '<section id="today-root"></section>';
  ({ state } = await import('../js/core/state.js'));
  ({ todoListHtml, renderToday } = await import('../js/modules/dashboard/todayView.js'));
  ({ normalizePlannerEntry } = await import('../js/modules/dashboard/planner.js'));
  state.settings = { freshness: { balanceHours: 24, loginHours: 24, marathonHours: 24 }, ui: {} };
  state.parties = [];
  state.marathons = [];
  state.plannerEntries = [];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', isLoggedIn: true, ancientCoins: 100, dungeonPasses: { weapon: 1, armor: 2, relic: 3 }, lastCoinUpdate: NOW.toISOString() }
  ];
});

afterEach(() => { vi.useRealTimers(); });

// Своя запись в том виде, какой выдаёт `plannerEventsForDate`: с признаком источника
const mine = (title, status) => ({ ...normalizePlannerEntry({ title, date: TODAY, status }), source: 'manual' });
const parse = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

describe('туду лист: разметка', () => {
  it('у своей записи есть чекбокс, название и кнопка статуса', () => {
    const host = parse(todoListHtml([mine('Пропыть караван', 'todo')], TODAY));
    const row = host.querySelector('.todo-row');
    expect(row.textContent).toContain('Пропыть караван');
    expect(row.querySelector('[data-todo-toggle]')).not.toBeNull();
    expect(row.querySelector('.todo-status').textContent.trim()).toBe('Ожидает');
    expect(row.querySelector('.todo-check.is-empty')).toBeNull();
  });

  it('статусы подписаны словами, а не выведены из галочки', () => {
    const host = parse(todoListHtml([
      mine('Ожидает', 'todo'), mine('В работе', 'doing'), mine('Сделано', 'done')
    ], TODAY));
    expect([...host.querySelectorAll('.todo-status')].map(b => b.textContent.trim()))
      .toEqual(['Ожидает', 'В работе', 'Выполнено']);
    // Галочка отмечена только у выполненного: «в работе» — не производное от неё
    expect([...host.querySelectorAll('[data-todo-toggle]')].map(i => i.checked))
      .toEqual([false, false, true]);
    expect(host.querySelectorAll('.todo-row')[1].className).toContain('is-doing');
    expect(host.querySelectorAll('.todo-row')[1].querySelector('[data-todo-toggle]').checked).toBe(false);
  });

  it('марафоны и ивенты остаются читаемыми, но без чекбокса и статуса', () => {
    const host = parse(todoListHtml([
      mine('Своё дело', 'todo'),
      { id: 'marathon-m1', title: 'Марафон', source: 'marathon', marathonId: 'm1', color: 'purple' }
    ], TODAY));
    const readonly = host.querySelector('.todo-row.is-readonly');
    expect(readonly.textContent).toContain('Марафон');
    expect(readonly.querySelector('[data-todo-toggle]')).toBeNull();
    expect(readonly.querySelector('.todo-status')).toBeNull();
    // У марафона осталась кнопка перехода
    expect(readonly.querySelector('[data-today-act="open-marathon"]')).not.toBeNull();
  });

  it('счётчик показывает невыполненные дела, а не все записи', () => {
    const host = parse(todoListHtml([
      mine('А', 'done'), mine('Б', 'doing'), mine('В', 'todo'),
      { id: 'marathon-m1', title: 'Марафон', source: 'marathon', marathonId: 'm1' }
    ], TODAY));
    expect(host.querySelector('.today-count').textContent).toBe('2');
  });

  it('пустой день: подсказка и кнопки добавления', () => {
    const host = parse(todoListHtml([], TODAY));
    expect(host.textContent).toContain('дел нет');
    expect(host.querySelector('[data-todo-add]').dataset.todoAdd).toBe(TODAY);
    expect(host.querySelector('[data-open-day]')).not.toBeNull();
  });
});

describe('туду лист: действия', () => {
  it('галочка ставит «выполнено» и сохраняет', async () => {
    state.plannerEntries = [mine('Пропыть караван', 'todo')];
    renderToday(document.getElementById('today-root'), {});
    const box = document.querySelector('[data-todo-toggle]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('done'));
    const { persist } = await import('../js/core/storage.js');
    expect(persist).toHaveBeenCalled();
  });

  it('снятая галочка возвращает делу статус «ожидает»', async () => {
    state.plannerEntries = [mine('Пропыть караван', 'done')];
    renderToday(document.getElementById('today-root'), {});
    const box = document.querySelector('[data-todo-toggle]');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('todo'));
  });

  it('кнопка статуса перебирает по кругу: ожидает → в работе → выполнено', async () => {
    state.plannerEntries = [mine('Пропыть караван', 'todo')];
    const root = document.getElementById('today-root');
    renderToday(root, {});
    const click = () => document.querySelector('.todo-status').click();
    click(); await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('doing'));
    click(); await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('done'));
    click(); await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('todo'));
  });

  it('марафон отметкой не трогается: у него нет ни галочки, ни статуса', async () => {
    state.plannerEntries = [];
    state.marathons = [{
      id: 'm1', title: 'Марафон', kind: 'single', status: 'active',
      startDate: TODAY, endDate: TODAY, participantIds: ['a'], balance: { start: {} },
      tasks: [], coins: {}, awards: {}, lastSync: null
    }];
    renderToday(document.getElementById('today-root'), {});
    expect(document.querySelector('[data-todo-toggle]')).toBeNull();
  });
});

describe('блок окон игры ушёл с «Сегодня»', () => {
  it('управление окнами живёт в «Инструментах», на «Сегодня» его больше нет', () => {
    renderToday(document.getElementById('today-root'), {});
    expect(document.querySelector('[data-running-windows]')).toBeNull();
    expect(document.querySelector('.rwn-block')).toBeNull();
    // Туду лист на месте
    expect(document.querySelector('.todo-list, .today-empty')).not.toBeNull();
  });
});