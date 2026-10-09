import { describe, expect, it } from 'vitest';
import {
  timeToMinutes, minutesToTime, eventDuration, eventEndMinutes, eventEndTime,
  timelineBlocks, isAllDayEvent, hourMarks, DAY_MINUTES, DEFAULT_DURATION_MINUTES
} from '../js/modules/dashboard/timeline.js';

const ev = (time, extra = {}) => ({ id: time || 'x', title: `T${time}`, time, color: 'blue', source: 'manual', ...extra });

describe('шкала дня', () => {
  it('переводит время в минуты и обратно', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('20:20')).toBe(1220);
    expect(timeToMinutes('24:00')).toBe(null);   // «24:00» — не время начала, а конец суток
    expect(timeToMinutes('25:00')).toBe(null);
    expect(timeToMinutes('')).toBe(null);
    expect(minutesToTime(1220)).toBe('20:20');
    expect(minutesToTime(1440)).toBe('00:00');
  });

  it('длительность: из записи, иначе значение по умолчанию', () => {
    expect(eventDuration(ev('10:00', { durationMinutes: 90 }))).toBe(90);
    expect(eventDuration(ev('10:00'))).toBe(DEFAULT_DURATION_MINUTES);
    expect(eventDuration(ev('10:00', { durationMinutes: 0 }))).toBe(DEFAULT_DURATION_MINUTES);
    expect(eventDuration(ev('23:30', { durationMinutes: 9999 }))).toBe(DAY_MINUTES);
    expect(eventEndMinutes(ev('20:00', { durationMinutes: 120 }))).toBe(1320);
  });

  it('марафон занимает весь день и уходит в верхнюю группу', () => {
    expect(isAllDayEvent({ source: 'marathon' })).toBe(true);
    const { allDay, blocks } = timelineBlocks([ev('20:20'), { id: 'm', title: 'Марафон', source: 'marathon', color: 'purple' }]);
    expect(allDay.map(x => x.event.title)).toEqual(['Марафон']);
    expect(allDay[0].full).toBe(true);
    expect(blocks).toHaveLength(1);
  });

  it('записи без времени идут сверху, со временем — на шкале по началу', () => {
    const { allDay, blocks } = timelineBlocks([ev('20:20'), ev('')]);
    expect(allDay).toHaveLength(1);
    expect(allDay[0].event.time).toBe('');
    expect(blocks[0].startTime).toBe('20:20');
    // 20:20 = 1220 минут из 1440 → 84.72% сверху
    expect(blocks[0].topPct).toBeCloseTo((1220 / DAY_MINUTES) * 100, 5);
  });

  it('высота блока — длительность записи', () => {
    const { blocks } = timelineBlocks([ev('12:00', { durationMinutes: 180 })]);
    expect(blocks[0].heightPct).toBeCloseTo((180 / DAY_MINUTES) * 100, 5);
    expect(blocks[0].endTime).toBe('15:00');
  });

  it('короткая запись всё равно видна: минимальная высота', () => {
    const { blocks } = timelineBlocks([ev('12:00', { durationMinutes: 1 })]);
    expect(blocks[0].heightPct).toBeGreaterThanOrEqual(0.7);
  });

  it('наложения по времени разводятся по дорожкам, а не перекрывают друг друга', () => {
    // Оба ивента в среду идут подряд: 19:30–19:59 и 20:00–21:30 — между ними минута, поэтому рядом
    const { blocks, lanes } = timelineBlocks([
      ev('19:30', { durationMinutes: 30, title: 'Ритм Гильдии' }),
      ev('20:00', { durationMinutes: 90, title: 'Запретное учение' })
    ]);
    expect(lanes).toBe(1);
    expect(blocks.map(b => b.lane)).toEqual([0, 0]);
    expect(blocks[0].widthPct).toBe(100);

    const overlap = timelineBlocks([
      ev('19:00', { durationMinutes: 120 }),
      ev('19:30', { durationMinutes: 30 })
    ]);
    expect(overlap.lanes).toBe(2);
    expect(overlap.blocks.map(b => b.lane)).toEqual([0, 1]);
    expect(overlap.blocks[1].leftPct).toBe(50);
    expect(overlap.blocks[1].widthPct).toBe(50);
  });

  it('запись за полночь обрезается по шкале', () => {
    const { blocks } = timelineBlocks([ev('23:30', { durationMinutes: 120 })]);
    expect(blocks[0].end).toBe(DAY_MINUTES);
    expect(blocks[0].heightPct).toBeCloseTo((30 / DAY_MINUTES) * 100, 5);
    // Для списка окончание показывается как «24:00», а не «00:30» — так это читают люди
    expect(eventEndTime(ev('23:30', { durationMinutes: 120 }))).toBe('24:00');
  });

  it('время окончания: явное из расписания и рассчитанное из длительности', () => {
    expect(eventEndTime(ev('19:30', { endTime: '20:00', durationMinutes: 30 }))).toBe('20:00');
    expect(eventEndTime(ev('10:00', { durationMinutes: 90 }))).toBe('11:30');
    expect(eventEndTime(ev(''))).toBe('');
  });

  it('пустой список и мусор не ломают раскладку', () => {
    expect(timelineBlocks(undefined)).toEqual({ allDay: [], blocks: [], lanes: 1 });
    expect(timelineBlocks([null, undefined]).blocks).toEqual([]);
  });

  it('часы для подписей шкалы: 00:00 … 24:00', () => {
    expect(hourMarks(3)).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '24:00']);
    expect(hourMarks(6)).toEqual(['00:00', '06:00', '12:00', '18:00', '24:00']);
  });
});
