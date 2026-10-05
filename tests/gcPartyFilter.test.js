// Окно «GameCenter и персонажи»: фильтр по пати (js/modules/launcher/gcSettingsModal.js).
// Фильтр собирается из реальных пати, умеет «Без пати» и «Только без GameCenter».
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => false }));
vi.mock('../js/modules/launcher/launch.js', () => ({
  gameCenterInfo: vi.fn(), pickGameCenter: vi.fn(), forgetAccount: vi.fn()
}));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ captureLogin: vi.fn(), forgetLogin: vi.fn() }));

let state, openGameCentersModal;
const GC = { id: 'gc-1', name: 'Основной', path: 'D:\\GC1\\GameCenter.exe' };

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ openGameCentersModal } = await import('../js/modules/launcher/gcSettingsModal.js'));
  state.settings.launcher.gameCenters = [GC];
  state.parties = [
    { id: 'p1', name: 'Основа', order: 1 },
    { id: 'p2', name: 'Фарм', order: 2 }
  ];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', launch: {} },
    { id: 'b', nick: 'Бб', class: 'Маг', partyIds: ['p2'], mainPartyId: 'p2', launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'bb' } } } },
    { id: 'c', nick: 'Вв', class: 'Жрец', partyIds: ['p1', 'p2'], mainPartyId: 'p1', launch: {} },
    { id: 'd', nick: 'Гг', class: 'Бард', partyIds: [], mainPartyId: null, launch: {} }
  ];
  openGameCentersModal();
});

const root = () => document.getElementById('gcm-root');
const shownChars = () => [...root().querySelectorAll('.gcm-char')].map(el => el.querySelector('b').textContent);
const partySelect = () => root().querySelector('#gcm-party');
const setParty = (value) => {
  const sel = partySelect();
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('фильтр по пати', () => {
  it('в списке есть «Все пати», «Без пати» и сами пати в их порядке', () => {
    const labels = [...partySelect().options].map(o => o.textContent);
    expect(labels).toEqual(['Все пати', 'Без пати', 'Основа', 'Фарм']);
  });

  it('«Все пати» показывает всех персонажей', () => {
    expect(shownChars()).toEqual(['Аа', 'Бб', 'Вв', 'Гг']);
  });

  it('выбор пати оставляет только её участников', () => {
    setParty('p1');
    expect(shownChars()).toEqual(['Аа', 'Вв']);
    setParty('p2');
    expect(shownChars()).toEqual(['Бб', 'Вв']);
  });

  it('«Без пати» показывает только персонажей без пати', () => {
    setParty('__none__');
    expect(shownChars()).toEqual(['Гг']);
  });

  it('фильтр по пати складывается с поиском по нику', () => {
    setParty('p1');
    const search = root().querySelector('#gcm-filter');
    search.value = 'вв';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shownChars()).toEqual(['Вв']);
  });

  it('«Только без GameCenter» скрывает персонажей с прикреплённым GameCenter', () => {
    const box = root().querySelector('#gcm-unbound');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(shownChars()).not.toContain('Бб');   // у него уже есть GameCenter
    expect(shownChars()).toEqual(['Аа', 'Вв', 'Гг']);
  });

  it('счётчик показывает, сколько скрыто фильтром', () => {
    expect(root().querySelector('#gcm-shown').textContent).toBe('Все персонажи: 4');
    setParty('p1');
    expect(root().querySelector('#gcm-shown').textContent).toBe('Показано: 2 из 4');
  });

  it('пустой результат подсказывает, что делать', () => {
    setParty('p1');
    const search = root().querySelector('#gcm-filter');
    search.value = 'неттакого';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root().textContent).toContain('Никого не найдено');
  });

  it('у персонажа видны его пати, основная помечена', () => {
    const card = root().querySelector('.gcm-char[data-char="c"]');
    const tags = [...card.querySelectorAll('.gcm-tag')].map(t => t.textContent);
    expect(tags).toEqual(['Основа', 'Фарм']);
    expect(card.querySelector('.gcm-tag.is-main').textContent).toBe('Основа');
    expect(root().querySelector('.gcm-char[data-char="d"] .gcm-tag').textContent).toBe('Без пати');
  });

  it('прикреплённый GameCenter отмечен в карточке', () => {
    expect(root().querySelector('.gcm-char[data-char="a"]').classList.contains('is-bound')).toBe(false);
    expect(root().querySelector('.gcm-char[data-char="b"]').classList.contains('is-bound')).toBe(true);
    expect(root().querySelector('.gcm-char[data-char="b"] .gcm-count').textContent).toBe('1');
  });
});
