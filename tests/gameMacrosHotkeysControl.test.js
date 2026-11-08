import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ persist: vi.fn(), invoke: vi.fn(), handlers: new Map() }));
vi.mock('../js/core/storage.js', () => ({ persist: m.persist }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (name, handler) => {
    m.handlers.set(name, handler);
    return () => {};
  })
}));
let state, runtime;
beforeEach(async () => {
  vi.resetModules();
  m.persist.mockReset().mockResolvedValue(undefined);
  m.handlers.clear();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.characters = [
    { id: 'a', nick: 'Alpha', partyIds: ['p'] },
    { id: 'b', nick: 'Beta', partyIds: ['p'] }
  ];
  state.settings.gameMacros = {
    enabled: false,
    partyId: 'p',
    leaders: { p: 'a' },
    commands: [{ id: 'keys', name: 'Клавиша', action: 'sequence', target: 'all', sequence: 'B', hotkey: 'CTRL+F' }]
  };
  m.invoke.mockReset().mockImplementation(async c =>
    c === 'launcher_running_details'
      ? [
          { pid: 10, startedAt: 100, hwnd: 1000, elevated: false, title: 'Alpha — Жрец' },
          { pid: 20, startedAt: 200, hwnd: 2000, elevated: false, title: 'Beta — Воин' }
        ]
      : c === 'game_macro_mirror'
        ? true
        : []
  );
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
afterEach(async () => {
  await runtime.disableKeyboardMirror();
});
it('persists and registers explicit on/off requests without enabling repeat or changing commands', async () => {
  const commands = structuredClone(runtime.config().commands);
  await runtime.setHotkeysEnabled(true);
  expect(m.persist).toHaveBeenCalledTimes(1);
  expect(runtime.snapshot()).toMatchObject({ hotkeysEnabled: true, mirrorKeys: false, mirrorMouse: false });
  expect(
    m.invoke.mock.calls.some(([c, a]) => c === 'game_macro_bindings' && a.bindings.some(b => b.chord === 'CTRL+F'))
  ).toBe(true);
  await runtime.setHotkeysEnabled(false);
  expect(runtime.snapshot().hotkeysEnabled).toBe(false);
  expect(state.settings.gameMacros.commands).toEqual(commands);
  expect(m.invoke.mock.calls.filter(([c]) => c === 'game_macro_mirror').some(([, a]) => a.operation === 'start')).toBe(
    false
  );
});
it('rejects malformed requests, serializes on/off and rolls back intent if saving fails', async () => {
  await runtime.setHotkeysEnabled('yes');
  expect(m.persist).not.toHaveBeenCalled();
  m.persist.mockRejectedValueOnce(new Error('disk'));
  await expect(runtime.setHotkeysEnabled(true)).rejects.toThrow('disk');
  expect(runtime.snapshot().hotkeysEnabled).toBe(false);
  expect(m.invoke.mock.calls.some(([c]) => c === 'game_macro_bindings')).toBe(false);
  await Promise.all([runtime.setHotkeysEnabled(true), runtime.setHotkeysEnabled(false)]);
  expect(runtime.snapshot().hotkeysEnabled).toBe(false);
});
it('keeps selected repeat modes on when hotkeys are enabled and disabled', async () => {
  await runtime.toggleKeyboardMirror('mouse');
  expect(runtime.snapshot().mirrorMouse).toBe(true);
  await runtime.setHotkeysEnabled(true);
  await runtime.setHotkeysEnabled(false);
  expect(runtime.snapshot()).toMatchObject({
    mirrorMouse: true,
    mirrorKeys: false,
    hotkeysEnabled: false,
    mirroring: true
  });
});
it('handles the overlay event in the main process and opens the standalone page from settings links', async () => {
  await runtime.initGameMacros();
  m.handlers.get('game-overlay-hotkeys-toggle')({ payload: { enabled: true } });
  await vi.waitFor(() => expect(runtime.snapshot().hotkeysEnabled).toBe(true));
  await vi.waitFor(() => expect(m.persist).toHaveBeenCalledTimes(1));
  document.body.innerHTML =
    '<button class="tab" data-tab="tools"></button><button class="tab" data-tab="game-macros"></button>';
  const click = vi.fn();
  document.querySelector('[data-tab="game-macros"]').onclick = click;
  runtime.openSettings();
  expect(click).toHaveBeenCalledTimes(1);
});

it('retains enabled intent on partial registration failures and treats duplicate enable requests as idempotent', async () => {
  m.invoke.mockImplementation(async (c, a) => (c === 'game_macro_bindings' && a.bindings.length ? ['keys'] : []));
  await Promise.all([runtime.setHotkeysEnabled(true), runtime.setHotkeysEnabled(true)]);
  expect(m.persist).toHaveBeenCalledTimes(1);
  expect(runtime.snapshot()).toMatchObject({ hotkeysEnabled: true, hotkeyFailures: ['CTRL+F'] });
});
