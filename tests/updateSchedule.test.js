import { describe, it, expect } from 'vitest';
import {
  resolveUpdateMode, lastBoundary, nextBoundary, isCheckDue, nextCheckText
} from '../js/desktop/updateSchedule.js';

// Issue #83: расписание автопроверки обновлений. 2026-10-07 — среда.
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe('resolveUpdateMode', () => {
  it('берёт mode, если он задан', () => {
    expect(resolveUpdateMode({ updates: { mode: 'weekly', checkOnStartup: false } })).toBe('weekly');
  });
  it('старые данные: отключённая проверка и старый never → startup', () => {
    expect(resolveUpdateMode({ updates: { checkOnStartup: false } })).toBe('startup');
    expect(resolveUpdateMode({ updates: { mode: 'never' } })).toBe('startup');
    expect(resolveUpdateMode({ updates: { checkOnStartup: true } })).toBe('startup');
    expect(resolveUpdateMode({})).toBe('startup');
    expect(resolveUpdateMode({ updates: { mode: 'bogus' } })).toBe('startup');
  });
});

describe('границы расписания', () => {
  it('daily: ближайшая полночь', () => {
    const now = at(2026, 10, 7, 15, 30);
    expect(lastBoundary('daily', now)).toEqual(at(2026, 10, 7));
    expect(nextBoundary('daily', now)).toEqual(at(2026, 10, 8));
  });
  it('weekly: понедельник 00:00', () => {
    const wed = at(2026, 10, 7, 15, 30);
    expect(lastBoundary('weekly', wed)).toEqual(at(2026, 10, 5));
    expect(nextBoundary('weekly', wed)).toEqual(at(2026, 10, 12));
    const sun = at(2026, 10, 11, 23, 59);
    expect(lastBoundary('weekly', sun)).toEqual(at(2026, 10, 5));
    const mon = at(2026, 10, 12, 0, 0);
    expect(lastBoundary('weekly', mon)).toEqual(at(2026, 10, 12));
  });
});

describe('isCheckDue', () => {
  const now = at(2026, 10, 7, 10, 0);
  it('daily: нужна, если сегодняшней проверки ещё не было', () => {
    expect(isCheckDue('daily', at(2026, 10, 6, 23, 0), now)).toBe(true);
    expect(isCheckDue('daily', at(2026, 10, 7, 0, 5), now)).toBe(false);
    expect(isCheckDue('daily', null, now)).toBe(true);
    expect(isCheckDue('daily', 'мусор', now)).toBe(true);
  });
  it('weekly: нужна, если на этой неделе проверки не было', () => {
    expect(isCheckDue('weekly', at(2026, 10, 4, 12, 0), now)).toBe(true);
    expect(isCheckDue('weekly', at(2026, 10, 5, 0, 1), now)).toBe(false);
  });
  it('startup и never не планируются', () => {
    expect(isCheckDue('startup', null, now)).toBe(false);
    expect(isCheckDue('never', null, now)).toBe(false);
  });
});

describe('nextCheckText', () => {
  it('подписи по режимам', () => {
    expect(nextCheckText('never')).toMatch(/запуске/);
    expect(nextCheckText('startup')).toMatch(/запуске/);
    expect(nextCheckText('daily', at(2026, 10, 7, 10))).toMatch(/08\.10\.2026/);
  });
});
