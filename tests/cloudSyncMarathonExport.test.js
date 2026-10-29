import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { createMarathon, createSeries, createTask } from '../js/modules/marathons/model.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { exportMarathon } from '../js/modules/cloudSync/marathonExport.js';

function fixture() {
  const series = createSeries({
    id: 'series-local',
    title: 'Серия',
    source: { type: 'site', url: 'https://pwonline.ru/supermarathon.php', siteName: 'Сайт' },
    childIds: ['marathon-local']
  });
  const marathon = createMarathon({
    id: 'marathon-local',
    title: 'Марафон',
    seriesId: 'series-local',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    participantIds: ['hero-local', 'old-local'],
    source: {
      type: 'template',
      url: 'https://pwonline.ru/supermarathon.php',
      templateId: 'template-local',
      newsUrl: 'https://pwonline.ru/news.php?article=42'
    },
    tasks: [
      createTask({
        id: 'task-local',
        title: 'Задание',
        targetChecks: 3,
        schedule: { mode: 'dates', dates: ['2026-10-02', '2026-10-03'] },
        rewards: [{ id: 'reward-local', threshold: 2, rewardText: 'Подарок', rewardCoins: 7 }]
      })
    ],
    bonuses: [{ id: 'bonus-local', needTasks: 1, text: 'Бонус' }],
    assignments: { 'hero-local': ['task-local'] },
    progress: {
      'hero-local': {
        'task-local': {
          site: 1,
          siteTotal: 3,
          adjust: -1,
          marks: ['2026-10-02'],
          history: { '2026-10-02': 1 },
          syncedAt: '2026-10-02T12:00:00Z'
        }
      }
    },
    balance: {
      start: { 'hero-local': { coins: 3, at: '2026-10-01T00:00:00Z' } },
      end: { 'old-local': { coins: 9, at: '2026-10-31T00:00:00Z' } }
    },
    awards: [
      {
        characterId: 'hero-local',
        charNick: 'Имя',
        taskId: 'task-local',
        taskTitle: 'Задание',
        rewardText: 'Подарок',
        coins: 7
      }
    ],
    lastSync: { at: '2026-10-02', errors: [{ charId: 'hero-local', error: 'SECRET_LOCAL_LOGIN_STATUS' }], changes: [] }
  });
  const state = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero-local', nick: 'Герой' }],
    archivedCharacters: [{ id: 'old-local', nick: 'Архив' }],
    marathons: [series, marathon],
    marathonTemplates: [{ id: 'template-local', name: 'Шаблон', tasks: [] }]
  });
  const { ui, ...snapshot } = state;
  const planned = planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
  const byId = rows => new Map(rows.map(row => [row.id, row.syncId]));
  const context = {
    characterSyncIds: byId([...planned.characters, ...planned.archivedCharacters]),
    marathonSyncIds: byId(planned.marathons),
    templateSyncIds: byId(planned.marathonTemplates)
  };
  return { series: planned.marathons[0], marathon: planned.marathons[1], context };
}
const project = (m, ctx) => exportMarathon(m, { ...ctx, syncId: m.syncId });

