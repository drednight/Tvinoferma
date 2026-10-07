// Единый модуль логов (core/logHub.js, «Настройки → Журналы»): общий список, фильтры, очистка, подключение видов логов.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toast: vi.fn() }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));
vi.mock('../js/core/state.js', () => ({ state: { characters: [] } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const $ = (s) => document.querySelector(s);
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
let hub;

/** Простой вид логов для проверок: данные в массиве, подписка через набор функций. */
function makeSource(id, rows, extra = {}) {
  const subs = new Set();
  const src = {
    id, title: `Вид ${id}`, icon: id === 'a' ? '🅰️' : '🅱️',
    rows,
    list: () => src.rows,
    open: vi.fn(),
    clear: vi.fn(() => { src.rows = []; }),
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    emit: () => subs.forEach(fn => fn()),
    ...extra
  };
  return src;
}
const row = (key, at, status = 'ok', extra = {}) => ({ key, at, title: `Запись ${key}`, status, summary: `итог ${key}`, ...extra });

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  document.body.innerHTML = '<div id="modal-root"></div><details id="p" open><div id="root"></div></details>';
  hub = await import('../js/core/logHub.js');
});

const setup = () => {
  const a = makeSource('a', [row('a1', '2026-10-01T10:00:00Z'), row('a2', '2026-10-03T10:00:00Z', 'warn', { who: 'Ауразак' })]);
  const b = makeSource('b', [row('b1', '2026-10-02T10:00:00Z', 'error'), row('b2', '2026-10-04T10:00:00Z', 'running')]);
  hub.registerLogSource(a); hub.registerLogSource(b);
  return { a, b };
};

describe('сбор записей', () => {
  it('все виды в одном списке, новые сверху; счётчики по видам', () => {
    setup();
    const { items, counts } = hub.collectLogs();
    expect(items.map(i => i.key)).toEqual(['b2', 'a2', 'b1', 'a1']);
    expect(items.map(i => i.source)).toEqual(['b', 'a', 'b', 'a']);
    expect(counts).toEqual({ all: 4, a: 2, b: 2 });
  });

  it('фильтры: вид, «только с проблемами», поиск по названию, итогу и нику', () => {
    setup();
    expect(hub.collectLogs({ source: 'a' }).items.map(i => i.key)).toEqual(['a2', 'a1']);
    expect(hub.collectLogs({ onlyProblems: true }).items.map(i => i.key)).toEqual(['a2', 'b1']);
    expect(hub.collectLogs({ query: 'ауразак' }).items.map(i => i.key)).toEqual(['a2']);
    expect(hub.collectLogs({ query: 'итог b1' }).items.map(i => i.key)).toEqual(['b1']);
    // счётчики не зависят от выбранного вида, но учитывают поиск и «проблемы»
    expect(hub.collectLogs({ source: 'a', onlyProblems: true }).counts).toEqual({ all: 2, a: 1, b: 1 });
  });

  it('сломанный источник не ломает остальные; записи без ключа/даты отбрасываются', () => {
    setup();
    hub.registerLogSource(makeSource('bad', [], { list: () => { throw new Error('boom'); } }));
    hub.registerLogSource(makeSource('junk', [{ title: 'без ключа', at: '2026-10-01T00:00:00Z' }, { key: 'x' }, null]));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(hub.collectLogs().items).toHaveLength(4);
  });

  it('регистрация требует id, list и open; повторная с тем же id заменяет вид', () => {
    expect(() => hub.registerLogSource({ id: 'x' })).toThrow();
    hub.registerLogSource(makeSource('a', [row('old', '2026-10-01T00:00:00Z')]));
    hub.registerLogSource(makeSource('a', [row('new', '2026-10-02T00:00:00Z')]));
    expect(hub.getLogSources()).toHaveLength(1);
    expect(hub.collectLogs().items.map(i => i.key)).toEqual(['new']);
  });

  it('заголовок панели: сколько записей, сколько с проблемами, какая последняя', () => {
    expect(hub.logHubSummary()).toContain('Записей пока нет');
    setup();
    const s = hub.logHubSummary({ sessionOnly: false });
    expect(s).toContain('Записей: 4');
    expect(s).toContain('с проблемами: 2');
    expect(s).toContain('Запись b2');
  });
});

describe('интерфейс', () => {
  it('кнопки видов со счётчиками, список, нажатие на запись открывает подробности у самого вида', () => {
    const { a } = setup();
    hub.mountLogHub($('#root'), { sessionOnly: false });
    expect([...document.querySelectorAll('.lh-chip')].map(c => c.textContent.replace(/\s+/g, ' ').trim())).toEqual(['📚 Все 4', '🅰️ Вид a 2', '🅱️ Вид b 2']);
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(4);
    document.querySelector('[data-lh-key="a2"]').click();
    expect(a.open).toHaveBeenCalledWith(expect.objectContaining({ key: 'a2', source: 'a', title: 'Запись a2' }));
  });

  it('выбор вида, поиск и «только проблемы»', () => {
    setup();
    hub.mountLogHub($('#root'), { sessionOnly: false });
    document.querySelector('[data-lh-source="b"]').click();
    expect([...document.querySelectorAll('[data-lh-key]')].map(r => r.dataset.lhKey)).toEqual(['b2', 'b1']);
    const q = $('[data-lh-query]'); q.value = 'b1'; q.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...document.querySelectorAll('[data-lh-key]')].map(r => r.dataset.lhKey)).toEqual(['b1']);
    q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
    const p = $('[data-lh-problems]'); p.checked = true; p.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...document.querySelectorAll('[data-lh-key]')].map(r => r.dataset.lhKey)).toEqual(['b1']);
  });

  it('начальный вид задаётся (кнопка «Журнал» в диалоге передачи)', () => {
    setup();
    hub.mountLogHub($('#root'), { source: 'a', sessionOnly: false });
    expect($('.lh-chip.active').textContent).toContain('Вид a');
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(2);
  });

  it('очистка: только выбранный вид, с подтверждением; на «Все» недоступна', async () => {
    const { a, b } = setup();
    hub.mountLogHub($('#root'), { sessionOnly: false });
    expect($('[data-lh-clear]').disabled).toBe(true);
    document.querySelector('[data-lh-source="a"]').click();
    // Подтверждение асинхронное (confirmModal): после клика ждём, пока оно разрешится
    mocks.confirm.mockResolvedValueOnce(false);
    $('[data-lh-clear]').click();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(a.clear).not.toHaveBeenCalled();
    $('[data-lh-clear]').click();
    await vi.waitFor(() => expect(a.clear).toHaveBeenCalledTimes(1));
    expect(b.clear).not.toHaveBeenCalled();
    expect(hub.collectLogs().items.map(i => i.key)).toEqual(['b2', 'b1']);
    expect($('[data-lh-clear]').disabled).toBe(true);    // у вида больше нет записей
  });

  it('дополнительные кнопки вида (например, архив CSV) показываются на его вкладке', () => {
    const run = vi.fn();
    hub.registerLogSource(makeSource('a', [row('a1', '2026-10-01T00:00:00Z')], { actions: () => [{ id: 'csv', label: '⬇ Архив', run }] }));
    hub.mountLogHub($('#root'), { sessionOnly: false });
    expect($('[data-lh-action="csv"]')).toBeNull();
    document.querySelector('[data-lh-source="a"]').click();
    $('[data-lh-action="csv"]').click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('длинный список выводится порциями по 100', () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`r${i}`, new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()));
    hub.registerLogSource(makeSource('a', rows));
    hub.mountLogHub($('#root'), { sessionOnly: false });
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(100);
    $('[data-lh-more]').click();
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(200);
    $('[data-lh-more]').click();
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(250);
    expect($('[data-lh-more]')).toBeNull();
  });

  it('копирование и текст списка: дата, вид, статус, название, итог', async () => {
    setup();
    const text = hub.logsToText(hub.collectLogs({ source: 'a' }).items);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toMatch(/Вид a · ⚠️ Запись a2 — итог a2/);
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    hub.mountLogHub($('#root'), { sessionOnly: false });
    $('[data-lh-copy]').click(); await wait();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].split('\n')).toHaveLength(4);
  });

  it('новая запись в источнике сама обновляет список (не чаще раза в 250 мс); свёрнутая панель не перерисовывается', async () => {
    const { a } = setup();
    hub.mountLogHub($('#root'), { sessionOnly: false });
    a.rows = [...a.rows, row('a3', '2026-10-05T10:00:00Z')];
    a.emit(); a.emit(); a.emit();
    await wait(320);
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(5);
    $('#p').open = false;
    a.rows = [...a.rows, row('a4', '2026-10-06T10:00:00Z')];
    a.emit(); await wait(320);
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(5);
  });

  it('отписка снимает подписки на источники', () => {
    const { a } = setup();
    const spy = vi.fn();
    const off = hub.onLogsChange(spy);
    a.emit(); expect(spy).toHaveBeenCalledTimes(1);
    off(); a.emit(); expect(spy).toHaveBeenCalledTimes(1);
  });

  it('openLogHub: отдельное окно, вид выбирается сразу', () => {
    setup();
    const ov = hub.openLogHub({ source: 'b', title: '📜 Журнал' });
    expect($('.tf-dialog-title').textContent).toBe('📜 Журнал');
    expect(ov.body.querySelector('.lh-chip.active').textContent).toContain('Вид b');
    ov.close();
    expect($('.tf-dialog')).toBeNull();
  });
});

