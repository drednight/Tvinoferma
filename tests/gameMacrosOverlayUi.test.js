import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  drag: vi.fn(),
  close: vi.fn(),
  emitTo: vi.fn(async () => {}),
  handlers: new Map()
}));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async (name, handler) => {
      mocks.handlers.set(name, handler);
      return () => {};
    },
    emitTo: mocks.emitTo
  }));
  vi.doMock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ startDragging: mocks.drag, close: mocks.close })
  }));
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    readFileSync('game-overlay.html', 'utf8'),
    'text/html'
  ).documentElement.innerHTML;
  await import('../js/modules/gameMacros/overlay.js');
  await vi.waitFor(() => expect(document.querySelector('#fold').onclick).toBeTypeOf('function'));
});
it('collapses the native window to its header and restores its content', async () => {
  const fold = document.querySelector('#fold');
  fold.click();
  await vi.waitFor(() => expect(document.body.classList.contains('folded')).toBe(true));
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_fold', { collapsed: true });
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('header [data-action="stop"]')).not.toBeNull();
  fold.click();
  await vi.waitFor(() => expect(document.body.classList.contains('folded')).toBe(false));
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_fold', { collapsed: false });
  expect(fold.getAttribute('aria-expanded')).toBe('true');
});
it('keeps content visible when native collapse fails', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('Denied'));
  document.querySelector('#fold').click();
  await vi.waitFor(() => expect(document.querySelector('#status').textContent).toContain('Не удалось изменить размер'));
  expect(document.body.classList.contains('folded')).toBe(false);
  expect(document.querySelector('#fold').disabled).toBe(false);
});
it('does not start window dragging when a header button is pressed', () => {
  const button = document.querySelector('#fold');
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'button', { value: 0 });
  button.dispatchEvent(event);
  expect(mocks.drag).not.toHaveBeenCalled();
  document.querySelector('header span').dispatchEvent(event);
  expect(mocks.drag).toHaveBeenCalledTimes(1);
});
it('keeps settings and journal inside the overlay using only its top navigation', async () => {
  document.querySelector('header [data-action="stop"]').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'stop' }));
  mocks.invoke.mockClear();
  document.querySelector('[data-view="appearance"]').click();
  expect(document.querySelector('#appearance-screen').hidden).toBe(false);
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(true);
  document.querySelector('[data-view="shortcuts"]').click();
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(false);
  document.querySelector('[data-view="journal"]').click();
  expect(document.querySelector('#journal-screen').hidden).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[data-action="stop"]')).toHaveLength(1);
  expect(document.querySelector('[data-action="settings"]')).toBeNull();
});
it('hides the service panel without hiding assigned shortcuts', () => {
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(true);
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(false);
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(false);
});
it('saves overlay appearance without opening the main app', async () => {
  document.querySelector('[data-view="appearance"]').click();
  document.querySelector('#opacity').value = '55';
  document.querySelector('#topmost').checked = false;
  document.querySelector('#save-appearance').click();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_preferences', {
      opacity: 0.55,
      topmost: false,
      appearance: { textColor: 'light', keyColor: 'gold', commandColor: 'mint', fontSize: 14, hideHeader: false }
    })
  );
});

it('hides navigation using the service-panel button without redundant return buttons', () => {
  document.querySelector('[data-view="journal"]').click();
  expect(document.querySelector('#back-hide')).toBeNull();
  expect(document.querySelector('#back')).toBeNull();
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(true);
  expect(document.querySelector('#journal-screen').hidden).toBe(false);
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(false);
});

it('opens party management inside the overlay and requests launch of a selected party', async () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      parties: [{ id: 'p1', name: 'Пати 1' }],
      partyId: 'p1',
      windows: [{ name: 'Игрок', pid: 123, known: true }]
    }
  });
  document.querySelector('[data-view="party"]').click();
  expect(document.querySelector('#party-screen').hidden).toBe(false);
  expect(document.querySelector('#windows').textContent).toContain('Игрок');
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'party-refresh', partyId: 'p1' })
  );
  // Refresh completion comes from main's snapshot, not just the IPC acknowledgement.
  mocks.handlers.get('game-macro-snapshot')({
    payload: { parties: [{ id: 'p1', name: 'Пати 1' }], partyId: 'p1', busy: false }
  });
  document.querySelector('#party-launch').click();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'party-launch', partyId: 'p1' })
  );
  document.querySelector('[data-view="shortcuts"]').click();
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(false);
});
it('uses visible labeled color swatches rather than dropdowns', () => {
  expect(document.querySelectorAll('.color-options select')).toHaveLength(0);
  const option = document.querySelector('[name="key-color-choice"][value="blue"]');
  option.checked = true;
  option.dispatchEvent(new Event('change'));
  expect(document.querySelector('#key-color').value).toBe('blue');
});

