import { describe, expect, it } from 'vitest';
import { exportMarathonTemplate } from '../js/modules/cloudSync/templateExport.js';

const id = 'a9115bf2-e834-444d-aeb6-7c3af1db8890';
const template = () => ({
  id: 'template-local',
  syncId: id,
  name: 'Шаблон',
  sourceUrl: 'https://pwonline.ru/supermarathon.php',
  tasks: [
    {
      id: 'task-local',
      title: 'Задание',
      siteTitle: null,
      description: 'Описание',
      descriptionSource: 'news',
      targetChecks: 2,
      schedule: { mode: 'dates', dates: ['2026-10-28'], weekStartDay: 1 },
      rewards: [{ id: 'reward-local', threshold: 2, rewardText: 'Подарок', rewardCoins: 5 }]
    }
  ],
  bonuses: [{ id: 'bonus-local', needTasks: 2, text: 'Бонус' }],
  createdAt: '2026-10-01T00:00:00Z'
});
const project = t => exportMarathonTemplate(t, { syncId: id });

describe('экспорт шаблонов марафона', () => {
  it('передаёт отдельную идентичность шаблона и значения заданий без старых локальных id', () => {
    const source = template();
    const before = JSON.stringify(source);
    const result = project(source);
    expect(result).toEqual({
      id,
      type: 'marathonTemplate',
      fields: {
        name: 'Шаблон',
        sourceUrl: 'https://pwonline.ru/supermarathon.php',
        tasks: [
          {
            title: 'Задание',
            siteTitle: null,
            description: 'Описание',
            descriptionSource: 'news',
            targetChecks: 2,
            schedule: { mode: 'dates', dates: ['2026-10-28'], weekStartDay: 1 },
            rewards: [{ threshold: 2, rewardText: 'Подарок', rewardCoins: 5 }]
          }
        ],
        bonuses: [{ needTasks: 2, text: 'Бонус' }],
        createdAt: '2026-10-01T00:00:00Z'
      }
    });
    for (const localId of ['template-local', 'task-local', 'reward-local', 'bonus-local'])
      expect(JSON.stringify(result)).not.toContain(localId);
    result.fields.tasks[0].rewards[0].rewardText = 'Изменено';
    expect(JSON.stringify(source)).toBe(before);
  });
  it('принимает ранний шаблон с отсутствующими необязательными полями', () => {
    expect(project({ id: 'local', syncId: id, name: 'Пример', tasks: [{ title: 'Задание' }] }).fields).toEqual({
      name: 'Пример',
      sourceUrl: null,
      tasks: [
        {
          title: 'Задание',
          siteTitle: null,
          description: '',
          descriptionSource: '',
          targetChecks: 1,
          schedule: { mode: 'everyDay', dates: [], weekStartDay: 1 },
          rewards: []
        }
      ],
      bonuses: [],
      createdAt: null
    });
  });
  it('не принимает назначение несуществующего или чужого sync-ID', () => {
    const source = template();
    delete source.syncId;
    expect(() => project(source)).toThrow();
    source.syncId = 'b9115bf2-e834-444d-aeb6-7c3af1db8890';
    expect(() => project(source)).toThrow();
  });
  it('отклоняет неожиданную вложенную идентичность, getters и неизвестные поля', () => {
    const source = template();
    source.tasks[0].rewards[0].syncId = id;
    expect(() => project(source)).toThrow();
    delete source.tasks[0].rewards[0].syncId;
    let accessed = false;
    Object.defineProperty(source.tasks[0], 'password', {
      enumerable: true,
      get() {
        accessed = true;
        return 'secret';
      }
    });
    expect(() => project(source)).toThrow();
    expect(accessed).toBe(false);
  });
  it('блокирует чужие URL, небезопасные параметры и повреждённое расписание', () => {
    const source = template();
    source.sourceUrl = 'https://evil.example/?token=secret';
    expect(() => project(source)).toThrow();
    source.sourceUrl = null;
    source.tasks[0].schedule.dates.push('not-a-date');
    expect(() => project(source)).toThrow();
  });
});
