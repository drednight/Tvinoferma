import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ restoreCharacter: vi.fn(async () => true) }));
vi.mock('../js/modules/archive/archive.js', () => ({ restoreCharacter: mocks.restoreCharacter }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));

describe('копии пати в архиве персонажей', () => {
  let state, renderPartiesGrid, setPartyArchiveView;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="party-summary"></div><div id="party-list"></div>
      <span id="active-party-count"></span><span id="archived-party-count"></span>
      <button id="show-active-parties"></button><button id="show-archived-parties"></button>
      <div id="modal-root"></div><div id="toast-root"></div>`;
    ({ state } = await import('../js/core/state.js'));
    ({ renderPartiesGrid, setPartyArchiveView } = await import('../js/modules/parties/renderer.js'));
    state.parties = [{ id: 'p1', name: 'Основная', order: 1 }];
    state.archivedParties = [];
    state.characters = [{ id: 'active', nick: 'Активный', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1' }];
    state.archivedCharacters = [{ id: 'archived', nick: 'Архивный', class: 'Маг', partyIds: ['p1'], mainPartyId: 'p1' }];
  });

  it('показывает отдельную архивную копию с архивными участниками, оставляя активных отдельно', () => {
    renderPartiesGrid();
    expect(document.querySelectorAll('#party-list .pt-member').length).toBe(1);
    expect(document.querySelector('#party-list').textContent).toContain('Активный');
    expect(document.querySelector('#party-list').textContent).not.toContain('Архивный');

    setPartyArchiveView(true);
    const mirror = document.querySelector('#party-list .pt-card');
    expect(mirror.textContent).toContain('Основная');
    expect(mirror.textContent).toContain('архивные участники активной пати');
    expect(mirror.textContent).toContain('Архивный');
    expect(mirror.textContent).not.toContain('Активный');
    expect(document.getElementById('archived-party-count').textContent).toBe('1');
  });

  it('позволяет восстановить архивного персонажа прямо из копии пати', async () => {
    setPartyArchiveView(true);
    document.querySelector('.restore-archived-member-btn').click();
    await vi.waitFor(() => expect(mocks.restoreCharacter).toHaveBeenCalledWith('archived'));
  });
});
