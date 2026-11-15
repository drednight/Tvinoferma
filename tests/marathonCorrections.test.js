import { expect, it } from 'vitest';
import {
  createMarathon,
  applySiteQuests,
  matchQuest,
  computeCell,
  calendarStates
} from '../js/modules/marathons/model.js';
const make = () =>
  createMarathon({
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    participantIds: ['c'],
    tasks: [{ id: 't', title: 'Задание (июнь)', targetChecks: 10 }],
    assignments: { c: ['t'] },
    progress: {
      c: {
        t: {
          site: 5,
          siteTotal: 10,
          syncedAt: '2026-06-05T00:00:00Z',
          marks: ['2026-06-02'],
          adjust: 2,
          history: { '2026-06-03': 2, '2026-06-04': 3 }
        }
      }
    }
  });
it('accepts a verified lower site result and zero, without changing manual marks or adjustment', () => {
  const m = make();
  expect(
    applySiteQuests(m, 'c', [{ title: 'Задание (июнь)', completed: 0, total: 10 }], '2026-06-06T00:00:00Z')
  ).toEqual([{ taskId: 't', from: 5, to: 0 }]);
  expect(m.progress.c.t).toMatchObject({ site: 0, marks: ['2026-06-02'], adjust: 2, history: {} });
  expect(computeCell(m, 'c', 't', '2026-06-06')).toMatchObject({ site: 0, manual: 1, count: 3 });
  expect(calendarStates(m, m.tasks[0], m.progress.c.t, '2026-06-06')['2026-06-02']).toBe('marked');
});
it('rejects a singleton task from another month, including a title learned by an older sync', () => {
  expect(matchQuest({ title: 'Задание' }, [{ title: 'Задание (май)', completed: 1 }], 'июнь')).toBeNull();
  expect(
    matchQuest({ title: 'Задание', siteTitle: 'Задание (май)' }, [{ title: 'Задание (май)', completed: 1 }], 'июнь')
  ).toBeNull();
  expect(matchQuest({ title: 'Задание (июнь 2026)' }, [{ title: 'Задание (июнь 2025)', completed: 1 }])).toBeNull();
});
it('does not seed a future event or overwrite newer site data with an older response', () => {
  const m = make();
  expect(
    applySiteQuests(m, 'c', [{ title: 'Задание (июнь)', completed: 1, total: 10 }], '2026-05-31T00:00:00Z')
  ).toEqual([]);
  expect(
    applySiteQuests(m, 'c', [{ title: 'Задание (июнь)', completed: 1, total: 10 }], '2026-06-04T00:00:00Z')
  ).toEqual([]);
  expect(m.progress.c.t.site).toBe(5);
});
it('never interprets a boolean or malformed value as one credit or an authoritative zero', () => {
  for (const completed of [true, false, null, undefined, '', '1abc', -1, 1.5]) {
    const m = make();
    expect(
      applySiteQuests(m, 'c', [{ title: 'Задание (июнь)', completed, total: 10 }], '2026-06-06T00:00:00Z')
    ).toEqual([]);
    expect(m.progress.c.t.site).toBe(5);
  }
});

it('ignores an explicit old year even when the event task has no year in its title', () => {
  const m = make();
  m.source.stageKey = 'июнь';
  expect(
    applySiteQuests(m, 'c', [{ title: 'Задание (июнь 2025)', completed: 1, total: 10 }], '2026-06-06T00:00:00Z')
  ).toEqual([]);
  expect(m.progress.c.t.site).toBe(5);
});

it('uses Moscow day for site sync after MSK midnight while UTC is still yesterday', () => {
  const m = createMarathon({
    startDate: '2026-11-08',
    endDate: '2026-11-11',
    participantIds: ['c'],
    tasks: [{ id: 't', title: 'Задание', targetChecks: 3 }],
    assignments: { c: ['t'] },
    progress: { c: { t: { site: 0, marks: [], history: {} } } }
  });
  const changes = applySiteQuests(m, 'c', [{ title: 'Задание', completed: 1, total: 3 }], '2026-11-07T21:01:00.000Z');
  expect(changes).toHaveLength(1);
  expect(m.progress.c.t.site).toBe(1);
  expect(m.progress.c.t.history).toEqual({ '2026-11-08': 1 });
});