describe('вид «Скрипты» (taskLog.js)', () => {
  it('задачи попадают в общий журнал; идущая — «выполняется»; очистка не трогает идущие', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    expect(hub.getLogSources().map(s => s.id)).toContain('task');
    const done = startTask('Проверка входа', { dock: false });
    done.finish('Готово: 3 из 3', 'done');
    const bad = startTask('Балансы', { dock: false });
    bad.log('сбой', 'error');
    bad.finish('Ошибок: 1');
    const running = startTask('Марафоны', { dock: false, total: 4 });
    running.progress(1, 4, 'Ауразак');
    const { items } = hub.collectLogs({ source: 'task' });
    expect(Object.fromEntries(items.map(i => [i.title, i.status]))).toEqual({ 'Проверка входа': 'ok', 'Балансы': 'warn', 'Марафоны': 'running' });
    expect(items.find(i => i.title === 'Марафоны').summary).toContain('25%');
    hub.getLogSources().find(s => s.id === 'task').clear();
    expect(hub.collectLogs({ source: 'task' }).items.map(i => i.title)).toEqual(['Марафоны']);
    running.finish('ok');
  });
});


describe('журнал текущей сессии', () => {
  it('при запуске история скрыта, новые записи видны; переключатель возвращает историю без удаления', () => {
    const old = row('old', '2000-01-01T00:00:00Z');
    const src = makeSource('session', [old]);
    hub.registerLogSource(src);
    src.rows.push(row('new', new Date().toISOString()));
    hub.mountLogHub($('#root'));
    expect([...document.querySelectorAll('[data-lh-key]')].map(el => el.dataset.lhKey)).toEqual(['new']);
    expect(hub.logHubSummary()).toContain('Записей: 1');
    const history = $('[data-lh-history]');
    expect(history.checked).toBe(false);
    history.checked = true;
    history.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(2);
    history.checked = false;
    history.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(1);
    expect(src.rows).toContain(old);
    expect(src.clear).not.toHaveBeenCalled();
  });

  it('прошлые задачи остаются в localStorage, но не попадают в текущий запуск', async () => {
    const key = 'tf_task_journal_v1';
    const saved = JSON.stringify([{ id: 'previous', title: 'Прошлая сессия', startedAt: '2000-01-01T00:00:00Z', status: 'done', entries: [] }]);
    localStorage.setItem(key, saved);
    const { startTask } = await import('../js/core/taskLog.js');
    hub.mountLogHub($('#root'));
    expect(document.querySelector('[data-lh-key="previous"]')).toBeNull();
    expect(localStorage.getItem(key)).toBe(saved);
    startTask('Текущая сессия', { dock: false }).finish('Готово');
    expect(hub.collectLogs({ sessionOnly: true }).items.map(it => it.title)).toEqual(['Текущая сессия']);
    expect(JSON.parse(localStorage.getItem(key)).map(it => it.title)).toContain('Прошлая сессия');
  });
});
