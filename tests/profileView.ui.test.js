import { describe, it, expect, beforeEach, vi } from 'vitest';

// Раскрытая карточка персонажа: меню «Проверить», доп. пати ниже основной, пометка баланса (issues #1, #4, #21)
const mocks = vi.hoisted(() => ({ auth: vi.fn(), balance: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/characters/formEditor.js', () => ({ openCharacterForm: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({
  openSyncHelper: vi.fn(), refreshAuthFor: mocks.auth, refreshBalanceFor: mocks.balance
}));

const $ = (s) => document.querySelector(s);
const wait = (ms = 150) => new Promise(r => setTimeout(r, ms));
let state, openCharacterProfile, applyCoinBalance;

const mkChar = (extra = {}) => ({
  id: 'c1', nick: 'Ник', class: 'Маг', level: 100, ancientCoins: 285, lastCoinUpdate: '2025-01-01T00:00:00Z',
  coinHistory: [{ delta: 285, date: '2025-01-01T00:00:00Z' }], isLoggedIn: true, lastLoginCheck: '2025-01-01T10:00:00',
  partyIds: ['p1', 'p2', 'p3'], mainPartyId: 'p1', ...extra
});

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ applyCoinBalance } = await import('../js/core/coins.js'));
  state.parties = [{ id: 'p1', name: 'Основа' }, { id: 'p2', name: 'Фарм' }, { id: 'p3', name: 'Арена' }];
  ({ openCharacterProfile } = await import('../js/modules/characters/profileView.js'));
});

describe('раскрытая карточка', () => {
  it('основная пати отдельной строкой, ниже одна строка «доп. пати» с раскрывающимся списком', async () => {
    openCharacterProfile(mkChar()); await wait();
    expect(document.body.textContent).toContain('Пати: Основа');
    const rows = document.querySelectorAll('[data-extra-party]');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('summary').textContent).toContain('доп. пати: 2');
    expect([...rows[0].querySelectorAll('li')].map(li => li.textContent).sort()).toEqual(['Арена', 'Фарм']);
  });

  it('без дополнительных пати строки нет', async () => {
    openCharacterProfile(mkChar({ partyIds: ['p1'] })); await wait();
    expect(document.querySelector('[data-extra-party]')).toBeNull();
  });

  it('проверка входа — в футере, меню «Проверить» рядом с «Открыть сайт» и «История»', async () => {
    openCharacterProfile(mkChar()); await wait();
    const footer = $('#btn-open-sync-helper-footer').parentElement;
    expect(footer.contains($('#btn-coin-history-footer'))).toBe(true);
    expect(footer.contains($('#pf-check-menu'))).toBe(true);
    expect($('#btn-refresh-coins-header')).toBeNull();            // из шапки кнопки убраны
    expect($('#btn-pf-check').tagName).toBe('BUTTON');            // обычная кнопка, как соседние (та же высота)
    expect($('.pf-menu-list').hidden).toBe(true);
    $('#btn-pf-check').click();
    expect($('.pf-menu-list').hidden).toBe(false);                // список раскрывается и остаётся открытым
    expect($('#btn-check-auth-profile')).toBeNull();
  });

  it('«Вход на сайт» запускает проверку и обновляет строку статуса', async () => {
    const c = mkChar();
    mocks.auth.mockImplementation(async (ch) => { ch.isLoggedIn = false; ch.lastLoginReason = 'not_logged_in'; ch.lastLoginCheck = '2026-10-02T12:00:00'; });
    openCharacterProfile(c); await wait();
    $('#btn-pf-check').click();
    $('[data-pf-check="auth"]').click(); await wait(20);
    expect($('.pf-menu-list').hidden).toBe(true);                 // после выбора пункта меню закрывается
    expect(mocks.auth).toHaveBeenCalledWith(c);
    expect($('#profile-auth-line').textContent).toContain('Оффлайн: не выполнен вход на сайт');
  });

  it('красная пометка баланса исчезает после перепроверки', async () => {
    const c = mkChar();
    mocks.balance.mockImplementation(async (ch) => { applyCoinBalance(ch, 28.5); });
    openCharacterProfile(c); await wait();
    expect($('[data-coin-warn]')).not.toBeNull();
    expect($('[data-pf-coins]').textContent).toContain('Перепроверить');
    $('[data-pf-check="coins"]').click(); await wait(20);
    expect(mocks.balance).toHaveBeenCalledWith(c);
    expect($('[data-coin-warn]')).toBeNull();
    expect($('#profile-coins-block').textContent).toContain('28,5');
    expect($('[data-pf-coins]').textContent).toContain('Баланс Древних монет');
  });

  it('если проверка не удалась, пометка остаётся', async () => {
    mocks.balance.mockImplementation(async () => { throw new Error('нет сети'); });
    openCharacterProfile(mkChar()); await wait();
    $('[data-pf-check="coins"]').click(); await wait(20);
    expect($('[data-coin-warn]')).not.toBeNull();
  });
});
