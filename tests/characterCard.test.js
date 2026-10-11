import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Карточка персонажа в списке: что на ней есть и как она устроена. Контрольный список
// (план п. 3): ник, класс, уровень, бонус к уровню, небесные петы, статус входа, пати
// с цветом, монеты, теги, HP/PA/PZ/PvE-PA/PvE-PZ, email и пароль с копированием и глазом,
// проходки, кнопки (игра, сайт, окно игры, архив/восстановить), выбор, клик в профиль.
const mocks = vi.hoisted(() => ({
  openCharacterProfile: vi.fn(),
  openSyncHelper: vi.fn(),
  launchOne: vi.fn(async () => true)
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

const full = () => ({
  id: 'a', nick: 'Твин', class: 'Воин', level: 130,
  sky: { name: 'Небесный пет', level: 5 },
  isLoggedIn: true, lastLoginCheck: new Date().toISOString(),
  partyIds: ['p1'], mainPartyId: 'p1',
  stats: { hp: 12345, pa: 5678, pz: 91011, pvePa: 1213, pvePz: 1415, levelBonus: 3 },
  contacts: { email: 'player@example.com', password: 'SuperSecret1' },
  dungeonPasses: { weapon: 12, armor: 345, relic: 6 },
  tags: ['мейн', 'твиноферма'], ancientCoins: 285,
  launch: { gcPath: 'C:\\GameCenter' }
});

describe('карточка персонажа: состав', () => {
  let state, renderCharacters, bindCharacters, card;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    ({ renderCharacters, bindCharacters } = await import('../js/modules/characters/list.js'));
    state.parties = [{ id: 'p1', name: 'Основная', color: 'red', memberLinks: [{ characterId: 'a', isMain: true }] }];
    state.archivedParties = [];
    state.characters = [full()];
    bindCharacters();
    renderCharacters();
    card = document.querySelector('.character-card');
  });

  it('ник, класс, уровень и бонус к уровню — в шапке', () => {
    expect(card.querySelector('.char-nick').textContent).toBe('Твин');
    const facts = card.querySelector('.char-facts');
    expect(facts.textContent).toContain('Воин');
    expect(facts.textContent).toContain('Ур. 130');
    expect(facts.querySelector('.char-bu').textContent).toBe('3 БУ');
  });

  it('небо — отдельной строкой под фактами, без пояснения в подсказке', () => {
    const sky = card.querySelector('.char-sky');
    expect(sky).not.toBeNull();
    expect(sky.textContent).toBe('Небесный пет (Ур.5)');
    // Небо стоит под фактами, а не в одной строке с классом и уровнем
    expect(sky.parentElement).toBe(card.querySelector('.char-ident'));
    expect(card.querySelector('.char-facts').textContent).not.toContain('Небесный пет');
    // Пояснение «небесные петы» убрано: подпись говорит сама за себя
    expect(sky.getAttribute('title')).toBeNull();
  });

  it('древние монеты всегда прижаты к правому краю ряда значков', () => {
    const meta = card.querySelector('.card-meta');
    expect(meta.querySelector('.card-coins')).not.toBeNull();
    const css = readFileSync('css/modules/characters.css', 'utf8');
    expect(css).toMatch(/\.card-meta \.card-coins \{[^}]*margin-left:\s*auto/);
  });

  it('статус входа показывается точкой и подписью', () => {
    const status = card.querySelector('.state');
    expect(status).not.toBeNull();
    expect(status.textContent).toMatch(/Онлайн/);
    expect(card.style.getPropertyValue('--state-c')).toBeTruthy();
  });

  it('пати с цветом, монеты и теги — одним рядом значков', () => {
    const party = card.querySelector('.card-party');
    expect(party.textContent).toContain('Основная');
    expect(party.classList.contains('has-color')).toBe(true);
    expect(party.getAttribute('style')).toContain('--party-c:');
    expect(card.querySelector('.card-coins').textContent).toContain('285');
    // Ряд значек один: пати, монеты и теги не занимают три строки, как раньше
    expect([...card.querySelector('.card-meta').children].map(el => el.className.split(' ')[0]))
      .toEqual(['badge', 'badge', 'card-tags']);
    expect(card.querySelectorAll('.tag-chip').length).toBe(2);
  });

  it('все пять показателей HP/PA/PZ/PvE-PA/PvE-PZ на месте', () => {
    const cells = [...card.querySelectorAll('.card-stats > div')]
      .map(d => `${d.querySelector('.muted').textContent}=${d.querySelector('strong').textContent}`);
    expect(cells.join(' ')).toBe('HP=12345 PA=5678 PZ=91011 PvE-PA=1213 PvE-PZ=1415');
  });

  it('email и пароль: значение, копирование и глаз', () => {
    const email = card.querySelector('.contact-value[data-type="email"]');
    const pass = card.querySelector('.contact-value[data-type="password"]');
    expect(email.dataset.original).toBe('player@example.com');
    expect(email.textContent).toContain('•••');           // по умолчанию замаскировано
    expect(pass.dataset.original).toBe('SuperSecret1');
    expect(email.closest('.contact-row-mini').classList.contains('is-empty')).toBe(false);
    // Глаз — кнопка рядом со значением, копирование — по значению
    expect(email.parentElement.querySelector('.mini-toggle-eye').dataset.target).toBe('email');
    expect(pass.parentElement.querySelector('.mini-toggle-eye').dataset.target).toBe('password');
    // Оба контакта в одной сетке, а не двумя строками подряд: в стилях колонок две
    const css = readFileSync('css/modules/characters.css', 'utf8');
    expect(css).toMatch(/\.card-contacts\s*{[^}]*grid-template-columns:\s*1fr 1fr/);
  });

  it('проходки с числом в каждой', () => {
    const passes = [...card.querySelectorAll('.pass-item')];
    expect(passes.map(p => p.textContent)).toEqual(['12', '345', '6']);
    expect(passes[0].getAttribute('title')).toBe('Оружие: 12');
  });

  it('кнопки: игра, сайт, архив — и клик по карточке ведёт в профиль', () => {
    expect(card.querySelector('.card-actions .play')).not.toBeNull();
    expect(card.querySelector('.card-actions [aria-label="Открыть сайт"]')).not.toBeNull();
    expect(card.querySelector('.card-actions .archive-character-action')).not.toBeNull();
    expect(card.querySelector('.card-actions .restore-character-action')).toBeNull();
    card.querySelector('.card-header').click();
    expect(mocks.openCharacterProfile).toHaveBeenCalledWith(state.characters[0]);
  });
});

describe('карточка персонажа: действия кнопок', () => {
  let state, renderCharacters, bindCharacters, card;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    ({ renderCharacters, bindCharacters } = await import('../js/modules/characters/list.js'));
    state.parties = [];
    state.archivedParties = [];
    state.characters = [full()];
    bindCharacters();
    renderCharacters();
    card = document.querySelector('.character-card');
  });

  it('«Играть» запускает игру, а не открывает профиль', async () => {
    card.querySelector('[data-action="launch"]').click();
    await vi.waitFor(() => expect(mocks.launchOne).toHaveBeenCalledWith(state.characters[0]));
    expect(mocks.openCharacterProfile).not.toHaveBeenCalled();
  });

  it('«Открыть сайт» открывает помощник входа, а не профиль', () => {
    card.querySelector('[data-action="site"]').click();
    expect(mocks.openSyncHelper).toHaveBeenCalledWith('a');
    expect(mocks.openCharacterProfile).not.toHaveBeenCalled();
  });

  it('тег фильтрует список по этому тегу', () => {
    card.querySelector('.tag-chip').click();
    expect(document.getElementById('tag-filter').value).toBe('мейн');
  });

  it('пустые контакты: показано «—», а глаз неактивен', () => {
    state.characters = [{ id: 'b', nick: 'Пустой', class: 'Маг', level: 1, contacts: {} }];
    renderCharacters();
    const row = document.querySelector('.character-card .contact-row-mini');
    expect(row.classList.contains('is-empty')).toBe(true);
    expect(row.querySelector('.contact-value').textContent).toBe('—');
  });
});
