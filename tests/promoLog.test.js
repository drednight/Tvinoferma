// Журнал и архив промокодов (Issue #25): запись только успешных, награда с первого прохода, пропуск, архив.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLog, applyRows, recordRun, planRun, recentRecords, missedList, enteredList, loadArchive, upsertArchive, archiveCsv,
  clearLog, LOG_MAX, RECENT_N, LOG_KEY
} from '../js/modules/automation/promoLog.js';

const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, n));
const chars = [{ id: 'a', nick: 'Аа' }, { id: 'b', nick: 'Бб' }, { id: 'c', nick: 'Вв' }];
const reward = [{ name: 'Метеорит', qty: 100, id: '47493', bound: true }];
const row = (charId, status, over = {}) => ({ code: 'CODE1234', charId, nick: chars.find(c => c.id === charId).nick, status, error: null, clicked: true, dryRun: false, skipped: false, rewards: null, at: T(1).toISOString(), ...over });

beforeEach(() => { window.localStorage.clear(); });

describe('applyRows', () => {
  it('недействительные коды не сохраняются, даже если запись уже есть — она не меняется', () => {
    const r = applyRows([], 'BAD00001', [row('a', 'invalid_code', { code: 'BAD00001' }), row('b', 'expired', { code: 'BAD00001' })], { known: chars, now: T(2) });
    expect(r.log).toEqual([]);
    expect(r.record).toBeNull();
  });

  it('только ошибки (нет входа, проверка) — записи тоже нет', () => {
    expect(applyRows([], 'CODE1234', [row('a', 'challenge'), row('b', 'not_logged_in')], { known: chars, now: T(2) }).record).toBeNull();
  });

  it('первый успех создаёт запись: дата первого ввода, награда, кому введён и кому нет (и почему)', () => {
    const { record, created } = applyRows([], 'CODE1234', [
      row('a', 'success', { rewards: reward, at: T(1).toISOString() }),
      row('b', 'already_used'),
      row('c', 'challenge')
    ], { known: chars, now: T(5) });
    expect(created).toBe(true);
    expect(record.firstAt).toBe(T(5).toISOString());
    expect(record.reward).toEqual(reward);
    expect(enteredList(record).map(e => [e.nick, e.status])).toEqual([['Аа', 'success'], ['Бб', 'already_used']]);
    expect(missedList(record)).toEqual([{ id: 'c', nick: 'Вв', reason: { nick: 'Вв', status: 'challenge', error: null, detail: null, at: T(1).toISOString() } }]);
  });

  it('персонаж, которого не запускали, виден в «не введён» без причины', () => {
    const { record } = applyRows([], 'CODE1234', [row('a', 'success')], { known: chars, now: T(5) });
    expect(missedList(record).map(m => [m.nick, m.reason])).toEqual([['Бб', null], ['Вв', null]]);
  });

  it('повторный запуск: добавленные переходят из «не введён» в «введён», дата первого ввода не меняется', () => {
    const first = applyRows([], 'CODE1234', [row('a', 'success'), row('c', 'challenge')], { known: chars, now: T(5) });
    const second = applyRows(first.log, 'CODE1234', [row('c', 'success', { at: T(9).toISOString() })], { known: chars, now: T(10) });
    expect(second.created).toBe(false);
    expect(second.record.firstAt).toBe(T(5).toISOString());
    expect(second.record.lastAt).toBe(T(10).toISOString());
    expect(enteredList(second.record).map(e => e.nick)).toEqual(['Аа', 'Вв']);
    expect(second.record.missed.c).toBeUndefined();
  });

  it('у кого код уже введён, ошибка потом не затирает ввод; первый ввод не перезаписывается', () => {
    const first = applyRows([], 'CODE1234', [row('a', 'success', { at: T(1).toISOString() })], { known: chars, now: T(5) });
    const next = applyRows(first.log, 'CODE1234', [row('a', 'error'), row('a', 'already_used', { at: T(8).toISOString() })], { known: chars, now: T(9) });
    expect(next.record.entered.a).toEqual({ nick: 'Аа', at: T(1).toISOString(), status: 'success' });
    expect(next.record.missed.a).toBeUndefined();
  });

  it('награда записывается с первого удачного прохода и больше не перезаписывается', () => {
    const first = applyRows([], 'CODE1234', [row('a', 'success', { rewards: reward })], { known: chars, now: T(5) });
    const other = [{ name: 'Другое', qty: 1, id: null, bound: false }];
    const next = applyRows(first.log, 'CODE1234', [row('b', 'success', { rewards: other })], { known: chars, now: T(6) });
    expect(next.record.reward).toEqual(reward);
    expect(next.rewardSet).toBe(false);
  });

  it('успех без списка наград: награда подтянется со следующего успеха', () => {
    const first = applyRows([], 'CODE1234', [row('a', 'success')], { known: chars, now: T(5) });
    expect(first.record.reward).toBeNull();
    const next = applyRows(first.log, 'CODE1234', [row('b', 'success', { rewards: reward })], { known: chars, now: T(6) });
    expect(next.record.reward).toEqual(reward);
    expect(next.rewardSet).toBe(true);
  });

  it('пропущенные по журналу строки и пробные запуски ничего не меняют', () => {
    const first = applyRows([], 'CODE1234', [row('a', 'success')], { known: chars, now: T(5) });
    const next = applyRows(first.log, 'CODE1234', [row('b', 'already_used', { skipped: true }), row('c', 'dry_run', { dryRun: true })], { known: chars, now: T(6) });
    expect(Object.keys(next.record.entered)).toEqual(['a']);
    expect(next.record.missed).toEqual({});
  });

  it(`журнал хранит не больше ${LOG_MAX} кодов: вытесняются давние`, () => {
    let log = [];
    for (let i = 0; i < LOG_MAX + 5; i++) {
      log = applyRows(log, `CODE${1000 + i}`, [row('a', 'success', { code: `CODE${1000 + i}` })], { known: chars, now: T(i) }).log;
    }
    expect(log).toHaveLength(LOG_MAX);
    expect(log.some(r => r.code === 'CODE1000')).toBe(false);
    expect(log[0].code).toBe(`CODE${1000 + LOG_MAX + 4}`);
  });
});

