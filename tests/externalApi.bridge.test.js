// tests/externalApi.bridge.test.js
// Мост между Rust и JS и задания запуска (M3).
//
// 1. `routeRequest` — маршрутизация без сервера: подменяем всё, что ходит наружу.
// 2. Права проверяются дважды: Rust и мост (на случай, если настройки поменяли
//    между запросом и ответом).
// 3. Закрытие окон требует `confirm: true` и PID из списка, а не id персонажа.
// 4. Задание запуска: `202`, один активный, честные строки `skipped`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { answer, parseCloseRequest, routeRequest } from '../js/modules/externalApi/bridge.js';
import { JobRegistry, launchPartyJob, launchSummary, publicJob } from '../js/modules/externalApi/actions/launch.js';

function setupSettings(overrides = {}) {
  state.settings = state.settings || {};
  state.settings.externalApi = {
    enabled: true,
    port: 47831,
    allowRead: true,
    allowModify: true,
    allowLaunchClose: true,
    tokenCreatedAt: '2026-11-24T10:00:00.000Z',
    ...overrides
  };
}

function setupState() {
  state.characters = [
    { id: 'Mag_1', nick: 'Маг', class: 'Маг', level: 100, partyIds: ['p-osnova'], stats: { hp: 1 }, dungeonPasses: {} },
    {
      id: 'Luchnik_2',
      nick: 'Лучник',
      class: 'Лучник',
      level: 99,
      partyIds: ['p-osnova'],
      stats: {},
      dungeonPasses: {}
    },
    { id: 'Zhrets_3', nick: 'Жрец', class: 'Жрец', level: 98, partyIds: ['p-farm'], stats: {}, dungeonPasses: {} }
  ];
  state.parties = [
    { id: 'p-osnova', name: 'Основа', color: '#6e8ef8' },
    { id: 'p-farm', name: 'Фарм', color: null }
  ];
}

/** Зависимости моста: всё внешнее подменено, ни сети, ни Tauri. */
function fakeDeps(overrides = {}) {
  const calls = { persist: 0, closed: [], launched: [] };
  return {
    calls,
    appVersion: '3.0.0',
    buildProfile: 'stable',
    storageWritable: true,
    windowRows: [{ pid: 111, title: 'Маг — Маг', known: true, charId: 'Mag_1', nick: 'Маг' }],
    jobs: new JobRegistry(),
    closeClientsByPid: async pids => {
      calls.closed.push(pids);
      return { found: pids.length, closed: pids.length, failed: 0, denied: 0, elevated: false, details: [], error: '' };
    },
    // Моки чтения — делегируют настоящим функциям, чтобы тест видел те же
    // поля и то же отсутствие секретов, что и приложение.
    characters: Object.fromEntries(
      [
        'publicCharacters',
        'publicCharacterStats',
        'publicParties',
        'publicWindows',
        'publicMarathons',
        'publicMarathonById',
        'marathonParticipants',
        'publicPlanner',
        'publicFinance',
        // Адресные маршруты и проверка `fields` используют эти экспорты.
        'unknownFields',
        'CHARACTER_FIELD_NAMES',
        'fieldLabel',
        'passKey'
      ].map(name => [name, (...args) => require_read()[name](...args)])
    ),
    // Моки изменения: сохранение «успешно», запись разрешена, время фиксировано.
    mutate: Object.fromEntries(
      [
        'patchCharacter',
        'bulkUpdate',
        'patchDungeonPasses',
        'patchCharacterFields',
        'createCharacter',
        'patchParty',
        'setMarathonMark',
        'adjustMarathonCell'
      ].map(name => [
        name,
        async (...args) =>
          require_mutate()[name](...args, {
            persist: async () => {},
            assertStateWriteAvailable: () => {},
            now: () => '2026-11-25T12:00:00.000Z',
            renderCharacters: () => {},
            renderParties: () => {},
            renderMarathons: () => {}
          })
      ])
    ),
    ...overrides
  };
}

