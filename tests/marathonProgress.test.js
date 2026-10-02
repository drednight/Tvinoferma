import { describe, it, expect } from 'vitest';
import { createMarathon, computeCell, calendarStates, rewardPotential } from '../js/modules/marathons/model.js';

// 30 дней: июнь 2026, задание на каждый день, цель 25 → запас 5 дней
const june = (over = {}) => createMarathon({
  id: 'm', title: 'Июнь', startDate: '2026-06-01', endDate: '2026-06-30', participantIds: ['c'],
  tasks: [{ id: 't', title: 'Задание', targetChecks: 25,
    rewards: [{ threshold: 15, rewardCoins: 5 }, { threshold: 25, rewardCoins: 10 }] }],
  assignments: { c: ['t'] }, ...over
});
const cell = (m, data) => { m.progress.c = { t: { site: null, adjust: 0, marks: [], history: {}, ...data } }; return m.progress.c.t; };
const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `2026-06-${String(from + i).padStart(2, '0')}`);

describe('сверка с сайтом и ручные отметки идут параллельно (#72, п.3)', () => {
  it('сайт дал 0 (данные из новости), а 25 дней отмечено вручную → 25/25 выполнено', () => {
    const m = june();
    cell(m, { site: 0, marks: days(1, 25) });
    expect(computeCell(m, 'c', 't', '2026-06-26')).toMatchObject({ count: 25, state: 'done', driver: 'manual', coins: 10 });
  });

  it('ручных отметок больше цели: 30/25 допустимо, награда за максимальный порог', () => {
    const m = june();
    cell(m, { site: 25, marks: days(1, 30) });
    const x = computeCell(m, 'c', 't', '2026-06-30');
    expect(x).toMatchObject({ count: 30, target: 25, state: 'done', percent: 100, coins: 10 });
  });

  it('день, отмеченный и на сайте, и вручную, не считается дважды', () => {
    const m = june();
    cell(m, { site: 10, marks: days(1, 10) });
    expect(computeCell(m, 'c', 't', '2026-06-11')).toMatchObject({ count: 10, driver: 'both' });
  });

  it('сайт впереди ручных отметок — берётся сайт; поправка добавляется', () => {
    const m = june();
    cell(m, { site: 12, marks: days(1, 3), adjust: 2 });
    expect(computeCell(m, 'c', 't', '2026-06-13')).toMatchObject({ count: 14, driver: 'site', site: 12, manual: 3 });
  });

  it('запас дней считается отдельно по сайту и по ручному вводу', () => {
    const m = june();
    cell(m, { site: 10, marks: days(1, 4) });
    const x = computeCell(m, 'c', 't', '2026-06-11'); // осталось 20 дней
    expect(x.left).toBe(20);
    expect(x.siteReserve).toBe(20 - 15);
    expect(x.manualReserve).toBe(20 - 21);
    expect(computeCell(june(), 'c', 't', '2026-06-11').siteReserve).toBeNull();
  });
});

describe('календарь: запасные дни и пропуски (#72, п.6)', () => {
  const count = (st, key) => Object.values(st).filter(v => v === key).length;

  it('в начале все 5 запасных дней жёлтые и стоят в конце периода', () => {
    const m = june(); const c = cell(m, {});
    const st = calendarStates(m, m.tasks[0], c, '2026-06-01');
    expect(count(st, 'spare')).toBe(5);
    expect(count(st, 'missed')).toBe(0);
    expect(days(26, 30).every(d => st[d] === 'spare')).toBe(true);
  });

  it('пропущенный день краснеет, а жёлтых становится меньше', () => {
    const m = june(); const c = cell(m, { marks: days(1, 4) }); // 5-е пропущено, сегодня 6-е
    const st = calendarStates(m, m.tasks[0], c, '2026-06-06');
    expect(st['2026-06-05']).toBe('missed');
    expect(st['2026-06-01']).toBe('marked');
    expect(count(st, 'spare')).toBe(4);
  });

  it('пропусков больше запаса: все прошедшие неотмеченные дни красные, жёлтых нет', () => {
    const m = june(); const c = cell(m, { marks: [] });
    const st = calendarStates(m, m.tasks[0], c, '2026-06-12'); // прошло 11 дней без отметок, нужно 25 из 19 оставшихся
    expect(count(st, 'missed')).toBe(11);
    expect(count(st, 'spare')).toBe(0);
  });

  it('прирост по сверке закрашивается как «сайт», а выполнения без даты закрывают ранние пропуски', () => {
    const m = june(); const c = cell(m, { site: 5, history: { '2026-06-03': 2 } });
    const st = calendarStates(m, m.tasks[0], c, '2026-06-08');
    expect(st['2026-06-03']).toBe('site');
    // 5 выполнений: 1 день с датой + 4 без даты закрывают 4 ранних пропуска; из 6 неотмеченных дней красных остаётся 2
    expect(count(st, 'missed')).toBe(2);
  });

  it('цель достигнута — ни красных, ни жёлтых', () => {
    const m = june(); const c = cell(m, { marks: days(1, 25) });
    const st = calendarStates(m, m.tasks[0], c, '2026-06-28');
    expect(count(st, 'missed') + count(st, 'spare')).toBe(0);
  });

  it('дни, когда задание не выдаётся, остаются неактивными', () => {
    const m = june(); m.tasks[0].schedule = { mode: 'dates', dates: ['2026-06-02'], weekStartDay: 1 };
    const st = calendarStates(m, m.tasks[0], cell(m, {}), '2026-06-01');
    expect(st['2026-06-03']).toBe('inactive');
  });
});

describe('сколько монет можно получить (#72, п.2)', () => {
  it('максимум и пороги', () => {
    const p = rewardPotential(june().tasks[0]);
    expect(p.max).toBe(10);
    expect(p.text).toBe('до 10 ДМ за задание (15 → 5, 25 → 10)');
  });
  it('один порог и отсутствие наград', () => {
    const m = june({ tasks: [{ id: 'a', title: 'A', targetChecks: 3, rewards: [{ threshold: 3, rewardCoins: 7 }] }, { id: 'b', title: 'B', targetChecks: 1 }] });
    expect(rewardPotential(m.tasks[0]).text).toBe('7 ДМ за задание');
    expect(rewardPotential(m.tasks[1]).text).toBe('');
  });
});
