// Кнопка «Закрыть окна пати» в карточке пати: она относится к конкретной пати и стоит рядом
// с «Запустить». Плюс проверка, что закрытие затрагивает окна только этой пати.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launchGroup: vi.fn(),
  closePartyWindows: vi.fn(),
  closeClientsByPid: vi.fn(),
  runningClientDetails: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
  showCloseReport: vi.fn()
}));

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({
  launchGroup: mocks.launchGroup,
  closePartyWindows: mocks.closePartyWindows,
  showCloseReport: mocks.showCloseReport
}));
vi.mock('../js/modules/launcher/launch.js', () => ({
  hasGameCenterPath: () => true,
  loginStatusText: () => '',
  launchContext: () => ({ gameCenters: [], preferredId: '' }),
  runningClientDetails: mocks.runningClientDetails,
  closeClientsByPid: mocks.closeClientsByPid
}));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm, showModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));

let state, renderParties;

const cards = () => [...document.querySelectorAll('.pt-card')];
const cardOf = (name) => cards().find(c => c.dataset.partyName === name);
const closeBtn = (name) => cardOf(name)?.querySelector('.close-party-action-btn');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div><div id="toast-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ renderPartiesGrid: renderParties } = await import('../js/modules/parties/renderer.js'));
  state.parties = [{ id: 'p1', name: 'Основа', order: 1 }, { id: 'p2', name: 'Фарм', order: 2 }];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: true, launch: { gcPath: 'D:\\GC' } },
    { id: 'b', nick: 'Бб', class: 'Маг', partyIds: ['p2'], mainPartyId: 'p2', isLoggedIn: false, launch: { gcPath: 'D:\\GC' } }
  ];
});

describe('кнопка закрытия окон в карточке пати', () => {
  it('есть у пати с персонажами и стоит рядом с «Запустить»', () => {
    renderParties();
    const btn = closeBtn('Основа');
    expect(btn).not.toBeNull();
    expect(btn.closest('.pt-actions')).toBe(cardOf('Основа').querySelector('.pt-actions'));
    expect(cardOf('Основа').querySelector('.launch-party-action-btn')).not.toBeNull();
  });

  it('есть у всех непустых пати, включая «Без пати»', () => {
    state.characters.push({ id: 'c', nick: 'Вв', class: 'Бард', partyIds: [], mainPartyId: null, launch: { gcPath: 'D:\\GC' } });
    renderParties();
    expect(cards().map(c => c.dataset.partyName)).toContain('Без пати');
    expect(closeBtn('Основа')).not.toBeNull();
    expect(closeBtn('Фарм')).not.toBeNull();
    expect(closeBtn('Без пати')).not.toBeNull();
  });

  it('клик вызывает закрытие окон именно этой пати', async () => {
    renderParties();
    closeBtn('Основа').click();
    // Обработчик подгружает модуль запуска динамически, поэтому вызов асинхронный
    await vi.waitFor(() => expect(mocks.closePartyWindows).toHaveBeenCalledWith('Основа'));
    expect(mocks.launchGroup).not.toHaveBeenCalled();
  });

  it('у пустой пати кнопки закрытия нет: закрывать нечего', () => {
    state.parties.push({ id: 'p3', name: 'Пустая', order: 3 });
    renderParties();
    const empty = cards().find(c => c.dataset.partyName === 'Пустая');
    expect(empty.querySelector('.close-party-action-btn')).toBeNull();
    // Но «Запустить» остаётся (она выключена и объясняет, чего не хватает)
    expect(empty.querySelector('.launch-party-action-btn')).not.toBeNull();
  });

  it('клик по кнопке закрытия не раскрывает карточку', () => {
    renderParties();
    const card = cardOf('Основа');
    expect(card.classList.contains('is-expanded')).toBe(false);
    closeBtn('Основа').click();
    expect(card.classList.contains('is-expanded')).toBe(false);
  });

  it('«Запустить» и закрытие не путаются между пати', async () => {
    renderParties();
    closeBtn('Фарм').click();
    await vi.waitFor(() => expect(mocks.closePartyWindows).toHaveBeenCalledWith('Фарм'));
    cardOf('Основа').querySelector('.launch-party-action-btn').click();
    await vi.waitFor(() => expect(mocks.launchGroup).toHaveBeenCalled());
    expect(mocks.launchGroup.mock.calls[0][0]).toContain('Основа');
  });
});

describe('порядок запуска в карточке пати', () => {
  it('у участников есть ручка перетаскивания и номер места', () => {
    state.characters = [
      { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', launch: {} },
      { id: 'b', nick: 'Бб', class: 'Маг', partyIds: ['p1'], mainPartyId: 'p1', launch: {} }
    ];
    renderParties();
    const rows = [...cardOf('Основа').querySelectorAll('.pt-member')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector('.pt-drag')).not.toBeNull();
      expect(row.querySelector('.pt-num').textContent).toMatch(/^[12]$/);
    }
    // Номера идут подряд, а не «1, 1» или «2, 1»
    expect(rows.map(r => r.querySelector('.pt-num').textContent)).toEqual(['1', '2']);
  });
});