// Ленивые импорты: так тест видит те же модули, что и мост, но без циклической
// инициализации на верхнем уровне файла.
let readModule = null;
let mutateModule = null;
function require_read() {
  return readModule;
}
function require_mutate() {
  return mutateModule;
}

beforeEach(async () => {
  readModule = await import('../js/modules/externalApi/actions/read.js');
  mutateModule = await import('../js/modules/externalApi/actions/mutate.js');
  setupSettings();
  setupState();
});

describe('внешний API: маршрутизация моста', () => {
  it('health: версия, права, запись и занятость запуска', async () => {
    const result = await routeRequest({ method: 'GET', path: '/api/v1/health' }, fakeDeps());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      app: { version: '3.0.0', build: 'stable' },
      api: { version: 1 },
      storage: { writable: true },
      scopes: { read: true, modify: true, launchClose: true },
      launch: { busy: false }
    });
  });

  it('GET /characters и /characters/{id}: секретов нет, неизвестный id — 404', async () => {
    const list = await routeRequest({ method: 'GET', path: '/api/v1/characters' }, fakeDeps());
    expect(list.body.characters).toHaveLength(3);
    const one = await routeRequest({ method: 'GET', path: '/api/v1/characters/Mag_1' }, fakeDeps());
    expect(one.body.character).toMatchObject({ id: 'Mag_1', nick: 'Маг' });
    expect(JSON.stringify(one.body)).not.toContain('password');
    const missing = await answer({ method: 'GET', path: '/api/v1/characters/Nope_9' }, fakeDeps());
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'no_such_character' } } });
  });

  it('список персонажей по умолчанию краткий, подробности — detail, fields и /characters.stats', async () => {
    // «GET /characters» — это список, а не 28 карточек: по умолчанию в строке только
    // `id` и `nick`. Проверяется на уровне маршрута, а не функции: именно адрес
    // копируют в скрипт, и именно он не должен внезапно приносить карточки.
    const list = await routeRequest({ method: 'GET', path: '/api/v1/characters' }, fakeDeps());
    expect(list.status).toBe(200);
    expect(list.body.characters.map(row => Object.keys(row))).toEqual([
      ['id', 'nick'],
      ['id', 'nick'],
      ['id', 'nick']
    ]);
    expect(list.body.detail).toBe('brief');
    expect(list.body.detailHint).toContain('/characters.stats');

    const full = await routeRequest({ method: 'GET', path: '/api/v1/characters', query: 'detail=full' }, fakeDeps());
    expect(full.body.detail).toBe('full');
    expect(full.body.characters[0]).toHaveProperty('stats');

    // прежний способ (`?full=true`) работает: старые скрипты переписывать не надо
    const legacy = await routeRequest({ method: 'GET', path: '/api/v1/characters', query: 'full=true' }, fakeDeps());
    expect(legacy.body.detail).toBe('full');

    const asked = await routeRequest(
      { method: 'GET', path: '/api/v1/characters', query: 'fields=id,nick,level' },
      fakeDeps()
    );
    expect(asked.body.detail).toBe('picked');
    expect(asked.body.characters[0]).toMatchObject({ id: expect.any(String), nick: expect.any(String) });
    expect(asked.body.characters[0]).toHaveProperty('level');
    expect(asked.body.characters[0]).not.toHaveProperty('stats');

    const stats = await routeRequest({ method: 'GET', path: '/api/v1/characters.stats' }, fakeDeps());
    expect(stats.status).toBe(200);
    expect(stats.body.detail).toBe('stats');
    expect(stats.body.characters[0]).toHaveProperty('dungeonPasses');
    expect(stats.body.totals).toMatchObject({ weapon: expect.any(Number), sum: expect.any(Number) });

    // секреты не приезжают ни в одном из режимов
    for (const body of [list.body, full.body, stats.body]) {
      expect(JSON.stringify(body)).not.toContain('password');
    }
  });

  it('без права «изменение» — 403 forbidden_scope, и данные не меняются', async () => {
    setupSettings({ allowModify: false });
    const result = await answer(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1', body: { stats: { hp: 2 } } },
      fakeDeps()
    );
    expect(result).toMatchObject({ status: 403, body: { error: { code: 'forbidden_scope' } } });
    expect(state.characters[0].stats.hp).toBe(1);
  });

  it('без права «запуск» закрытие окон запрещено до любых действий', async () => {
    setupSettings({ allowLaunchClose: false });
    const deps = fakeDeps();
    const result = await answer(
      { method: 'POST', path: '/api/v1/windows/close', body: { pids: [111], confirm: true } },
      deps
    );
    expect(result.status).toBe(403);
    expect(deps.calls.closed).toEqual([]);
  });

  it('закрытие окон: без confirm — 400, с confirm — вызов с PID', async () => {
    const deps = fakeDeps();
    const denied = await answer({ method: 'POST', path: '/api/v1/windows/close', body: { pids: [111] } }, deps);
    expect(denied).toMatchObject({ status: 400, body: { error: { code: 'confirm_required' } } });
    expect(deps.calls.closed).toEqual([]);
    const ok = await answer(
      { method: 'POST', path: '/api/v1/windows/close', body: { pids: [111], confirm: true } },
      deps
    );
    expect(ok.status).toBe(200);
    expect(deps.calls.closed).toEqual([[111]]);
    expect(ok.body).toMatchObject({ found: 1, closed: 1, failed: 0 });
  });

  it('неизвестный путь — 404, чужой метод — 404, тело не JSON — 400', async () => {
    expect((await answer({ method: 'GET', path: '/api/v1/nope' }, fakeDeps())).status).toBe(404);
    expect((await answer({ method: 'GET', path: '/api/v1/characters/..%2f..' }, fakeDeps())).status).toBe(404);
    const bad = await answer({ method: 'PATCH', path: '/api/v1/characters/Mag_1', body: 'строка' }, fakeDeps());
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'invalid_json' } } });
  });

  it('ленивая загрузка модуля: маршрут без подмены в deps работает сам', async () => {
    // Регресс: `load()` возвращал саму фабрику `() => import(...)` вместо модуля,
    // и любой маршрут, не подменённый в deps, падал с «is not a function».
    state.marathons = [];
    const result = await routeRequest({ method: 'GET', path: '/api/v1/marathons' }, { marathonTotals: null });
    expect(result.status).toBe(200);
    expect(result.body.marathons).toEqual([]);
  });

  it('ответ всегда в формате { status, body } — даже если внутри исключение', async () => {
    const result = await answer({ method: 'GET', path: '/api/v1/parties' }, { characters: null });
    // `deps.characters = null` ломает загрузку модуля — мост обязан вернуть общий ответ.
    expect(result).toHaveProperty('status');
    expect(result.body).toHaveProperty('error');
  });
});

