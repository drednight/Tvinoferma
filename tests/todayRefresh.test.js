import { it, expect, vi, afterEach } from 'vitest';
const calls = vi.hoisted(() => ({ check: vi.fn(async () => {}), news: vi.fn(async () => {}), invoke: vi.fn() }));
vi.mock('../js/modules/automation/promoDiscovery.js', () => ({
  discoveredPromos: () => [],
  promoCoverage: a => a,
  promoDiscovery: () => ({ check: calls.check })
}));
vi.mock('../js/modules/dashboard/siteFeed.js', () => ({ refreshSiteFeed: calls.news }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: calls.invoke }));
import { runTodayAction } from '../js/modules/dashboard/todayRuntime.js';
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.clearAllMocks();
});
it('manual news refresh calls the shared public feed only, never a server/account refresh', async () => {
  window.__TAURI_INTERNALS__ = {};
  expect(await runTodayAction('news-refresh')).toEqual({ ok: true });
  expect(calls.news).toHaveBeenCalledWith({ invokeFn: calls.invoke });
  expect(calls.check).not.toHaveBeenCalled();
  expect(calls.invoke).not.toHaveBeenCalled();
});
it('manual promo refresh force-checks the actual news discovery service', async () => {
  window.__TAURI_INTERNALS__ = {};
  expect(await runTodayAction('promo-refresh')).toEqual({ ok: true });
  expect(calls.check).toHaveBeenCalledWith({ force: true });
  expect(calls.news).not.toHaveBeenCalled();
});
it('browser catalogue cannot issue native refresh requests', async () => {
  expect((await runTodayAction('news-refresh')).ok).toBe(false);
  expect((await runTodayAction('promo-refresh')).ok).toBe(false);
  expect(calls.check).not.toHaveBeenCalled();
  expect(calls.news).not.toHaveBeenCalled();
});
