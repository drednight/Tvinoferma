import { describe, it, expect, beforeEach, vi } from 'vitest';

// Ручная проверка входа и отмена массовой проверки (issue #21)
const mocks = vi.hoisted(() => ({ calls: [], release: null, gate: null, balCalls: [], closed: 0 }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), showModal: vi.fn(), closeModal: vi.fn(), confirmModal: vi.fn(async () => true) }));
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
  closeAuthPopups: vi.fn(async () => mocks.closed),
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

// Ответы по умолчанию. Тесты про пропуск подменяют их, поэтому стандартные возвращаем
// в beforeEach: иначе подмена утекла бы в следующие тесты (мок живёт весь файл).
const defaultAuth = async (charId) => {
  mocks.calls.push(charId);
  if (mocks.gate) await mocks.gate;               // первая проверка «висит», пока тест не отпустит
  return charId === 'bad'
    ? { charId, status: 'offline', reason: 'not_logged_in' }
    : { charId, status: 'online', reason: null };
};
const defaultBalance = async (charId) => {
  mocks.balCalls.push(charId);
  if (mocks.gate) await mocks.gate;
  return { charId, balance: 28.5, error: null };
};

beforeEach(async () => {
  vi.resetModules();
  mocks.calls.length = 0; mocks.balCalls.length = 0; mocks.gate = null; mocks.closed = 0;
  ({ state } = await import('../js/core/state.js'));
  state.settings = { scripts: { concurrency: 1, retries: 0, retryDelayMs: 0 } };
  (await import('../js/modules/sync/checkAuth.js')).checkCharacterAuth.mockImplementation(defaultAuth);
  (await import('../js/modules/sync/getBalance.js')).getCharacterBalance.mockImplementation(defaultBalance);
  sync = await import('../js/modules/sync/syncManager.js');
  ({ authDetails } = await import('../js/modules/sync/authStatus.js'));
  ({ startTask } = await import('../js/core/taskLog.js'));
  // Здоровье парсеров проверяем «с нуля»: иначе состояние прошлых тестов сделало бы проверку неверной
  (await import('../js/core/parserHealth.js')).resetParserHealth();
});

