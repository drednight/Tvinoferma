import { describe, it, expect, beforeEach, vi } from 'vitest';

// Запуск пати с проверками: пропуск уже запущенных окон, экран «Проверка перед запуском», «Исправить и запустить», история.
const invoke = vi.fn(async () => ({}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), confirmModal: vi.fn(async () => true) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const ch = (id, nick, gcIds = ['gc-1']) => ({ id, nick, class: 'Воин', launch: { gcIds, gcAccounts: {} } });
const A = () => ch('a', 'Аа');
const B = () => ch('b', 'Бб');
const C = () => ch('c', 'Вв');

let state, partyLaunch, ui, log;
/** Что вернут команды Rust про окна и права; по умолчанию — ничего не запущено, Твиноферма с обычными правами. */
let facts;
beforeEach(async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div>';
  facts = { windows: [], elevated: false };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd) => {
    if (cmd === 'launcher_running_details') { if (facts.windows instanceof Error) throw facts.windows; return facts.windows; }
    if (cmd === 'launcher_self_elevated') return facts.elevated;
    if (cmd === 'launcher_check_path') return 'D:\\New\\GameCenter.exe';
    if (cmd === 'launcher_pick_gamecenter') return 'D:\\New\\GameCenter.exe';
    return {};
  });
  vi.resetModules();
  ({ state } = await import('../js/core/state.js'));
  state.settings.launcher = { ...(state.settings.launcher || {}), gameCenters: [GC1], preferredGcId: '', decorateWindows: false, skipRunning: true, preflight: 'issues', delaySec: 3 };
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ui = await import('../js/core/ui.js');
  log = await import('../js/modules/launcher/launchLog.js');
});

const started = () => invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => String(c[1].charId).split('@')[0]);   // ключ запуска — «id@gc-id»
const dlg = () => document.querySelector('.tf-dialog');
const click = (act) => document.querySelector(`[data-act="${act}"]`).click();
const win = (nick) => ({ pid: 500, title: `${nick} — Воин`, elevated: false });

describe('порядок запуска по пати', () => {
  it('персонажи запускаются в том порядке, который задан в карточке пати, а не в общем списке', async () => {
    state.parties = [{ id: 'p1', name: 'Папка 1' }];
    // Общий список персонажей: Аа, Бб, Вв. Порядок в пати задаёт перетаскивание: Вв, Аа, Бб
    state.characters = [A(), B(), C()].map(c => ({ ...c, partyIds: ['p1'], partyOrder: { p1: 0 } }));
    state.characters[2].partyOrder = { p1: 1 };
    state.characters[0].partyOrder = { p1: 2 };
    state.characters[1].partyOrder = { p1: 3 };

    await partyLaunch.launchPartyByName('Папка 1');
    expect(started()).toEqual(['c', 'a', 'b']);
  });

  it('у кого порядок не задан — запускаются по алфавиту, но после заданных', async () => {
    state.parties = [{ id: 'p1', name: 'Папка 1' }];
    state.characters = [A(), B(), C()].map(c => ({ ...c, partyIds: ['p1'] }));
    state.characters[0].partyOrder = { p1: 2 };   // Аа — единственный с заданным порядком

    await partyLaunch.launchPartyByName('Папка 1');
    // Заданные идут первыми (иначе перетаскивание теряло бы смысл), остальные — по алфавиту
    expect(started()).toEqual(['a', 'b', 'c']);
  });
});

