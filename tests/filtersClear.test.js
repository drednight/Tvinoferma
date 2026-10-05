// Кнопка «Сбросить» в панели фильтров (js/modules/characters/list.js):
// видна только при активном фильтре и одним нажатием возвращает весь список.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({
  openSyncHelper: vi.fn(), refreshAuthFor: vi.fn(), refreshBalanceFor: vi.fn(),
  refreshAllLoginStatuses: vi.fn(), refreshAllBalances: vi.fn()
}));

const body = `
  <input id="search-input" class="input" />
  <select id="class-filter"><option value="">Все классы</option></select>
  <select id="party-filter"><option value="">Все пати</option></select>
  <select id="auth-filter"><option value="">Все статусы</option><option value="online">онлайн</option></select>
  <select id="tag-filter"><option value="">Все теги</option></select>
  <button id="filters-clear" hidden></button>
  <button id="btn-select-mode"></button>
  <div id="bulk-bar" hidden></div>
  <div id="character-grid"></div>
  <b id="kpi-total-chars"></b><b id="kpi-active-parties"></b><b id="kpi-no-party"></b>
  <b id="kpi-coins"></b><b id="kpi-online-count"></b><b id="kpi-offline-count"></b>
  <div id="modal-root"></div><div id="toast-root"></div>`;

const clearBtn = () => document.getElementById('filters-clear');
const cards = () => document.querySelectorAll('.character-card').length;

describe('фильтры персонажей: кнопка «Сбросить»', () => {
  let state, bindCharacters;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    ({ bindCharacters } = await import('../js/modules/characters/list.js'));
    state.parties = [];
    state.marathons = [];
    state.characters = [
      { id: 'a', nick: 'Аа', class: 'Воин', level: 1, isLoggedIn: true, contacts: {}, tags: ['фарм'], partyIds: [], mainPartyId: null },
      { id: 'b', nick: 'Бб', class: 'Маг', level: 1, isLoggedIn: false, contacts: {}, tags: [], partyIds: [], mainPartyId: null }
    ];
    bindCharacters();
  });

  it('без фильтров кнопки не видно', () => {
    expect(clearBtn().hidden).toBe(true);
    expect(cards()).toBe(2);
  });

  it('поиск показывает кнопку, а сброс возвращает всех персонажей', () => {
    const search = document.getElementById('search-input');
    search.value = 'Аа';
    search.dispatchEvent(new Event('input'));
    expect(cards()).toBe(1);
    expect(clearBtn().hidden).toBe(false);

    clearBtn().click();
    expect(search.value).toBe('');
    expect(clearBtn().hidden).toBe(true);
    expect(cards()).toBe(2);
  });

  it('сброс очищает и выпадающие фильтры', () => {
    const cls = document.getElementById('class-filter');
    cls.value = 'Воин';
    cls.dispatchEvent(new Event('change'));
    expect(cards()).toBe(1);
    expect(clearBtn().hidden).toBe(false);

    clearBtn().click();
    expect(cls.value).toBe('');
    expect(cards()).toBe(2);
  });

  it('фильтр, который перестал подходить данным, снимает кнопку сам', () => {
    const search = document.getElementById('search-input');
    search.value = 'неттакого';
    search.dispatchEvent(new Event('input'));
    expect(cards()).toBe(0);
    expect(document.querySelector('.empty-state').textContent).toContain('Сбросить');

    clearBtn().click();
    expect(cards()).toBe(2);
  });
});
