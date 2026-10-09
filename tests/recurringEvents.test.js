import { describe, expect, it } from 'vitest';
import {
  RECURRING_EVENTS, recurringEventsForDate, recurringEventById,
  recurringDurationMinutes, recurringEventScheduleText, weekdayOf, WEEKDAY_NAMES
} from '../js/modules/dashboard/recurringEvents.js';
import { plannerEventsForDate, normalizePlannerEntry } from '../js/modules/dashboard/planner.js';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';

// Даты-ориентиры: 2026-06-08 — понедельник, значит 10-е — среда, 11-е — четверг, 12-е — пятница
const MON = '2026-06-08';
const WED = '2026-06-10';
const THU = '2026-06-11';
const FRI = '2026-06-12';
const SAT = '2026-06-13';

describe('постоянные ивенты', () => {
  it('расписание соответствует игровому: дни недели и московское время', () => {
    const byId = Object.fromEntries(RECURRING_EVENTS.map(e => [e.id, e]));
    expect(byId['dynasty-battle']).toMatchObject({ days: [0, 4], start: '20:20', end: '22:20' });
    expect(byId['guild-rhythm']).toMatchObject({ days: [2], start: '19:30', end: '19:59' });
    expect(byId['forbidden-teaching']).toMatchObject({ days: [2], start: '20:00', end: '21:30' });
    expect(byId['hero-arena']).toMatchObject({ days: [3], start: '19:00', end: '24:00' });
  });

  it('Битва Династий в понедельник и пятницу, не в среду', () => {
    const titles = (date) => recurringEventsForDate(date).map(e => e.title);
    expect(titles(MON)).toContain('Битва Династий');
    expect(titles(FRI)).toContain('Битва Династий');
    expect(titles(WED)).not.toContain('Битва Династий');
    expect(titles(SAT)).toEqual([]);
  });

  it('в среду два ивента: Ритм Гильдии и Запретное учение', () => {
    expect(recurringEventsForDate(WED).map(e => e.title)).toEqual(['Ритм Гильдии', 'Запретное учение']);
  });

  it('Арена Героев в четверг до конца суток', () => {
    const [arena] = recurringEventsForDate(THU);
    expect(arena.title).toBe('Арена Героев');
    expect(arena.time).toBe('19:00');
    expect(arena.endTime).toBe('24:00');
    expect(recurringDurationMinutes(RECURRING_EVENTS.find(e => e.id === 'hero-arena'))).toBe(300);
  });

  it('записи помечены источником recurring — их нельзя править или удалять', () => {
    for (const event of recurringEventsForDate(WED)) {
      expect(event.source).toBe('recurring');
      expect(event.recurring).toBe(true);
      expect(event.kind).toBe('event');
      expect(event.date).toBe(WED);
    }
  });

  it('ивент подмешивается в план дня вместе с ручными записями', () => {
    const state = {
      plannerEntries: [normalizePlannerEntry({ id: 'p1', title: 'Своё дело', date: WED, time: '10:00' })],
      marathons: []
    };
    const titles = plannerEventsForDate(state, WED).map(e => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Своё дело', 'Ритм Гильдии', 'Запретное учение']));
    expect(titles).not.toContain('Арена Героев');
  });

  it('битая дата и чужой день дают пустой список', () => {
    expect(recurringEventsForDate('')).toEqual([]);
    expect(recurringEventsForDate('2026-13-45')).toEqual([]);
    expect(recurringEventsForDate(SAT)).toEqual([]);
  });

  it('день недели считается по календарной дате без часовых поясов', () => {
    expect(WEEKDAY_NAMES[weekdayOf(MON)]).toBe('Понедельник');
    expect(WEEKDAY_NAMES[weekdayOf(THU)]).toBe('Четверг');
    expect(weekdayOf('мусор')).toBe(-1);
  });

  it('подпись расписания называет дни и время', () => {
    expect(recurringEventScheduleText(recurringEventById('dynasty-battle'))).toBe('Понедельник, Пятница, 20:20–22:20');
    expect(recurringEventScheduleText(recurringEventById('guild-rhythm'))).toBe('Среда, 19:30–19:59');
  });

  it('в настройках уведомлений есть запись на каждый ивент — списки не разошлись', () => {
    // Если добавить ивент и забыть про настройку, напоминание о нём молча не работало бы
    for (const event of RECURRING_EVENTS) {
      const conf = DEFAULT_SETTINGS.notifications.events[event.id];
      expect(conf, `нет настроек уведомлений для ${event.id}`).toBeTruthy();
      expect(conf.leadMinutes).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_SETTINGS.notifications.events).sort()).toEqual(RECURRING_EVENTS.map(e => e.id).sort());
  });
});
