// Данные снимка синхронизированы с тремя макетами «Сегодня». Это полностью вымышленные записи.
import { CHARACTERS, PARTIES, EVENTS, createDemoState } from '../today/data.js';
import { mskAddDays, mskDate } from './replica/js/core/msk.js';
import { createMarathon, createTask } from './replica/js/modules/marathons/model.js';
import { plannerEventsForDate } from './replica/js/modules/dashboard/planner.js';

/** События планировщика для концептов, включая повторы в выбранный день. */
export function demoTodayEvents(appState, date = mskDate()) {
  return plannerEventsForDate(appState, date)
    .filter(entry => entry.source === 'manual' && entry.kind === 'event')
    .map(entry => ({ id: entry.id, title: entry.title, time: entry.time, color: entry.color }));
}

export const DEMO_RUNES = {
  schemaVersion: 1,
  runes: [
    {
      id: 'r1',
      class: 'Воин',
      author: 'Звеномир',
      pve: 'Пример PvE: 1 · 2 · 3',
      pvp: 'Пример PvP: 3 · 2 · 1',
      additional: '1 · 1 · 2',
      note: 'Учебная запись',
      addedAt: '2026-10-01'
    },
    {
      id: 'r2',
      class: 'Маг',
      author: 'Тихомир',
      pve: '2 · 3 · 1',
      pvp: '1 · 3 · 2',
      additional: '',
      note: 'Пример',
      addedAt: '2026-10-02'
    },
    {
      id: 'r3',
      class: 'Лучник',
      author: 'Радовика',
      pve: '3 · 1 · 2',
      pvp: '2 · 1 · 3',
      additional: '',
      note: 'Пример',
      addedAt: '2026-10-03'
    },
    {
      id: 'r4',
      class: 'Жрец',
      author: 'Светолика',
      pve: '1 · 3 · 2',
      pvp: '2 · 2 · 1',
      additional: '',
      note: 'Пример',
      addedAt: '2026-10-04'
    },
    {
      id: 'r5',
      class: 'Паладин',
      author: 'Ярополк',
      pve: '2 · 1 · 2',
      pvp: '3 · 1 · 1',
      additional: '',
      note: 'Пример',
      addedAt: '2026-10-05'
    }
  ]
};

export function makeDemoMarathon(today = mskDate(), characters = CHARACTERS, id = 'demo-marathon') {
  const ids = characters.map(c => c.id);
  const tasks = [
    createTask({
      id: 'm-task-1',
      title: 'Победить монстров',
      description: 'Пример задания марафона',
      targetChecks: 5,
      rewards: [{ threshold: 5, rewardCoins: 100 }]
    }),
    createTask({
      id: 'm-task-2',
      title: 'Пройти данж',
      targetChecks: 4,
      rewards: [{ threshold: 4, rewardCoins: 120 }]
    }),
    createTask({
      id: 'm-task-3',
      title: 'Выполнить поручение',
      targetChecks: 3,
      rewards: [{ threshold: 3, rewardCoins: 80 }]
    })
  ];
  const progress = Object.fromEntries(
    ids.map((id, index) => [
      id,
      Object.fromEntries(
        tasks.map((task, taskIndex) => [
          task.id,
          {
            site: Math.min(task.targetChecks, Math.max(0, task.targetChecks - ((index + taskIndex) % 3))),
            siteTotal: task.targetChecks,
            adjust: 0,
            marks: [],
            history: {},
            syncedAt: new Date().toISOString()
          }
        ])
      )
    ])
  );
  return createMarathon({
    id,
    title: 'Путь героя',
    description: 'Вымышленный марафон для проверки интерфейса.',
    startDate: mskAddDays(today, -14),
    endDate: mskAddDays(today, 7),
    participantIds: ids,
    assignments: Object.fromEntries(ids.map(id => [id, tasks.map(task => task.id)])),
    tasks,
    progress
  });
}

export function isDemoMarathonActive(marathon, today = mskDate()) {
  return (
    !!marathon &&
    marathon.kind !== 'series' &&
    marathon.status !== 'completed' &&
    marathon.startDate <= today &&
    marathon.endDate >= today
  );
}

