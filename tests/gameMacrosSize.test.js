import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null), persist: vi.fn(async () => {}), listeners: [] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (name, handler) => {
    const off = vi.fn();
    mocks.listeners.push({ name, handler, off });
    return off;
  })
}));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
let runtime, state;
beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.length = 0;
  mocks.invoke.mockClear();
  mocks.persist.mockReset().mockResolvedValue();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.settings.gameMacros = { leaderWidth: 2560, leaderHeight: 1400, otherWidth: 1280, otherHeight: 720 };
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
async function frame(role = 'leader') {
  await runtime.showSize(1920, 1080, role);
  const [, args] = mocks.invoke.mock.calls.findLast(([command]) => command === 'game_macro_guide');
  return { args, ...mocks.listeners.at(-1) };
}
it('saves actual physical dimensions for the requested role only', async () => {
  const f = await frame('other');
  await f.handler({ payload: { requestId: f.args.requestId, width: 1600, height: 900 } });
  expect(state.settings.gameMacros.otherWidth).toBe(1600);
  expect(state.settings.gameMacros.leaderWidth).toBe(2560);
  expect(mocks.persist).toHaveBeenCalledOnce();
  expect(f.off).toHaveBeenCalledOnce();
});
it('cancel closes without persisting', async () => {
  const f = await frame();
  await f.handler({ payload: { requestId: f.args.requestId, cancelled: true } });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(state.settings.gameMacros.leaderWidth).toBe(2560);
});
it('ignores unrelated, old and out-of-range results', async () => {
  const old = await frame();
  const current = await frame();
  await old.handler({ payload: { requestId: old.args.requestId, width: 1800, height: 900 } });
  await current.handler({ payload: { requestId: 'other', width: 1800, height: 900 } });
  await current.handler({ payload: { requestId: current.args.requestId, width: 9000, height: 900 } });
  expect(mocks.persist).not.toHaveBeenCalled();
});
it('preserves saved configuration when vault write protection rejects saving', async () => {
  const f = await frame();
  mocks.persist.mockRejectedValueOnce(new Error('blocked'));
  await f.handler({ payload: { requestId: f.args.requestId, width: 1920, height: 1080 } });
  expect(state.settings.gameMacros.leaderWidth).toBe(2560);
  expect(runtime.snapshot().logs.join(' ')).toContain('Не удалось сохранить 1920');
});
