// Счётчики разделов в навигации (js/core/navBadges.js): число показывается только там, где есть записи,
// и обновляется после сохранения и при переключении вкладки.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/state.js', () => ({ state: { characters: [], parties: [], marathons: [] } }));

import { navCounts, countLabel, refreshNavBadges, initNavBadges } from '../js/core/navBadges.js';
import { state } from '../js/core/state.js';

const markup = () => `
  <nav class="tabs">
    <button class="tab" data-tab="characters"><span class="tab-ico">👥</span><span>Персонажи</span><span class="tab-count" id="tab-count-characters" hidden></span></button>
    <button class="tab" data-tab="parties"><span class="tab-ico">🛡</span><span>Пати</span><span class="tab-count" id="tab-count-parties" hidden></span></button>
    <button class="tab" data-tab="marathons"><span class="tab-ico">🏃</span><span>Марафоны</span><span class="tab-count" id="tab-count-marathons" hidden></span></button>
    <button class="tab" data-tab="settings"><span class="tab-ico">⚙</span><span>Настройки</span></button>
  </nav>`;

const counter = (section) => document.getElementById(`tab-count-${section}`);

describe('счётчики разделов', () => {
  beforeEach(() => {
    document.body.innerHTML = markup();
    state.characters = [];
    state.parties = [];
    state.marathons = [];
  });

  it('считает персонажей и пати, у марафонов — только идущие', () => {
    state.characters = [{ id: 'a' }, { id: 'b' }];
    state.parties = [{ id: 'p1' }];
    state.marathons = [
      { id: 'm1', kind: 'single', status: 'active' },
      { id: 'm2', kind: 'single', status: 'completed' },   // завершённые не считаем
      { id: 's1', kind: 'series' }                          // папка — не марафон
    ];
    expect(navCounts()).toEqual({ characters: 2, parties: 1, marathons: 1 });
  });

  it('пустые данные и отсутствующие поля не ломают счёт', () => {
    expect(navCounts({})).toEqual({ characters: 0, parties: 0, marathons: 0 });
    expect(navCounts({ characters: null, marathons: null })).toEqual({ characters: 0, parties: 0, marathons: 0 });
  });

  it('подпись: до тысячи — как есть, дальше — «тыс.» без лишнего нуля', () => {
    expect(countLabel(0)).toBe('0');
    expect(countLabel(7)).toBe('7');
    expect(countLabel(999)).toBe('999');
    expect(countLabel(1200)).toBe('1,2 тыс.');
    expect(countLabel(2000)).toBe('2 тыс.');
    expect(countLabel(15400)).toBe('15 тыс.');
    expect(countLabel(undefined)).toBe('0');
  });

  it('нулевой раздел счётчик прячет: пустая вкладка не кричит нулём', () => {
    state.characters = [{ id: 'a' }, { id: 'b' }];
    refreshNavBadges();
    expect(counter('characters').hidden).toBe(false);
    expect(counter('characters').textContent).toBe('2');
    expect(counter('parties').hidden).toBe(true);
    expect(counter('marathons').hidden).toBe(true);
  });

  it('у вкладки появляется доступное имя с числом записей', () => {
    state.parties = [{ id: 'p1' }, { id: 'p2' }];
    refreshNavBadges();
    expect(document.querySelector('.tab[data-tab="parties"]').getAttribute('aria-label')).toBe('Пати: 2');
  });

  it('без разметки ничего не падает', () => {
    document.body.innerHTML = '';
    expect(() => refreshNavBadges()).not.toThrow();
  });

  it('пересчитывается после сохранения и при клике по вкладке', () => {
    const run = initNavBadges();
    state.characters = [{ id: 'a' }];
    window.dispatchEvent(new CustomEvent('tf-persisted'));
    expect(counter('characters').textContent).toBe('1');

    state.characters = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    document.querySelector('.tab[data-tab="parties"]').click();
    expect(counter('characters').textContent).toBe('3');
    expect(typeof run).toBe('function');
  });
});