describe('authDetails: результат и время последней проверки', () => {
  it('не проверялся / онлайн / оффлайн с понятной причиной', () => {
    expect(authDetails({ id: 'a' })).toBe('Оффлайн · ещё не проверялся');
    // Время проверки показывается по Москве, поэтому момент задаётся явным UTC:
    // 15:20 UTC = 18:20 МСК. Без «Z» JS счёл бы строку местным временем и на CI (UTC)
    // получилось бы другое значение — тест зависел бы от пояса машины.
    expect(authDetails({ id: 'a', isLoggedIn: true, lastLoginCheck: '2026-10-02T15:20:00Z' })).toMatch(/^Онлайн · проверено 02\.10\.2026 18:20$/);
    expect(authDetails({ id: 'a', isLoggedIn: false, lastLoginReason: 'not_logged_in', lastLoginCheck: '2026-10-02T15:20:00Z' }))
      .toBe('Оффлайн: не выполнен вход на сайт · проверено 02.10.2026 18:20');
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

describe('открытое окно персонажа: пропуск вместо переключения страницы', () => {
  it('проверка входа не трогает статус, время проверки и здоровье парсеров', async () => {
    const char = { id: 'a', nick: 'Аа', isLoggedIn: false, lastLoginReason: 'not_logged_in', lastLoginCheck: null };
    state.characters = [char];
    const res = sync.applyLoginResult({ charId: 'a', status: 'skipped', reason: 'window_open', skipped: true });
    expect(res.changed).toBe(false);
    // Прежний статус и время не меняются: мы не проверяли, а не «нет входа»
    expect(char.isLoggedIn).toBe(false);
    expect(char.lastLoginReason).toBe('not_logged_in');
    expect(char.lastLoginCheck).toBeNull();
    const { getParserHealth } = await import('../js/core/parserHealth.js');
    expect(getParserHealth().auth.status).toBeNull();
  });

  it('массовая проверка считает такого персонажа пропущенным, а не оффлайн', async () => {
    const busy = { id: 'busy', nick: 'Бб', isLoggedIn: true };
    const ok = { id: 'ok', nick: 'Ок', isLoggedIn: true };
    state.characters = [busy, ok];
    const { checkCharacterAuth } = await import('../js/modules/sync/checkAuth.js');
    checkCharacterAuth.mockImplementation(async (charId) => {
      mocks.calls.push(charId);
      return charId === 'busy'
        ? { charId, status: 'skipped', reason: 'window_open', skipped: true }
        : { charId, status: 'online', reason: null };
    });

    const res = await sync.runAuthChecks([busy, ok]);
    expect(res.busy).toEqual(['Бб']);
    expect(res.online).toBe(1);
    expect(res.offline).toEqual([]);          // «пропущен» ≠ «нет входа»
    expect(busy.isLoggedIn).toBe(true);       // статус прежний
  });

  it('в журнале видно, что персонаж пропущен', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const char = { id: 'busy', nick: 'Бб', isLoggedIn: true };
    state.characters = [char];
    const task = startTask('Проверка входа', { dock: false });
    task.watch('char:busy');
    sync.applyLoginResult({ charId: 'busy', status: 'skipped', reason: 'window_open', skipped: true });
    expect(task.entries.some(e => e.level === 'warn' && /пропущен/.test(e.message))).toBe(true);
    task.finish('Готово', 'warn');
  });

  it('баланс: открытое окно — пропуск, а не ошибка (прежние монеты и вход не трогаем)', async () => {
    const char = { id: 'a', nick: 'Аа', isLoggedIn: true, ancientCoins: 100 };
    state.characters = [char];
    const res = sync.applyBalanceResult({ charId: 'a', balance: null, error: 'window_open', skipped: true });
    expect(res.skipped).toBe(true);
    expect(res.changed).toBe(false);
    expect(char.ancientCoins).toBe(100);
    expect(char.isLoggedIn).toBe(true);
    const { getParserHealth } = await import('../js/core/parserHealth.js');
    expect(getParserHealth().balance.status).toBeNull();
  });

  it('массовое обновление балансов: пропущенные отдельно от ошибок', async () => {
    const busy = { id: 'busy', nick: 'Бб', isLoggedIn: true, ancientCoins: 5 };
    const ok = { id: 'ok', nick: 'Ок', isLoggedIn: true, ancientCoins: 0 };
    state.characters = [busy, ok];
    const { getCharacterBalance } = await import('../js/modules/sync/getBalance.js');
    getCharacterBalance.mockImplementation(async (charId) => {
      mocks.balCalls.push(charId);
      return charId === 'busy'
        ? { charId, balance: null, error: 'window_open', skipped: true }
        : { charId, balance: 28.5, error: null };
    });

    const res = await sync.refreshAllBalances([busy, ok]);
    expect(res.skipped).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('Rust: и проверка входа, и баланс, и любое окно скрипта не берут видимое окно', async () => {
    const { readFileSync } = await import('node:fs');
    const auth = readFileSync('src-tauri/src/auth.rs', 'utf8');
    const balance = readFileSync('src-tauri/src/balance.rs', 'utf8');
    const windows = readFileSync('src-tauri/src/windows.rs', 'utf8');
    // Проверка входа и баланс сообщают о пропуске, а не падают
    expect(auth).toMatch(/window_is_open[\s\S]{0,200}окно занято, персонаж пропущен/);
    expect(balance).toMatch(/window_is_open[\s\S]{0,200}окно занято, персонаж пропущен/);
    // Центральная функция не отдаёт видимое окно ни одному скрипту
    expect(windows).toMatch(/get_or_create_hidden_window[\s\S]{0,900}is_visible[\s\S]{0,120}ERR_WINDOW_OPEN/);
    // Сканирование тоже не берёт окно, в котором работает пользователь
    expect(windows).toMatch(/pick_scan_window[\s\S]{0,600}!window\.is_visible/);
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

describe('открытие сайта вручную', () => {
  it('пока идёт проверка персонажа, окно не открывается', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    invoke.mockClear();
    state.characters = [mk('a')];
    state.ui.authCheck = { a: 'checking' };
    expect(sync.isCheckInProgress('a')).toBe(true);
    await sync.openSyncHelper('a');
    expect(invoke).not.toHaveBeenCalledWith('open_sync_window', expect.anything());
    state.ui.authCheck = {};
    await sync.openSyncHelper('a');
    expect(invoke).toHaveBeenCalledWith('open_sync_window', expect.anything());
  });
});

describe('закрытие окна браузера', () => {
  it('метка окна и метка окна авторизации дают id персонажа', () => {
    expect(sync.charIdFromWindowLabel('sync-win-DragonSlayer_1')).toBe('DragonSlayer_1');
    // Раньше закрытие окна авторизации не давало эффекта: id получался «popup-<id>-<N>»
    expect(sync.charIdFromWindowLabel('popup-sync-win-DragonSlayer_1-1')).toBe('DragonSlayer_1');
    expect(sync.charIdFromWindowLabel('popup-sync-win-a-b-12')).toBe('a-b');
    // Ник с дефисом: у основного окна «-b» — часть id, а не номер окна
    expect(sync.charIdFromWindowLabel('sync-win-a-b')).toBe('a-b');
    expect(sync.charIdFromWindowLabel('main')).toBeNull();
    expect(sync.charIdFromWindowLabel('sync-win-')).toBeNull();
  });

  it('закрытие окна авторизации перепроверяет вход и закрывает оставшиеся окна', async () => {
    const { closeAuthPopups } = await import('../js/modules/sync/checkAuth.js');
    const { toast } = await import('../js/core/ui.js');
    mocks.closed = 1;
    state.characters = [mk('a')];

    await sync.handleBrowserWindowClosed('popup-sync-win-a-1');

    // Вход подтверждён → перепроверка выполнена и лишние окна авторизации закрыты
    await vi.waitFor(() => expect(mocks.calls).toEqual(['a']));
    await vi.waitFor(() => expect(closeAuthPopups).toHaveBeenCalledWith('a'));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Вход выполнен'), 'success');
  });

  it('если вход не подтверждён, окна авторизации не трогаем', async () => {
    const { closeAuthPopups } = await import('../js/modules/sync/checkAuth.js');
    state.characters = [mk('bad')];

    await sync.handleBrowserWindowClosed('popup-sync-win-bad-1');

    await vi.waitFor(() => expect(mocks.calls).toEqual(['bad']));
    expect(state.characters[0].isLoggedIn).toBe(false);
    expect(closeAuthPopups).not.toHaveBeenCalled();
  });

  it('закрытие основного окна тоже перепроверяет вход, но окна авторизации не закрывает', async () => {
    const { closeAuthPopups } = await import('../js/modules/sync/checkAuth.js');
    state.characters = [mk('a')];

    await sync.handleBrowserWindowClosed('sync-win-a');

    await vi.waitFor(() => expect(mocks.calls).toEqual(['a']));
    expect(closeAuthPopups).not.toHaveBeenCalled();
  });

  it('чужое окно не вызывает проверку', async () => {
    state.characters = [mk('a')];
    await sync.handleBrowserWindowClosed('main');
    await sync.handleBrowserWindowClosed('popup-sync-win-другой-1');
    expect(mocks.calls).toEqual([]);
  });
});
