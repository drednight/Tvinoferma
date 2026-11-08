import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (name, callback) => {
    m.listeners.set(name, callback);
    return () => {};
  })
}));
let state, runtime;
const clients = [
  { pid: 10, startedAt: 100, hwnd: 1000, elevated: false, title: 'Alpha — Жрец' },
  { pid: 20, startedAt: 200, hwnd: 2000, elevated: false, title: 'Beta — Воин' },
  { pid: 30, startedAt: 300, hwnd: 3000, elevated: false, title: 'Perfect World' }
];
beforeEach(async () => {
  vi.resetModules();
  m.listeners.clear();
  m.invoke.mockReset();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.characters = [
    { id: 'a', nick: 'Alpha' },
    { id: 'b', nick: 'Beta' }
  ];
  state.settings.gameMacros = { commands: [{ id: 'mirror', action: 'mirror', hotkey: 'CTRL+ALT+F12' }] };
  m.invoke.mockImplementation(async (c, a) =>
    c === 'launcher_running_details'
      ? clients
      : c === 'game_macro_mirror'
        ? a.operation === 'start' || a.operation === 'heartbeat'
        : null
  );
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
afterEach(async () => {
  await runtime.disableKeyboardMirror();
});
it('toggle selects all known clients without requiring a party; unknown clients excluded', async () => {
  await runtime.run('mirror');
  expect(runtime.snapshot().mirroring).toBe(true);
  const [, args] = m.invoke.mock.calls.find(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start');
  expect(args.targets).toEqual([
    { pid: 10, startedAt: 100 },
    { pid: 20, startedAt: 200 }
  ]);
  expect(args.shortcuts).not.toContain('CTRL+ALT+F12');
  expect(args.shortcuts).toContain('CTRL+ALT+PAUSE');
  expect(m.listeners.has('game-macro-mirror-state')).toBe(true);
  await runtime.run('mirror');
  expect(runtime.snapshot().mirroring).toBe(false);
  expect(
    m.invoke.mock.calls.some(
      ([c, a]) => c === 'game_macro_mirror' && a.operation === 'stop' && a.sessionId === args.sessionId
    )
  ).toBe(true);
});
it('stop switches off even when hotkey registration is disabled', async () => {
  await runtime.toggleKeyboardMirror();
  expect(runtime.snapshot().registered).toBe(false);
  runtime.stop();
  await vi.waitFor(() => expect(runtime.snapshot().mirroring).toBe(false));
});
it('reacts only to matching native session status; no keystroke events cross IPC', async () => {
  await runtime.toggleKeyboardMirror();
  const [, args] = m.invoke.mock.calls.find(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start');
  const callback = m.listeners.get('game-macro-mirror-state');
  callback({ payload: { sessionId: 'old', active: false, reason: 1 } });
  expect(runtime.snapshot().mirroring).toBe(true);
  callback({ payload: { sessionId: args.sessionId, active: false, reason: 3 } });
  expect(runtime.snapshot().mirroring).toBe(false);
  expect(runtime.snapshot().logs.join(' ')).toContain('Игровое окно изменилось');
  expect([...m.listeners.keys()]).not.toContain('keyboard-event');
});
it('stops a start that was cancelled while native activation was pending', async () => {
  let resolveStart;
  m.invoke.mockImplementation(async (c, a) =>
    c === 'launcher_running_details'
      ? clients
      : c === 'game_macro_mirror' && a.operation === 'start'
        ? new Promise(r => (resolveStart = r))
        : false
  );
  const start = runtime.toggleKeyboardMirror();
  await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
  await runtime.disableKeyboardMirror();
  resolveStart(true);
  await start;
  expect(runtime.snapshot().mirroring).toBe(false);
  expect(
    m.invoke.mock.calls.filter(([c, a]) => c === 'game_macro_mirror' && a.operation === 'stop').length
  ).toBeGreaterThan(1);
});
it('refuses ambiguous nicknames and never starts with fewer than two verified clients', async () => {
  state.characters.push({ id: 'other', nick: 'Beta' });
  await runtime.toggleKeyboardMirror();
  expect(m.invoke.mock.calls.some(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start')).toBe(false);
  expect(runtime.snapshot().mirroring).toBe(false);
});
it('does not enable itself on initialization and persists no active state', async () => {
  await runtime.initGameMacros();
  expect(runtime.snapshot().mirroring).toBe(false);
  expect(m.invoke.mock.calls.some(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start')).toBe(false);
  expect(state.settings.gameMacros.mirroring).toBeUndefined();
});
it('switches mouse and keyboard independently, including mouse-only mode', async () => {
  await runtime.toggleKeyboardMirror('mouse');
  expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: false, mirrorMouse: true });
  let starts = () => m.invoke.mock.calls.filter(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start');
  expect(starts().at(-1)[1]).toMatchObject({ keyboard: false, mouse: true });
  await runtime.toggleKeyboardMirror();
  expect(starts().at(-1)[1]).toMatchObject({ keyboard: true, mouse: true });
  await runtime.toggleKeyboardMirror('mouse');
  expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: false });
  await runtime.toggleKeyboardMirror();
  expect(runtime.snapshot()).toMatchObject({ mirroring: false, mirrorKeys: false, mirrorMouse: false });
});
it('exposes activation failures as a persistent status, not only a log', async () => {
  state.characters = [];
  await runtime.toggleKeyboardMirror();
  expect(runtime.snapshot().notice).toContain('Повтор не включён');
  expect(runtime.snapshot().notice).toContain('2–30');
});
it('allows a mouse toggle as an editable command and does not persist active modes', async () => {
  state.settings.gameMacros.commands.push({ id: 'mouse', name: 'Мышь', action: 'mouse-mirror' });
  await runtime.run('mouse');
  expect(runtime.snapshot()).toMatchObject({ mirrorKeys: false, mirrorMouse: true });
  expect(state.settings.gameMacros.mirrorMouse).toBeUndefined();
});
it('logs only the active session input diagnostics and identifies the delayed key on overflow', async () => {
  await runtime.toggleKeyboardMirror();
  const id = m.invoke.mock.calls.find(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start')[1].sessionId;
  const trace = m.listeners.get('game-macro-mirror-input');
  trace({ payload: { sessionId: 'stale', events: [{ vk: 0x71, up: false, recipients: 1 }] } });
  expect(runtime.snapshot().logs.join(' ')).not.toContain('Повтор: F2');
  trace({ payload: { sessionId: id, events: [{ vk: 0x78, up: false, recipients: 1, ageMs: 18 }] } });
  expect(runtime.snapshot().logs.join(' ')).toContain('Повтор: F9');
  m.listeners.get('game-macro-mirror-state')({
    payload: { sessionId: id, active: false, reason: 1, failedInput: { vk: 0x78, up: false, ageMs: 265 } }
  });
  expect(runtime.snapshot().notice).toContain('F9');
  expect(runtime.snapshot().notice).toContain('265 мс');
});
it('pins the configured PL as source while keeping all recognized recipients in the snapshot', async () => {
  state.settings.gameMacros.mirrorSource = 'leader';
  state.settings.gameMacros.partyId = 'p';
  state.settings.gameMacros.leaders = { p: 'a' };
  await runtime.toggleKeyboardMirror();
  const args = m.invoke.mock.calls.find(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start')[1];
  expect(args.source).toEqual({ pid: 10, startedAt: 100, hwnd: 1000 });
  expect(args.targets).toHaveLength(2);
});
it('refuses PL-only mirroring without a recognized PL, without silently using another window', async () => {
  state.settings.gameMacros.mirrorSource = 'leader';
  await runtime.toggleKeyboardMirror();
  expect(runtime.snapshot().executionState).toBe('failed');
  expect(runtime.snapshot().notice).toContain('назначьте ПЛ');
  expect(m.invoke.mock.calls.some(([c, a]) => c === 'game_macro_mirror' && a.operation === 'start')).toBe(false);
});
it('keeps keyboard and mouse enabled through an ordinary command and unchanged hotkey configuration', async () => {
  await runtime.toggleKeyboardMirror();
  await runtime.toggleKeyboardMirror('mouse');
  state.settings.gameMacros.commands.push({ id: 'key', action: 'sequence', sequence: 'F8', target: 'all' });
  m.invoke.mockClear();
  await runtime.run('key');
  await runtime.configure();
  expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: true });
  expect(m.invoke.mock.calls.some(([name, args]) => name === 'game_macro_mirror' && args.operation === 'stop')).toBe(
    false
  );
});
it('reconfigures shortcuts without resetting selected repeat modes', async () => {
  state.settings.gameMacros.enabled = true;
  await runtime.toggleKeyboardMirror();
  await runtime.toggleKeyboardMirror('mouse');
  const modes = [];
  const capture = () => modes.push(runtime.snapshot());
  window.addEventListener('tf-game-macros-changed', capture);
  try {
    state.settings.gameMacros.commands[0].hotkey = 'CTRL+ALT+F11';
    m.invoke.mockClear();
    await runtime.configure();
    expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: true });
    const start = m.invoke.mock.calls.find(
      ([name, args]) => name === 'game_macro_mirror' && args.operation === 'start'
    );
    expect(start[1]).toMatchObject({ keyboard: true, mouse: true });
    expect(start[1].shortcuts).toContain('CTRL+ALT+F11');
    expect(modes.every(row => row.mirrorKeys && row.mirrorMouse)).toBe(true);
  } finally {
    window.removeEventListener('tf-game-macros-changed', capture);
  }
});
it('does not disable repeat when pausing macros, but explicit stop still disables both modes', async () => {
  await runtime.toggleKeyboardMirror();
  await runtime.toggleKeyboardMirror('mouse');
  state.settings.gameMacros.commands.push({ id: 'pause', action: 'pause' });
  await runtime.run('pause');
  expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: true });
  runtime.stop();
  await vi.waitFor(() => expect(runtime.snapshot().mirroring).toBe(false));
  expect(runtime.snapshot()).toMatchObject({ mirrorKeys: false, mirrorMouse: false });
});
it('does not re-enable repeat if the user stops during a settings refresh', async () => {
  await runtime.toggleKeyboardMirror();
  let releaseStop;
  m.invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? clients
      : name === 'game_macro_mirror'
        ? args.operation === 'stop' && args.sessionId
          ? new Promise(resolve => {
              releaseStop = resolve;
            })
          : args.operation === 'start' || args.operation === 'heartbeat'
        : null
  );
  state.settings.gameMacros.commands[0].hotkey = 'CTRL+ALT+F11';
  m.invoke.mockClear();
  const refreshing = runtime.configure();
  await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'));
  runtime.stop();
  releaseStop(true);
  await refreshing;
  expect(runtime.snapshot()).toMatchObject({ mirroring: false, mirrorKeys: false, mirrorMouse: false });
  expect(m.invoke.mock.calls.some(([name, args]) => name === 'game_macro_mirror' && args.operation === 'start')).toBe(
    false
  );
});
it('toggles only mouse mode through the overlay event and preserves keyboard mode', async () => {
  await runtime.initGameMacros();
  await runtime.toggleKeyboardMirror();
  const toggle = m.listeners.get('game-overlay-mouse-toggle');
  expect(toggle).toBeTypeOf('function');
  toggle({ payload: { enabled: true } });
  await vi.waitFor(() =>
    expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: true })
  );
  toggle({ payload: { enabled: false } });
  await vi.waitFor(() =>
    expect(runtime.snapshot()).toMatchObject({ mirroring: true, mirrorKeys: true, mirrorMouse: false })
  );
});