it('puts the latest log entry first and keeps long command names in a separate element from their key', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      commands: [{ name: 'Очень длинное имя '.repeat(10), hotkey: 'CTRL+ALT+F8' }],
      logs: ['первое действие', 'последнее действие'],
      opacity: 0.1
    }
  });
  expect(document.querySelector('#logs').textContent.split('\n')[0]).toBe('последнее действие');
  expect(document.querySelector('#commands li span').textContent).toContain('Очень длинное');
  expect(document.querySelector('#commands li kbd').textContent).toBe('CTRL+ALT+F8');
});
it('applies independent text/key colors and font size, with header recovery on a later snapshot', () => {
  const handler = mocks.handlers.get('game-macro-snapshot');
  handler({
    payload: { appearance: { textColor: 'mint', keyColor: 'blue', fontSize: 18, hideHeader: true }, commands: [] }
  });
  expect(document.documentElement.style.getPropertyValue('--overlay-text')).toBe('#bcefd8');
  expect(document.documentElement.style.getPropertyValue('--overlay-key')).toBe('#b7c2ff');
  expect(document.documentElement.style.getPropertyValue('--overlay-font')).toBe('18px');
  expect(document.body.classList.contains('header-hidden')).toBe(true);
  handler({ payload: { appearance: { hideHeader: false }, commands: [] } });
  expect(document.body.classList.contains('header-hidden')).toBe(false);
});
it('hides both service headings together with the service panel', () => {
  document.querySelector('#info-toggle').click();
  expect([...document.querySelectorAll('[data-service-heading]')].every(el => el.hidden)).toBe(true);
  document.querySelector('#info-toggle').click();
  expect([...document.querySelectorAll('[data-service-heading]')].every(el => !el.hidden)).toBe(true);
});

it('shows the continuous keyboard mirror status without exposing keystrokes', () => {
  mocks.handlers.get('game-macro-snapshot')({ payload: { mirroring: true, commands: [] } });
  expect(document.querySelector('#status').textContent).toContain('клавиатура ВКЛ');
  expect(document.querySelector('#status').textContent).toContain('Ctrl+Alt+Pause');
});
it('colors only the command name, independently of text and key colors, without interpreting HTML', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      appearance: { commandColor: 'violet' },
      logEntries: [{ text: '12:00 · Начало: <img src=x>.', commandName: '<img src=x>' }]
    }
  });
  const label = document.querySelector('#logs span span');
  expect(label.textContent).toBe('<img src=x>');
  expect(label.style.color).toBe('var(--overlay-command)');
  expect(document.querySelector('#logs img')).toBeNull();
  expect(document.documentElement.style.getPropertyValue('--overlay-command')).toBe('#c4a5ff');
});
it('shows a mirror activation error prominently in the overlay status', () => {
  mocks.handlers.get('game-macro-snapshot')({ payload: { notice: 'Повтор не включён: нет игровых окон', logs: [] } });
  expect(document.querySelector('#status').textContent).toContain('нет игровых окон');
});
it('marks terminal status and its journal entry red using the project terminal classes', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      executionState: 'finished',
      notice: 'Завершена: Проба',
      logEntries: [{ text: 'Завершена: Проба', commandName: 'Проба', terminal: true }]
    }
  });
  expect(document.querySelector('#status').dataset.executionState).toBe('finished');
  expect(document.querySelector('#status').textContent).toContain('Завершена');
  expect(document.querySelector('#logs .gm-log-terminal')).not.toBeNull();
});

it('keeps a compact panel control outside the header when the header is hidden', () => {
  mocks.handlers.get('game-macro-snapshot')({ payload: { appearance: { hideHeader: true } } });
  const control = document.querySelector('#floating-panel-toggle');
  expect(control.closest('header')).toBeNull();
  expect(control.closest('#overlay-controls')).toBeNull();
  control.click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(true);
  expect(document.querySelector('#info-toggle').getAttribute('aria-expanded')).toBe('false');
  control.click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(false);
  document.querySelector('[data-view="appearance"]').click();
  expect(document.querySelector('#appearance-screen').hidden).toBe(false);
});

