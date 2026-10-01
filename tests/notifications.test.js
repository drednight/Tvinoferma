import { describe, it, expect } from 'vitest';
import { collectAlerts } from '../js/notifications.js';
import { createMarathon } from '../js/marathons/model.js';

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
});
