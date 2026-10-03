import { describe, it, expect, beforeEach, vi } from 'vitest';

// Ручная проверка входа и отмена массовой проверки (issue #21)
const mocks = vi.hoisted(() => ({ calls: [], release: null, gate: null, balCalls: [] }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), showModal: vi.fn(), closeModal: vi.fn(), confirmDialog: vi.fn(() => true) }));
vi.mock('../js/modules/characters/list.js', () => ({ renderCharacters: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({ onCharMarathonData: vi.fn(), syncAllActiveMarathons: vi.fn() }));
vi.mock('../js/modules/sync/getBalance.js', () => ({
  getCharacterBalance: vi.fn(async (charId) => {
    mocks.balCalls.push(charId);
    if (mocks.gate) await mocks.gate;
    return { charId, balance: 28.5, error: null };
  })
}));
vi.mock('../js/modules/sync/checkAuth.js', () => ({
  checkCharacterAuth: vi.fn(async (charId) => {
    mocks.calls.push(charId);
    if (mocks.gate) await mocks.gate;               // первая проверка «висит», пока тест не отпустит
    return charId === 'bad'
      ? { charId, status: 'offline', reason: 'not_logged_in' }
      : { charId, status: 'online', reason: null };
  })
}));

let state, sync, authDetails, startTask;
const mk = (id) => ({ id, nick: id, isLoggedIn: true, lastLoginCheck: null });

beforeEach(async () => {
  vi.resetModules();
  mocks.calls.length = 0; mocks.balCalls.length = 0; mocks.gate = null;
  ({ state } = await import('../js/core/state.js'));
  state.settings = { scripts: { concurrency: 1, retries: 0, retryDelayMs: 0 } };
  sync = await import('../js/modules/sync/syncManager.js');
  ({ authDetails } = await import('../js/modules/sync/authStatus.js'));
  ({ startTask } = await import('../js/core/taskLog.js'));
});

describe('authDetails: результат и время последней проверки', () => {
  it('не проверялся / онлайн / оффлайн с понятной причиной', () => {
    expect(authDetails({ id: 'a' })).toBe('Оффлайн · ещё не проверялся');
    expect(authDetails({ id: 'a', isLoggedIn: true, lastLoginCheck: '2026-10-02T15:20:00' })).toMatch(/^Онлайн · проверено 02\.10\.2026 15:20$/);
    expect(authDetails({ id: 'a', isLoggedIn: false, lastLoginReason: 'not_logged_in', lastLoginCheck: '2026-10-02T15:20:00' }))
      .toBe('Оффлайн: не выполнен вход на сайт · проверено 02.10.2026 15:20');
  });
});

describe('refreshAuthFor: ручная проверка одного персонажа', () => {
  it('онлайн: пишет время; оффлайн: причину', async () => {
    const ok = mk('ok'), bad = mk('bad');
    state.characters = [ok, bad];
    await sync.refreshAuthFor(ok);
    expect(ok.isLoggedIn).toBe(true);
    expect(ok.lastLoginCheck).toBeTruthy();
    expect(ok.lastLoginReason).toBeNull();
    await sync.refreshAuthFor(bad);
    expect(bad.isLoggedIn).toBe(false);
    expect(bad.lastLoginReason).toBe('not_logged_in');
    expect(authDetails(bad)).toMatch(/Оффлайн: не выполнен вход на сайт · проверено/);
  });
});

describe('отмена массовой проверки', () => {
  it('Task.cancel вызывает onCancel один раз и пишет в журнал', () => {
    const t = startTask('x', { cancelable: true, dock: false });
    const fn = vi.fn(); t.onCancel(fn);
    t.cancel(); t.cancel();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(t.cancelled).toBe(true);
    t.finish('', 'warn');
    t.cancel();                                            // после завершения — игнорируется
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('после отмены оставшиеся персонажи не проверяются и их статус не меняется', async () => {
    const chars = ['a', 'b', 'c', 'd'].map(mk);
    state.characters = chars;
    let open; mocks.gate = new Promise(r => { open = r; });
    const pending = sync.runAuthChecks(chars, { title: 'тест', baseTimeout: 1 });
    await vi.waitFor(() => expect(mocks.calls).toEqual(['a']));        // concurrency = 1: идёт только первая
    const btn = document.querySelector('[data-task-cancel]');           // кнопка «⛔ Отмена» в карточке задачи
    expect(btn).not.toBeNull();
    btn.click();
    open();
    const res = await pending;
    expect(res.cancelled).toBe(true);
    expect(mocks.calls).toEqual(['a']);                                    // b, c, d даже не запускались
    expect(res.skipped).toBe(3);
    expect(chars.map(c => c.isLoggedIn)).toEqual([true, true, true, true]); // статусы пропущенных не тронуты
    expect(chars[0].lastLoginCheck).toBeTruthy();
    expect(state.ui.authCheck).toEqual({});                                // «Проверка…» снято у всех

  });
});

describe('отмена массового обновления балансов', () => {
  it('после «Отмена» остальные персонажи не запрашиваются, итог — «Отменено»', async () => {
    const chars = ['a', 'b', 'c'].map(mk);
    state.characters = chars;
    let open; mocks.gate = new Promise(r => { open = r; });
    const pending = sync.refreshAllBalances(chars);
    await vi.waitFor(() => expect(mocks.balCalls).toEqual(['a']));
    document.querySelector('[data-task-cancel]').click();
    open();
    const res = await pending;
    expect(res.cancelled).toBe(true);
    expect(res.updated).toBe(1);
    expect(mocks.balCalls).toEqual(['a']);
    expect(chars[0].ancientCoins).toBe(28.5);
    expect(chars[1].ancientCoins ?? 0).toBe(0);
  });
  it('для одного персонажа кнопки «Отмена» нет', async () => {
    const c = mk('a'); state.characters = [c];
    mocks.gate = new Promise(() => {});
    sync.refreshAllBalances([c]);
    await vi.waitFor(() => expect(mocks.balCalls).toEqual(['a']));
    expect(document.querySelector('[data-task-cancel]')).toBeNull();
  });
});
