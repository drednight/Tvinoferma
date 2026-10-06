import { describe, expect, it } from 'vitest';
import { localDate, monthMatrix, normalizePlannerEntry, plannerEventsForDate } from '../js/modules/dashboard/planner.js';

describe('месячный планер', () => {
  it('строит календарную сетку с понедельника', () => {
    const cells = monthMatrix(2026, 9);
    expect(cells).toHaveLength(35);
    expect(cells.slice(0, 3)).toEqual([null, null, null]);
    expect(cells[3]).toBe('2026-10-01');
    expect(cells.filter(Boolean).at(-1)).toBe('2026-10-31');
  });

  it('нормализует расширенные поля записи', () => {
    expect(normalizePlannerEntry({
      id: 'x', title: '  Сделать  ', date: '2026-10-05', kind: 'note',
      priority: 'high', reminderMinutes: 60, recurrence: 'weekly',
      recurrenceEnd: '2026-12-01', color: 'red', done: true, durationMinutes: 90
    })).toMatchObject({
      id: 'x', title: 'Сделать', date: '2026-10-05', kind: 'note',
      priority: 'high', reminderMinutes: 60, recurrence: 'weekly',
      recurrenceEnd: '2026-12-01', color: 'red', done: true, durationMinutes: 90
    });
  });

  it('длительность записи: по умолчанию час, битое значение не проходит', () => {
    expect(normalizePlannerEntry({ id: 'a', title: 'A', date: '2026-10-05' }).durationMinutes).toBe(60);
    expect(normalizePlannerEntry({ id: 'b', title: 'B', date: '2026-10-05', durationMinutes: 0 }).durationMinutes).toBe(60);
    expect(normalizePlannerEntry({ id: 'c', title: 'C', date: '2026-10-05', durationMinutes: 99999 }).durationMinutes).toBe(1440);
  });

  it('показывает повторы и активные марафоны', () => {
    const state = {
      plannerEntries: [
        normalizePlannerEntry({ id: 'daily', title: 'Ежедневно', date: '2026-10-01', recurrence: 'daily' }),
        normalizePlannerEntry({ id: 'weekly', title: 'По понедельникам', date: '2026-10-05', recurrence: 'weekly' })
      ],
      marathons: [{ id: 'm1', title: 'Осенний', startDate: '2026-10-01', endDate: '2026-10-10' }]
    };
    expect(plannerEventsForDate(state, '2026-10-05').map(e => e.title)).toEqual(
      expect.arrayContaining(['Ежедневно', 'По понедельникам', 'Осенний'])
    );
    expect(plannerEventsForDate(state, '2026-10-06').map(e => e.title)).not.toContain('По понедельникам');
  });

  it('localDate не сдвигает календарную дату и считает её по Москве', () => {
    expect(localDate(new Date(2026, 9, 5, 23, 30))).toBe('2026-10-05');
    // 21:30 UTC = 00:30 МСК следующего дня
    expect(localDate(new Date('2026-06-10T21:30:00Z'))).toBe('2026-06-11');
  });

  it('в сетке месяца даты собираются без сдвига часовым поясом', () => {
    const cells = monthMatrix(2026, 9);
    expect(cells.filter(Boolean)).toHaveLength(31);
    expect(cells.filter(Boolean)[0]).toBe('2026-10-01');
  });

  it('постоянные ивенты попадают в план дня и остаются источником recurring', () => {
    const state = { plannerEntries: [], marathons: [] };
    const wed = plannerEventsForDate(state, '2026-06-10').filter(e => e.source === 'recurring');
    expect(wed.map(e => e.title)).toEqual(['Ритм Гильдии', 'Запретное учение']);
    expect(plannerEventsForDate(state, '2026-06-13').filter(e => e.source === 'recurring')).toEqual([]);
  });
});