describe('planRun: пропуск уже введённых среди последних кодов', () => {
  const build = () => {
    let log = [];
    for (let i = 0; i < RECENT_N + 2; i++) {
      const code = `CODE${1000 + i}`;
      log = applyRows(log, code, [row('a', 'success', { code }), row('b', 'challenge', { code })], { known: chars, now: T(i) }).log;
    }
    return log;
  };

  it('для кода из последних 10: введённым — пропуск, остальным — запуск', () => {
    const [plan] = planRun(build(), [`CODE${1000 + RECENT_N + 1}`], chars);
    expect(plan.done.map(c => c.id)).toEqual(['a']);
    expect(plan.todo.map(c => c.id)).toEqual(['b', 'c']);
    expect(plan.record).not.toBeNull();
  });

  it('код старше последних 10 считается новым', () => {
    const [plan] = planRun(build(), ['CODE1000'], chars);
    expect(plan.record).toBeNull();
    expect(plan.todo).toHaveLength(3);
  });

  it('регистр кода не важен; новый код — всем', () => {
    const [a, b] = planRun(build(), [`code${1000 + RECENT_N + 1}`, 'NEWCODE99'], chars);
    expect(a.done).toHaveLength(1);
    expect(b.todo).toHaveLength(3);
  });

  it('недавними считаются последние использованные, а не самые старые по дате первого ввода', () => {
    const recent = recentRecords(build());
    expect(recent).toHaveLength(RECENT_N);
    expect(recent[0].code).toBe(`CODE${1000 + RECENT_N + 1}`);
  });
});

describe('запись на диск и архив', () => {
  it('recordRun сохраняет журнал и архив, недействительный код — нет', () => {
    recordRun('CODE1234', [row('a', 'success', { rewards: reward })], { known: chars, now: T(5) });
    recordRun('BAD00001', [row('a', 'invalid_code', { code: 'BAD00001' })], { known: chars, now: T(6) });
    expect(loadLog().map(r => r.code)).toEqual(['CODE1234']);
    expect(loadArchive()).toEqual([{ code: 'CODE1234', firstAt: T(5).toISOString(), reward }]);
  });

  it('архив не ограничен журналом и не очищается вместе с ним', () => {
    for (let i = 0; i < LOG_MAX + 3; i++) recordRun(`CODE${2000 + i}`, [row('a', 'success', { code: `CODE${2000 + i}` })], { known: chars, now: T(i) });
    expect(loadLog()).toHaveLength(LOG_MAX);
    expect(loadArchive()).toHaveLength(LOG_MAX + 3);
    clearLog();
    expect(loadLog()).toEqual([]);
    expect(loadArchive()).toHaveLength(LOG_MAX + 3);
  });

  it('upsertArchive дописывает награду, но не меняет дату и уже записанную награду', () => {
    const a = upsertArchive([], { code: 'X1234', firstAt: 'd1', reward: null });
    const b = upsertArchive(a, { code: 'x1234', firstAt: 'd2', reward });
    expect(b).toEqual([{ code: 'X1234', firstAt: 'd1', reward }]);
    expect(upsertArchive(b, { code: 'X1234', firstAt: 'd3', reward: [{ name: 'Z', qty: 1 }] })).toBe(b);
  });

  it('CSV архива: код, дата, награда', () => {
    const csv = archiveCsv([{ code: 'CODE1234', firstAt: 'd', reward: [{ name: 'Метеорит', qty: 100 }, { name: 'Руны', qty: 1 }] }]);
    expect(csv).toBe('\ufeffПромокод;Дата первого ввода;Награда\r\nCODE1234;d;"Метеорит ×100; Руны"');
  });

  it('прежний формат истории удаляется, повреждённые данные не ломают загрузку', () => {
    window.localStorage.setItem('tf_promo_history_v1', '[]');
    window.localStorage.setItem(LOG_KEY, '{oops');
    expect(loadLog()).toEqual([]);
    expect(window.localStorage.getItem('tf_promo_history_v1')).toBeNull();
  });
});
