import { beforeEach, describe, it, expect, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { mountGameMacros } from '../js/modules/gameMacros/panel.js';
const mocks = vi.hoisted(() => ({
  diagnoseBackground: vi.fn(async () => 'Диагностический отчёт'),
  showSize: vi.fn(),
  openOverlay: vi.fn(),
  run: vi.fn(),
  pickPoint: vi.fn(),
  listMacroWindows: vi.fn(async () => [])
}));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/modules/gameMacros/runtime.js', async () => {
  const { normalizeGameMacros } = await import('../js/modules/gameMacros/model.js');
  const { state } = await import('../js/core/state.js');
  return {
    diagnoseBackground: mocks.diagnoseBackground,
    listMacroWindows: mocks.listMacroWindows,
    clearLogs: vi.fn(async () => {}),
    config: () => normalizeGameMacros(state.settings.gameMacros),
    toggleKeyboardMirror: vi.fn(async () => {}),
    reconnectInput: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    initGameMacros: vi.fn(async () => {}),
    getExecutionHistory: () => [],
    runBackgroundTrial: vi.fn(),
    controlReceiver: vi.fn(),
    snapshot: () => ({ logs: ['Session log'], busy: false, registered: false }),
    openOverlay: mocks.openOverlay,
    run: mocks.run,
    stop: vi.fn(),
    togglePause: vi.fn(),
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
  it('keeps everyday controls visible and technical tools collapsed below the command list', () => {
    const host = document.querySelector('#host');
    const advanced = host.querySelector('.gm-advanced-tools');
    expect(host.querySelector('.gm-page-heading h3').textContent).toBe('Команды');
    expect(advanced.open).toBe(false);
    for (const selector of [
      '[data-gm-recipients]',
      '[data-gm-overlay]',
      '[data-gm-enabled]',
      '[data-gm-mirror]',
      '[data-gm-mirror-mouse]',
      '[data-gm-pause]',
      '[data-gm-stop]',
      '[data-gm-create]',
      '[data-gm-run]',
      '[data-gm-edit]'
    ]) {
      expect(host.querySelector(selector).closest('.gm-advanced-tools')).toBeNull();
    }
    for (const selector of [
      '[data-gm-diagnostics]',
      '[data-gm-background-probe]',
      '[data-gm-multi-trial]',
      '[data-gm-logs]',
      '[data-gm-transfer]',
      '[data-gm-party]',
      '.gm-points-section'
    ]) {
      expect(advanced.querySelector(selector)).not.toBeNull();
    }
    expect(
      host.querySelector('.gm-command-workbench').compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(host.querySelector('[data-gm-execution-status]').hidden).toBe(true);
  });
  it('preserves expanded sections and search on remount without running a command', () => {
    const host = document.querySelector('#host');
    host.querySelector('.gm-advanced-tools').open = true;
    host.querySelector('.gm-points-section').open = true;
    host.querySelector('.gm-repeat-settings').open = true;
    const search = host.querySelector('[data-gm-search]');
    search.value = 'unsafe';
    search.dispatchEvent(new Event('input'));
    host.querySelector('[data-gm-select]').click();
    expect(host.querySelector('.gm-advanced-tools').open).toBe(true);
    expect(host.querySelector('.gm-points-section').open).toBe(true);
    expect(host.querySelector('.gm-repeat-settings').open).toBe(true);
    expect(host.querySelector('[data-gm-search]').value).toBe('unsafe');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('runs a saved command only from its explicit run button', () => {
    document.querySelector('[data-gm-run]').click();
    expect(mocks.run).toHaveBeenCalledWith('next');
  });
  it('keeps saved pause commands available during execution', () => {
    state.settings.gameMacros.commands = [{ id: 'pause', name: 'Пауза', action: 'pause' }];
    mountGameMacros(document.querySelector('#host'));
    const button = document.querySelector('[data-gm-run]');
    expect(button.hasAttribute('data-gm-pause')).toBe(true);
    button.click();
    expect(mocks.run).toHaveBeenCalledWith('pause');
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
    form.querySelector('[data-add-type="keys"]').click();
    const key = form.querySelector('[data-step="0"] [data-field="value"]');
    key.value = 'F7';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-footer .primary').click();
    await vi.waitFor(() => expect(state.settings.gameMacros.commands).toHaveLength(2));
    expect(state.settings.gameMacros.commands[1]).toMatchObject({
      name: 'Моя команда',
      action: 'composite',
      scope: 'party',
      blocks: [expect.objectContaining({ scope: 'managed', target: 'all', steps: [{ type: 'keys', value: 'F7' }] })]
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
  it('creates commands in a single composition editor, with no exclusive action chooser', () => {
    document.querySelector('[data-gm-create]').click();
    const form = document.querySelector('[data-gm-form]');
    expect(form.querySelector('.gm-action-picker').hidden).toBe(true);
    expect(form.querySelector('[data-gm-composition]').hidden).toBe(false);
    expect(form.querySelector('[data-add-type="keys"]')).not.toBeNull();
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
it('keeps the master switch in the standalone page header', () => {
  const toggle = document.querySelector('[data-gm-enabled]');
  const details = document.querySelector('#game-macros-block');
  expect(details.tagName).toBe('SECTION');
  expect(toggle.closest('.gm-page-heading')).not.toBeNull();
  expect(toggle.getAttribute('role')).toBe('switch');
  expect(toggle.checked).toBe(false);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  toggle.closest('label').dispatchEvent(click);
  expect(details.querySelector(':scope > summary')).toBeNull();
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
it('does not offer bulk creation of experimental variants in the normal editor', () => {
  document.querySelector('[data-gm-edit]').click();
  expect(document.querySelector('[data-gm-background-variants]')).toBeNull();
  expect(mocks.run).not.toHaveBeenCalled();
});

it('groups keyboard and mouse repeat controls together', () => {
  const group = document.querySelector('.gm-mirror-buttons');
  expect(group.querySelector('[data-gm-mirror]')).not.toBeNull();
  expect(group.querySelector('[data-gm-mirror-mouse]')).not.toBeNull();
  expect(group.querySelector('[data-gm-mirror]').textContent).toBe('⌨ ВЫКЛ');
  expect(group.querySelector('[data-gm-mirror-mouse]').textContent).toBe('🖱 ВЫКЛ');
  expect(group.querySelector('[data-gm-mirror]').getAttribute('aria-label')).toContain('клавиатуры');
  expect(group.querySelector('[data-gm-mirror-mouse]').getAttribute('aria-label')).toContain('мыши');
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

it('lets the user choose or disable a twins-only click modifier without automatically enabling mouse repeat', async () => {
  const field = document.querySelector('[data-gm-twins-modifier]');
  expect(field.value).toBe('');
  expect([...field.options].map(o => o.value)).toEqual([
    '',
    'CTRL',
    'ALT',
    'SHIFT',
    'CTRL+ALT',
    'CTRL+SHIFT',
    'ALT+SHIFT',
    'CTRL+ALT+SHIFT'
  ]);
  field.value = 'ALT+SHIFT';
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(state.settings.gameMacros.mirrorTwinsModifier).toBe('ALT+SHIFT'));
  const runtime = await import('../js/modules/gameMacros/runtime.js');
  expect(runtime.toggleKeyboardMirror).not.toHaveBeenCalled();
  expect(state.settings.gameMacros.mirrorSource).toBe('any');
});

it('groups execution controls together and separates repeat configuration in a named block', () => {
  const buttons = document.querySelector('.gm-control-buttons');
  expect([...buttons.querySelectorAll('button')].map(b => b.textContent)).toEqual([
    '⌨ ВЫКЛ',
    '🖱 ВЫКЛ',
    'Ⅱ Пауза',
    '■ Остановить'
  ]);
  const group = document.querySelector('.gm-repeat-settings');
  expect(group.querySelector('legend').textContent).toContain('Повтор клавиатуры и мыши');
  expect(group.contains(document.querySelector('[data-gm-mirror-source]'))).toBe(true);
  expect(group.contains(document.querySelector('[data-gm-twins-modifier]'))).toBe(true);
});

it('filters commands without executing them', () => {
  const search = document.querySelector('[data-gm-search]');
  search.value = 'нет такой';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelector('[data-gm-select]').hidden).toBe(true);
  expect(document.querySelector('[data-gm-no-matches]').hidden).toBe(false);
  expect(mocks.run).not.toHaveBeenCalled();
});
it('offers independent active-window-only mouse modifier, disabled by default and persisted', async () => {
  const input = document.querySelector('[data-gm-active-modifier]');
  expect(input).not.toBeNull();
  expect(input.value).toBe('');
  input.value = 'SHIFT';
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(state.settings.gameMacros.mirrorActiveModifier).toBe('SHIFT'));
  expect(state.settings.gameMacros.mirrorTwinsModifier).toBe('');
});

it('removes obsolete background test shortcuts and the separate journal while retaining E and hybrid checks', () => {
  for (const selector of [
    'trial-wizard',
    'receiver',
    'mirror-observation',
    'trial-table',
    'background-lab',
    'background-journal',
    'input-comparison'
  ]) {
    expect(document.querySelector(`[data-gm-${selector}]`)).toBeNull();
  }
  for (const selector of ['multi-trial', 'modifier-batch', 'modifier-experiments']) {
    expect(document.querySelector(`[data-gm-${selector}]`)).not.toBeNull();
  }
});

it('allows excluding only currently recognized characters and preserves absent exclusions', async () => {
  state.settings.gameMacros.excludedCommandCharacters = ['offline'];
  mocks.listMacroWindows.mockResolvedValue([
    { charId: 'a', known: true, nick: 'Alpha', pid: 10, hwnd: 100, startedAt: 1, elevated: false },
    { known: false, pid: 30 }
  ]);
  document.querySelector('[data-gm-recipients]').click();
  await vi.waitFor(() => expect(document.querySelector('.gm-recipient-picker')).not.toBeNull());
  const checkbox = document.querySelector('[name="character"]');
  expect(checkbox.checked).toBe(true);
  expect(document.querySelectorAll('[name="character"]')).toHaveLength(1);
  checkbox.checked = false;
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() => expect(state.settings.gameMacros.excludedCommandCharacters).toEqual(['offline', 'a']));
});

it('assigns an explicitly chosen checked running leader to its party', async () => {
  mocks.listMacroWindows.mockResolvedValue([
    { charId: 'a', known: true, nick: 'Alpha', pid: 10, hwnd: 100, startedAt: 1, elevated: false }
  ]);
  document.querySelector('[data-gm-recipients]').click();
  await vi.waitFor(() => expect(document.querySelector('[name="leaderChoice"]')).not.toBeNull());
  document.querySelector('[name="leaderChoice"]').value = JSON.stringify(['p', 'a']);
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() => expect(state.settings.gameMacros.leaders.p).toBe('a'));
  expect(state.settings.gameMacros.partyId).toBe('p');
});
it('refuses stale main-window choices if the overlay changed the settings', async () => {
  mocks.listMacroWindows.mockResolvedValue([
    { charId: 'a', known: true, nick: 'Alpha', pid: 10, hwnd: 100, startedAt: 1, elevated: false }
  ]);
  document.querySelector('[data-gm-recipients]').click();
  await vi.waitFor(() => expect(document.querySelector('[name="character"]')).not.toBeNull());
  state.settings.gameMacros.excludedCommandCharacters = ['a'];
  document.querySelector('.modal-footer .primary').click();
  await vi.waitFor(() => expect(document.querySelector('#toast-root').textContent).toContain('Настройки изменились'));
  expect(state.settings.gameMacros.excludedCommandCharacters).toEqual(['a']);
});

it('assigns and clears the leader of the explicitly selected party from settings', async () => {
  const leader = document.querySelector('[data-gm-leader]');
  expect(leader.value).toBe('');
  leader.value = 'a';
  leader.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(state.settings.gameMacros.leaders.p).toBe('a'));
  document.querySelector('[data-gm-leader]').value = '';
  document.querySelector('[data-gm-leader]').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(state.settings.gameMacros.leaders.p).toBeUndefined());
});
