import { describe, it, expect, beforeEach, vi } from 'vitest';

// Запуск пати: GameCenter выбирается по большинству участников (issue #91, Issue7.13-1)
const invoke = vi.fn(async () => ({}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), confirmModal: vi.fn(async () => true) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };
// Вход запомнен в каждом прикреплённом GameCenter: иначе проверка до запуска отсеет
// персонажа («вход не запомнен — запустить нельзя») и до выбора GameCenter дело не дойдёт.
const ch = (id, gcIds) => ({
  id, nick: id.toUpperCase(), class: '',
  launch: { gcIds, gcAccounts: Object.fromEntries(gcIds.map(g => [g, { nick: id }])) }
});

let state, partyLaunch, ui;
beforeEach(async () => {
  invoke.mockClear();
  vi.resetModules();
  ({ state } = await import('../js/core/state.js'));
  state.settings.launcher = { ...(state.settings.launcher || {}), gameCenters: [GC1, GC2], preferredGcId: '', decorateWindows: false };
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ui = await import('../js/core/ui.js');
});

const startedPaths = () => invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => c[1].path);

describe('запуск пати: GameCenter по большинству участников', () => {
  it('«Папка 2» у четверых, «Папка 1» у двоих: все запускаются из «Папки 2»', async () => {
    const results = await partyLaunch.launchGroup('Пати', [ch('a', ['gc-1', 'gc-2']), ch('b', ['gc-2']), ch('c', ['gc-1', 'gc-2']), ch('d', ['gc-2'])]);
    expect(results.every(r => r.ok)).toBe(true);
    // у всех есть «Папка 2» — запускаются из неё
    expect(startedPaths()).toEqual([GC2.path, GC2.path, GC2.path, GC2.path]);
  });

  it('у кого выбранного GameCenter нет — запускается из того, что есть', async () => {
    await partyLaunch.launchGroup('Пати', [ch('a', ['gc-2']), ch('b', ['gc-2']), ch('c', ['gc-1'])]);
    expect(startedPaths()).toEqual([GC2.path, GC2.path, GC1.path]);
  });

  it('при ничьей побеждает «Запускать в первую очередь»', async () => {
    state.settings.launcher.preferredGcId = 'gc-2';
    await partyLaunch.launchGroup('Пати', [ch('a', ['gc-1', 'gc-2']), ch('b', ['gc-1', 'gc-2'])]);
    expect(startedPaths()).toEqual([GC2.path, GC2.path]);
    invoke.mockClear();
    state.settings.launcher.preferredGcId = '';
    await partyLaunch.launchGroup('Пати', [ch('a', ['gc-1']), ch('b', ['gc-2'])]);
    expect(startedPaths()).toEqual([GC1.path, GC2.path]);
  });

  it('явно выбранный GameCenter (opts.gcId) важнее большинства', async () => {
    await partyLaunch.launchGroup('Пати', [ch('a', ['gc-1', 'gc-2']), ch('b', ['gc-1', 'gc-2']), ch('c', ['gc-2'])], { gcId: 'gc-1' });
    expect(startedPaths()).toEqual([GC1.path, GC1.path, GC2.path]);
  });
});

describe('закрытие окон игры: запрос прав администратора', () => {
  it('если отказано в доступе, предлагается закрыть как администратор; согласие запускает команду Rust', async () => {
    invoke.mockImplementation(async (cmd) => cmd === 'launcher_close_clients_elevated' ? { found: 2, closed: 2, failed: 0, denied: 0, elevated: true } : {});
    partyLaunch.showCloseReport({ found: 2, closed: 0, failed: 2, denied: 2, elevated: false, details: ['PID 1: отказано в доступе (код 5)'] });
    window.dispatchEvent(new Event('focus'));   // приложение было свёрнуто (закрывали из трея): вопрос появляется, когда его открыли
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('launcher_close_clients_elevated', undefined));
    expect(ui.confirmModal).toHaveBeenCalled();
    expect(ui.confirmModal.mock.calls[0][0].title).toContain('администратора');
  });

  it('если отказов нет, вопрос не показывается', async () => {
    ui.confirmModal.mockClear();
    partyLaunch.showCloseReport({ found: 2, closed: 2, failed: 0, denied: 0 });
    partyLaunch.showCloseReport({ found: 2, closed: 1, failed: 1, denied: 0, details: ['PID 1: код ошибки Windows 1'] });
    await new Promise(r => setTimeout(r, 20));
    expect(ui.confirmModal).not.toHaveBeenCalled();
  });
});