describe('уже запущенные окна', () => {
  it('запущенный пропускается, очередь сразу идёт дальше; без экрана проверок', async () => {
    facts.windows = [win('Бб')];
    const results = await partyLaunch.launchGroup('Пати', [A(), B(), C()]);
    expect(started()).toEqual(['a', 'c']);
    expect(results.map(r => r.id)).toEqual(['a', 'c']);
    expect(dlg()).toBeNull();
    expect(ui.toast.mock.calls.flat().join(' ')).not.toContain('Не указан');
  });

  it('настройка «пропускать» выключена — запускаются все', async () => {
    state.settings.launcher.skipRunning = false;
    facts.windows = [win('Бб')];
    await partyLaunch.launchGroup('Пати', [A(), B()]);
    expect(started()).toEqual(['a', 'b']);
  });

  it('все окна уже запущены — запускать нечего, сообщение и ни одного запуска', async () => {
    facts.windows = [win('Аа'), win('Бб')];
    expect(await partyLaunch.launchGroup('Пати', [A(), B()])).toBeNull();
    expect(started()).toEqual([]);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('Все окна уже запущены (2)'), 'info');
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('сбой чтения списка окон запуску не мешает', async () => {
    facts.windows = new Error('нет доступа');
    await partyLaunch.launchGroup('Пати', [A(), B()]);
    expect(started()).toEqual(['a', 'b']);
  });
});

describe('экран «Проверка перед запуском»', () => {
  it('режим «всегда»: экран показан, «Отмена» — ни одного запуска и запуск не «залипает»', async () => {
    state.settings.launcher.preflight = 'always';
    const p = partyLaunch.launchGroup('Пати', [A(), B()]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    expect(dlg().textContent).toContain('Проверка перед запуском');
    expect(partyLaunch.isLaunching()).toBe(true);   // место занято, пока экран открыт
    click('cancel');
    expect(await p).toBeNull();
    expect(started()).toEqual([]);
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('режим «всегда»: «Запустить» запускает; режим «никогда» экран не показывает даже при проблемах', async () => {
    state.settings.launcher.preflight = 'always';
    const p = partyLaunch.launchGroup('Пати', [A(), B()]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    click('launch');
    expect((await p).length).toBe(2);
    expect(started()).toEqual(['a', 'b']);

    invoke.mockClear();
    state.settings.launcher.preflight = 'off';
    await partyLaunch.launchGroup('Пати', [A(), ch('n', 'Нн', [])]);
    expect(dlg()).toBeNull();
    expect(started()).toEqual(['a']);
  });

  it('нет GameCenter — экран сам; «Запустить» пропускает такого, остальные запускаются', async () => {
    const p = partyLaunch.launchGroup('Пати', [A(), ch('n', 'Нн', []), B()]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    expect(dlg().textContent).toContain('Нн');
    click('launch');
    await p;
    expect(started()).toEqual(['a', 'b']);
  });

  it('«Исправить и запустить»: GameCenter прикрепляется персонажу без него, и он тоже запускается', async () => {
    const n = ch('n', 'Нн', []);
    const p = partyLaunch.launchGroup('Пати', [A(), n, B()]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    click('fix');
    const results = await p;
    expect(n.launch.gcIds).toEqual(['gc-1']);
    expect(started()).toEqual(['a', 'n', 'b']);
    expect(results).toHaveLength(3);
    expect(invoke).not.toHaveBeenCalledWith('launcher_pick_gamecenter', expect.anything());
  });

  it('«Исправить и запустить» при пустом списке GameCenter: просит указать GameCenter.exe и добавляет его в список', async () => {
    state.settings.launcher.gameCenters = [];
    const n = ch('n', 'Нн', []);
    const p = partyLaunch.launchGroup('Пати', [n]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    click('fix');
    await p;
    expect(invoke).toHaveBeenCalledWith('launcher_pick_gamecenter', undefined);
    expect(state.settings.launcher.gameCenters).toHaveLength(1);
    expect(state.settings.launcher.gameCenters[0].path).toBe('D:\\New\\GameCenter.exe');
    expect(n.launch.gcIds).toEqual([state.settings.launcher.gameCenters[0].id]);
    expect(started()).toEqual(['n']);
  });

  it('«Исправить и запустить»: отказ выбрать файл — запуск отменяется', async () => {
    state.settings.launcher.gameCenters = [];
    invoke.mockImplementation(async (cmd) => (cmd === 'launcher_pick_gamecenter' ? null : cmd === 'launcher_running_details' ? [] : cmd === 'launcher_self_elevated' ? false : {}));
    const p = partyLaunch.launchGroup('Пати', [ch('n', 'Нн', [])]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    click('fix');
    expect(await p).toBeNull();
    expect(started()).toEqual([]);
  });

  it('клиент от администратора при Твинофере без прав — экран; с правами — экрана нет', async () => {
    facts.windows = [{ pid: 9, title: 'Perfect World', elevated: true }];
    const p = partyLaunch.launchGroup('Пати', [A()]);
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    click('launch');
    await p;
    expect(started()).toEqual(['a']);

    document.body.innerHTML = '<div id="modal-root"></div>';
    facts.elevated = true;
    invoke.mockClear();
    await partyLaunch.launchGroup('Пати', [A()]);
    expect(dlg()).toBeNull();
    expect(started()).toEqual(['a']);
  });

  it('запуск из трея (interactive: false): экран не показывается, но запущенные пропускаются, а у кого нет GameCenter — пропускаются', async () => {
    facts.windows = [win('Бб')];
    await partyLaunch.launchGroup('Пати', [A(), B(), ch('n', 'Нн', [])], { interactive: false });
    expect(dlg()).toBeNull();
    expect(started()).toEqual(['a']);
  });
});

describe('история запусков', () => {
  it('запуск записывается: окна со временем ожидания, пропущенные и без GameCenter', async () => {
    facts.windows = [win('Бб')];
    await partyLaunch.launchGroup('Пати «Тест»', [A(), B(), C(), ch('n', 'Нн', [])], { interactive: false });
    const [run] = log.loadLaunchLog();
    expect(run.title).toBe('Пати «Тест»');
    expect(run.delayMs).toBe(3000);
    expect(run.requested).toBe(4);
    expect(run.items.map(i => [i.id, i.status])).toEqual([['a', 'ok'], ['c', 'ok'], ['b', 'running'], ['n', 'nogc']]);
    expect(run.items[0].ms).toBeGreaterThanOrEqual(0);
    expect(run.items[2].ms).toBeNull();
    expect([run.ok, run.running, run.noGc]).toEqual([2, 1, 1]);
  });

  it('ошибка запуска попадает в историю с текстом', async () => {
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'launcher_running_details') return [];
      if (cmd === 'launcher_self_elevated') return false;
      if (cmd === 'launcher_start' && String(args.charId).startsWith('b@')) throw new Error('клиент не появился');
      return {};
    });
    await partyLaunch.launchGroup('Пати', [A(), B()]);
    const [run] = log.loadLaunchLog();
    expect(run.items.find(i => i.id === 'b')).toMatchObject({ status: 'failed', error: 'клиент не появился' });
    expect(log.statsOf([run])).toMatchObject({ ok: 1, failed: 1 });
  });

  it('если все окна уже запущены, в историю ничего не пишется (запуска не было)', async () => {
    facts.windows = [win('Аа')];
    await partyLaunch.launchGroup('Пати', [A()]);
    expect(log.loadLaunchLog()).toEqual([]);
  });
});