describe('строгий экспорт марафонов', () => {
  it('экспортирует серию и все связанные данные через устойчивые ID', () => {
    const { series, marathon, context } = fixture();
    const a = project(series, context);
    const b = project(marathon, context);
    const char = context.characterSyncIds.get('hero-local');
    const old = context.characterSyncIds.get('old-local');
    const task = marathon.tasks[0].syncId;
    expect(a).toMatchObject({ id: series.syncId, type: 'marathonSeries', fields: { childIds: [marathon.syncId] } });
    expect(b).toMatchObject({
      id: marathon.syncId,
      type: 'marathon',
      fields: {
        seriesId: series.syncId,
        participantIds: [char, old],
        assignments: { [char]: [task] },
        source: {
          templateId: context.templateSyncIds.get('template-local'),
          newsUrl: 'https://pwonline.ru/news.php?article=42'
        },
        tasks: [{ id: task, rewards: [{ id: marathon.tasks[0].rewards[0].syncId, threshold: 2 }] }],
        bonuses: [{ id: marathon.bonuses[0].syncId }],
        progress: { [char]: { [task]: { site: 1, siteTotal: 3, adjust: -1, history: { '2026-10-02': 1 } } } },
        balance: { start: { [char]: { coins: 3 } }, end: { [old]: { coins: 9 } } },
        awards: [{ characterId: char, taskId: task }]
      }
    });
    const serialized = JSON.stringify([a, b]);
    for (const secret of [
      'hero-local',
      'old-local',
      'series-local',
      'marathon-local',
      'task-local',
      'reward-local',
      'bonus-local',
      'template-local',
      'SECRET_LOCAL_LOGIN_STATUS',
      'lastSync'
    ]) {
      expect(serialized).not.toContain(secret);
    }
    b.fields.tasks[0].rewards[0].rewardText = 'Изменено';
    expect(marathon.tasks[0].rewards[0].rewardText).toBe('Подарок');
  });

  it('сохраняет старую ячейку прогресса без необязательных полей', () => {
    const { marathon, context } = fixture();
    marathon.progress['hero-local']['task-local'] = { site: 2, adjust: 0 };
    const char = context.characterSyncIds.get('hero-local');
    const task = marathon.tasks[0].syncId;
    expect(project(marathon, context).fields.progress[char][task]).toEqual({
      site: 2,
      siteTotal: null,
      adjust: 0,
      marks: [],
      history: {},
      syncedAt: null
    });
  });

  it.each([
    ['участник', m => m.participantIds.push('deleted')],
    [
      'назначение персонажа',
      m => {
        m.assignments.deleted = ['task-local'];
      }
    ],
    ['назначение задания', m => m.assignments['hero-local'].push('deleted')],
    [
      'прогресс персонажа',
      m => {
        m.progress.deleted = {};
      }
    ],
    [
      'прогресс задания',
      m => {
        m.progress['hero-local'].deleted = {};
      }
    ],
    [
      'баланс',
      m => {
        m.balance.end.deleted = { coins: 1, at: '2026-10-01' };
      }
    ],
    [
      'персонаж награды',
      m => {
        m.awards[0].characterId = 'deleted';
      }
    ],
    [
      'задание награды',
      m => {
        m.awards[0].taskId = 'deleted';
      }
    ],
    [
      'серия',
      m => {
        m.seriesId = 'deleted';
      }
    ],
    [
      'шаблон',
      m => {
        m.source.templateId = 'deleted';
      }
    ]
  ])('останавливает экспорт при осиротевшей ссылке: %s', (_, change) => {
    const { marathon, context } = fixture();
    change(marathon);
    const before = JSON.stringify(marathon);
    expect(() => project(marathon, context)).toThrow();
    expect(JSON.stringify(marathon)).toBe(before);
  });

  it('не пропускает отсутствующую или циклическую ссылку на дочерний марафон', () => {
    const { series, context } = fixture();
    series.childIds.push('deleted');
    expect(() => project(series, context)).toThrow();
    series.childIds = [series.id];
    expect(() => project(series, context)).toThrow();
  });

  it('не экспортирует повторяющиеся или повреждённые вложенные ID', () => {
    const { marathon, context } = fixture();
    marathon.bonuses[0].syncId = marathon.tasks[0].syncId;
    expect(() => project(marathon, context)).toThrow();
    marathon.bonuses[0].syncId = 'bad';
    expect(() => project(marathon, context)).toThrow();
  });

  it('блокирует потерю данных при совпадении sync-ID разных ключей', () => {
    const { marathon, context } = fixture();
    context.characterSyncIds.set('old-local', context.characterSyncIds.get('hero-local'));
    expect(() => project(marathon, context)).toThrow();
    marathon.participantIds = [];
    marathon.assignments['old-local'] = [];
    expect(() => project(marathon, context)).toThrow();
  });

  it.each([
    'https://evil.example/supermarathon.php',
    'http://pwonline.ru/supermarathon.php',
    'https://user:pass@pwonline.ru/supermarathon.php',
    'https://pwonline.ru/news.php?token=secret',
    'https://pwonline.ru/news.php?article=42#secret',
    'https://pwonline.ru/news.php?article=42&article=43'
  ])('отклоняет непроверенный адрес источника %s', url => {
    const { marathon, context } = fixture();
    marathon.source.url = url;
    expect(() => project(marathon, context)).toThrow();
  });

  it('не выполняет getter и не пропускает неизвестные поля в открытом или вложенном объекте', () => {
    const { marathon, context } = fixture();
    let accessed = false;
    Object.defineProperty(marathon.tasks[0], 'unexpected', {
      enumerable: true,
      get() {
        accessed = true;
        return 'secret';
      }
    });
    expect(() => project(marathon, context)).toThrow();
    expect(accessed).toBe(false);
    marathon.extra = 'secret';
    expect(() => project(marathon, context)).toThrow();
  });
});
