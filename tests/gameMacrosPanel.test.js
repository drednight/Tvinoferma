import { beforeEach, describe, it, expect, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { mountGameMacros } from '../js/modules/gameMacros/panel.js';
const mocks = vi.hoisted(() => ({ showSize: vi.fn(), openOverlay: vi.fn(), run: vi.fn(), pickPoint: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/modules/gameMacros/runtime.js', async () => {
  const { normalizeGameMacros } = await import('../js/modules/gameMacros/model.js');
  const { state } = await import('../js/core/state.js');
  return {
    config: () => normalizeGameMacros(state.settings.gameMacros),
    toggleKeyboardMirror: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    initGameMacros: vi.fn(async () => {}),
    snapshot: () => ({ logs: ['Session log'], busy: false, registered: false }),
    openOverlay: mocks.openOverlay,
    run: mocks.run,
    stop: vi.fn(),
    saveProfile: vi.fn(),
    pickPoint: mocks.pickPoint,
    previewCommand: vi.fn(),
    showSize: mocks.showSize,
    applyOverlayPreferences: vi.fn(async () => {})
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  state.parties = [{ id: 'p', name: 'Пати' }];
  state.characters = [{ id: 'a', nick: 'Alpha', class: 'Воин', partyIds: ['p'] }];
  state.settings.gameMacros = {
    partyId: 'p',
    commands: [{ id: 'next', name: '<unsafe>', action: 'next', hotkey: 'CTRL+ALT+F8' }]
  };
  document.body.innerHTML = '<div id="host"></div><div id="modal-root"></div><div id="toast-root"></div>';
  mountGameMacros(document.getElementById('host'));
});
describe('party command workspace', () => {
  it('has one party selector and separate command menu/detail panel', () => {
    expect(document.querySelector('[data-gm-buff-party]')).toBeNull();
    expect(document.querySelector('.gm-command-menu')).not.toBeNull();
    expect(document.querySelector('.gm-command-detail')).not.toBeNull();
    expect(document.querySelector('unsafe')).toBeNull();
    expect(document.querySelector('.gm-command-choice kbd').textContent).toBe('CTRL+ALT+F8');
    expect(document.body.textContent).not.toContain('Глобальные хоткеи');
    expect(document.body.textContent).not.toContain('Перед массовыми');
  });
  it('opens a clean creation modal and can cancel without creating a command', () => {
    expect(document.querySelector('[data-gm-form]')).toBeNull();
    document.querySelector('[data-gm-create]').click();
    const form = document.querySelector('[data-gm-form]');
    expect(form).not.toBeNull();
    expect(form.elements.namedItem('name').value).toBe('');
    document.querySelector('.modal-footer .ghost').click();
    expect(document.querySelector('[data-gm-form]')).toBeNull();
    expect(state.settings.gameMacros.commands).toHaveLength(1);
  });
  it('edits a saved command without confusing its trigger and sent sequence', () => {
    document.querySelector('[data-gm-edit]').click();
    const form = document.querySelector('[data-gm-form]');
    expect(form.elements.namedItem('hotkey').value).toBe('CTRL+ALT+F8');
    expect(form.elements.namedItem('sequence').value).toBe('F8');
  });
  it('saves a new custom command from the modal', async () => {
    document.querySelector('[data-gm-create]').click();
    const form = document.querySelector('[data-gm-form]');
    form.elements.namedItem('name').value = 'Моя команда';
    form.elements.namedItem('sequence').value = 'F7';
    document.querySelector('.modal-footer .primary').click();
    await vi.waitFor(() => expect(state.settings.gameMacros.commands).toHaveLength(2));
    expect(state.settings.gameMacros.commands[1]).toMatchObject({
      name: 'Моя команда',
      sequence: 'F7',
      scope: 'party'
    });
  });
  it('opens overlay preferences and session logs only on request', () => {
    expect(document.querySelector('[data-gm-log-text]')).toBeNull();
    document.querySelector('[data-gm-logs]').click();
    expect(document.querySelector('[data-gm-log-text]').textContent).toBe('Session log');
    document.querySelector('[data-gm-overlay-settings]').click();
    expect(document.querySelector('.gm-overlay-form')).not.toBeNull();
  });
  it('previews the entered physical client boundaries without applying them to game windows', async () => {
    expect(document.querySelector('[data-gm-size="leaderWidth"]').value).toBe('2560');
    expect(document.querySelector('[data-gm-size="leaderHeight"]').value).toBe('1400');
    document.querySelector('[data-gm-size="leaderWidth"]').value = '1920';
    document.querySelector('[data-gm-show-size="leader"]').click();
    await vi.waitFor(() => expect(mocks.showSize).toHaveBeenCalledWith(1920, 1400, 'leader'));
  });
  it('only shows fields for the selected action in the creation dialog', () => {
    document.querySelector('[data-gm-create]').click();
    const form = document.querySelector('[data-gm-form]');
    expect(form.querySelector('[data-gm-click-field]').hidden).toBe(true);
    form.elements.namedItem('action').value = 'click';
    form.dispatchEvent(new Event('change'));
    expect(form.querySelector('[data-gm-click-field]').hidden).toBe(false);
    expect(form.querySelector('[data-gm-sequence-field]').hidden).toBe(true);
  });
});
it('preserves command-menu and page scroll when selecting a command', () => {
  const host = document.querySelector('#host');
  document.querySelector('.gm-command-menu').scrollTop = 137;
  document.documentElement.scrollTop = 430;
  document.querySelector('[data-gm-select]').click();
  expect(host.querySelector('.gm-command-menu').scrollTop).toBe(137);
  expect(document.documentElement.scrollTop).toBe(430);
});
it('edits point name and coordinates in a modal, preserving references and cancellation', async () => {
  const point = { id: 'point', name: 'Свиток', uiScale: '100%', x: 10, y: 20, width: 800, height: 600, dpi: 96 };
  state.settings.gameMacros.points = [point];
  state.settings.gameMacros.commands[0].pointId = 'point';
  mountGameMacros(document.querySelector('#host'));
  expect(document.querySelector('[data-point-char]')).toBeNull();
  expect(document.querySelector('[data-point-edit]').textContent).toContain('Редактировать');
  document.querySelector('[data-point-edit]').click();
  let form = document.querySelector('[data-point-edit-form]');
  form.elements.namedItem('name').value = 'Отменённое имя';
  form.elements.namedItem('x').value = 101;
  document.querySelector('.modal-footer .ghost').click();
  expect(state.settings.gameMacros.points[0]).toEqual(point);
  document.querySelector('[data-point-edit]').click();
  form = document.querySelector('[data-point-edit-form]');
  form.elements.namedItem('name').value = 'Новое имя';
  form.elements.namedItem('x').value = 200;
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() => expect(state.settings.gameMacros.points[0].name).toBe('Новое имя'));
  expect(state.settings.gameMacros.points[0]).toMatchObject({ id: 'point', x: 200 });
  expect(state.settings.gameMacros.commands[0].pointId).toBe('point');
});
