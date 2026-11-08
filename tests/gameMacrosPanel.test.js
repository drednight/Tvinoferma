import { beforeEach, describe, it, expect, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { mountGameMacros } from '../js/modules/gameMacros/panel.js';
const mocks = vi.hoisted(() => ({
  diagnoseBackground: vi.fn(async () => 'Диагностический отчёт'),
  showSize: vi.fn(),
  openOverlay: vi.fn(),
  run: vi.fn(),
  pickPoint: vi.fn()
}));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/modules/gameMacros/runtime.js', async () => {
  const { normalizeGameMacros } = await import('../js/modules/gameMacros/model.js');
  const { state } = await import('../js/core/state.js');
  return {
    diagnoseBackground: mocks.diagnoseBackground,
    clearLogs: vi.fn(async () => {}),
    config: () => normalizeGameMacros(state.settings.gameMacros),
    toggleKeyboardMirror: vi.fn(async () => {}),
    reconnectInput: vi.fn(async () => {}),
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
it('keeps the master switch in the always-visible summary', () => {
  const toggle = document.querySelector('[data-gm-enabled]');
  const details = document.querySelector('#game-macros-block');
  expect(toggle.closest('summary')).toBe(details.querySelector('summary'));
  expect(toggle.getAttribute('role')).toBe('switch');
  expect(toggle.checked).toBe(false);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  toggle.closest('label').dispatchEvent(click);
  expect(details.open).toBe(false);
  expect(toggle.checked).toBe(true);
  expect(document.querySelector('[data-gm-mirror-source]').value).toBe('any');
});
it('converts key steps to a composition without legacy add-command controls or losing steps', () => {
  document.querySelector('[data-gm-edit]').click();
  const form = document.querySelector('[data-gm-form]');
  form.elements.namedItem('sequence').value = 'CTRL+F9\nwait 200\nF8';
  form.querySelector('[data-gm-to-composition]').click();
  expect(form.elements.namedItem('action').value).toBe('composite');
  expect(form.querySelector('[data-command-picker]')).toBeNull();
  expect([...form.querySelectorAll('[data-step] [data-field="value"]')].map(e => e.value)).toEqual(['CTRL+F9', 'F8']);
  expect(form.querySelector('[data-field="ms"]').value).toBe('200');
});
it('creates three background test commands from the editor without running them', async () => {
  document.querySelector('[data-gm-edit]').click();
  const form = document.querySelector('[data-gm-form]');
  form.querySelector('[name="action"][value="sequence"]').checked = true;
  form.elements.namedItem('sequence').value = 'CTRL+F9';
  form.elements.namedItem('delivery').value = 'background';
  form.dispatchEvent(new Event('change', { bubbles: true }));
  expect(form.querySelector('[data-gm-background-method]').hidden).toBe(false);
  form.querySelector('[data-gm-background-variants]').click();
  await vi.waitFor(() => expect(state.settings.gameMacros.commands).toHaveLength(4));
  expect(state.settings.gameMacros.commands.slice(1).map(c => c.backgroundMethod)).toEqual([
    'post',
    'send-timeout',
    'notify'
  ]);
  expect(state.settings.gameMacros.commands.slice(1).every(c => c.hotkey === '')).toBe(true);
  expect(mocks.run).not.toHaveBeenCalled();
});

it('groups keyboard and mouse repeat controls together', () => {
  const group = document.querySelector('.gm-mirror-buttons');
  expect(group.querySelector('[data-gm-mirror]')).not.toBeNull();
  expect(group.querySelector('[data-gm-mirror-mouse]')).not.toBeNull();
});

it('opens a non-input diagnostic modal and explicitly probes one selected client', async () => {
  document.querySelector('[data-gm-background-probe]').click();
  expect(mocks.diagnoseBackground).not.toHaveBeenCalled();
  document.querySelector('[data-bg-probe-run]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-bg-probe-report]').value).toBe('Диагностический отчёт'));
  expect(mocks.diagnoseBackground).toHaveBeenCalledWith('a', 'B');
  expect(mocks.run).not.toHaveBeenCalled();
});

it('offers journal clearing in the main dialog without running or stopping a command', async () => {
  document.querySelector('[data-gm-logs]').click();
  document.querySelector('[data-gm-clear-logs]').click();
  const runtime = await import('../js/modules/gameMacros/runtime.js');
  await vi.waitFor(() => expect(runtime.clearLogs).toHaveBeenCalledTimes(1));
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
it('copies the current entire main journal without invoking a command', async () => {
  const write = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  document.querySelector('[data-gm-logs]').click();
  document.querySelector('[data-gm-copy-logs]').click();
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Session log'));
  expect(mocks.run).not.toHaveBeenCalled();
});

it('keeps copy and clear next to each other in one journal toolbar', () => {
  document.querySelector('[data-gm-logs]').click();
  const copy = document.querySelector('[data-gm-copy-logs]'),
    clear = document.querySelector('[data-gm-clear-logs]');
  expect(copy.nextElementSibling).toBe(clear);
  expect(copy.parentElement.classList.contains('gm-journal-actions')).toBe(true);
  expect(document.querySelector('[data-gm-copy-status]').parentElement).toBe(copy.parentElement.parentElement);
});

it('requires explicit opt-in before the one-key activity experiment', async () => {
  document.querySelector('[data-gm-background-probe]').click();
  const button = document.querySelector('[data-bg-activity-run]'),
    confirm = document.querySelector('[data-bg-activity-confirm]');
  expect(button.disabled).toBe(true);
  button.click();
  expect(mocks.diagnoseBackground).not.toHaveBeenCalled();
  confirm.checked = true;
  confirm.dispatchEvent(new Event('change'));
  button.click();
  await vi.waitFor(() => expect(mocks.diagnoseBackground).toHaveBeenCalledWith('a', 'B', true));
  expect(mocks.run).not.toHaveBeenCalled();
});
it('does not render the command execution notice below the repeat source', () => {
  expect(document.querySelector('[data-gm-runtime]')).toBeNull();
  expect(document.querySelector('[data-gm-mirror-source]')).not.toBeNull();
  expect(document.querySelector('[data-gm-logs]')).not.toBeNull();
});
it('hides size/profile settings and commands without deleting saved data', () => {
  state.settings.gameMacros.commands.push(
    { id: 'size', action: 'resize', name: 'Old size' },
    { id: 'layout', action: 'layout', name: 'Old layout' }
  );
  state.settings.gameMacros.profiles = [{ id: 'saved', name: 'Saved profile', windows: [] }];
  mountGameMacros(document.getElementById('host'));
  expect(document.querySelector('[data-gm-hidden-sizes]').hidden).toBe(true);
  expect(document.querySelector('[data-gm-hidden-profiles]').hidden).toBe(true);
  expect(document.querySelector('[data-gm-select="size"]')).toBeNull();
  expect(document.querySelector('[data-gm-select="layout"]')).toBeNull();
  expect(state.settings.gameMacros.commands.some(row => row.id === 'size')).toBe(true);
  expect(state.settings.gameMacros.profiles[0].id).toBe('saved');
  document.querySelector('[data-gm-create]').click();
  for (const action of ['resize', 'layout'])
    expect(document.querySelector(`[name="action"][value="${action}"]`).closest('label').hidden).toBe(true);
});
