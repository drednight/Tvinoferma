import { describe, it, expect } from 'vitest';
import {
  createMarathon, migrateMarathon, computeCell, rewardFor, marathonTotals,
  marathonPhase, matchQuest, applySiteQuests, freezeAwards, SCHEMA_VERSION
} from '../js/modules/marathons/model.js';

const marathon = (over = {}) => createMarathon({
  id: 'm1', title: 'Тест', startDate: '2026-06-01', endDate: '2026-06-10',
  participantIds: ['c1'],
  tasks: [{ id: 't1', title: 'Испытание снов (июнь)', targetChecks: 5,
    rewards: [{ threshold: 3, rewardCoins: 10 }, { threshold: 5, rewardCoins: 30 }] }],
  assignments: { c1: ['t1'] },
  ...over
});

describe('rewardFor', () => {
  it('берёт максимальный достигнутый порог и следующий', () => {
    const task = marathon().tasks[0];
    expect(rewardFor(task, 0)).toMatchObject({ reached: null, next: { threshold: 3 } });
    expect(rewardFor(task, 4).reached.threshold).toBe(3);
    expect(rewardFor(task, 7)).toMatchObject({ reached: { threshold: 5 }, next: null });
  });
});

describe('computeCell', () => {
  it('считает запас дней: ok / warn / fail / done', () => {
    const m = marathon();
    // 10 активных дней с 1-го, на 6-е осталось 5 дней, нужно 5 → запас 0 → warn
    expect(computeCell(m, 'c1', 't1', '2026-06-06')).toMatchObject({ count: 0, left: 5, reserve: 0, state: 'warn' });
    expect(computeCell(m, 'c1', 't1', '2026-06-01').state).toBe('ok');
    expect(computeCell(m, 'c1', 't1', '2026-06-08').state).toBe('fail');
    m.progress.c1 = { t1: { site: 5, adjust: 0, marks: [], history: {} } };
    expect(computeCell(m, 'c1', 't1', '2026-06-08')).toMatchObject({ state: 'done', coins: 30, percent: 100 });
  });

  it('учитывает ручную поправку и отметки без данных сайта', () => {
    const m = marathon();
    m.progress.c1 = { t1: { site: null, adjust: 1, marks: ['2026-06-01', '2026-06-02'], history: {} } };
    expect(computeCell(m, 'c1', 't1', '2026-06-03')).toMatchObject({ base: 2, adjust: 1, count: 3, coins: 10 });
  });

  it('не назначенное задание — off', () => {
    const m = marathon({ assignments: { c1: [] } });
    expect(computeCell(m, 'c1', 't1', '2026-06-03').state).toBe('off');
  });
});

describe('итоги и фазы', () => {
  it('marathonTotals и freezeAwards', () => {
    const m = marathon();
    m.progress.c1 = { t1: { site: 3, adjust: 0, marks: [], history: {} } };
    const totals = marathonTotals(m);
    expect(totals).toMatchObject({ cells: 1, coins: 10, maxCoins: 30 });
    expect(freezeAwards(m, [{ id: 'c1', nick: 'Hero' }])).toEqual([
      expect.objectContaining({ characterId: 'c1', charNick: 'Hero', coins: 10 })
    ]);
  });

  it('marathonPhase', () => {
    const m = marathon();
    expect(marathonPhase(m, '2026-05-30')).toBe('upcoming');
    expect(marathonPhase(m, '2026-06-05')).toBe('active');
    expect(marathonPhase(m, '2026-06-11')).toBe('ended');
    expect(marathonPhase({ ...m, status: 'completed' }, '2026-06-05')).toBe('completed');
  });
});

describe('сверка с сайтом', () => {
  const quests = [
    { title: 'Испытание снов (июль)', completed: 1, total: 20 },
    { title: 'Испытание снов (июнь)', completed: 4, total: 15 }
  ];

  it('matchQuest учитывает месяц этапа', () => {
    const task = { title: 'Испытание снов' };
    expect(matchQuest(task, quests, 'июль').completed).toBe(1);
    expect(matchQuest(task, quests, 'июнь').completed).toBe(4);
    expect(matchQuest({ title: 'Испытание снов (июнь)' }, quests).completed).toBe(4);
  });

  it('applySiteQuests пишет прогресс и историю прироста', () => {
    const m = marathon();
    expect(applySiteQuests(m, 'c1', quests, '2026-06-03T10:00:00Z')).toEqual([{ taskId: 't1', from: null, to: 4 }]);
    applySiteQuests(m, 'c1', [{ ...quests[1], completed: 6 }], '2026-06-04T10:00:00Z');
    expect(m.progress.c1.t1).toMatchObject({ site: 6, siteTotal: 15, history: { '2026-06-04': 2 } });
    expect(applySiteQuests(m, 'other', quests)).toEqual([]);
  });
});

describe('migrateMarathon', () => {
  it('конвертирует старую схему (stages, records, пустые назначения)', () => {
    const legacy = {
      id: 'old', title: 'Старый', type: 'auto-detected', startDate: '2026-06-01', endDate: '2026-06-05',
      participantIds: ['c1'], participantAssignments: { c1: [] },
      tasks: [{ id: 't1', title: 'Задание', targetChecks: 3, stages: [{ threshold: 2, rewardCoins: 5 }], baseRewardCoins: 15 }],
      records: [{ characterId: 'c1', taskId: 't1', date: '2026-06-01', completed: true }],
      description: 'Источник: https://pwonline.ru/supermarathon.php'
    };
    const m = migrateMarathon(legacy, []);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.assignments).toEqual({ c1: ['t1'] });
    expect(m.tasks[0].rewards.map(r => r.threshold)).toEqual([2, 3]);
    expect(m.tasks[0].siteTitle).toBe('Задание');
    expect(m.progress.c1.t1.marks).toEqual(['2026-06-01']);
    expect(m.source).toMatchObject({ type: 'site', url: 'https://pwonline.ru/supermarathon.php' });
  });

  it('марафон текущей схемы не меняется по смыслу', () => {
    const m = marathon();
    expect(migrateMarathon(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
});
