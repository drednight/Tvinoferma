// Отображение экрана «Сегодня» (js/modules/dashboard/todayView.js):
// три блока, действия в строках, сворачивание.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

let state, todayHtml, renderToday, todayCollapsed;

const NOW = new Date('2026-10-05T12:00:00');
const at = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const day = (o) => { const d = new Date(NOW); d.setDate(d.getDate() + o); return d.toLocaleDateString('sv'); };

const html = (deps = {}) => todayHtml(deps, state);

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<section id="characters"><div id="character-grid"></div></section>';
  ({ state } = await import('../js/core/state.js'));
  ({ todayHtml, renderToday, todayCollapsed } = await import('../js/modules/dashboard/todayView.js'));
  state.settings = { freshness: { balanceHours: 24, loginHours: 24, marathonHours: 24 }, ui: {} };
  state.parties = [];
  state.marathons = [];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', isLoggedIn: true, ancientCoins: 100, dungeonPasses: { weapon: 1, armor: 2, relic: 3 }, lastCoinUpdate: at(1) }
  ];
});

describe('разметка экрана «Сегодня»', () => {
  it('на пустых данных экрана нет: там своя подсказка первых шагов', () => {
    state.characters = [];
    expect(html()).toBe('');
  });

  it('показывает три блока: внимание, марафоны, запасы', () => {
    const out = html();
    expect(out).toContain('Сегодня');
    expect(out).toContain('Требуют внимания');
    expect(out).toContain('Сегодня в марафонах');
    expect(out).toContain('Запасы');
  });

  it('когда всё в порядке, блок внимания говорит об этом прямо', () => {
    expect(html()).toContain('Всё в порядке');
  });

  it('персонаж без входа попадает в блок внимания с кнопкой', () => {
    state.characters = [{ id: 'a', nick: 'Аа', class: 'Воин', isLoggedIn: false, dungeonPasses: {}, ancientCoins: 0 }];
    const out = html();
    expect(out).toContain('data-today-act="check-auth-one"');
    expect(out).toContain('data-today-char="a"');
    expect(out).toContain('Проверить вход');
    expect(out).not.toContain('Всё в порядке');
  });

  it('давний баланс даёт строку с кнопкой обновления', () => {
    state.characters = [{ id: 'a', nick: 'Аа', class: 'Воин', isLoggedIn: true, lastCoinUpdate: at(50), dungeonPasses: {} }];
    const out = html();
    expect(out).toContain('data-today-act="balance-one"');
    expect(out).toContain('Обновить баланс');
  });

  it('запасы: монеты, проходки по видам и число персонажей', () => {
    const out = html();
    expect(out).toContain('100');
    expect(out).toContain('Проходки в данжи');
    expect(out).toContain('<b>6</b>');            // 1 + 2 + 3
    expect(out).toContain('оружие 1');
    expect(out).toContain('броня 2');
    expect(out).toContain('реликвии 3');
    expect(out).toContain('авторизованы: 1 из 1');
  });

  it('идущий марафон показывается со сроком и кнопкой', () => {
    state.marathons = [{
      id: 'm1', kind: 'single', title: 'Лето', status: 'active',
      startDate: day(-5), endDate: day(3), participantIds: ['a'],
      tasks: [{ id: 't1', title: 'Вход', targetChecks: 3, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }],
      progress: {}
    }];
    const out = html();
    expect(out).toContain('Лето');
    expect(out).toContain('осталось 3 дня');
    expect(out).toContain('data-today-act="open-marathon"');
    expect(out).toContain('отстают 1');
  });

  it('ближайшие окончания и пати попадают в блок запасов', () => {
    state.parties = [{ id: 'p1', name: 'Основа', order: 1 }];
    state.characters[0].partyIds = ['p1'];
    state.characters[0].mainPartyId = 'p1';
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Скоро', endDate: day(2), status: 'active' }];
    const out = html();
    expect(out).toContain('Скоро заканчиваются');
    expect(out).toContain('Скоро');
    expect(out).toContain('2 дня');
    expect(out).toContain('data-today-act="open-party"');
    expect(out).toContain('Основа');
  });

  it('экран можно свернуть, и это состояние сохраняется в разметке', () => {
    expect(todayCollapsed()).toBe(false);
    expect(html()).toContain('▾ Свернуть');
    state.settings.ui.todayCollapsed = true;
    expect(todayCollapsed()).toBe(true);
    const out = html();
    expect(out).toContain('▸ Развернуть');
    expect(out).not.toContain('Сегодня в марафонах');   // блоки скрыты
  });
});

describe('отрисовка и действия', () => {
  const grid = () => document.getElementById('character-grid');
  const section = () => document.querySelector('[data-today]');

  it('экран вставляется перед сеткой карточек и не заменяет её', () => {
    renderToday(grid(), {});
    const sec = section();
    expect(sec).not.toBeNull();
    // Сетка осталась на месте и идёт после экрана
    expect(grid()).not.toBeNull();
    expect(sec.nextElementSibling).toBe(grid());
  });

  it('повторная отрисовка не дублирует экран', () => {
    renderToday(grid(), {});
    renderToday(grid(), {});
    expect(document.querySelectorAll('[data-today]')).toHaveLength(1);
  });

  it('на пустых данных экран убирается', () => {
    renderToday(grid(), {});
    expect(section()).not.toBeNull();
    state.characters = [];
    renderToday(grid(), {});
    expect(section()).toBeNull();
  });

  it('кнопка действия вызывает переданный обработчик с id персонажа', () => {
    state.characters = [{ id: 'a', nick: 'Аа', isLoggedIn: false, dungeonPasses: {} }];
    const run = vi.fn();
    renderToday(grid(), { run });
    document.querySelector('[data-today-act="check-auth-one"]').click();
    expect(run).toHaveBeenCalledWith('check-auth-one', 'a');
  });

  it('кнопка марафона передаёт его id', () => {
    state.marathons = [{
      id: 'm1', kind: 'single', title: 'Лето', status: 'active',
      startDate: day(-5), endDate: day(3), participantIds: ['a'],
      tasks: [{ id: 't1', title: 'Вход', targetChecks: 3, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }],
      progress: {}
    }];
    const run = vi.fn();
    renderToday(grid(), { run });
    document.querySelector('[data-today-act="open-marathon"]').click();
    expect(run).toHaveBeenCalledWith('open-marathon', 'm1');
  });

  it('сворачивание запоминается и перерисовывает экран', async () => {
    renderToday(grid(), {});
    document.querySelector('[data-today-toggle]').click();
    await vi.waitFor(() => expect(todayCollapsed()).toBe(true));
    expect(document.querySelector('[data-today-toggle]').textContent).toContain('Развернуть');
  });

  it('без сетки ничего не падает', () => {
    expect(() => renderToday(null, {})).not.toThrow();
    const detached = document.createElement('div');
    expect(() => renderToday(detached, {})).not.toThrow();
  });
});
