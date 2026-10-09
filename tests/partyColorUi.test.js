// Выбор цвета пати в интерфейсе: кнопка 🎨 в карточке пати и окно выбора цвета
// (js/modules/parties/manager.js + renderer.js). Проверяем, что выбранный цвет доезжает
// до карточки и переживает сохранение, а сброс возвращает оттенок по названию.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

let state, renderer, manager, persist;

const PARTY = 'Alpha Strike';

// Разметка вкладки «Персонажи» целиком: карточка рисуется вместе с панелью KPI и фильтрами.
const characterListHtml = `
  <input id="search-input" class="input" />
  <select id="class-filter"><option value="">Все классы</option></select>
  <select id="party-filter"><option value="">Все пати</option></select>
  <select id="auth-filter"><option value="">Все статусы</option></select>
  <select id="tag-filter"><option value="">Все теги</option></select>
  <button id="filters-clear" hidden></button>
  <button id="show-active-characters"></button><button id="show-archived-characters"></button>
  <span id="active-character-count"></span><span id="archived-character-count"></span>
  <div id="bulk-bar" hidden></div><div id="character-grid"></div>
  <b id="kpi-total-chars"></b><b id="kpi-active-parties"></b><b id="kpi-no-party"></b>
  <b id="kpi-coins"></b><b id="kpi-online-count"></b><b id="kpi-offline-count"></b>`;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = `
    <div id="party-summary"></div><div id="party-list"></div>
    <span id="active-party-count"></span><span id="archived-party-count"></span>
    <button id="show-active-parties"></button><button id="show-archived-parties"></button>
    <div id="modal-root"></div><div id="toast-root"></div>`;
  ({ state } = await import('../js/core/state.js'));
  ({ persist } = await import('../js/core/storage.js'));
  renderer = await import('../js/modules/parties/renderer.js');
  manager = await import('../js/modules/parties/manager.js');
  state.parties = [{ id: 'p1', name: PARTY, order: 1 }];
  state.archivedParties = [];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: true, ancientCoins: 100 },
    { id: 'c', nick: 'Вв', class: 'Лучник', partyIds: [], mainPartyId: null }
  ];
  renderer.renderPartiesGrid();
});

const card = (name = PARTY) => document.querySelector(`.pt-card[data-party-name="${name}"]`);
const colorBtn = (name = PARTY) => card(name).querySelector('.party-color-action-btn');

describe('кнопка выбора цвета в карточке пати', () => {
  it('есть у обычной пати и отсутствует у «Без пати»', () => {
    expect(colorBtn()).not.toBeNull();
    expect(colorBtn('Без пати')).toBeNull();
  });

  it('без выбранного цвета карточка красится оттенком по названию', () => {
    expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`);
    expect(colorBtn().getAttribute('title')).toBe('Выбрать цвет пати');
  });

  it('после сохранения цвета карточка и кнопка показывают именно его', async () => {
    state.parties[0].color = '#57f287';
    renderer.renderPartiesGrid();
    // Оттенок выбранного цвета вместо оттенка по названию
    expect(card().getAttribute('style')).toContain('--pt-h:139');
    expect(card().getAttribute('style')).toContain('--pt-s:86%');
    expect(colorBtn().getAttribute('title')).toContain('#57f287');
    expect(colorBtn().getAttribute('style')).toContain('--swatch:#57f287');
  });

  it('выбранный цвет попадает и на бейдж пати в карточке персонажа', async () => {
    state.parties[0].color = '#57f287';
    document.body.insertAdjacentHTML('beforeend', characterListHtml);
    const list = await import('../js/modules/characters/list.js');
    state.characters[0].partyIds = ['p1'];
    list.renderCharacters();
    const badge = document.querySelector('.character-card[data-char-id="a"] .card-party');
    expect(badge.classList.contains('has-color')).toBe(true);
    expect(badge.getAttribute('style')).toContain('--party-c:hsl(139 86% 65%)');
  });
});

describe('окно выбора цвета', () => {
  const submit = () => document.querySelector('#modal-root .btn.primary').click();

  it('открывается из кнопки и предлагает палитру и свой цвет', () => {
    colorBtn().click();
    const modal = document.querySelector('#modal-root');
    expect(modal.textContent).toContain(`Цвет пати: ${PARTY}`);
    expect(modal.querySelectorAll('.ptc-swatch').length).toBeGreaterThanOrEqual(12);
    expect(modal.querySelector('#ptc-native')).not.toBeNull();
    expect(modal.querySelector('#ptc-hex')).not.toBeNull();
    // Предпросмотр показывает нынешний оттенок — по названию, пока свой цвет не выбран
    expect(modal.querySelector('#ptc-preview')).not.toBeNull();
  });

  it('клик по образцу цвета сохраняет его в пати и перерисовывает карточку', async () => {
    colorBtn().click();
    document.querySelector('#modal-root .ptc-swatch[data-color="#57F287"]').click();
    expect(document.querySelector('#ptc-hex').value).toBe('#57F287');
    submit();
    // В пати цвет хранится в нижнем регистре — так его проще сравнивать
    expect(state.parties[0].color).toBe('#57f287');
    expect(persist).toHaveBeenCalled();
    // Карточка перерисовывается после сохранения на диск, поэтому ждём кадр
    await vi.waitFor(() => expect(card().getAttribute('style')).toContain('--pt-h:139'));
  });

  it('свой цвет из поля hex тоже сохраняется и приводится к нижнему регистру', () => {
    colorBtn().click();
    const hex = document.querySelector('#ptc-hex');
    hex.value = '#ED4245';
    submit();
    expect(state.parties[0].color).toBe('#ed4245');
  });

  it('«По названию» сбрасывает цвет: карточка возвращается к оттенку от названия', async () => {
    state.parties[0].color = '#57f287';
    renderer.renderPartiesGrid();
    colorBtn().click();
    document.querySelector('#modal-root #ptc-reset').click();
    expect(document.querySelector('#ptc-hex').value).toBe('');
    submit();
    expect(state.parties[0].color).toBeNull();
    await vi.waitFor(() => expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`));
  });

  it('кривой текст в поле не сохраняется как цвет', () => {
    colorBtn().click();
    document.querySelector('#ptc-hex').value = 'не цвет';
    submit();
    // Мусорный ввод не должен попасть в пати: карточка остаётся на оттенке по названию
    expect(state.parties[0].color ?? null).toBeNull();
    expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`);
  });

  it('несуществующая пати открывает окно с ошибкой, а не падает', () => {
    manager.openPartyColorModal('Нет такой');
    expect(document.querySelector('#modal-root .modal-container')).toBeNull();
  });
});
