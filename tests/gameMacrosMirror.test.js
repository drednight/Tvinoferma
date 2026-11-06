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
  expect(args.shortcuts).toContain('CTRL+ALT+F12');
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
