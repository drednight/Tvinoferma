// Кнопка «Сбросить» в панели фильтров (js/modules/characters/list.js):
// видна только при активном фильтре и одним нажатием возвращает весь список.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const onboardingCss = readFileSync(resolve(process.cwd(), 'css/modules/onboarding.css'), 'utf8');

const mocks = vi.hoisted(() => ({
  showModal: vi.fn(({ content }) => {
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = content;
  }),
  closeModal: vi.fn(() => {
    const root = document.getElementById('modal-root');
    if (root) root.replaceChildren();
  }),
  openCharacterForm: vi.fn()
}));

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));
vi.mock('../js/modules/characters/index.js', () => ({
  openCharacterProfile: vi.fn(), openCharacterForm: mocks.openCharacterForm
}));
vi.mock('../js/core/ui.js', () => ({
  toast: vi.fn(), showModal: mocks.showModal, closeModal: mocks.closeModal,
  confirmModal: vi.fn(async () => true)
}));
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
  <p class="row gap" id="welcome-row"><button id="welcome-btn">💡 С чего начать</button></p>
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

  it('строка приветствия видна только при пустом активном списке', async () => {
    const { renderCharacters } = await import('../js/modules/characters/list.js');
    const row = document.getElementById('welcome-row');
    expect(row.hidden).toBe(true);

    state.characters = [];
    state.settings.ui.onboardingSeen = true;
    renderCharacters();
    expect(row.hidden).toBe(false);
  });

  it('CSS скрывает welcome-row даже при display:flex у общего класса row', () => {
    expect(onboardingCss).toMatch(/#welcome-row\[hidden\]\s*\{\s*display:\s*none\s*;/);
    expect(document.getElementById('welcome-row').hidden).toBe(true);
  });

  it('кнопка повторно открывает приветствие, а действие шага переключает на нужный экран', async () => {
    document.getElementById('welcome-btn').click();
    await vi.waitFor(() => expect(mocks.showModal).toHaveBeenCalledTimes(1));
    expect(document.getElementById('modal-root').textContent).toContain('С чего начать');

    document.querySelector('[data-onb="new-character"]').click();
    expect(mocks.closeModal).toHaveBeenCalledTimes(1);
    expect(mocks.openCharacterForm).toHaveBeenCalledWith(null);
    expect(document.getElementById('modal-root').textContent).toBe('');
  });

  it('шаг со справкой закрывает приветствие и оставляет открытой справку', async () => {
    document.getElementById('welcome-btn').click();
    await vi.waitFor(() => expect(mocks.showModal).toHaveBeenCalledTimes(1));
    document.querySelector('[data-onb="open-help"]').click();

    await vi.waitFor(() => expect(mocks.showModal).toHaveBeenCalledTimes(2));
    expect(mocks.closeModal).toHaveBeenCalledTimes(1);
    expect(mocks.showModal.mock.calls[1][0].title).toBe('Как войти на сайт игры');
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
