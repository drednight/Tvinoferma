// tests/externalApi.launchWiring.test.js
// «Проводка» задания запуска: доходит ли POST /launch/* до настоящего лаунчера.
//
// Зачем отдельный тест: мост (js/modules/externalApi/bridge.js) передаёт в
// `launchCharacterJob` / `launchPartyJob` / `launchSelectionJob` только реестр
// заданий — настоящий `launchGroup` модуль обязан брать у себя. Когда он брался
// исключительно из `deps`, любое внешнее задание умирало на `TypeError` ещё до
// открытия окон, а страница показывала «задание создано» (202) и тихий `failed`.
// Тест ниже вызывает ровно с теми `deps`, что даёт мост.
//
// `preflight` подменён сознательно: с настоящим `launchPreflight` у тестовых
// персонажей нет GameCenter, и задание честно завершается на «Запускать некого»,
// не доходя до строки с лаунчером — проверяемая проводка осталась бы непокрытой.
import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../js/core/state.js';
import {
  JobRegistry,
  launchCharacterJob,
  launchPartyJob,
  launchSelectionJob
} from '../js/modules/externalApi/actions/launch.js';

/** Проверка «до»: всех можно запускать, никто не запущен и не пропущен. */
const preflightOk = async characters => ({
  toLaunch: characters,
  alreadyRunning: [],
  noGc: [],
  noSavedLogin: [],
  total: characters.length
});

function setupState() {
  state.characters = [
    { id: 'Mag_1', nick: 'Маг', class: 'Маг', level: 100, partyIds: ['p-osnova'], stats: {}, dungeonPasses: {} },
    {
      id: 'Luchnik_2',
      nick: 'Лучник',
      class: 'Лучник',
      level: 99,
      partyIds: ['p-osnova'],
      stats: {},
      dungeonPasses: {}
    }
  ];
  state.parties = [{ id: 'p-osnova', name: 'Основа', color: '#6e8ef8' }];
}

/** Дождаться завершения задания в фоне (без таймеров «на глаз»). */
async function waitJob(jobs, id, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const job = jobs.get(id);
    if (job && job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Задание ${id} не завершилось`);
}

beforeEach(() => {
  setupState();
});

describe('внешний API: задание запуска доходит до лаунчера', () => {
  for (const [title, start] of [
    ['персонаж', jobs => launchCharacterJob(state, { characterId: 'Mag_1' }, { jobs, preflight: preflightOk })],
    [
      'пати',
      jobs =>
        launchPartyJob(
          state,
          { partyName: 'Основа' },
          {
            jobs,
            preflight: preflightOk,
            members: (chars, partyId) => chars.filter(char => char.partyIds.includes(partyId))
          }
        )
    ],
    [
      'выборка',
      jobs => launchSelectionJob(state, { characterIds: ['Mag_1', 'Luchnik_2'] }, { jobs, preflight: preflightOk })
    ]
  ]) {
    it(`${title}: без launchGroup в deps лаунчер берётся из модуля`, async () => {
      const jobs = new JobRegistry();
      const created = start(jobs);
      const job = await waitJob(jobs, created.id);

      // Так выглядит сломанная проводка: `deps.launchGroup` = undefined.
      expect(JSON.stringify(job)).not.toContain('is not a function');
      expect(['done', 'failed']).toContain(job.status);
      // Строчка «Запуск не начался» означает, что управление ушло в настоящий
      // `launchGroup`: вне приложения (jsdom) он отказывается открывать окна.
      expect(job.progress.stage).toBe('Запуск не начался');
    });
  }

  it('опции запуска: interactive:false и partyId пати', async () => {
    const jobs = new JobRegistry();
    /** @type {any[]} */
    const seen = [];
    const created = launchPartyJob(
      state,
      { partyName: 'Основа' },
      {
        jobs,
        preflight: preflightOk,
        members: (chars, partyId) => chars.filter(char => char.partyIds.includes(partyId)),
        launchGroup: async (title, characters, opts) => {
          seen.push(opts);
          return characters.map(char => ({ id: char.id, nick: char.nick, ok: true, ms: 1000 }));
        }
      }
    );
    const done = await waitJob(jobs, created.id);
    expect(seen).toHaveLength(1);
    expect(seen[0].interactive).toBe(false);
    expect(seen[0].partyId).toBe('p-osnova');
    expect(done.result).toMatchObject({ requested: 2, launched: 2, failed: 0, skipped: 0 });
  });
});