/** Добавляет действующий пример, не стирая прошедшие марафоны и не дублируя их id. */
export function ensureDemoMarathon(marathons, characters, today = mskDate()) {
  const active = marathons.find(item => isDemoMarathonActive(item, today));
  if (active) return active;
  const ids = new Set(marathons.map(item => item.id));
  let id = 'demo-marathon';
  for (let n = 2; ids.has(id); n += 1) id = `demo-marathon-${n}`;
  const marathon = makeDemoMarathon(today, characters, id);
  marathons.push(marathon);
  return marathon;
}

export function makeDemoAppData(now = new Date()) {
  const today = mskDate(now);
  const sample = createDemoState(now);
  const characters = CHARACTERS.map((character, index) => ({
    id: character.id,
    nick: character.nick,
    class: character.className,
    partyIds: [character.party],
    mainPartyId: character.party,
    partyOrder: { [character.party]: index + 1 },
    favorite: index < 2,
    level: 102 + (index % 4),
    sky: { name: 'Небо предела', level: 5 + (index % 5) },
    contacts: { email: '', password: '', recoveryEmail: '', phone: '' },
    dungeonPasses: { weapon: index % 4, armor: (index + 1) % 4, relic: (index + 2) % 4 },
    stats: { hp: 12000 + index * 450, strength: 120 + index * 8, pvePa: 32 + index },
    ancientCoins: character.coins,
    isLoggedIn: character.auth === 'online',
    lastLoginCheck: now.toISOString(),
    lastCoinUpdate: now.toISOString(),
    tags: index < 3 ? ['Основные'] : ['Пример'],
    notes: 'Демо-персонаж, вымышленные данные.'
  }));
  return {
    schemaVersion: 10,
    characters,
    parties: PARTIES.map((party, index) => ({ id: party.id, name: party.name, order: index + 1 })),
    archivedCharacters: [],
    archivedParties: [],
    marathons: [makeDemoMarathon(today)],
    marathonTemplates: [],
    plannerEntries: EVENTS.map(event => ({
      id: event.id,
      title: event.title,
      time: event.time,
      date: today,
      kind: 'event',
      color: event.color === 'violet' ? 'purple' : 'blue',
      status: 'todo'
    })),
    finance: {
      operations: [
        {
          id: 'fin-1',
          date: today,
          kind: 'in',
          currency: 'coins',
          amount: 5400,
          source: 'manual',
          counterparty: 'Доход · пример'
        },
        {
          id: 'fin-2',
          date: today,
          kind: 'out',
          currency: 'coins',
          amount: 620,
          source: 'manual',
          counterparty: 'Расход · пример'
        }
      ],
      shopItems: [{ id: 'shop-1', side: 'sell', name: 'Пример предмета', price: 120, qty: 3, date: today }],
      loans: [
        { id: 'loan-1', direction: 'lent', who: 'Тихомир', principal: 500, percent: 0, currency: 'coins', start: today }
      ],
      settings: { goldRate: 250, commissionPct: 2, opening: { gold: 100, coins: 0 } }
    },
    settings: {
      ui: { guideSeen: true, onboardingSeen: true },
      notifications: { enabled: false },
      guild: {
        enabled: true,
        syncedAt: now.getTime(),
        selfNick: 'Звеномир',
        poll: sample.poll,
        events: [
          {
            id: 'clan-1',
            title: 'Сбор клана',
            when: `${today} 20:30`,
            comment: 'Общий сбор перед походом',
            response: ''
          },
          {
            id: 'clan-2',
            title: 'Выход в цитадель',
            when: `${mskAddDays(today, 1)} 19:00`,
            comment: 'Возьмите расходники',
            response: ''
          }
        ],
        parties: [
          {
            name: 'Север',
            members: CHARACTERS.filter(c => c.party === 'p1').map(c => ({
              nick: c.nick,
              cls: c.icon,
              title: c.className
            }))
          }
        ]
      }
    }
  };
}
