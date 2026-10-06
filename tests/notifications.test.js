import { describe, it, expect } from 'vitest';
import { collectAlerts, collectEventAlerts, eventNotificationSettings, leadText } from '../js/desktop/notifications.js';
import { createMarathon } from '../js/modules/marathons/model.js';
import { normalizeState } from '../js/core/state.js';
import { RECURRING_EVENTS } from '../js/modules/dashboard/recurringEvents.js';

const st = (progress = {}) => ({
  characters: [{ id: 'c1', nick: 'Hero' }],
  marathons: [createMarathon({
    id: 'm1', title: 'Летний', startDate: '2026-06-01', endDate: '2026-06-10', participantIds: ['c1'],
    tasks: [{ id: 't1', title: 'Сны', targetChecks: 5 }], assignments: { c1: ['t1'] }, progress
  })],
  settings: { notifications: { enabled: true, dailyHour: 20 } }
});

describe('collectAlerts', () => {
  it('не успевает → уведомление behind', () => {
    const alerts = collectAlerts(st(), { today: '2026-06-08', hour: 10 });
    const behind = alerts.find(a => a.kind === 'behind');
    expect(behind.title).toMatch(/не успевают 1/);
    expect(behind.body).toMatch(/Hero — «Сны» \(не хватает 2 дн\.\)/);
    expect(alerts.find(a => a.kind === 'ending').title).toMatch(/осталось 2 дн/);
  });

  it('запас ≤ 1 дня → tight; ежедневное напоминание после заданного часа', () => {
    const alerts = collectAlerts(st(), { today: '2026-06-06', hour: 21 });
    expect(alerts.map(a => a.kind).sort()).toEqual(['daily', 'tight']);
  });

  it('выполненные задания и выключенные типы не напоминают', () => {
    const done = st({ c1: { t1: { site: 5, adjust: 0, marks: [], history: {} } } });
    expect(collectAlerts(done, { today: '2026-06-09', hour: 23 })).toEqual([]);
    const off = st();
    off.settings.notifications = { marathonBehind: false, marathonEnding: false, dailyReminder: false };
    expect(collectAlerts(off, { today: '2026-06-09', hour: 23 })).toEqual([]);
  });

  it('час для ежедневного напоминания берётся по Москве', () => {
    // 18:30 UTC = 21:30 МСК → напоминание уже пора; 15:00 UTC = 18:00 МСК → ещё рано
    const late = collectAlerts(st(), { today: '2026-06-06', hour: 21 });
    const early = collectAlerts(st(), { today: '2026-06-06', hour: 18 });
    expect(late.map(a => a.kind)).toContain('daily');
    expect(early.map(a => a.kind)).not.toContain('daily');
  });
});

describe('напоминания о постоянных ивентах', () => {
  // 2026-06-10 — среда: Ритм Гильдии 19:30 (1170 мин), Запретное учение 20:00 (1200 мин)
  const WED = '2026-06-10';
  const settings = (leadMinutes = 10) => ({
    events: {
      'guild-rhythm': { enabled: true, leadMinutes },
      'forbidden-teaching': { enabled: true, leadMinutes }
    }
  });

  it('напоминает ровно за выбранное время до начала', () => {
    const alerts = collectEventAlerts({ today: WED, nowMinutes: 1160, settings: settings(10) });
    expect(alerts.map(a => a.eventId)).toEqual(['guild-rhythm']);   // 19:20 → до начала 10 мин
    expect(alerts[0].title).toContain('Ритм Гильдии');
    expect(alerts[0].body).toContain('осталось 10 мин');
    expect(alerts[0].key).toBe(`event:guild-rhythm:${WED}`);
  });

  it('вне окна не напоминает, а уже начавшийся ивент не напоминает', () => {
    expect(collectEventAlerts({ today: WED, nowMinutes: 1000, settings: settings(10) })).toEqual([]);
    expect(collectEventAlerts({ today: WED, nowMinutes: 1170, settings: settings(10) })).toEqual([]);
  });

  it('выбор «за 1 час» расширяет окно', () => {
    expect(collectEventAlerts({ today: WED, nowMinutes: 1120, settings: settings(60) }).map(a => a.eventId))
      .toEqual(['guild-rhythm']);   // 18:40 — за 50 минут
    expect(collectEventAlerts({ today: WED, nowMinutes: 1120, settings: settings(30) })).toEqual([]);
  });

  it('снятая галочка выключает напоминание об ивенте', () => {
    const off = { events: { 'guild-rhythm': { enabled: false, leadMinutes: 10 }, 'forbidden-teaching': { enabled: false, leadMinutes: 10 } } };
    expect(collectEventAlerts({ today: WED, nowMinutes: 1165, settings: off })).toEqual([]);
  });

  it('ивент другого дня не напоминает сегодня', () => {
    expect(collectEventAlerts({ today: '2026-06-13', nowMinutes: 1165, settings: settings(10) })).toEqual([]);
  });

  it('после полуночи ивент предыдущего дня не тянется', () => {
    // Арена Героев идёт в четверг до 24:00, в пятницу 00:05 напоминать не о чем
    expect(collectEventAlerts({ today: '2026-06-12', nowMinutes: 5, settings: settings(10) })).toEqual([]);
  });

  it('настройки ивента приводятся к допустимым значениям', () => {
    expect(eventNotificationSettings({ events: { 'hero-arena': { leadMinutes: 15 } } }, 'hero-arena'))
      .toEqual({ enabled: true, leadMinutes: 15 });
    // Битое значение заменяется на умолчание, иначе окно напоминания стало бы непредсказуемым
    expect(eventNotificationSettings({ events: { 'hero-arena': { leadMinutes: 7 } } }, 'hero-arena').leadMinutes).toBe(10);
    expect(eventNotificationSettings({}, 'hero-arena')).toEqual({ enabled: true, leadMinutes: 10 });
    expect(leadText(60)).toBe('за 1 час');
  });
});

describe('настройки уведомлений в состоянии', () => {
  it('старый state.json без настроек ивентов получает их по умолчанию', () => {
    // Иначе напоминания о новом ивенте молча не работали бы у тех, кто обновился
    const s = normalizeState({ characters: [], settings: { notifications: { dailyHour: 21 } } });
    expect(s.settings.notifications.dailyHour).toBe(21);
    for (const event of RECURRING_EVENTS) {
      expect(s.settings.notifications.events[event.id]).toEqual({ enabled: true, leadMinutes: 10 });
    }
  });

  it('выбор пользователя сохраняется, а не затирается умолчаниями', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { events: { 'hero-arena': { enabled: false, leadMinutes: 30 } } } }
    });
    expect(s.settings.notifications.events['hero-arena']).toEqual({ enabled: false, leadMinutes: 30 });
    // Ивент без своей записи всё равно получает умолчание
    expect(s.settings.notifications.events['guild-rhythm']).toEqual({ enabled: true, leadMinutes: 10 });
  });

  it('битое значение «за сколько» приводится к положительному числу', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { events: { 'guild-rhythm': { leadMinutes: -5 } } } }
    });
    expect(s.settings.notifications.events['guild-rhythm'].leadMinutes).toBe(10);
    // `eventNotificationSettings` дополнительно отсекает значения вне списка вариантов
    expect(eventNotificationSettings(s.settings.notifications, 'guild-rhythm').leadMinutes).toBe(10);
  });
});