it('does not re-enable from a stale overlay disable request after native protective stop', async () => {
  await runtime.toggleKeyboardMirror('mouse');
  const [, args] = m.invoke.mock.calls.find(
    ([name, args]) => name === 'game_macro_mirror' && args.operation === 'start'
  );
  m.listeners.get('game-macro-mirror-state')({ payload: { sessionId: args.sessionId, active: false, reason: 6 } });
  m.invoke.mockClear();
  await runtime.setMirrorEnabled('mouse', false);
  expect(runtime.snapshot().mirrorMouse).toBe(false);
  expect(m.invoke).not.toHaveBeenCalled();
});
it('duplicate explicit mouse-off requests cannot toggle the mode back on', async () => {
  await runtime.toggleKeyboardMirror('mouse');
  await runtime.setMirrorEnabled('mouse', false);
  await runtime.setMirrorEnabled('mouse', false);
  expect(runtime.snapshot()).toMatchObject({ mirrorMouse: false, mirroring: false });
});

it('reconnects only enabled mirror modes and explicit Stop wins over a pending reconnect', async () => {
  await runtime.toggleKeyboardMirror();
  const original = m.invoke.getMockImplementation();
  let finish;
  m.invoke.mockImplementation((c, a) =>
    c === 'game_macro_input_idle'
      ? true
      : c === 'game_macro_bindings' && a.bindings.length === 0
        ? new Promise(resolve => {
            finish = resolve;
          })
        : original(c, a)
  );
  const reconnect = runtime.reconnectInput();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  runtime.stop();
  m.invoke.mockImplementation(original);
  finish(null);
  await reconnect;
  expect(runtime.snapshot()).toMatchObject({ mirrorKeys: false, mirrorMouse: false, mirroring: false });
});
