import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), check: vi.fn(async () => {}), candidates: [] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
// authCheckCandidates — стоп перед запуском задачи: если интервал автопроверки не вышел,
// фоновый таймер не должен будить очередь вхолостую
vi.mock('../js/modules/sync/syncManager.js', () => ({
  verifySavedLoginsOnStartup: mocks.check,
  authCheckCandidates: () => mocks.candidates
}));
vi.mock('../js/modules/launcher/launch.js', () => ({ launchablePartyNames: () => [], decorateNotice: () => '', hasGameCenterPath: () => false }));
let state, apply;
beforeEach(async () => { vi.resetModules(); vi.useFakeTimers(); mocks.check.mockReset().mockResolvedValue({}); mocks.invoke.mockClear(); mocks.candidates = [{ char: { id: 'a' } }]; window.__TAURI_INTERNALS__ = {}; ({ state } = await import('../js/core/state.js'));state.settings.tray.backgroundAuthMinutes=1;state.ui.authCheck={};({applyDesktopSettings:apply}=await import('../js/desktop/desktop.js')); });
afterEach(async () => { state.settings.tray.backgroundAuthMinutes=0;await apply();delete window.__TAURI_INTERNALS__;vi.useRealTimers();vi.restoreAllMocks(); });

describe('фоновые проверки входа', () => {
  it('не запускает вторую пачку, пока первая не завершилась', async () => {
    let finish; mocks.check.mockImplementationOnce(() => new Promise(resolve => { finish=resolve; })); await apply(); await vi.advanceTimersByTimeAsync(180000);
    expect(mocks.check).toHaveBeenCalledTimes(1); finish({}); await Promise.resolve();await vi.advanceTimersByTimeAsync(60000);expect(mocks.check).toHaveBeenCalledTimes(2);
  });
  it('не мешает ручной проверке и возобновляется после неё', async () => {
    state.ui.authCheck={a:'checking'};await apply();await vi.advanceTimersByTimeAsync(60000);expect(mocks.check).not.toHaveBeenCalled();state.ui.authCheck={};await vi.advanceTimersByTimeAsync(60000);expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it('ошибка освобождает флаг, смена настроек не дублирует таймер', async () => {
    vi.spyOn(console,'warn').mockImplementation(()=>{});mocks.check.mockRejectedValueOnce(Error('Сеть'));await apply();await apply();await vi.advanceTimersByTimeAsync(120000);expect(mocks.check).toHaveBeenCalledTimes(2);
  });
  it('не запускает задачу, если интервал автопроверки ещё не вышел', async () => {
    // Таймер из трея может быть короче интервала: без стопа он будил бы очередь вхолостую
    mocks.candidates = []; await apply(); await vi.advanceTimersByTimeAsync(180000);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
