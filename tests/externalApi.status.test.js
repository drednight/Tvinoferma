// tests/externalApi.status.test.js
// Внешний API: сводка «как дела», правки планировщика и запись в реестр денег.
//
// Что тут проверяется:
//   - `/status` отвечает счётчиками, сегодняшними делами и балансом — и не выдаёт
//     при этом ничего лишнего (контактов, паролей, куки);
//   - планировщик меняется тем же правилом, что и в интерфейсе (у повтора своё
//     состояние на каждый день);
//   - реестр денег остаётся единственной правдой: округление и валюта — из модели
//     учёта, а не из API;
//   - права «Изменение» проверяются и на новых маршрутах.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state } from '../js/core/state.js';
import { mskDate } from '../js/core/msk.js';
import { answer, routeRequest } from '../js/modules/externalApi/bridge.js';
import { JobRegistry } from '../js/modules/externalApi/actions/launch.js';

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
    { id: 'Mag_1', nick: 'Маг', class: 'Маг', level: 100, partyIds: ['p1'], stats: { hp: 1 }, dungeonPasses: {} }
  ];
  state.parties = [{ id: 'p1', name: 'Основа', color: null }];
  state.marathons = [];
  state.plannerEntries = [
    {
      id: 'e1',
      title: 'Ежедневка',
      date: mskDate(new Date()),
      time: '',
      durationMinutes: 60,
      kind: 'task',
      priority: 'normal',
      recurrence: 'none',
      status: 'todo',
      statusByDate: {},
      notes: ''
    }
  ];
  state.finance = {
    operations: [],
    shopItems: [],
    loans: [],
    settings: { goldRate: 0, commissionPct: 2, goldRateAt: null, opening: { gold: 100, coins: 0 } }
  };
}

function fakeDeps(overrides = {}) {
  const calls = { persist: 0 };
  // Мок изменения: настоящие функции, но с подменёнными зависимостями (сохранение
  // «успешно», запись разрешена, время фиксировано).
  const mockDeps = {
    persist: async () => {
      calls.persist += 1;
    },
    assertStateWriteAvailable: () => {},
    now: () => '2026-11-25T12:00:00.000Z'
  };
  return {
    calls,
    appVersion: '3.0.0',
    buildProfile: 'stable',
    storageWritable: true,
    windowRows: [],
    jobs: new JobRegistry(),
    balances: { gold: 100, coins: 0 },
    mutate: {
      patchPlannerEntry: async (state, id, body) => {
        const module = await import('../js/modules/externalApi/actions/mutate.js');
        return module.patchPlannerEntry(state, id, body, mockDeps);
      },
      createPlannerEntry: async (state, body) => {
        const module = await import('../js/modules/externalApi/actions/mutate.js');
        return module.createPlannerEntry(state, body, mockDeps);
      },
      addFinanceOperation: async (state, body) => {
        const module = await import('../js/modules/externalApi/actions/mutate.js');
        return module.addFinanceOperation(state, body, mockDeps);
      }
    },
    ...overrides
  };
}

beforeEach(() => {
  setupSettings();
  setupState();
});

describe('внешний API: сводка /status', () => {
  it('отвечает счётчиками, сегодняшними делами и балансом', async () => {
    const result = await routeRequest({ method: 'GET', path: '/api/v1/status' }, fakeDeps());
    expect(result.status).toBe(200);
    expect(result.body.counts).toMatchObject({ characters: 1, parties: 1, marathons: 0, windows: 0 });
    expect(result.body.counts.plannerEntries).toBe(1);
    expect(result.body.today).toMatchObject({ date: mskDate(new Date()), total: 1, done: 0 });
    expect(result.body.finance.balances).toEqual({ gold: 100, coins: 0 });
    expect(result.body.app).toMatchObject({ version: '3.0.0', build: 'stable' });
  });

  it('считает сделанное за сегодня и не выдаёт ничего лишнего', async () => {
    state.plannerEntries[0].status = 'done';
    const result = await routeRequest({ method: 'GET', path: '/api/v1/status' }, fakeDeps());
    expect(result.body.today.done).toBe(1);
    // Секретов в сводке быть не должно: только счётчики и итоги.
    expect(JSON.stringify(result.body)).not.toMatch(/contacts|password|cookie/i);
  });

  it('повтор попадает в сегодняшние дела и его статус считается за этот день', async () => {
    // Ежедневная запись началась вчера: в календаре на сегодня она есть,
    // а её «сделано» за вчера не должен означать «сделано сегодня».
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    state.plannerEntries[0].recurrence = 'daily';
    state.plannerEntries[0].date = mskDate(yesterday);
    state.plannerEntries[0].status = 'done';
    const result = await routeRequest({ method: 'GET', path: '/api/v1/status' }, fakeDeps());
    expect(result.body.today.total).toBe(1);
    expect(result.body.today.done).toBe(0);
  });
});

