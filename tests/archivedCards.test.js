import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openCharacterProfile: vi.fn(),
  openSyncHelper: vi.fn(),
  launchOne: vi.fn(),
  restoreCharacter: vi.fn(async () => true)
}));

vi.mock('../js/modules/characters/index.js', () => ({
  openCharacterProfile: mocks.openCharacterProfile,
  openCharacterForm: vi.fn()
}));
vi.mock('../js/modules/sync/syncManager.js', () => ({
  openSyncHelper: mocks.openSyncHelper,
  refreshAllBalances: vi.fn(),
  refreshAllLoginStatuses: vi.fn()
}));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ launchOne: mocks.launchOne }));
vi.mock('../js/modules/archive/archive.js', () => ({ restoreCharacter: mocks.restoreCharacter }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

const body = `
  <input id="search-input" class="input" />
  <select id="class-filter"><option value="">Все классы</option></select>
  <select id="party-filter"><option value="">Все пати</option></select>
  <select id="auth-filter"><option value="">Все статусы</option><option value="online">онлайн</option></select>
  <select id="tag-filter"><option value="">Все теги</option></select>
  <button id="filters-clear" hidden></button>
  <button id="show-active-characters"></button><button id="show-archived-characters"></button>
  <span id="active-character-count"></span><span id="archived-character-count"></span>
  <div id="bulk-bar" hidden></div><div id="character-grid"></div>
  <b id="kpi-total-chars"></b><b id="kpi-active-parties"></b><b id="kpi-no-party"></b>
  <b id="kpi-coins"></b><b id="kpi-online-count"></b><b id="kpi-offline-count"></b>
  <div id="modal-root"></div><div id="toast-root"></div>`;

describe('карточки персонажей в архиве', () => {
  let state, bindCharacters;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    ({ bindCharacters } = await import('../js/modules/characters/list.js'));
    state.parties = [{ id: 'p1', name: 'Основная' }];
    state.archivedParties = [];
    state.characters = [{
      id: 'active', nick: 'Активный', class: 'Воин', level: 1,
      partyIds: [], mainPartyId: null, contacts: {}, stats: {}, dungeonPasses: {}
    }];
    state.archivedCharacters = [{
      id: 'archived', nick: 'Архивный', class: 'Маг', level: 100,
      partyIds: ['p1'], mainPartyId: 'p1', contacts: { email: 'arch@example.com', password: 'secret' },
      stats: { hp: 1234, pa: 567 }, dungeonPasses: { weapon: 3, armor: 2, relic: 1 },
      launch: { gcPath: 'C:\\GameCenter' }, tags: ['архив'], ancientCoins: 42
    }];
    bindCharacters();
    document.getElementById('show-archived-characters').click();
  });

  it('использует ту же полноценную карточку с показателями, проходками и действиями', () => {
    const card = document.querySelector('.archived-character-card');
    expect(card).not.toBeNull();
    expect(card.querySelector('.card-body .card-stats').textContent).toContain('1234');
    expect(card.querySelector('.card-passes').textContent).toContain('3');
    expect(card.querySelector('.card-contacts [data-original="arch@example.com"]')).not.toBeNull();
    expect(card.querySelector('.card-actions .play')).not.toBeNull();
    expect(card.querySelector('.card-actions [aria-label="Открыть сайт"]')).not.toBeNull();
    expect(card.querySelector('.card-actions .restore-character-action')).not.toBeNull();
    expect(card.querySelector('.card-actions .archive-character-action')).toBeNull();
  });

  it('открывает профиль именно архивного персонажа, сайт и игру для него', async () => {
    const archived = state.archivedCharacters[0];
    document.querySelector('.archived-character-card .card-header').click();
    expect(mocks.openCharacterProfile).toHaveBeenCalledWith(archived);

    window.handleOpenSite(archived.id);
    expect(mocks.openSyncHelper).toHaveBeenCalledWith(archived.id);

    await window.handleLaunchChar(archived.id);
    expect(mocks.launchOne).toHaveBeenCalledWith(archived);
  });

  it('восстанавливает персонажа кнопкой в карточке', async () => {
    document.querySelector('.restore-character-action').click();
    await vi.waitFor(() => expect(mocks.restoreCharacter).toHaveBeenCalledWith('archived'));
  });
});
