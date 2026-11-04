import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  details: vi.fn(async () => [{ pid: 1 }]),
  rows: vi.fn(() => [{ pid: 1, known: true, nick: 'A' }]),
  decorate: vi.fn(async () => ({ ok: 0, fixed: 1, failed: 0 })),
  summary: vi.fn(() => 'Окон: 1')
}));
vi.mock('../js/modules/launcher/launch.js', () => ({
  runningClientDetails: mocks.details,
  redecorateRunningWindows: mocks.decorate,
  redecorateText: mocks.summary
}));
vi.mock('../js/modules/launcher/windowList.js', () => ({ windowRows: mocks.rows }));
import { runTodayAction } from '../js/modules/dashboard/todayRuntime.js';
beforeEach(() => {
  vi.clearAllMocks();
  window.__TAURI_INTERNALS__ = {};
});
it('decorates real running windows through the shared sequential implementation, forwarding progress', async () => {
  const onProgress = vi.fn();
  expect((await runTodayAction('decorate-windows', { onProgress })).ok).toBe(true);
  expect(mocks.details).toHaveBeenCalledOnce();
  expect(mocks.decorate).toHaveBeenCalledWith([{ pid: 1, known: true, nick: 'A' }], { onProgress });
});
it('does not report partial failure as successful completion', async () => {
  mocks.decorate.mockResolvedValueOnce({ ok: 0, fixed: 1, failed: 1 });
  expect((await runTodayAction('decorate-windows')).ok).toBe(false);
});
it('never attempts native decoration in a browser preview', async () => {
  delete window.__TAURI_INTERNALS__;
  expect((await runTodayAction('decorate-windows')).ok).toBe(false);
  expect(mocks.details).not.toHaveBeenCalled();
});
