import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// «Статус серверов»: чтение без аккаунтов при запуске и по расписанию, плашка в шапке, настройка «Свежесть данных» (Issue #26)
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

const SERVERS = { status: 'ok', recommended: 'Капелла', servers: [{ name: 'Центавр', online: true }, { name: 'Фенрир', online: true }, { name: 'Мицар', online: false }, { name: 'Капелла', online: true }] };
let ss, view;

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  window.__TAURI_INTERNALS__ = {};
  mocks.invoke.mockReset().mockImplementation(async () => ({ ...SERVERS }));
  ss = await import('../js/modules/servers/serverStatus.js');
  view = await import('../js/modules/servers/serverStatusView.js');
});
afterEach(() => { vi.useRealTimers(); delete window.__TAURI_INTERNALS__; });

describe('настройка «Статус серверов» (Свежесть данных)', () => {
  it('по умолчанию 10 минут (сайт обновляет страницу раз в 10 минут); 0 допустим; мусор → значение по умолчанию', () => {
    expect(ss.serverStatusMinutes({})).toBe(10);
    expect(ss.serverStatusMinutes({ freshness: { serverStatusMinutes: 0 } })).toBe(0);
    expect(ss.serverStatusMinutes({ freshness: { serverStatusMinutes: 45 } })).toBe(45);
    expect(ss.serverStatusMinutes({ freshness: { serverStatusMinutes: 'abc' } })).toBe(10);
    expect(ss.serverStatusMinutes({ freshness: { serverStatusMinutes: -5 } })).toBe(10);
  });

  it('значение по умолчанию попадает в настройки; поле есть в «Настройки → Свежесть данных»', async () => {
    const { DEFAULT_SETTINGS } = await import('../js/core/constants.js');
    expect(DEFAULT_SETTINGS.freshness.serverStatusMinutes).toBe(10);
    const html = readFileSync('index.html', 'utf8');
    expect(html).toMatch(/data-setting="freshness\.serverStatusMinutes"/);
    // Поле лежит именно в панели «Свежесть данных». Раньше проверка была «раньше панели
    // парсеров», но та уехала в «Инструменты», и порядок в файле больше ничего не значит.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('#settings-freshness [data-setting="freshness.serverStatusMinutes"]')).not.toBeNull();
  });

  it('isStatusDue: данных нет — пора; свежие — нет; 0 — никогда; недавняя попытка тоже считается', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const at = (minAgo) => ({ at: new Date(now - minAgo * 60000).toISOString() });
    expect(ss.isStatusDue(null, 10, now)).toBe(true);
    expect(ss.isStatusDue(at(5), 10, now)).toBe(false);
    expect(ss.isStatusDue(at(11), 10, now)).toBe(true);
    expect(ss.isStatusDue(at(999), 0, now)).toBe(false);
    expect(ss.isStatusDue(at(11), 10, now, now - 3 * 60000)).toBe(false);
  });
});

