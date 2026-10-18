// tests/taskReminders.test.js
// Напоминания о начале записей календаря.
//
// Поле `reminderMinutes` собиралось в форме и сохранялось, но его никто не читал:
// выбрать «За 15 минут» для кланового ивента можно было, а напоминание не приходило.
// Тест держит на этом дверь открытой — чтобы поле снова не осиротело.
import { describe, it, expect } from 'vitest';
import { collectTaskAlerts } from '../js/desktop/notifications.js';
import { normalizeState } from '../js/core/state.js';
import { CLAN_REMINDER_MINUTES, CLAN_ENTRY_PREFIX, isClanEntry } from '../js/modules/guild/core.js';

const TODAY = '2026-06-09';
const entry = (over = {}) => ({ id: 'p1', title: 'Собрание клана', date: TODAY, time: '19:30', reminderMinutes: 15, ...over });
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

describe('напоминания о начале записей', () => {
  it('срабатывает внутри окна «за N минут»', () => {
    const alerts = collectTaskAlerts({ today: TODAY, nowMinutes: at('19:20'), entries: [entry()] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain('Собрание клана');
    expect(alerts[0].kind).toBe('task');
  });

  it('раньше запасного времени не напоминает', () => {
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:00'), entries: [entry()] })).toEqual([]);
  });

  it('ровно в момент начала не напоминает', () => {
    // Иначе при перезапуске приложения пришло бы «через минуту после начала»
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:30'), entries: [entry()] })).toEqual([]);
  });

  it('запись без напоминания молчит', () => {
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:25'), entries: [entry({ reminderMinutes: 0 })] })).toEqual([]);
  });

  it('запись без времени молчит', () => {
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:25'), entries: [entry({ time: '' })] })).toEqual([]);
  });

  it('чужая дата не попадает в сегодняшние напоминания', () => {
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:25'), entries: [entry({ date: '2026-06-10' })] })).toEqual([]);
  });

  it('выполненная запись не напоминает', () => {
    const done = entry({ status: 'done' });
    expect(collectTaskAlerts({ today: TODAY, nowMinutes: at('19:25'), entries: [done], isDone: (e) => e.status === 'done' })).toEqual([]);
  });

  it('запас свой у каждой записи', () => {
    // Одна запись в 19:30 с запасом 15 минут (окно с 19:15) и одна с запасом 5 минут
    // (окно с 19:25). В 19:20 напомнит только первая — иначе запас не работал бы вовсе.
    const alerts = collectTaskAlerts({
      today: TODAY, nowMinutes: at('19:20'),
      entries: [entry({ id: 'a', reminderMinutes: 15 }), entry({ id: 'b', reminderMinutes: 5 })]
    });
    expect(alerts.map((a) => a.entryId)).toEqual(['a']);
  });

  it('ключ у напоминания свой на запись и день: повторов не будет', () => {
    const [a] = collectTaskAlerts({ today: TODAY, nowMinutes: at('19:20'), entries: [entry()] });
    expect(a.key).toBe(`task:p1:${TODAY}`);
  });
});

describe('клановые ивенты получают напоминание', () => {
  it('запись клана создаётся сразу с напоминанием, без захода в настройки', () => {
    // Человек отметил «Пойду» — значит не хочет пропустить. Молчаливый пропуск был
    // единственной реальной пользой ответа на сайте.
    const s = normalizeState({});
    expect(s.plannerEntries).toEqual([]);
    expect(CLAN_REMINDER_MINUTES).toBe(15);
  });

  it('префикс клановой записи узнаётся', () => {
    expect(isClanEntry({ id: `${CLAN_ENTRY_PREFIX}abc` })).toBe(true);
    expect(isClanEntry({ id: 'planner-1' })).toBe(false);
  });

  it('напоминание кланового ивента доходит до сборщика', () => {
    const alerts = collectTaskAlerts({
      today: TODAY, nowMinutes: at('19:20'),
      entries: [entry({ id: `${CLAN_ENTRY_PREFIX}42`, reminderMinutes: CLAN_REMINDER_MINUTES })]
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].entryId).toBe(`${CLAN_ENTRY_PREFIX}42`);
  });
});