it('requests clearing the shared journal and renders the authoritative empty snapshot', async () => {
  const update = mocks.handlers.get('game-macro-snapshot');
  update({ payload: { logs: ['Старая запись'] } });
  document.querySelector('[data-view="journal"]').click();
  document.querySelector('[data-action="clear-logs"]').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'clear-logs' }));
  expect(document.querySelector('#logs').textContent).toContain('Старая запись');
  update({ payload: { logs: [], logEntries: [] } });
  expect(document.querySelector('#logs').textContent).toBe('');
  update({ payload: { logs: ['Новая запись'] } });
  expect(document.querySelector('#logs').textContent).toContain('Новая запись');
});
it('copies the complete snapshot chronologically rather than the reversed rendered journal', async () => {
  const write = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  mocks.handlers.get('game-macro-snapshot')({
    payload: { logs: ['Первая', 'Вторая'], logEntries: [{ text: 'Первая' }, { text: 'Вторая' }] }
  });
  expect(document.querySelector('#logs').textContent).toBe('Вторая\nПервая\n');
  document.querySelector('#copy-logs').click();
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Первая\nВторая'));
  expect(mocks.invoke).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('#copy-logs').disabled).toBe(false));
  mocks.handlers.get('game-macro-snapshot')({ payload: { logs: [], logEntries: [] } });
  document.querySelector('#copy-logs').click();
  await vi.waitFor(() => expect(document.querySelector('#copy-logs-status').textContent).toContain('Журнал пуст'));
  expect(write).toHaveBeenCalledTimes(1);
});

it('groups copy and clear side by side with feedback below the toolbar', () => {
  const copy = document.querySelector('#copy-logs'),
    clear = document.querySelector('[data-action="clear-logs"]');
  expect(copy.nextElementSibling).toBe(clear);
  expect(copy.parentElement.classList.contains('gm-journal-actions')).toBe(true);
  expect(copy.parentElement.nextElementSibling.id).toBe('copy-logs-status');
});

it('runs the selected command from a labelled play button even without a hotkey', async () => {
  mocks.emitTo.mockClear();
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      commands: [
        { id: 'one', name: 'Первая', hotkey: 'CTRL+F8' },
        { id: 'two', name: 'Вторая' }
      ]
    }
  });
  const rows = document.querySelectorAll('#commands li');
  expect([...rows[0].children].map(node => node.tagName)).toEqual(['BUTTON', 'SPAN', 'KBD']);
  expect(rows[0].querySelector('button').getAttribute('aria-label')).toContain('Первая');
  expect(rows[1].querySelector('kbd').textContent).toBe('Не назначена');
  rows[1].querySelector('button').click();
  await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'game-overlay-run', 'two'));
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('prevents concurrent starts while retaining the pause control', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      busy: true,
      commands: [
        { id: 'one', name: 'Первая' },
        { id: 'pause', allowWhileBusy: true, name: 'Пауза' }
      ]
    }
  });
  const buttons = document.querySelectorAll('#commands button');
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[1].disabled).toBe(false);
});
it('reports delivery failure without claiming execution and allows retry', async () => {
  mocks.emitTo.mockRejectedValueOnce(new Error('denied'));
  mocks.handlers.get('game-macro-snapshot')({ payload: { commands: [{ id: 'one', name: 'Первая' }] } });
  const play = document.querySelector('#commands button');
  play.click();
  await vi.waitFor(() => expect(document.querySelector('#status').textContent).toContain('Не удалось отправить'));
  expect(play.disabled).toBe(false);
});
it('shows a dedicated mouse toggle outside the hideable service panel with honest on/off/paused states', async () => {
  const update = mocks.handlers.get('game-macro-snapshot'),
    button = document.querySelector('#mouse-repeat-toggle');
  update({ payload: { mirrorMouse: false, mirroring: false } });
  expect(button.textContent).toContain('ВЫКЛ');
  expect(button.getAttribute('aria-pressed')).toBe('false');
  mocks.emitTo.mockClear();
  button.click();
  await vi.waitFor(() =>
    expect(mocks.emitTo).toHaveBeenCalledWith('main', 'game-overlay-mouse-toggle', { enabled: true })
  );
  update({ payload: { mirrorMouse: true, mirroring: true } });
  expect(button.textContent).toContain('ВКЛ');
  expect(button.dataset.state).toBe('on');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  document.querySelector('#info-toggle').click();
  expect(button.closest('#overlay-controls')).toBeNull();
  expect(button.hidden).toBe(false);
  update({ payload: { mirrorMouse: true, mirroring: false } });
  expect(button.textContent).toContain('ПРИОСТАНОВЛЕН');
  update({ payload: { mirrorMouse: true, mirroring: true, busy: true } });
  expect(button.disabled).toBe(false);
  update({ payload: { mirrorMouse: false, busy: true } });
  expect(button.disabled).toBe(true);
});

