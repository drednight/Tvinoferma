// История и статистика запусков игры (launchLog.js, launchLogView.js).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeRun, loadLaunchLog, recordLaunchRun, clearLaunchLog, statsOf, perCharacter, perDelay, delayAdvice, fmtMs,
  LOG_KEY, LOG_MAX
} from '../js/modules/launcher/launchLog.js';
import { runSummary, runDetailsHtml, statsView, launchLogSource } from '../js/modules/launcher/launchLogView.js';

const item = (id, status = 'ok', ms = 4000, over = {}) => ({ id, nick: id.toUpperCase(), status, ms, ...over });
const run = (items, over = {}) => ({ id: `r${Math.random()}`, at: '2026-10-01T10:00:00Z', title: 'Пати', ms: 20000, delayMs: 3000, gc: 'Папка 1', requested: items.length, items, ...over });
/** Журнал нужного вида: от новых к старым, как отдаёт loadLaunchLog. */
const logOf = (...runs) => runs.map(r => normalizeRun(r)).sort((a, b) => b.at.localeCompare(a.at));

beforeEach(() => { window.localStorage.clear(); });

describe('normalizeRun', () => {
  it('считает итоги по окнам и чистит данные', () => {
    const r = normalizeRun(run([item('a'), item('b', 'failed', 9000, { error: 'нет окна\n\tклиента' }), item('c', 'cancelled', null), item('d', 'running', null), item('e', 'nogc', null)]));
    expect([r.ok, r.failed, r.cancelled, r.running, r.noGc]).toEqual([1, 1, 1, 1, 1]);
    expect(r.items[1].error).toBe('нет окна  клиента');
    expect(r.items[2].ms).toBeNull();
  });

  it('мусор и пустые запуски отбрасываются', () => {
    expect(normalizeRun(null)).toBeNull();
    expect(normalizeRun(run([]))).toBeNull();
    expect(normalizeRun(run([item('a')], { at: 'вчера' }))).toBeNull();
    expect(normalizeRun(run([{ id: 'a', status: 'странный' }, { status: 'ok' }]))).toBeNull();
  });

  it('requested не меньше числа окон, числа ограничены', () => {
    const r = normalizeRun(run([item('a'), item('b')], { requested: 1, delayMs: -5, ms: 'abc' }));
    expect(r.requested).toBe(2);
    expect(r.delayMs).toBe(0);
    expect(r.ms).toBe(0);
  });
});