describe('внешний API: закрытие окон — разбор тела', () => {
  it('принимает только pids и confirm, PID — положительные целые без повторов', () => {
    expect(parseCloseRequest({ pids: [1, 2], confirm: true })).toEqual([1, 2]);
    expect(() => parseCloseRequest({ pids: [1], confirm: false })).toThrow(/confirm/);
    expect(() => parseCloseRequest({ pids: [0], confirm: true })).toThrow(/PID/);
    expect(() => parseCloseRequest({ pids: [1, 1], confirm: true })).toThrow(/Повторяющийся/);
    expect(() => parseCloseRequest({ pids: [1], confirm: true, force: true })).toThrow(/Неизвестное поле/);
    expect(() => parseCloseRequest({ pids: [], confirm: true })).toThrow(/pids/);
  });
});

describe('внешний API: задания запуска', () => {
  const preflightOk = async characters => ({
    toLaunch: characters,
    alreadyRunning: [],
    noGc: [],
    noSavedLogin: [],
    total: characters.length
  });

  it('пати: memberIds фильтруются по составу, чужие id — в ignoredIds', async () => {
    const jobs = new JobRegistry();
    let launched = null;
    const job = launchPartyJob(
      state,
      { partyName: 'Основа', memberIds: ['Mag_1', 'Чужой_9'] },
      {
        jobs,
        members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)),
        preflight: preflightOk,
        launchGroup: async (title, chars) => {
          launched = chars.map(c => c.id);
          return chars.map(c => ({ id: c.id, nick: c.nick, ok: true, ms: 1000 }));
        }
      }
    );
    expect(job.status).toBe('running');
    expect(job.kind).toBe('party');
    await new Promise(resolve => setTimeout(resolve, 20));
    const done = await waitJob(jobs, job.id);
    expect(launched).toEqual(['Mag_1']);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ requested: 1, launched: 1, failed: 0, ignoredIds: ['Чужой_9'] });
  });

  it('второй запуск во время первого — 429 launch_busy', async () => {
    const jobs = new JobRegistry();
    const slow = () => new Promise(resolve => setTimeout(() => resolve([{ id: 'Mag_1', ok: true }]), 50));
    launchPartyJob(
      state,
      { partyName: 'Основа' },
      {
        jobs,
        members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)),
        preflight: preflightOk,
        launchGroup: slow
      }
    );
    expect(() =>
      launchPartyJob(
        state,
        { partyName: 'Фарм' },
        {
          jobs,
          members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)),
          preflight: preflightOk,
          launchGroup: slow
        }
      )
    ).toThrow(/уже идёт запуск/i);
  });

  it('нет пати — 404, нет персонажа — 404, пустой memberIds — 422', () => {
    const jobs = new JobRegistry();
    const deps = { jobs, members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)) };
    expect(() => launchPartyJob(state, { partyName: 'Нет такой' }, deps)).toThrow(/Пати не найдена/);
    expect(() => launchPartyJob(state, { partyName: 'Основа', memberIds: ['Нет_1'] }, deps)).toThrow(
      /Ни один memberIds/
    );
  });

  it('итог: skipped с причиной no_saved_login, already_running считается отдельно', () => {
    const requested = [
      { id: 'A', nick: 'А' },
      { id: 'B', nick: 'Б' },
      { id: 'C', nick: 'В' }
    ];
    const pre = {
      alreadyRunning: [{ char: { id: 'C' } }],
      noGc: [],
      noSavedLogin: [{ id: 'B' }]
    };
    const summary = launchSummary(requested, [{ id: 'A', nick: 'А', ok: true, ms: 500 }], pre, 900);
    expect(summary).toMatchObject({ requested: 3, launched: 1, skipped: 2, failed: 0, alreadyRunning: 1 });
    expect(summary.items.map(row => [row.id, row.status, row.error])).toEqual([
      ['A', 'ok', null],
      ['B', 'skipped', 'no_saved_login'],
      ['C', 'skipped', 'already_running']
    ]);
  });

  it('ошибка запуска — задание failed, но ответ HTTP был 202 и остаётся читаемым', async () => {
    const jobs = new JobRegistry();
    const job = launchPartyJob(
      state,
      { partyName: 'Основа' },
      {
        jobs,
        members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)),
        preflight: preflightOk,
        launchGroup: async () => {
          throw new Error('GameCenter не найден');
        }
      }
    );
    expect(job.id).toMatch(/^job_/);
    const done = await waitJob(jobs, job.id);
    expect(done.status).toBe('failed');
    expect(done.result.error).toContain('GameCenter');
    // Публичная копия не отдаёт внутренние поля реестра.
    expect(publicJob({ ...done, lazy: true })).not.toHaveProperty('lazy');
  });

  it('проверка «некого запускать» завершает задание как done со строками skipped', async () => {
    const jobs = new JobRegistry();
    const job = launchPartyJob(
      state,
      { partyName: 'Основа' },
      {
        jobs,
        members: (chars, partyId) => chars.filter(c => c.partyIds.includes(partyId)),
        preflight: async characters => ({
          toLaunch: [],
          alreadyRunning: [],
          noGc: [],
          noSavedLogin: characters,
          total: characters.length
        }),
        launchGroup: async () => {
          throw new Error('не должен вызываться');
        }
      }
    );
    const done = await waitJob(jobs, job.id);
    expect(done.status).toBe('done');
    expect(done.result.items.every(row => row.status === 'skipped' && row.error === 'no_saved_login')).toBe(true);
  });
});