describe('внешний API: правки планировщика', () => {
  it('PATCH /planner/entries/{id}: статус меняется и запись сохраняется', async () => {
    const deps = fakeDeps();
    const result = await routeRequest(
      { method: 'PATCH', path: '/api/v1/planner/entries/e1', body: { status: 'done' } },
      deps
    );
    expect(result.status).toBe(200);
    expect(result.body.changed).toContain('status');
    expect(result.body.entry.status).toBe('done');
    expect(state.plannerEntries[0].status).toBe('done');
    expect(deps.calls.persist).toBe(1);
  });

  it('неизвестное поле и пустое тело — 422, нет такой записи — 404', async () => {
    const deps = fakeDeps();
    const bad = await answer(
      { method: 'PATCH', path: '/api/v1/planner/entries/e1', body: { status: 'done', kind: 'x' } },
      deps
    );
    expect(bad.status).toBe(422);
    const empty = await answer({ method: 'PATCH', path: '/api/v1/planner/entries/e1', body: {} }, deps);
    expect(empty.status).toBe(422);
    const missing = await answer(
      { method: 'PATCH', path: '/api/v1/planner/entries/nope', body: { status: 'done' } },
      deps
    );
    expect(missing.status).toBe(404);
    expect(deps.calls.persist).toBe(0);
  });

  it('у повтора своё состояние на каждый день', async () => {
    state.plannerEntries[0].recurrence = 'daily';
    state.plannerEntries[0].date = '2026-11-24';
    const result = await routeRequest(
      { method: 'PATCH', path: '/api/v1/planner/entries/e1', body: { date: '2026-11-25', status: 'done' } },
      fakeDeps()
    );
    expect(result.status).toBe(200);
    // Статус записи не изменился: отмечен был конкретный день повтора.
    expect(state.plannerEntries[0].status).toBe('todo');
    expect(state.plannerEntries[0].statusByDate['2026-11-25']).toBe('done');
  });

  it('POST /planner/entries: запись создаётся и попадает в календарь', async () => {
    const result = await routeRequest(
      { method: 'POST', path: '/api/v1/planner/entries', body: { title: 'Сходить в игру', date: '2026-11-26' } },
      fakeDeps()
    );
    expect(result.status).toBe(201);
    expect(result.body.entry.title).toBe('Сходить в игру');
    expect(state.plannerEntries).toHaveLength(2);
    expect(state.plannerEntries[1].date).toBe('2026-11-26');
  });

  it('POST /planner/entries: без названия и с кривой датой — 422', async () => {
    const noTitle = await answer(
      { method: 'POST', path: '/api/v1/planner/entries', body: { date: '2026-11-26' } },
      fakeDeps()
    );
    expect(noTitle.status).toBe(422);
    const badDate = await answer(
      { method: 'POST', path: '/api/v1/planner/entries', body: { title: 'X', date: '26.11.2026' } },
      fakeDeps()
    );
    expect(badDate.status).toBe(422);
    expect(state.plannerEntries).toHaveLength(1);
  });

  it('без права «Изменение» правки не проходят', async () => {
    setupSettings({ allowModify: false });
    const result = await answer(
      { method: 'PATCH', path: '/api/v1/planner/entries/e1', body: { status: 'done' } },
      fakeDeps()
    );
    expect(result.status).toBe(403);
    expect(state.plannerEntries[0].status).toBe('todo');
  });
});

describe('внешний API: запись в реестр денег', () => {
  it('POST /finance/operations: операция попадает в реестр', async () => {
    const deps = fakeDeps();
    const result = await routeRequest(
      {
        method: 'POST',
        path: '/api/v1/finance/operations',
        body: { kind: 'in', amount: 250, currency: 'gold', note: 'Продажа зелья' }
      },
      deps
    );
    expect(result.status).toBe(201);
    expect(result.body.operation).toMatchObject({ kind: 'in', amount: 250, currency: 'gold' });
    expect(state.finance.operations).toHaveLength(1);
    expect(deps.calls.persist).toBe(1);
  });

  it('сумма должна быть положительной, валюта — известной', async () => {
    const zero = await answer(
      { method: 'POST', path: '/api/v1/finance/operations', body: { kind: 'out', amount: 0 } },
      fakeDeps()
    );
    expect(zero.status).toBe(422);
    const currency = await answer(
      { method: 'POST', path: '/api/v1/finance/operations', body: { kind: 'out', amount: 10, currency: 'rur' } },
      fakeDeps()
    );
    expect(currency.status).toBe(422);
    expect(state.finance.operations).toHaveLength(0);
  });
});

describe('внешний API: маршруты Rust', () => {
  it('новые пути есть в таблице прав доступа', () => {
    const auth = readFileSync('src-tauri/src/external_api/auth.rs', 'utf8');
    expect(auth).toContain('("GET", ["status"])');
    expect(auth).toContain('("PATCH", ["planner", "entries", _])');
    expect(auth).toContain('("POST", ["planner", "entries"])');
    expect(auth).toContain('("POST", ["finance", "operations"])');
  });
});
