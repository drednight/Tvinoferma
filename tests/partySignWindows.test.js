// Кнопка «🔖» в карточке пати: подписать окна игры участников пати (название «Ник — Класс»
// и значок класса). Кнопка появляется только когда у пати реально есть запущенные окна.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launchGroup: vi.fn(),
  closePartyWindows: vi.fn(),
  signPartyWindows: vi.fn(),
  running: []
}));

vi.mock('../js/core/storage.js', () => ({
  persist: vi.fn(async () => {}),
  saveNow: vi.fn(async () => {}),
  isTauri: () => true
}));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({
  launchGroup: mocks.launchGroup,
  closePartyWindows: mocks.closePartyWindows,
  signPartyWindows: mocks.signPartyWindows
}));
vi.mock('../js/modules/launcher/launch.js', () => ({
  hasGameCenterPath: () => true,
  loginStatusText: () => '',
  launchContext: () => ({ gameCenters: [], preferredId: '' })
}));
// Список запущенных окон: кэш общий на приложение, поэтому подменяем его
vi.mock('../js/modules/launcher/runningWindows.js', () => ({
  runningWindows: () => mocks.running,
  onRunningWindows: () => () => {}
}));
vi.mock('../js/core/ui.js', () => ({
  toast: vi.fn(),
  confirmModal: vi.fn(async () => true),
  showModal: vi.fn(),
  closeModal: vi.fn()
}));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));

let state, renderParties;

const cards = () => [...document.querySelectorAll('.pt-card')];
const cardOf = name => cards().find(c => c.dataset.partyName === name);
const signBtn = name => cardOf(name)?.querySelector('.sign-party-action-btn');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.running = [];
  document.body.innerHTML =
    '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div><div id="toast-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ renderPartiesGrid: renderParties } = await import('../js/modules/parties/renderer.js'));
  state.parties = [
    { id: 'p1', name: 'Основа', order: 1 },
    { id: 'p2', name: 'Фарм', order: 2 }
  ];
  state.characters = [
    {
      id: 'a',
      nick: 'Аа',
      class: 'Воин',
      partyIds: ['p1'],
      mainPartyId: 'p1',
      isLoggedIn: true,
      launch: { gcPath: 'D:\\GC', gcAccount: true }
    },
    {
      id: 'b',
      nick: 'Бб',
      class: 'Маг',
      partyIds: ['p2'],
      mainPartyId: 'p2',
      isLoggedIn: false,
      launch: { gcPath: 'D:\\GC', gcAccount: true }
    }
  ];
});

describe('кнопка подписи окон в карточке пати', () => {
  it('появляется у пати с запущенными окнами и стоит рядом с «Запустить»', () => {
    mocks.running = [{ charId: 'a', known: true, nick: 'Аа' }];
    renderParties();
    const btn = signBtn('Основа');
    expect(btn).not.toBeNull();
    expect(btn.closest('.pt-actions')).toBe(cardOf('Основа').querySelector('.pt-actions'));
    expect(cardOf('Основа').querySelector('.launch-party-action-btn')).not.toBeNull();
    // У другой пати своих окон нет — и кнопки у неё нет
    expect(signBtn('Фарм')).toBeNull();
  });

  it('без запущенных окон кнопки нет: подписывать нечего', () => {
    renderParties();
    expect(signBtn('Основа')).toBeNull();
    expect(signBtn('Фарм')).toBeNull();
  });

  it('клик подписывает окна именно этой пати и не раскрывает карточку', async () => {
    mocks.running = [{ charId: 'a', known: true, nick: 'Аа' }];
    renderParties();
    const card = cardOf('Основа');
    signBtn('Основа').click();
    await vi.waitFor(() => expect(mocks.signPartyWindows).toHaveBeenCalledWith('Основа'));
    expect(card.classList.contains('is-expanded')).toBe(false);
  });
});