describe('чтение', () => {
  const opts = () => ({ invokeFn: mocks.invoke });

  it('читает без аккаунтов, сохраняет и сообщает подписчикам; параллельные вызовы делят одно чтение', async () => {
    const seen = [];
    ss.onServerStatus(s => seen.push([s.busy, s.status?.servers.length ?? 0]));
    const [a, b] = await Promise.all([ss.refreshServerStatus(opts()), ss.refreshServerStatus(opts())]);
    expect(a).toBe(b);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('read_server_status', { timeoutSeconds: 20 });
    expect(ss.getServerStatus().status.servers.map(s => s.name)).toEqual(['Центавр', 'Фенрир', 'Мицар', 'Капелла']);
    expect(seen).toEqual([[true, 0], [false, 4]]);
    expect(JSON.parse(window.localStorage.getItem('tf_transfer_servers_v1')).recommended).toBe('Капелла');
  });

  it('сбой не стирает прежние данные и запоминается как ошибка; успех сбрасывает ошибку', async () => {
    await ss.refreshServerStatus(opts());
    mocks.invoke.mockImplementation(async () => ({ status: 'challenge' }));
    await ss.refreshServerStatus(opts());
    expect(ss.getServerStatus().status.servers).toHaveLength(4);
    expect(ss.getServerStatus().error).toEqual({ status: 'challenge', error: null });
    mocks.invoke.mockImplementation(async () => ({ ...SERVERS }));
    await ss.refreshServerStatus(opts());
    expect(ss.getServerStatus().error).toBeNull();
  });

  it('при запуске читается сразу и не задерживает дальнейшее больше, чем на maxWaitMs', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(() => new Promise(() => {}));   // сайт «завис»
    let done = false;
    ss.loadServerStatusOnStartup(() => ({}), 5000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('read_server_status', expect.any(Object));
  });

  it('вне приложения (без Tauri) ничего не читается', async () => {
    delete window.__TAURI_INTERNALS__;
    await ss.loadServerStatusOnStartup(() => ({}), 10);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('расписание', () => {
  it('читает, когда данные старше интервала из настроек; интервал берётся «на лету»; 0 — не читает', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const settings = { freshness: { serverStatusMinutes: 10 } };
    ss.setServerStatus({ servers: [{ name: 'Фенрир', online: true }] });   // данные «от 12:00»
    const stop = ss.startServerStatusScheduler(() => settings, 30000);
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(mocks.invoke).not.toHaveBeenCalled();                          // 5 минут < 10
    await vi.advanceTimersByTimeAsync(6 * 60000);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);                        // прошло 11 минут
    settings.freshness.serverStatusMinutes = 0;
    await vi.advanceTimersByTimeAsync(60 * 60000);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);                        // выключено
    settings.freshness.serverStatusMinutes = 1;
    await vi.advanceTimersByTimeAsync(2 * 60000);
    expect(mocks.invoke.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  it('после сбоя повторная попытка не раньше интервала (сайт не долбим)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    mocks.invoke.mockImplementation(async () => ({ status: 'error', error: 'timeout' }));
    const stop = ss.startServerStatusScheduler(() => ({ freshness: { serverStatusMinutes: 10 } }), 30000);
    await vi.advanceTimersByTimeAsync(9 * 60000);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);   // данных нет → одна попытка в начале, дальше ждём интервал
    await vi.advanceTimersByTimeAsync(2 * 60000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('плашка', () => {
  const snap = (o = {}) => ({ status: { at: new Date().toISOString(), recommended: 'Капелла', servers: SERVERS.servers }, busy: false, error: null, ...o });

  it('просто перечисляет серверы с отметкой онлайн/оффлайн, без кнопок и полей', () => {
    document.body.innerHTML = view.serverStatusHtml(snap());
    expect([...document.querySelectorAll('.srv')].map(e => e.textContent)).toEqual(['Центавр', 'Фенрир', 'Мицар', 'Капелла']);
    expect([...document.querySelectorAll('.srv')].map(e => e.className.replace('srv ', ''))).toEqual(['is-on', 'is-on', 'is-off', 'is-on']);
    expect(document.querySelectorAll('button, input, select, a')).toHaveLength(0);
    expect(document.querySelector('.srv-head b').textContent).toBe('Статус серверов');
    expect(document.querySelector('.srv-age').textContent).toBe('обновлено только что');
  });

  it('состояния подписи: нет данных, чтение, сбой при старых данных', () => {
    expect(view.serverStatusMeta({ status: null, busy: false, error: null }).text).toBe('нет данных');
    expect(view.serverStatusMeta({ status: null, busy: true, error: null }).text).toContain('читаю');
    expect(view.serverStatusMeta({ status: null, busy: false, error: { status: 'error' } })).toEqual({ text: '⚠ не удалось прочитать', warn: true });
    const old = snap({ error: { status: 'challenge', error: null } });
    old.status.at = new Date(Date.now() - 3 * 3600000).toISOString();
    expect(view.serverStatusMeta(old)).toEqual({ text: '⚠ не обновилось, данные: 3 ч назад', warn: true });
  });

  it('стоит в нижней части новой боковой панели перед настройками; сама обновляется после чтения', async () => {
    const html = readFileSync('index.html', 'utf8');
    const sidebar = html.slice(html.indexOf('<aside class="next-sidebar"'), html.indexOf('</aside>'));
    expect(sidebar.indexOf('id="server-status"')).toBeGreaterThan(-1);
    expect(sidebar.indexOf('id="server-status"')).toBeLessThan(sidebar.indexOf('data-tab="settings"'));
    document.body.innerHTML = '<div id="server-status"></div>';
    const stop = view.mountServerStatus(document.getElementById('server-status'));
    expect(document.querySelector('.srv-age').textContent).toBe('нет данных');
    await ss.refreshServerStatus({ invokeFn: mocks.invoke });
    expect(document.querySelectorAll('#server-status .srv')).toHaveLength(4);
    stop();
  });
});

describe('запуск приложения', () => {
  it('main.js: сначала «Статус серверов», затем проверка входа персонажей', () => {
    const src = readFileSync('js/main.js', 'utf8');
    const status = src.indexOf('await loadServerStatusOnStartup(');
    const auth = src.indexOf('await verifySavedLoginsOnStartup(');
    expect(status).toBeGreaterThan(0);
    expect(status).toBeLessThan(auth);
  });
});

describe('без журнала и уведомлений', () => {
  it('чтение статуса серверов не создаёт задач и не показывает уведомлений — ни при успехе, ни при сбое', async () => {
    const toast = vi.fn();
    vi.doMock('../js/core/ui.js', () => ({ toast, confirmModal: vi.fn(async () => true) }));
    const log = await import('../js/core/taskLog.js');
    const changes = vi.fn();
    log.onTaskChange(changes);
    await ss.refreshServerStatus({ invokeFn: mocks.invoke });
    mocks.invoke.mockImplementation(async () => ({ status: 'challenge' }));
    await ss.refreshServerStatus({ invokeFn: mocks.invoke });
    await ss.loadServerStatusOnStartup(() => ({}), 100);
    expect(toast).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('tf_task_journal_v1')).toBeNull();
  });

  it('модули чтения не подключают журнал задач и уведомления; Rust пишет в «тихую» область', () => {
    for (const f of ['serverStatus.js', 'serverStatusView.js']) {
      const src = readFileSync(`js/modules/servers/${f}`, 'utf8');
      expect(src).not.toMatch(/taskLog|toast|startTask/);
    }
    const rs = readFileSync('src-tauri/src/automation/transfer.rs', 'utf8');
    const fn = rs.slice(rs.indexOf('pub async fn read_server_status'), rs.indexOf('pub async fn transfer_items'));
    expect(fn).not.toContain('tf_log');
    expect(rs).toContain('const STATUS_SCOPE: &str = QUIET_SCOPE;');
  });
});
