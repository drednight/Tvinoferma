import { describe, it, expect, beforeEach, vi } from 'vitest';

// Режим «Выбрать» → «👥 В пати» → «➕ Создать новую пати…» для выбранных персонажей
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/characters/index.js', () => ({ openCharacterProfile: vi.fn(), openCharacterForm: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAllLoginStatuses: vi.fn(), refreshAllBalances: vi.fn(), openSyncHelper: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));

let state, list;
const modal = () => document.querySelector('#modal-root .modal-container');
const submit = () => /** @type {HTMLButtonElement} */ (modal().querySelector('.modal-footer .btn.primary')).click();

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = `
    <button id="btn-select-mode"></button><div id="bulk-bar" hidden></div><div id="character-grid"></div>
    <div id="modal-root"></div><div id="toast-root"></div>
    ${['total-chars', 'active-parties', 'no-party', 'coins', 'online-count', 'offline-count'].map(k => `<b id="kpi-${k}"></b>`).join('')}
    <select id="class-filter"></select><select id="party-filter"></select><select id="auth-filter"></select><select id="tag-filter"></select><input id="search-input" />`;
  ({ state } = await import('../js/core/state.js'));
  state.parties = [{ id: 'p1', name: 'Старая', order: 1 }];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', updatedAt: 'old' },
    { id: 'b', nick: 'Бб', class: 'Маг', partyIds: [], mainPartyId: null, updatedAt: 'old' },
    { id: 'c', nick: 'Вв', class: 'Лучник', partyIds: [], mainPartyId: null, updatedAt: 'old' }
  ];
  list = await import('../js/modules/characters/list.js');
  list.bindCharacters();
  list.setSelectionMode(true);
  state.ui.selection.add('a'); state.ui.selection.add('b');
  document.getElementById('bulk-bar').hidden = false;
  document.getElementById('bulk-bar').innerHTML = '<button data-bulk="party">В пати</button>';
  document.querySelector('[data-bulk="party"]').click();
});

describe('«В пати» в режиме выбора', () => {
  it('в списке есть существующие пати и пункт «Создать новую», поле названия скрыто, пока выбрана существующая', () => {
    const options = [...modal().querySelectorAll('#bulk-party-select option')].map(o => o.textContent);
    expect(options).toEqual(['Старая', '➕ Создать новую пати…']);
    expect(document.getElementById('bulk-party-new').style.display).toBe('none');
  });

  it('выбор «Создать новую» показывает поле названия и прячет «убрать из пати»', () => {
    const sel = document.getElementById('bulk-party-select');
    sel.value = '__new__';
    sel.dispatchEvent(new Event('change'));
    expect(document.getElementById('bulk-party-new').style.display).toBe('');
    expect(modal().querySelectorAll('[data-existing-only]')[0].style.display).toBe('none');
  });

  it('создаёт пати и собирает в неё выбранных персонажей (остальных не трогает)', () => {
    const sel = document.getElementById('bulk-party-select');
    sel.value = '__new__';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('bulk-party-name').value = '  Ферма-2 ';
    submit();
    expect(state.parties.map(p => p.name)).toEqual(['Старая', 'Ферма-2']);
    const created = state.parties[1];
    const [a, b, c] = state.characters;
    expect(a).toMatchObject({ mainPartyId: created.id, partyIds: ['p1', created.id] });
    expect(b).toMatchObject({ mainPartyId: created.id, partyIds: [created.id] });
    expect(c.partyIds).toEqual([]);
  });

  it('существующая пати по-прежнему работает', () => {
    document.querySelector('#modal-root input[name="op"][value="add"]').checked = true;
    submit();
    expect(state.characters[1].partyIds).toEqual(['p1']);
    expect(state.parties).toHaveLength(1);
  });
});
