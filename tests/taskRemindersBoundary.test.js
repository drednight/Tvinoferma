// Границы календарных напоминаний: дата вхождения, переход суток и журнал.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/notifyCenter.js', () => ({ showInApp: vi.fn() }));

import { state } from '../js/core/state.js';
import { entryStatusForDate, normalizePlannerEntry } from '../js/modules/dashboard/planner.js';
import { collectTaskAlerts, runEventCheck } from '../js/desktop/notifications.js';
import { showInApp } from '../js/core/notifyCenter.js';

const base = (overrides = {}) =>
  normalizePlannerEntry({
    id: 'test-task',
    title: 'Календарная запись',
    date: '2026-06-09',
    time: '18:00',
    reminderMinutes: 1440,
    recurrence: 'none',
    ...overrides
  });
const collect = (today, nowMinutes, entry) =>
  collectTaskAlerts({ today, nowMinutes, entries: [entry], isDone: (e, day) => entryStatusForDate(e, day) === 'done' });

describe('границы напоминаний календаря', () => {
  it('вариант «за день» срабатывает накануне, но не раньше окна', () => {
    const entry = base({ date: '2026-06-10' });
    expect(collect('2026-06-09', 17 * 60 + 59, entry)).toEqual([]);
    const [alert] = collect('2026-06-09', 18 * 60, entry);
    expect(alert).toMatchObject({ entryId: entry.id, key: `task:${entry.id}:2026-06-10` });
    expect(alert.body).toContain('2026-06-10');
  });

  it('короткое напоминание о событии в 00:05 приходит в предыдущий день', () => {
    const entry = base({ date: '2027-01-01', time: '00:05', reminderMinutes: 15 });
    expect(collect('2026-12-31', 23 * 60 + 49, entry)).toEqual([]);
    expect(collect('2026-12-31', 23 * 60 + 50, entry)).toMatchObject([{ key: `task:${entry.id}:2027-01-01` }]);
  });

  it('каждый повтор имеет свою дату и проверяет именно отметку этого дня', () => {
    const entry = base({ date: '2026-06-01', time: '18:00', reminderMinutes: 15, recurrence: 'daily' });
    entry.status = 'done';
    entry.statusByDate = { '2026-06-09': 'doing', '2026-06-10': 'done' };
    expect(collect('2026-06-09', 17 * 60 + 50, entry)).toMatchObject([{ key: `task:${entry.id}:2026-06-09` }]);
    expect(collect('2026-06-10', 17 * 60 + 50, entry)).toEqual([]);
  });

  it('соблюдает день недели и конец повтора', () => {
    const entry = base({ date: '2026-06-01', recurrence: 'weekly', recurrenceEnd: '2026-06-08', reminderMinutes: 15 });
    expect(collect('2026-06-08', 17 * 60 + 50, entry)).toHaveLength(1);
    expect(collect('2026-06-09', 17 * 60 + 50, entry)).toEqual([]);
    expect(collect('2026-06-15', 17 * 60 + 50, entry)).toEqual([]);
  });

  it('запас больше суток пока не обещает раннее оповещение, но сохраняет прежнее поведение в день события', () => {
    const entry = base({ date: '2026-06-10', reminderMinutes: 2880 });
    expect(collect('2026-06-09', 18 * 60, entry)).toEqual([]);
    expect(collect('2026-06-10', 10 * 60, entry)).toHaveLength(1);
  });

  it('не принимает несуществующее время', () => {
    const entry = base({ time: '18:00', reminderMinutes: 15 });
    entry.time = '17:99';
    expect(collect('2026-06-09', 18 * 60 + 30, entry)).toEqual([]);
    entry.time = '24:00';
    expect(collect('2026-06-09', 23 * 60 + 55, entry)).toEqual([]);
  });
});

describe('журнал напоминаний о будущем вхождении', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    state.settings = { notifications: { kinds: { task: { inapp: true, popup: false, sound: false } } } };
    state.plannerEntries = [base({ date: '2026-06-10' })];
  });

  it('не выдаёт второе напоминание после смены суток', async () => {
    const first = await runEventCheck({ now: new Date('2026-06-09T15:00:00Z') }); // 18:00 МСК
    expect(first.filter(item => item.kind === 'task')).toHaveLength(1);
    expect(showInApp).toHaveBeenCalledTimes(1);
    const second = await runEventCheck({ now: new Date('2026-06-10T14:45:00Z') }); // 17:45 МСК
    expect(second.filter(item => item.kind === 'task')).toEqual([]);
    expect(showInApp).toHaveBeenCalledTimes(1);
  });

  it('повторяет попытку при недоставленном уведомлении, но не после успешной доставки', async () => {
    state.settings.notifications.kinds.task = { inapp: false, popup: true, sound: false };
    const failed = await runEventCheck({ now: new Date('2026-06-09T15:00:00Z') });
    expect(failed.find(item => item.kind === 'task').delivered).toBe(false);
    state.settings.notifications.kinds.task = { inapp: true, popup: false, sound: false };
    const retried = await runEventCheck({ now: new Date('2026-06-09T15:00:30Z') });
    expect(retried.find(item => item.kind === 'task').delivered).toBe(true);
    expect(
      (await runEventCheck({ now: new Date('2026-06-09T15:01:00Z') })).filter(item => item.kind === 'task')
    ).toEqual([]);
  });

  it('при отказе localStorage не повторяет сообщение каждые 30 секунд в той же сессии', async () => {
    const failWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      const first = await runEventCheck({ now: new Date('2026-06-09T15:00:00Z') });
      const second = await runEventCheck({ now: new Date('2026-06-09T15:00:30Z') });
      const tomorrow = await runEventCheck({ now: new Date('2026-06-10T14:45:00Z') });
      expect(first.filter(item => item.kind === 'task')).toHaveLength(1);
      expect(second.filter(item => item.kind === 'task')).toEqual([]);
      expect(tomorrow.filter(item => item.kind === 'task')).toEqual([]);
      expect(showInApp).toHaveBeenCalledTimes(1);
    } finally {
      failWrite.mockRestore();
      // После восстановления хранения временная копия переносится в localStorage.
      await runEventCheck({ now: new Date('2026-06-10T14:46:00Z') });
    }
  });
});
