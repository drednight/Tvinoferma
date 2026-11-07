import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handlers: new Map(), invoke: vi.fn(), persist: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => mocks.invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, handler) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  }),
  emitTo: vi.fn(async () => {})
}));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
let state, runtime;
beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async (name, handler) => {
      mocks.handlers.set(name, handler);
      return () => mocks.handlers.delete(name);
    },
    emitTo: async () => {}
  }));
  mocks.handlers.clear();
  mocks.invoke.mockReset();
  mocks.persist.mockClear();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.parties = [{ id: 'p', name: 'Пати' }];
  state.characters = [{ id: 'a', nick: 'Alpha', partyIds: ['p'] }];
  state.settings.gameMacros = { partyId: 'p' };
  mocks.invoke.mockImplementation(async command =>
    command === 'launcher_running_details'
      ? [{ pid: 10, startedAt: 1000, hwnd: 100, elevated: false, title: 'Alpha — Воин' }]
      : null
  );
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
it('restores saved physical overlay position on opening', async () => {
  state.settings.gameMacros.overlayPosition = { x: -1200, y: 90 };
  await runtime.openOverlay();
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay', {
    topmost: true,
    position: { x: -1200, y: 90 },
    existingOnly: false
  });
});
it('debounces move events and persists the last position', async () => {
  await runtime.initGameMacros();
  mocks.handlers.get('game-overlay-position')({ payload: { x: 80, y: 90 } });
  mocks.handlers.get('game-overlay-position')({ payload: { x: 120, y: 150 } });
  await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));
  expect(runtime.config().overlayPosition).toEqual({ x: 120, y: 150 });
});
it('applies overlay appearance without opening a hidden overlay', async () => {
  await runtime.applyOverlayPreferences();
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay', expect.objectContaining({ existingOnly: true }));
});
it('sets the same party for buff and other commands when a party is launched', async () => {
  await runtime.selectMacroParty('p');
  expect(runtime.config().partyId).toBe('p');
  expect(runtime.config().buffPartyId).toBe('p');
  expect(mocks.persist).toHaveBeenCalled();
});
it('captures a moved marker without requiring a game click or a UI scale input', async () => {
  const promise = runtime.pickPoint('a', 'Свиток воскрешения');
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      'game_macro_guide',
      expect.objectContaining({ mode: 'point', target: { pid: 10, startedAt: 1000 } })
    )
  );
  expect(mocks.invoke.mock.calls.some(([, args]) => args?.action === 'click')).toBe(false);
  const requestId = mocks.invoke.mock.calls.find(([, args]) => args?.mode === 'point')[1].requestId;
  mocks.handlers.get('game-macro-picked')({ payload: { requestId: 'old', cancelled: true } });
  mocks.handlers.get('game-macro-picked')({
    payload: { requestId, geometry: { x: 20, y: 30, width: 2560, height: 1400, dpi: 144 } }
  });
  const point = await promise;
  expect(point).toMatchObject({ name: 'Свиток воскрешения', x: 20, y: 30, width: 2560, height: 1400, dpi: 144 });
  expect(runtime.config().points).toHaveLength(1);
  expect(runtime.snapshot().busy).toBe(false);
});
it('does not retain a point if marker selection is cancelled', async () => {
  const promise = runtime.pickPoint('a', 'Отмена');
  const rejection = expect(promise).rejects.toThrow('отменено');
  await vi.waitFor(() => expect(mocks.handlers.has('game-macro-picked')).toBe(true));
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([, args]) => args?.mode === 'point')).toBe(true));
  const requestId = mocks.invoke.mock.calls.find(([, args]) => args?.mode === 'point')[1].requestId;
  mocks.handlers.get('game-macro-picked')({ payload: { requestId, cancelled: true } });
  await rejection;
  expect(runtime.config().points).toEqual([]);
  expect(runtime.snapshot().busy).toBe(false);
});
it('calibrates an existing point as an uncommitted draft without changing its ID or command references', async () => {
  const original = { id: 'kept', name: 'Старая', uiScale: '100%', x: 5, y: 7, width: 2560, height: 1400, dpi: 144 };
  state.settings.gameMacros.points = [original];
  const pending = runtime.pickPoint('a', 'Черновик', 'kept', 'p', true, original);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([, a]) => a?.mode === 'point')).toBe(true));
  const args = mocks.invoke.mock.calls.find(([, a]) => a?.mode === 'point')[1];
  expect(args.initialPoint).toEqual(original);
  mocks.handlers.get('game-macro-picked')({
    payload: { requestId: args.requestId, geometry: { x: 100, y: 200, width: 2560, height: 1400, dpi: 144 } }
  });
  expect(await pending).toMatchObject({ id: 'kept', name: 'Черновик', x: 100, y: 200 });
  expect(runtime.config().points[0]).toEqual(original);
});