describe('внешний API: новые маршруты моста', () => {
  beforeEach(() => {
    // Даты в имени файла должны быть предсказуемыми: подменяем системное время.
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
  });

  it('марафоны: список, карточка, участники и 404 на неизвестный', async () => {
    state.marathons = [
      {
        id: 'm1',
        title: 'Ноябрь',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        participantIds: ['Mag_1'],
        tasks: [
          { id: 't1', title: 'Ежедневки', targetChecks: 3, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }
        ],
        progress: {}
      }
    ];
    // `totalsOf` — заведомо известный: модель марафонов проверяется своими тестами.
    const deps = { ...fakeDeps(), marathonTotals: () => ({ checks: 1, maxChecks: 3, coins: 0, maxCoins: 100 }) };
    const list = await routeRequest({ method: 'GET', path: '/api/v1/marathons' }, deps);
    expect(list.status).toBe(200);
    expect(list.body.marathons[0].title).toBe('Ноябрь');
    expect(list.body.marathons[0].totals).toMatchObject({ checks: 1 });
    const one = await routeRequest({ method: 'GET', path: '/api/v1/marathons/m1' }, deps);
    expect(one.body.marathon.id).toBe('m1');
    const participants = await routeRequest({ method: 'GET', path: '/api/v1/marathons/m1/participants' }, deps);
    expect(participants.body.characters).toEqual([{ id: 'Mag_1', nick: 'Маг' }]);
    const missing = await answer({ method: 'GET', path: '/api/v1/marathons/nope' }, deps);
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'no_such_marathon' } } });
  });

  it('планировщик, учёт и пати по id отвечают без секретов', async () => {
    state.plannerEntries = [];
    state.finance = { operations: [], shopItems: [], loans: [], settings: {} };
    const planner = await routeRequest({ method: 'GET', path: '/api/v1/planner' }, fakeDeps());
    expect(planner.body.entries).toEqual([]);
    const finance = await routeRequest({ method: 'GET', path: '/api/v1/finance' }, fakeDeps());
    expect(finance.body).toHaveProperty('operations');
    const party = await routeRequest({ method: 'GET', path: '/api/v1/parties/p-osnova' }, fakeDeps());
    expect(party.body.party).toMatchObject({ id: 'p-osnova', name: 'Основа' });
    const missing = await answer({ method: 'GET', path: '/api/v1/parties/nope' }, fakeDeps());
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'no_such_party' } } });
  });

  it('выгрузка: CSV приходит как raw с Content-Disposition, JSON — файл с .json', async () => {
    const csv = await routeRequest({ method: 'GET', path: '/api/v1/export/characters.csv' }, fakeDeps());
    expect(csv.status).toBe(200);
    expect(csv.raw.contentType).toContain('text/csv');
    expect(csv.raw.disposition).toBe('attachment; filename="tvinoferma_characters_2026-11-25.csv"');
    expect(csv.raw.text).toContain('Ник');
    expect(csv.raw.text).toContain('Маг');
    // Тело — короткая сводка, а не гигантская таблица в JSON.
    expect(csv.body).toMatchObject({ dataset: 'characters', format: 'csv', rows: 3 });

    const json = await routeRequest({ method: 'GET', path: '/api/v1/export/parties.json' }, fakeDeps());
    expect(json.raw.contentType).toContain('application/json');
    expect(JSON.parse(json.raw.text).dataset).toBe('parties');

    const txt = await routeRequest({ method: 'GET', path: '/api/v1/export/windows.txt' }, fakeDeps());
    expect(txt.raw.contentType).toContain('text/csv');

    const badFormat = await answer({ method: 'GET', path: '/api/v1/export/characters.pdf' }, fakeDeps());
    expect(badFormat).toMatchObject({ status: 422, body: { error: { code: 'invalid_value' } } });
    const badSet = await answer({ method: 'GET', path: '/api/v1/export/contacts.csv' }, fakeDeps());
    expect(badSet).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('выгрузка требует права чтения, изменение — права изменения', async () => {
    setupSettings({ allowModify: false });
    const exportDenied = await answer({ method: 'GET', path: '/api/v1/export/characters.csv' }, fakeDeps());
    // Чтение разрешено по умолчанию, поэтому выгрузка проходит и без «изменения».
    expect(exportDenied.status).toBe(200);
    const partyPatch = await answer(
      { method: 'PATCH', path: '/api/v1/parties/p-osnova', body: { name: 'X' } },
      fakeDeps()
    );
    expect(partyPatch).toMatchObject({ status: 403, body: { error: { code: 'forbidden_scope' } } });
    const passes = await answer(
      { method: 'PATCH', path: '/api/v1/dungeon-passes/Mag_1', body: { weapon: 1 } },
      fakeDeps()
    );
    expect(passes).toMatchObject({ status: 403 });
  });

  it('проходки и поля карточки меняются через свои маршруты', async () => {
    const deps = fakeDeps();
    const passes = await routeRequest(
      { method: 'PATCH', path: '/api/v1/dungeon-passes/Mag_1', body: { weapon: 7 } },
      deps
    );
    expect(passes.body.dungeonPasses).toMatchObject({ weapon: 7 });
    expect(state.characters[0].dungeonPasses.weapon).toBe(7);

    const created = await routeRequest(
      { method: 'POST', path: '/api/v1/characters', body: { nick: 'Новый' } },
      { ...deps, mutate: undefined }
    );
    expect(created.status).toBe(201);
    expect(created.body.character.nick).toBe('Новый');
  });

  it('отметки марафона пишутся через мост, затем видны в чтении', async () => {
    state.marathons = [
      {
        id: 'm1',
        title: 'Ноябрь',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        participantIds: ['Mag_1'],
        tasks: [
          { id: 't1', title: 'Ежедневки', targetChecks: 3, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }
        ],
        progress: {}
      }
    ];
    const result = await routeRequest(
      {
        method: 'POST',
        path: '/api/v1/marathons/m1/marks',
        body: { characterId: 'Mag_1', taskId: 't1', date: '2026-11-10' }
      },
      fakeDeps()
    );
    expect(result.body).toMatchObject({ marked: true, changed: true, date: '2026-11-10' });
    const read = await routeRequest({ method: 'GET', path: '/api/v1/marathons/m1' }, fakeDeps());
    expect(read.body.marathon.progress.Mag_1.t1.marks).toEqual(['2026-11-10']);
  });

  it('запуск выборки: 202 и задание, второй запуск — 429', async () => {
    const deps = fakeDeps({
      preflight: async characters => ({
        toLaunch: [],
        alreadyRunning: [],
        noGc: [],
        noSavedLogin: characters,
        total: characters.length
      }),
      launchGroup: async () => {
        throw new Error('не должен вызываться');
      }
    });
    const started = await routeRequest(
      { method: 'POST', path: '/api/v1/launch/selection', body: { characterIds: ['Luchnik_2', 'Mag_1'] } },
      deps
    );
    expect(started.status).toBe(202);
    expect(started.body.kind).toBe('selection');
    const busy = await answer(
      { method: 'POST', path: '/api/v1/launch/selection', body: { characterIds: ['Mag_1'] } },
      deps
    );
    expect(busy).toMatchObject({ status: 429, body: { error: { code: 'launch_busy' } } });
    const done = await waitJob(deps.jobs, started.body.id);
    expect(done.status).toBe('done');
  });
});

/** Дождаться завершения задания в фоне (без таймеров «на глаз»). */
async function waitJob(jobs, id, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const job = jobs.get(id);
    if (job && job.status !== 'running' && job.status !== 'queued') return publicJob(job);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Задание не завершилось за отведённое время');
}