it('keyboard repeat is independent, visible with service panel hidden, and reflects state', async () => {
  const button = document.getElementById('keyboard-repeat-toggle');
  mocks.handlers.get('game-macro-snapshot')({ payload: { mirrorKeys: true, mirrorMouse: false, mirroring: true } });
  expect(button.textContent).toContain('ВКЛ');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  document.getElementById('info-toggle').click();
  expect(button.closest('[hidden]')).toBeNull();
  button.click();
  await vi.waitFor(() =>
    expect(mocks.emitTo).toHaveBeenCalledWith('main', 'game-overlay-keyboard-toggle', { enabled: false })
  );
  mocks.handlers.get('game-macro-snapshot')({ payload: { mirrorKeys: true, mirroring: false } });
  expect(button.textContent).toContain('ПРИОСТАНОВЛЕН');
});
it('requires explicit confirmation before closing all clients from overlay', async () => {
  document.getElementById('party-close-all').click();
  expect(document.getElementById('close-confirm').hidden).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    'game_macro_navigate',
    expect.objectContaining({ action: 'party-close-all' })
  );
  document.getElementById('close-confirm-no').click();
  expect(document.getElementById('close-confirm').hidden).toBe(true);
  document.getElementById('party-close-all').click();
  document.getElementById('close-confirm-yes').click();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'party-close-all', partyId: null })
  );
});
it('offers additional selectable colors in every palette and saves them', async () => {
  for (const id of ['text-color', 'key-color', 'command-color']) {
    expect(document.querySelectorAll(`[name="${id}-choice"]`).length).toBe(9);
    const radio = document.querySelector(`[name="${id}-choice"][value="coral"]`);
    radio.click();
    expect(document.getElementById(id).value).toBe('coral');
  }
  document.getElementById('save-appearance').click();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      'game_macro_overlay_preferences',
      expect.objectContaining({
        appearance: expect.objectContaining({ textColor: 'coral', keyColor: 'coral', commandColor: 'coral' })
      })
    )
  );
});

it('renders real party launch percent and stage without fabricating elapsed-time progress', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      launchProgress: { done: 2, total: 4, percent: 48, stage: 'Alpha: ожидание нового клиента…', status: 'running' }
    }
  });
  expect(document.getElementById('launch-progress').hidden).toBe(false);
  expect(document.getElementById('launch-percent').value).toBe(48);
  expect(document.getElementById('launch-stage').textContent).toContain('48% · Alpha: ожидание нового клиента… · 2/4');
});

it('shows current character, elapsed stage time and terminal launch counts', async () => {
  const started = Date.now() - 65000;
  const progress = {
    status: 'running',
    percent: 45,
    done: 1,
    total: 2,
    stage: 'Ожидаем окно клиента',
    stageStartedAt: started,
    character: { id: 'a', nick: 'Alpha' },
    counts: { launched: 1, alreadyRunning: 2, failed: 0, cancelled: 0, skipped: 0 }
  };
  mocks.handlers.get('game-macro-snapshot')({ payload: { launchProgress: progress } });
  expect(document.getElementById('launch-character').textContent).toBe('Сейчас: Alpha');
  expect(document.getElementById('launch-elapsed').textContent).toContain('1:05');
  expect(document.getElementById('launch-result').hidden).toBe(true);
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      launchProgress: {
        ...progress,
        character: null,
        status: 'warn',
        finishedAt: Date.now(),
        counts: { ...progress.counts, failed: 1 }
      }
    }
  });
  expect(document.getElementById('launch-character').hidden).toBe(true);
  expect(document.getElementById('launch-result').hidden).toBe(false);
  expect(document.getElementById('launch-result').textContent).toContain('Запущено: 1 · Уже работало: 2 · Ошибка: 1');
});
