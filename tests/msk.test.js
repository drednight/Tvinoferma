import { describe, expect, it } from 'vitest';
import {
  mskParts, mskDate, mskTime, mskTimeSeconds, mskMinutes, mskWeekday, mskAddDays, mskDateTime, mskText,
  mskStamp, mskStampSeconds, weekdayOfDate
} from '../js/core/msk.js';

// Летом Москва — UTC+3; зимой тоже UTC+3 (перевода часов нет с 2014 года).
describe('московское время', () => {
  it('дата и время считаются по Москве, а не по местному поясу', () => {
    // 21:30 UTC = 00:30 следующего дня по Москве
    const late = new Date('2026-06-10T21:30:00Z');
    expect(mskDate(late)).toBe('2026-06-11');
    expect(mskTime(late)).toBe('00:30');
    expect(mskMinutes(late)).toBe(30);
  });

  it('полночь — «00:00», а не «24:00»', () => {
    expect(mskTime(new Date('2026-06-10T21:00:00Z'))).toBe('00:00');
    expect(mskMinutes(new Date('2026-06-10T21:00:00Z'))).toBe(0);
  });

  it('время с секундами «ЧЧ:ММ:СС» — по Москве, с нулями слева', () => {
    expect(mskTimeSeconds(new Date('2026-06-10T17:20:05Z'))).toBe('20:20:05');
    expect(mskTimeSeconds(new Date('2026-06-10T21:00:00Z'))).toBe('00:00:00');
    expect(mskTimeSeconds(new Date('не дата'))).toBe('');
  });

  it('зимой смещение то же: UTC+3 круглый год', () => {
    expect(mskDate(new Date('2026-01-15T22:00:00Z'))).toBe('2026-01-16');
    expect(mskTime(new Date('2026-01-15T22:00:00Z'))).toBe('01:00');
  });

  it('день недели в нумерации планировщика: 0 — понедельник', () => {
    // 2026-06-08 — понедельник, 2026-06-14 — воскресенье
    expect(mskWeekday(new Date('2026-06-08T12:00:00Z'))).toBe(0);
    expect(mskWeekday(new Date('2026-06-10T12:00:00Z'))).toBe(2);   // среда
    expect(mskWeekday(new Date('2026-06-11T12:00:00Z'))).toBe(3);   // четверг
    expect(mskWeekday(new Date('2026-06-12T12:00:00Z'))).toBe(4);   // пятница
    expect(mskWeekday(new Date('2026-06-14T12:00:00Z'))).toBe(6);
  });

  it('день недели не сбивается на границе суток по Москве', () => {
    // 21:30 UTC воскресенья = уже понедельник по Москве
    expect(mskWeekday(new Date('2026-06-14T21:30:00Z'))).toBe(0);
  });

  it('сдвиг даты работает через границы месяца и года', () => {
    expect(mskAddDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(mskAddDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(mskAddDays('2026-06-10', 0)).toBe('2026-06-10');
    expect(mskAddDays('мусор', 3)).toBe('');
  });

  it('момент московского времени переводится в Date с постоянным смещением +3', () => {
    const d = mskDateTime('2026-06-10', '20:20');
    expect(d.toISOString()).toBe('2026-06-10T17:20:00.000Z');
    // Обратный перевод даёт то же время — вычисления согласованы
    expect(mskTime(d)).toBe('20:20');
    expect(mskDate(d)).toBe('2026-06-10');
  });

  it('подпись для логов: дата и время по Москве', () => {
    expect(mskText(new Date('2026-06-10T17:20:00Z'))).toBe('2026-06-10 20:20');
  });

  it('привычная подпись «02.10.2026 15:20» и с секундами — тоже по Москве', () => {
    expect(mskStamp(new Date('2026-10-02T15:20:00Z'))).toBe('02.10.2026 18:20');
    expect(mskStampSeconds(new Date('2026-10-02T15:20:05Z'))).toBe('02.10.2026 18:20:05');
    expect(mskStamp('мусор')).toBe('');
  });

  it('день недели календарной даты считается без часовых поясов', () => {
    expect(weekdayOfDate('2026-06-08')).toBe(0);
    expect(weekdayOfDate('2026-06-14')).toBe(6);
    expect(weekdayOfDate('2026-06-15')).toBe(0);   // следующий понедельник
    expect(weekdayOfDate('мусор')).toBe(-1);
  });

  it('битая дата не роняет функции', () => {
    const bad = new Date('не дата');
    expect(mskDate(bad)).toBe('');
    expect(mskTime(bad)).toBe('');
    expect(mskText(bad)).toBe('');
    expect(mskParts(bad)).toEqual({ year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 });
  });
});
