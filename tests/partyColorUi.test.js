// Выбор цвета пати (js/modules/parties/manager.js + renderer.js): цвет задаётся в настройках пати
// и попадает в карточку пати и в бейдж пати на карточке персонажа.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/archive/archive.js', () => ({ archiveParty: vi.fn(async () => true) }));

let state, renderer, manager, persist;

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

const PARTY = 'Alpha Strike';

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
const openSettings = () => {
  manager.openEditPartyModal(PARTY);
  return document.querySelector('#modal-root');
};
const submit = () => document.querySelector('#modal-root .btn.primary').click();

describe('цвет и архив убраны из карточки в настройки', () => {
  it('в карточке остались только запуск, закрытие окон и настройки', () => {
    const actions = card().querySelector('.pt-actions');
    expect(actions.querySelector('.launch-party-action-btn')).not.toBeNull();
    expect(actions.querySelector('.close-party-action-btn')).not.toBeNull();
    expect(actions.querySelector('.edit-party-action-btn')).not.toBeNull();
    // Цвет и архив переехали в настройки: в карточке их больше нет
    expect(actions.querySelector('.party-color-action-btn')).toBeNull();
    expect(actions.querySelector('.archive-party-action-btn')).toBeNull();
  });

  it('у «Без пати» нет кнопки настроек, как и раньше', () => {
    expect(card('Без пати').querySelector('.edit-party-action-btn')).toBeNull();
  });
});

describe('настройки пати', () => {
  it('в окне есть название, состав, цвет и опасная зона', () => {
    const modal = openSettings();
    expect(modal.querySelector('#edit-party-name-input')).not.toBeNull();
    expect(modal.querySelectorAll('.member-checkbox').length).toBe(2);
    expect(modal.querySelector('[data-party-color]')).not.toBeNull();
    expect(modal.querySelector('#archive-this-party-btn')).not.toBeNull();
    expect(modal.querySelector('#delete-this-party-btn')).not.toBeNull();
  });

  it('клик по образцу цвета сохраняет его вместе с остальными полями', async () => {
    openSettings();
    document.querySelector('#modal-root .ptc-swatch[data-color="#57F287"]').click();
    expect(document.querySelector('#ptc-hex').value).toBe('#57F287');
    submit();
    // В пати цвет хранится в нижнем регистре — так его проще сравнивать
    expect(state.parties[0].color).toBe('#57f287');
    expect(persist).toHaveBeenCalled();
    await vi.waitFor(() => expect(card().getAttribute('style')).toContain('--pt-h:139'));
  });

  it('свой цвет из поля hex сохраняется', () => {
    openSettings();
    document.querySelector('#ptc-hex').value = '#ED4245';
    submit();
    expect(state.parties[0].color).toBe('#ed4245');
  });

  it('«По названию» сбрасывает цвет: карточка возвращается к оттенку от названия', async () => {
    state.parties[0].color = '#57f287';
    renderer.renderPartiesGrid();
    openSettings();
    document.querySelector('#modal-root #ptc-reset').click();
    expect(document.querySelector('#ptc-hex').value).toBe('');
    submit();
    expect(state.parties[0].color).toBeNull();
    await vi.waitFor(() => expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`));
  });

  it('кривой текст в поле не сохраняется как цвет', () => {
    openSettings();
    document.querySelector('#ptc-hex').value = 'не цвет';
    submit();
    // Мусорный ввод не должен попасть в пати: карточка остаётся на оттенке по названию
    expect(state.parties[0].color ?? null).toBeNull();
    expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`);
  });

  it('цвет сохраняется вместе с переименованием и составом', () => {
    openSettings();
    document.querySelector('#edit-party-name-input').value = 'Новое имя';
    document.querySelector('#modal-root .ptc-swatch[data-color="#ED4245"]').click();
    const other = document.querySelector('.member-checkbox[data-char-id="c"]');
    if (other) other.checked = true;
    submit();
    expect(state.parties[0].name).toBe('Новое имя');
    expect(state.parties[0].color).toBe('#ed4245');
  });

  it('несуществующая пати открывает окно с ошибкой, а не падает', () => {
    manager.openEditPartyModal('Нет такой');
    expect(document.querySelector('#modal-root .modal-container')).toBeNull();
  });
});

describe('перенос в архив из настроек', () => {
  it('после подтверждения вызывает archiveParty с id пати', async () => {
    const { archiveParty } = await import('../js/modules/archive/archive.js');
    openSettings();
    document.getElementById('archive-this-party-btn').click();
    document.querySelector('.tf-confirm-overlay [data-act="ok"]').click();
    await vi.waitFor(() => expect(archiveParty).toHaveBeenCalledWith('p1'));
    // Настройки закрываются, чтобы архив не выглядел как «всё ещё открытое окно»
    expect(document.querySelector('#modal-root .modal-container')).toBeNull();
  });

  it('отмена в подтверждении ничего не архивирует', async () => {
    const { archiveParty } = await import('../js/modules/archive/archive.js');
    openSettings();
    document.getElementById('archive-this-party-btn').click();
    document.querySelector('.tf-confirm-overlay [data-act="cancel"]').click();
    await vi.waitFor(() => expect(document.querySelector('.tf-confirm-overlay')).toBeNull());
    expect(archiveParty).not.toHaveBeenCalled();
    // Окно настроек осталось открытым — отмена ничего не должна ломать
    expect(document.querySelector('#edit-party-name-input')).not.toBeNull();
  });
});

describe('цвет доезжает до интерфейса', () => {
  it('без выбранного цвета карточка красится оттенком по названию', () => {
    expect(card().getAttribute('style')).toContain(`--pt-h:${renderer.partyHue(PARTY)}`);
  });

  it('после сохранения цвета карточка красится именно им', () => {
    state.parties[0].color = '#57f287';
    renderer.renderPartiesGrid();
    expect(card().getAttribute('style')).toContain('--pt-h:139');
    expect(card().getAttribute('style')).toContain('--pt-s:86%');
  });

  it('цвет попадает и на бейдж пати в карточке персонажа', async () => {
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
