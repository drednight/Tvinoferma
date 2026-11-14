import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLabState } from '../demo/design-lab/model.js';
import { state } from '../js/core/state.js';
import { renderReferenceToday } from '../js/modules/dashboard/referenceTodayView.js';
import { renderTodayLayoutEditor } from '../js/modules/dashboard/todayLayoutEditor.js';
import { applyTodayCanvas, applyTodayLayout, normalizeTodayCanvas } from '../js/modules/dashboard/todayLayout.js';
import { renderShowcaseWidgets } from '../js/modules/dashboard/showcaseWidgets.js';

const ids = ['characters', 'parties', 'finance', 'upcoming'];
const rootFor = html => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};
let previous;
beforeEach(() => {
  previous = {
    characters: state.characters,
    parties: state.parties,
    plannerEntries: state.plannerEntries,
    marathons: state.marathons,
    finance: state.finance
  };
});
afterEach(() => Object.assign(state, previous));

describe('optional Today content widgets', () => {
  it('keeps optional widgets hidden in default, legacy and existing free layouts', () => {
    const root = rootFor(renderReferenceToday(createLabState()));
    for (const id of ids) expect(root.querySelector(`.rt-${id}`).hidden).toBe(true);
    applyTodayLayout(root, ['launch']);
    for (const id of ids) expect(root.querySelector(`.rt-${id}`).hidden).toBe(true);
    applyTodayCanvas(root, { width: 1200, blocks: { news: { x: 0, y: 0, width: 350 } } });
    for (const id of ids) expect(root.querySelector(`.rt-${id}`).hidden).toBe(true);
    expect(root.querySelector('.rt-news').hidden).toBe(false);
  });
  it('restores enabled widgets and honors explicitly hidden coordinates', () => {
    const root = rootFor(renderReferenceToday(createLabState()));
    const value = {
      width: 1200,
      blocks: { news: { x: 0, y: 0 }, characters: { x: 25, y: 500, width: 320 }, parties: { x: 400, y: 500 } },
      hidden: ['parties']
    };
    applyTodayCanvas(root, value);
    expect(root.querySelector('.rt-characters').hidden).toBe(false);
    expect(root.querySelector('.rt-characters').style.left).toBe('25px');
    expect(root.querySelector('.rt-parties').hidden).toBe(true);
    expect(normalizeTodayCanvas(value).blocks.parties).toEqual({ x: 400, y: 500 });
  });
  it('projects only active cards and distinguishes unknown login, unverified balance, and old parser data', () => {
    state.characters = [
      {
        id: 'a',
        nick: '<img src=x onerror=bad()>',
        class: 'Воин',
        partyIds: ['p'],
        mainPartyId: 'p',
        isLoggedIn: true,
        ancientCoins: 99
      },
      {
        id: 'b',
        nick: 'Бета',
        class: 'Друид',
        partyIds: ['p', 'q'],
        mainPartyId: 'q',
        isLoggedIn: true,
        lastLoginCheck: '2026-11-01T12:00:00Z',
        ancientCoins: 12.5,
        lastCoinUpdate: '2026-11-02T12:00:00Z',
        coinsParserV: 1
      },
      { id: 'c', nick: 'Гамма', isLoggedIn: false, lastLoginCheck: 'bad', ancientCoins: 0, lastCoinUpdate: 'bad' }
    ];
    state.parties = [
      { id: 'p', name: 'Пати <один>' },
      { id: 'q', name: 'Вторая' }
    ];
    state.plannerEntries = [];
    state.marathons = [];
    const model = { ...createLabState(), production: true };
    const root = rootFor(renderReferenceToday(model));
    const chars = root.querySelector('.rt-characters');
    expect(chars.querySelector('img[onerror]')).toBeNull();
    expect(chars.textContent).toContain('<img src=x onerror=bad()>');
    expect(chars.textContent).toContain('Вход на сайт: не проверен');
    expect(chars.textContent).toContain('Вход на сайт: подтверждён');
    expect(chars.textContent).toContain('Монеты: не проверены');
    expect(chars.textContent).toContain('требуется перепроверка');
    expect(root.querySelector('.rt-parties').textContent).toContain('подтверждён: 1/2');
    expect(root.querySelector('.rt-parties').textContent).toContain('Пати <один>');
    expect(root.querySelector('.rt-finance').textContent).toContain('проверено 0/3');
    expect(root.querySelector('.rt-finance').textContent).toContain('не суммируются');
    expect(root.textContent).not.toContain('MUST_NOT_LEAK');
  });
  it('uses finance values and displays unknown rather than invented zeros', () => {
    const model = createLabState();
    model.day.gold = null;
    model.day.bank = 12.5;
    const root = rootFor(renderShowcaseWidgets(model, { demo: true }));
    expect(root.querySelector('.rt-finance').textContent).toContain('Нет данных');
    expect(root.querySelector('.rt-finance').textContent).toContain('12,5');
  });
  it('includes untimed unfinished tasks, excludes completed tasks and identifies active marathon end without repeating it daily', () => {
    const model = createLabState();
    model.day.date = '2026-11-01';
    model.plannerState = {
      plannerEntries: [
        { id: 'a', date: '2026-11-01', title: 'Важное <дело>', kind: 'task', status: 'todo' },
        { id: 'b', date: '2026-11-01', title: 'Выполнено', kind: 'task', status: 'done' }
      ],
      marathons: [{ id: 'm', title: 'Проверка марафона', startDate: '2026-10-30', endDate: '2026-11-02' }]
    };
    const root = rootFor(renderShowcaseWidgets(model));
    const upcoming = root.querySelector('.rt-upcoming');
    expect(upcoming.textContent).toContain('Важное <дело>');
    expect(upcoming.textContent).not.toContain('Выполнено');
    expect(upcoming.textContent).toContain('Конец марафона');
    expect(upcoming.querySelector('[data-today-action="calendar"]')).not.toBeNull();
  });
});

it('keeps the saved visibility preference for the existing site-login information field', () => {
  const before = state.settings.ui.todayInformationHidden;
  try {
    state.settings.ui.todayInformationHidden = ['С входом на сайт'];
    const root = rootFor(renderReferenceToday(createLabState()));
    renderTodayLayoutEditor(root);
    const field = [...root.querySelectorAll('.rt-information-grid > div')].find(
      el => el.querySelector('dt').textContent === 'С входом на сайт'
    );
    expect(field.hidden).toBe(true);
  } finally {
    state.settings.ui.todayInformationHidden = before;
  }
});
