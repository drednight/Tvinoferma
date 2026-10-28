import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  syncMarathons: vi.fn(),
  marathonUrlOf: () => null,
  SITE_PAGES: [],
  customPages: () => [],
  rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(),
  parseMarathonPage: vi.fn(),
  pickScannerCharacter: () => null,
  loadNewsPage: vi.fn(),
  isNewsUrl: () => false
}));

import { state } from '../js/core/state.js';
import { setAuthChecking } from '../js/modules/sync/authStatus.js';
import { createMarathon, createTask } from '../js/modules/marathons/model.js';
import { bindMarathons, openMarathon } from '../js/modules/marathons/page.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="marathon-list"></div><div id="modal-root"></div>';
  state.characters = [
    { id: 'a', nick: 'А', isLoggedIn: true },
    { id: 'b', nick: 'Б', isLoggedIn: false },
    { id: 'c', nick: 'В', isLoggedIn: true }
  ];
  state.parties = [];
  state.ui.authCheck = { c: 'checking' };
  const m = createMarathon({
    title: 'Марафон',
    startDate: '2026-10-01',
    endDate: '2026-10-30',
    participantIds: ['a', 'b', 'c'],
    tasks: [createTask({ id: 'task', title: 'Тест' })],
    assignments: { a: ['task'], b: ['task'], c: ['task'] }
  });
  state.marathons = [m];
  bindMarathons();
  openMarathon(m.id);
});

describe('статусы авторизации персонажей в марафоне', () => {
  it('использует те же цвета и подписи, что карточки персонажей', () => {
    for (const [id, color, text] of [
      ['a', '#9ece6a', 'Онлайн'],
      ['b', '#f7768e', 'Оффлайн'],
      ['c', '#e0af68', 'Проверка…']
    ]) {
      const cells = [...document.querySelectorAll(`[data-auth-char="${id}"]`)];
      expect(cells.length).toBeGreaterThanOrEqual(2); // матрица и таблица наград
      expect(cells.every(cell => cell.style.getPropertyValue('--state-c') === color)).toBe(true);
      expect(cells.every(cell => cell.title.includes(text))).toBe(true);
    }
  });

  it('обновляет проверку и ответ на месте, не перерисовывая таблицу и не теряя прокрутку', () => {
    const cell = document.querySelector('.mr-name[data-auth-char="a"]');
    setAuthChecking('a', true);
    expect(document.querySelector('.mr-name[data-auth-char="a"]')).toBe(cell);
    expect(cell.style.getPropertyValue('--state-c')).toBe('#e0af68');
    expect(cell.querySelector('[data-auth-label]').textContent).toBe('Проверка…');
    state.characters[0].isLoggedIn = false;
    setAuthChecking('a', false);
    expect(cell.style.getPropertyValue('--state-c')).toBe('#f7768e');
    expect(cell.closest('tr').classList.contains('mr-row--offline')).toBe(true);
    expect(cell.querySelector('[data-auth-label]').textContent).toBe('Оффлайн');
  });
});
