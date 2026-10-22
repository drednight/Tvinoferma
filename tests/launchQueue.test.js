import { describe, it, expect, beforeEach, vi } from 'vitest';

// Запуск игры во время другого скрипта: не отказ «запуск уже идёт», а очередь в доке.
// Раньше второй запуск просто отказывал, и приходилось ждать и повторять руками.
const invoke = vi.fn(async () => ({}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/core/ui.js', async (orig) => {
  const actual = await orig();
  return { ...actual, toast: vi.fn(), confirmModal: vi.fn(async () => true) };
});
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const A = () => ({
  id: 'a', nick: 'Аа', class: 'Воин',
  launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'Аа' } } }
});
const B = () => ({
  id: 'b', nick: 'Бэ', class: 'Лучник',
  launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'Бэ' } } }
});
const C = () => ({
  id: 'c', nick: 'Цэ', class: 'Маг',
  launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'Цэ' } } }
});
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

let state, partyLaunch, ui, taskLog;
beforeEach(async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div><div class="topbar-right"></div>';
  invoke.mockReset();
  invoke.mockImplementation(async (cmd) => {
    if (cmd === 'launcher_running_details') return [];
    if (cmd === 'launcher_self_elevated') return false;
    return {};
  });
  vi.resetModules();
  ({ state } = await import('../js/core/state.js'));
  state.settings.launcher = {
    ...(state.settings.launcher || {}),
    gameCenters: [GC1], preferredGcId: '', decorateWindows: false,
    skipRunning: true, preflight: 'issues', delaySec: 0
  };
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ui = await import('../js/core/ui.js');
  taskLog = await import('../js/core/taskLog.js');
});

const started = () => invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => String(c[1].charId).split('@')[0]);
const dockRow = (title) => [...document.querySelectorAll('#tf-task-dock .tf-dock-row')].find(r => r.textContent.includes(title));

describe('очередь запуска игры', () => {
  it('запуск во время другого скрипта встаёт в очередь дока, а не отказывает', async () => {
    const busy = taskLog.startTask('Другой скрипт', { total: 1, cancelable: true });
    const p = partyLaunch.launchGroup('Пати', [A()]);
    await Promise.resolve();

    expect(ui.toast.mock.calls.flat().join(' ')).not.toContain('Запуск уже идёт');
    const row = dockRow('Пати');
    expect(row).toBeTruthy();
    expect(row.className).toContain('is-queued');
    expect(started()).toEqual([]);          // очередь ждёт — игру ещё не запускали

    busy.finish('Готово');                   // место освободилось — запуск пошёл
    await p;
    expect(started()).toEqual(['a']);
  });

  it('запуск в очереди отменяется крестиком и не начинает работу', async () => {
    const busy = taskLog.startTask('Другой скрипт', { total: 1, cancelable: true });
    const p = partyLaunch.launchGroup('Пати', [A()]);
    await Promise.resolve();

    const cancel = document.querySelector('#tf-task-dock [data-dock-cancel]');
    expect(cancel).toBeTruthy();
    cancel.click();

    busy.finish('Готово');
    expect(await p).toBeNull();
    expect(started()).toEqual([]);
  });

  it('отменённый в очереди не держит очередь: следующий запуск проходит', async () => {
    const busy = taskLog.startTask('Другой скрипт', { total: 1, cancelable: true });
    const first = partyLaunch.launchGroup('Пати', [A()]);
    await Promise.resolve();
    document.querySelector('#tf-task-dock [data-dock-cancel]').click();

    const second = partyLaunch.launchGroup('Пати 2', [A()]);
    await Promise.resolve();
    busy.finish('Готово');
    await first;
    await second;
    expect(started()).toEqual(['a']);
  });

  it('зависшая задача снимается сама и не держит очередь', async () => {
    const busy = taskLog.startTask('Зависший скрипт', { total: 1, cancelable: true });
    busy.updatedAt = minutesAgo(4);

    await partyLaunch.launchGroup('Пати', [A()]);

    expect(started()).toEqual(['a']);
    expect(busy.status).toBe('warn');
    expect(busy.summary).toBe('Прервано: задача зависла');
    expect(busy.entries.some(e => e.message.includes('Прервано'))).toBe(true);
  });

  it('свежая задача не снимается: запуск ждёт в очереди', async () => {
    const busy = taskLog.startTask('Другой скрипт', { total: 1, cancelable: true });
    const p = partyLaunch.launchGroup('Пати', [A()]);
    await Promise.resolve();

    expect(busy.status).toBe('running');
    expect(dockRow('Пати').className).toContain('is-queued');
    expect(started()).toEqual([]);
    expect(busy.entries.some(e => e.message.includes('Прервано'))).toBe(false);

    busy.finish('Готово');
    await p;
    expect(started()).toEqual(['a']);
  });

  it('задача на паузе не считается зависшей', async () => {
    const busy = taskLog.startTask('Другой скрипт', { total: 1, cancelable: true });
    busy.paused = true;
    busy.updatedAt = minutesAgo(10);

    const p = partyLaunch.launchGroup('Пати', [A()]);
    await Promise.resolve();

    expect(busy.status).toBe('running');
    expect(dockRow('Пати').className).toContain('is-queued');
    expect(started()).toEqual([]);

    busy.paused = false;
    busy.finish('Готово');
    await p;
    expect(started()).toEqual(['a']);
  });

  it('после автоснятия зависшей очередь соблюдает порядок', async () => {
    const busy = taskLog.startTask('Зависший скрипт', { total: 1, cancelable: true });
    const b = partyLaunch.launchGroup('Пати B', [B()]);
    await Promise.resolve();
    expect(started()).toEqual([]);

    busy.updatedAt = minutesAgo(4);
    const c = partyLaunch.launchGroup('Пати C', [C()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(started()).not.toContain('c');
    expect(dockRow('Пати C').className).toContain('is-queued');

    await b;
    await c;
    expect(started()).toEqual(['b', 'c']);
  });
});
