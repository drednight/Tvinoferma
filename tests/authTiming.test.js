import { describe, it, expect, vi } from 'vitest';

// Замер скорости проверки входа (js/modules/sync/authTiming.js).
// Главное в нём — что отчёт не врёт: пропущенные и упавшие проверки времени не имеют,
// и раньше они попадали в средние, показывая половину настоящего времени.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../js/modules/sync/checkAuth.js', () => ({ checkCharacterAuth: vi.fn(async () => ({})) }));

const { parseTimings, stageAverages, timingReport, measuredRows, measureAuth, measureAllAuth } =
  await import('../js/modules/sync/authTiming.js');

const TIMINGS = { totalMs: 4000, windowMs: 500, navigateMs: 500, parseMs: 2000, cookiesMs: 1000 };

const row = (charId, over = {}) => ({ charId, status: 'online', reason: null, ...TIMINGS, ...over });

/** Ответ команды `check_login_status_http`: разбивка по этапам лежит в `timings`. */
const payload = (charId) => ({ charId, status: 'online', reason: null, timings: { ...TIMINGS } });

describe('замер входа: разбор результата', () => {
  it('timings из ответа Rust разбираются в числа, отсутствующие — в нули', () => {
    const [r] = parseTimings([{ charId: 'a', status: 'online', timings: { totalMs: '4200', windowMs: 300 } }]);
    expect(r).toEqual({ charId: 'a', status: 'online', reason: null, totalMs: 4200, windowMs: 300, navigateMs: 0, parseMs: 0, cookiesMs: 0 });
    // skipped отдаётся вовсе без timings — разбор не должен падать
    expect(parseTimings([{ charId: 'b', status: 'skipped', reason: 'window_open' }])[0].totalMs).toBe(0);
  });
});

describe('замер входа: средние не врут', () => {
  it('пропущенные и упавшие не попадают в среднее', () => {
    const rows = [
      row('a'), row('b'),
      row('c', { status: 'skipped', reason: 'window_open', totalMs: 0, windowMs: 0, navigateMs: 0, parseMs: 0, cookiesMs: 0 })
    ];
    expect(measuredRows(rows).map(r => r.charId)).toEqual(['a', 'b']);
    // Без фильтра среднее было бы 2667 мс вместо 4000
    expect(stageAverages(rows).totalMs).toBe(4000);
  });

  it('пустой набор — нули, а не NaN', () => {
    expect(stageAverages([]).totalMs).toBe(0);
    expect(stageAverages([row('a', { status: 'skipped' })]).totalMs).toBe(0);
  });
});

describe('замер входа: отчёт', () => {
  it('среднее считается по замеренным, пропуски видны отдельной строкой', () => {
    const text = timingReport([row('a'), row('b'), row('c', { status: 'skipped', reason: 'window_open' })]);
    expect(text).toContain('Среднее по 2');
    expect(text).toContain('Без времени: 1');
    expect(text).toContain('c: skipped (window_open)');
    expect(text).toContain('Дольше всего');
  });

  it('без единого замера не показывает нули и подсказку «дольше всего»', () => {
    const text = timingReport([
      row('a', { status: 'skipped', reason: 'window_open' }),
      row('b', { status: 'error', reason: 'окно не создалось' })
    ]);
    expect(text).toContain('Время не замерено');
    expect(text).not.toContain('Дольше всего');
  });

  it('нет ни одного результата — понятная строка', () => {
    expect(timingReport([])).toContain('Замеров нет');
  });
});

describe('замер входа: measureAuth', () => {
  it('ошибка одного персонажа не отменяет замер остальных', async () => {
    const seen = [];
    const res = await measureAuth(['a', 'b', 'c'], {
      deps: {
        check: async (id) => {
          seen.push(id);
          if (id === 'b') throw new Error('окно не создалось');
          return payload(id);
        }
      }
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(res.rows.map(r => r.status)).toEqual(['online', 'error', 'online']);
    expect(res.avg.totalMs).toBe(4000);
  });
});

describe('замер входа: measureAllAuth', () => {
  const state = { characters: [
    { id: 'a', isLoggedIn: true },
    { id: 'arch', isLoggedIn: true, archived: true },
    { id: 'b', isLoggedIn: false },
    { id: 'c', isLoggedIn: null }
  ] };

  it('берёт всех, кроме архивных, и по умолчанию первые 10', async () => {
    const seen = [];
    const res = await measureAllAuth({ state, deps: { check: async (id) => { seen.push(id); return payload(id); } } });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(res.report).not.toContain('Замерены первые');
  });

  it('лимит и «только непроверенные» уважаются, deps доходят до замера', async () => {
    const seen = [];
    await measureAllAuth({ state, limit: 1, deps: { check: async (id) => { seen.push(id); return payload(id); } } });
    expect(seen).toEqual(['a']);
    seen.length = 0;
    await measureAllAuth({ state, onlyUnconfirmed: true, deps: { check: async (id) => { seen.push(id); return payload(id); } } });
    expect(seen).toEqual(['b', 'c']);
  });
});