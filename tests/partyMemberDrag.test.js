// Hotfix 1.0.1: перетаскивание персонажа внутри пати вешало приложение.
// Причина: обработчики drag-and-drop накапливались на `#party-list` при каждой перерисовке,
// и один drop запускал десятки сохранений и перерисовок, каждая из которых добавляла новые обработчики.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}) }));

vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist, saveNow: vi.fn(async () => {}), isTauri: () => false }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), confirmModal: vi.fn(async () => true), showModal: vi.fn(), closeModal: vi.fn() }));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ launchGroup: vi.fn(), closePartyWindows: vi.fn(), showCloseReport: vi.fn() }));
vi.mock('../js/modules/launcher/launch.js', () => ({
  hasGameCenterPath: () => true, loginStatusText: () => '', launchContext: () => ({ gameCenters: [], preferredId: '' }),
  runningClientDetails: vi.fn(), closeClientsByPid: vi.fn()
}));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));

let state, renderParties, order;

const dnd = (type, target, extra = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '', dropEffect: '' };
  Object.assign(ev, extra);
  target.dispatchEvent(ev);
  return ev;
};
const row = (id) => document.querySelector(`.pt-member[data-char-id="${id}"]`);
const drag = (fromId, toId) => {
  dnd('dragstart', row(fromId).querySelector('.pt-drag'));
  dnd('dragover', row(toId), { clientY: 0 });
  dnd('drop', row(toId), { clientY: 0 });
};
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  mocks.persist.mockClear();
  document.body.innerHTML = '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  ({ renderPartiesGrid: renderParties } = await import('../js/modules/parties/renderer.js'));
  ({ charactersInPartyOrdered: order } = await import('../js/modules/parties/membership.js'));
  state.parties = [{ id: 'p1', name: 'Основа', order: 1 }, { id: 'p2', name: 'Фарм', order: 2 }];
  state.characters = ['a', 'b', 'c'].map((id, i) => ({
    id, nick: id.toUpperCase(), class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', partyOrder: { p1: i + 1 }
  }));
  state.characters.push({ id: 'd', nick: 'D', class: 'Маг', partyIds: ['p2'], mainPartyId: 'p2' });
  // Раскрытая карточка, чтобы строки были в DOM
  renderParties();
});

describe('перетаскивание персонажа внутри пати', () => {
  it('меняет порядок и сохраняет ровно один раз', async () => {
    drag('c', 'a');
    await flush();
    expect(order(state.characters, 'p1').map(c => c.id)).toEqual(['c', 'a', 'b']);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('после многих перерисовок один drop по-прежнему даёт одно сохранение и один порядок', async () => {
    for (let i = 0; i < 25; i++) renderParties();
    drag('c', 'a');
    await flush();
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(order(state.characters, 'p1').map(c => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('серия перетаскиваний не раздувает число обработчиков', async () => {
    const spy = vi.spyOn(document.getElementById('party-list'), 'addEventListener');
    for (let i = 0; i < 6; i++) {
      drag(i % 2 ? 'a' : 'c', i % 2 ? 'c' : 'a');
      await flush();
    }
    // Каждая отрисовка вешает фиксированный набор обработчиков (9), а не растущий
    const perRender = spy.mock.calls.length / 6;
    expect(perRender).toBeLessThanOrEqual(9);
    expect(mocks.persist).toHaveBeenCalledTimes(6);
  });

  it('перенос персонажа не пытается переставлять пати', async () => {
    const before = state.parties.map(p => `${p.name}:${p.order}`);
    drag('c', 'a');
    await flush();
    expect(state.parties.map(p => `${p.name}:${p.order}`)).toEqual(before);
  });

  it('в чужую пати персонажа перенести нельзя', async () => {
    dnd('dragstart', row('a').querySelector('.pt-drag'));
    const over = dnd('dragover', row('d'), { clientY: 0 });
    dnd('drop', row('d'), { clientY: 0 });
    await flush();
    expect(over.defaultPrevented).toBe(false);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

describe('перетаскивание карточек пати', () => {
  it('меняет порядок пати местами и сохраняет один раз, даже после перерисовок', async () => {
    for (let i = 0; i < 10; i++) renderParties();
    const head = document.querySelector('.party-card-header[data-party-name="Основа"]');
    const target = document.querySelector('.party-card-modern[data-party-name="Фарм"]');
    dnd('dragstart', head);
    dnd('dragover', target);
    const ev = dnd('drop', target);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(state.parties.find(p => p.name === 'Фарм').order).toBe(1);
    expect(state.parties.find(p => p.name === 'Основа').order).toBe(2);
  });
});