describe('журнал: запись, чтение, очистка', () => {
  it('новые записи сверху, событие tf-launch-log при записи и очистке', () => {
    const seen = vi.fn();
    window.addEventListener('tf-launch-log', seen);
    recordLaunchRun(run([item('a')], { id: 'old', at: '2026-10-01T10:00:00Z' }));
    recordLaunchRun(run([item('b')], { id: 'new', at: '2026-10-02T10:00:00Z' }));
    expect(loadLaunchLog().map(r => r.id)).toEqual(['new', 'old']);
    expect(seen).toHaveBeenCalledTimes(2);
    clearLaunchLog();
    expect(loadLaunchLog()).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(3);
    window.removeEventListener('tf-launch-log', seen);
  });

  it('хранит не больше LOG_MAX запусков; пустая запись возвращает null и ничего не пишет', () => {
    expect(recordLaunchRun(run([]))).toBeNull();
    expect(window.localStorage.getItem(LOG_KEY)).toBeNull();
    for (let i = 0; i < LOG_MAX + 5; i++) recordLaunchRun(run([item('a')], { id: `r${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const log = loadLaunchLog();
    expect(log).toHaveLength(LOG_MAX);
    expect(log[0].id).toBe(`r${LOG_MAX + 4}`);
  });

  it('повреждённое хранилище не ломает чтение', () => {
    window.localStorage.setItem(LOG_KEY, '{не json');
    expect(loadLaunchLog()).toEqual([]);
    window.localStorage.setItem(LOG_KEY, JSON.stringify([{ мусор: 1 }, run([item('a')])]));
    expect(loadLaunchLog()).toHaveLength(1);
  });
});

describe('statsOf', () => {
  it('считает попытки, ошибки, среднее и максимум времени по успешным', () => {
    const s = statsOf(logOf(run([item('a', 'ok', 2000), item('b', 'ok', 6000), item('c', 'failed', 30000), item('d', 'running', null), item('e', 'nogc', null), item('f', 'cancelled', null)])));
    expect([s.runs, s.attempts, s.ok, s.failed, s.cancelled, s.skippedRunning, s.noGc]).toEqual([1, 3, 2, 1, 1, 1, 1]);
    expect(s.avgMs).toBe(4000);
    expect(s.maxMs).toBe(6000);
    expect(s.failRate).toBeCloseTo(1 / 3);
  });

  it('пустой журнал: нули и прочерки', () => {
    const s = statsOf([]);
    expect(s).toMatchObject({ runs: 0, attempts: 0, failRate: 0, avgMs: null, maxMs: null, from: null, to: null });
  });
});

describe('perCharacter', () => {
  it('нестабильные (≥3 попыток и ≥30% ошибок) — первыми; последняя ошибка берётся из самого свежего запуска', () => {
    const log = logOf(
      run([item('a', 'failed', 100, { error: 'старая' }), item('b')], { at: '2026-10-01T10:00:00Z' }),
      run([item('a', 'failed', 100, { error: 'свежая' }), item('b')], { at: '2026-10-02T10:00:00Z' }),
      run([item('a'), item('b')], { at: '2026-10-03T10:00:00Z' })
    );
    const rows = perCharacter(log);
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ attempts: 3, failed: 2, unstable: true, lastError: 'свежая' });
    expect(rows[1]).toMatchObject({ attempts: 3, failed: 0, unstable: false, avgMs: 4000 });
  });

  it('мало попыток — не «нестабильный»; пропуски считаются отдельно и в попытки не входят', () => {
    const rows = perCharacter(logOf(run([item('a', 'failed'), item('b', 'running', null)]), run([item('a', 'failed')], { at: '2026-10-02T10:00:00Z' })));
    const a = rows.find(r => r.id === 'a');
    expect(a).toMatchObject({ attempts: 2, failed: 2, unstable: false });
    expect(rows.find(r => r.id === 'b')).toMatchObject({ attempts: 0, skipped: 1, failRate: 0 });
  });
});

describe('perDelay и delayAdvice', () => {
  const many = (n, failed, delayMs, at = '2026-10-01T10:00:00Z') => run(Array.from({ length: n }, (_, i) => item(`c${i}`, i < failed ? 'failed' : 'ok')), { delayMs, at });

  it('группирует по паузе, по возрастанию', () => {
    const rows = perDelay(logOf(many(10, 2, 3000, '2026-10-01T10:00:00Z'), many(10, 0, 5000, '2026-10-02T10:00:00Z'), many(5, 1, 3000, '2026-10-03T10:00:00Z')));
    expect(rows.map(r => [r.delaySec, r.windows, r.failed])).toEqual([[3, 15, 3], [5, 10, 0]]);
  });

  it('мало данных — честно об этом говорит', () => {
    expect(delayAdvice(perDelay(logOf(many(4, 1, 3000))), 3)).toMatch(/Пока мало данных/);
  });

  it('при разных паузах называет лучшую и худшую', () => {
    const rows = perDelay(logOf(many(10, 4, 2000, '2026-10-01T10:00:00Z'), many(10, 0, 5000, '2026-10-02T10:00:00Z')));
    const text = delayAdvice(rows, 2);
    expect(text).toContain('Меньше всего ошибок при паузе 5 с');
    expect(text).toContain('больше всего — при 2 с');
    expect(text).toContain('Сейчас в настройках 2 с');
  });

  it('одинаковые доли ошибок при разных паузах: пауза не влияет', () => {
    const rows = perDelay(logOf(many(10, 1, 2000, '2026-10-01T10:00:00Z'), many(10, 1, 5000, '2026-10-02T10:00:00Z')));
    expect(delayAdvice(rows, 3)).toMatch(/поровну/);
  });

  it('одна пауза: нет ошибок — можно быстрее; много ошибок — увеличить', () => {
    expect(delayAdvice(perDelay(logOf(many(12, 0, 3000))), 3)).toMatch(/Ошибок нет/);
    expect(delayAdvice(perDelay(logOf(many(12, 4, 3000))), 3)).toMatch(/увеличить паузу/);
    expect(delayAdvice(perDelay(logOf(many(20, 1, 3000))), 3)).toMatch(/Ошибок немного/);
  });
});

describe('fmtMs', () => {
  it('секунды и минуты', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(4200)).toBe('4,2 с');
    expect(fmtMs(12400)).toBe('12 с');
    expect(fmtMs(65000)).toBe('1 мин 5 с');
  });
});

describe('вид «Запуски» в журналах', () => {
  it('подпись и подробности запуска: пропущенные, без GameCenter, ошибки; текст экранируется', () => {
    const r = normalizeRun(run([item('a'), item('b', 'failed', 9000, { error: '<b>сбой</b>' }), item('c', 'running', null), item('d', 'nogc', null)], { title: 'Пати <1>' }));
    expect(runSummary(r)).toContain('запущено 1 из 2');
    expect(runSummary(r)).toContain('ошибок 1');
    expect(runSummary(r)).toContain('уже было запущено 1');
    expect(runSummary(r)).toContain('без GameCenter 1');
    const html = runDetailsHtml(r);
    expect(html).toContain('уже было запущено, пропущено');
    expect(html).toContain('&lt;b&gt;сбой&lt;/b&gt;');
    expect(html).toContain('Пати &lt;1&gt;');
    expect(html).not.toContain('<b>сбой</b>');
  });

  it('источник отдаёт записи со статусом, очищается и сообщает о новых запусках', () => {
    recordLaunchRun(run([item('a'), item('b', 'failed')], { id: 'x1' }));
    recordLaunchRun(run([item('a')], { id: 'x2', at: '2026-10-02T10:00:00Z' }));
    const rows = launchLogSource.list();
    expect(rows.map(r => [r.key, r.status])).toEqual([['x2', 'ok'], ['x1', 'error']]);
    const cb = vi.fn();
    const off = launchLogSource.subscribe(cb);
    recordLaunchRun(run([item('a')], { id: 'x3' }));
    expect(cb).toHaveBeenCalled();
    off();
    expect(launchLogSource.actions()[0]).toMatchObject({ id: 'stats', disabled: false });
    launchLogSource.clear();
    expect(launchLogSource.list()).toEqual([]);
    expect(launchLogSource.actions()[0].disabled).toBe(true);
  });

  it('статистика: нестабильные в таблице и в предупреждении, совет по паузе, пустой журнал не падает', () => {
    const log = logOf(...Array.from({ length: 4 }, (_, i) => run([item('a', i < 2 ? 'failed' : 'ok', 3000, { error: 'нет клиента' }), item('b')], { at: `2026-10-0${i + 1}T10:00:00Z` })));
    const v = statsView(log, 3);
    expect(v.chars[0]).toMatchObject({ id: 'a', unstable: true });
    expect(v.html).toContain('Нестабильные');
    expect(v.html).toContain('promo-alert-row');
    expect(v.text).toContain('Нестабильные: A');
    expect(v.advice).toMatch(/Пока мало данных/);   // 8 окон < 10
    const empty = statsView([], 3);
    expect(empty.html).toContain('Данных пока нет');
    expect(empty.advice).toMatch(/Пока мало данных/);
  });
});
