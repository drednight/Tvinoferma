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
      recurrenceEnd: '2026-12-01', color: 'red', status: 'done', durationMinutes: 90
    });
  });

  it('статус отметки: поле, а не вывод из галочки; старый done переносится один раз', () => {
    // «В работе» нельзя вывести из «выполнено» — это промежуточное состояние
    expect(normalizePlannerEntry({ status: 'doing' }).status).toBe('doing');
    expect(normalizePlannerEntry({ status: 'done' }).status).toBe('done');
    expect(normalizePlannerEntry({}).status).toBe('todo');
    expect(normalizePlannerEntry({ status: 'ерунда' }).status).toBe('todo');
    // Данные, сохранённые до появления статуса
    expect(normalizePlannerEntry({ done: true }).status).toBe('done');
    expect(normalizePlannerEntry({ done: false }).status).toBe('todo');
    // Два источника истины на один факт не заводятся: булева done в записи не остаётся
    expect(normalizePlannerEntry({ done: true })).not.toHaveProperty('done');
    expect(normalizePlannerEntry({ status: 'done' }).done).toBeUndefined();
  });

  it('в туду листе сначала «в работе», потом «ожидает», выполненные — в конце', () => {
    const mk = (title, status) => normalizePlannerEntry({ title, date: '2026-10-05', status });
    const state = { plannerEntries: [mk('Сделано', 'done'), mk('Ждёт', 'todo'), mk('Делаю', 'doing')] };
    expect(plannerEventsForDate(state, '2026-10-05').filter(e => e.source === 'manual').map(e => e.title))
      .toEqual(['Делаю', 'Ждёт', 'Сделано']);
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

  it('localDate считает календарную дату по Москве, а не по поясу машины', () => {
    // Тесты запускаются и на машине в UTC+3, и на CI в UTC, поэтому моменты задаются
    // явным UTC: ожидание не должно зависеть от часового пояса того, кто запускает тесты.
    // 20:30 UTC = 23:30 МСК того же дня
    expect(localDate(new Date('2026-10-05T20:30:00Z'))).toBe('2026-10-05');
    // 21:30 UTC = 00:30 МСК следующего дня — на границе суток дата обязана перескочить
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