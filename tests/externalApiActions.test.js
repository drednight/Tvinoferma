// tests/externalApiActions.test.js
// Вкладки «Действия» и «Обзор» на странице API: модель действий, её связь
// с контрактом и живая картина по разделам.
//
// Зачем тест: страница — это консоль, а консоль легко «разъезжается» с API.
// Модель описана данными (web/actions.js), поэтому проверяем:
//   1. каждое действие бьёт в существующий маршрут моста (иначе — 404);
//   2. тело и адрес, которые строит форма, действительно принимаются;
//   3. опасные действия требуют подтверждения, а права указаны честно;
//   4. вкладка рисуется, выбор персонажа подставляется, запрос уходит верный.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { state } from '../js/core/state.js';
import { answer } from '../js/modules/externalApi/bridge.js';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api/web');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');

/** Загрузить модель действий так же, как это делает страница. */
function loadActions() {
  const scope = {};
  new Function('window', read('actions.js'))(scope);
  return scope.TF_API_ACTIONS || [];
}

/** Загрузить страницу целиком и подключить токен. */
async function mountPage({ fetchImpl = null } = {}) {
  document.documentElement.innerHTML = read('index.html')
    .replace(/^[\s\S]*?<body>/, '<body>')
    .replace(/<\/body>[\s\S]*$/, '</body>');
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (fetchImpl) return fetchImpl(path, options);
    const method = (options.method || 'GET').toUpperCase();
    const body =
      path === '/api/v1/health'
        ? {
            ok: true,
            app: { version: '3.0.0' },
            scopes: { read: true, modify: true, launchClose: true },
            storage: { writable: true }
          }
        : path === '/api/v1/characters' && method === 'GET'
          ? { characters: [{ id: 'Mag_1', nick: 'Маг', level: 100 }], count: 1, fields: null }
          : path.startsWith('/api/v1/characters/') && path.includes('/stats/')
            ? { id: 'Mag_1', nick: 'Маг', stat: 'hp', value: 45, before: 40, changed: true }
            : path.startsWith('/api/v1/characters/') && path.includes('/dungeon-passes/')
              ? { id: 'Mag_1', nick: 'Маг', pass: 'weapon', value: 3, before: 1, total: 3, changed: true }
              : path.startsWith('/api/v1/characters/')
                ? { character: { id: 'Mag_1', nick: 'Маг' } }
                : path === '/api/v1/parties'
                  ? { parties: [{ id: 'p-osnova', name: 'Основа', members: [] }] }
                  : path === '/api/v1/windows'
                    ? { windows: [{ pid: 4321, title: 'Маг' }] }
                    : path === '/api/v1/audit'
                      ? { audit: [] }
                      : { id: 'Mag_1', nick: 'Маг', stat: 'hp', value: 45, before: 40, changed: true };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify(body)
    };
  };
  for (const file of ['errors.js', 'docs.js', 'actions.js', 'app.js']) new Function(read(file))();
  document.getElementById('token').value = 'a'.repeat(64);
  document.getElementById('connect').click();
  await new Promise(done => setTimeout(done, 50));
  return calls;
}

/** Заготовка состояния: два персонажа, пати, окно. */
function seedState() {
  state.settings = { externalApi: { allowRead: true, allowModify: true, allowLaunchClose: true } };
  state.characters = [
    {
      id: 'Mag_1',
      nick: 'Маг',
      class: 'Маг',
      level: 100,
      partyIds: ['p-osnova'],
      stats: { hp: 40 },
      dungeonPasses: { weapon: 1 }
    },
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
  state.parties = [{ id: 'p-osnova', name: 'Основа', members: ['Mag_1'] }];
  state.plannerEntries = [
    {
      id: 'pl1',
      title: 'Ежедневка',
      date: '2026-11-24',
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
  state.marathons = [
    {
      id: 'm1',
      title: 'Ноябрь',
      kind: 'marathon',
      participantIds: ['Mag_1'],
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      tasks: [{ id: 't1', title: 'Задание' }],
      progress: {}
    }
  ];
  return { persist: async () => {}, storageWritable: () => true };
}

describe('страница API: вкладка «Действия»', () => {
  it('каждое действие ведёт в существующий маршрут моста', async () => {
    const deps = seedState();
    const actions = loadActions();
    expect(actions.length).toBeGreaterThan(20);
    const misses = [];
    for (const action of actions) {
      // Значения по умолчанию: первое из options, для остальных — заглушка.
      const values = {};
      for (const field of action.fields || []) {
        if (field.type === 'select') values[field.name] = field.options ? field.options[0] : '';
        else if (field.type === 'character') values[field.name] = 'Mag_1';
        else if (field.type === 'party') values[field.name] = 'p-osnova';
        else if (field.type === 'number') values[field.name] = '1';
        else if (field.type === 'date') values[field.name] = '2026-11-24';
        else if (field.type === 'checkbox') values[field.name] = true;
        else if (field.type === 'list') values[field.name] = 'Mag_1';
        // Идентификаторы берём из подготовленного состояния, иначе проверяем
        // только форму маршрута: сервер ответит «не найдено» по делу.
        else if (field.name === 'id') values[field.name] = action.id === 'planner-entry' ? 'pl1' : 'm1';
        else if (field.name === 'jobId') values[field.name] = 'job_1';
        else if (field.name === 'taskId') values[field.name] = 't1';
        else values[field.name] = 'x';
      }
      const path = action.pathOf ? action.pathOf(values) : action.path;
      const query = action.query ? action.query(values).replace(/^\?/, '') : '';
      const body = action.body ? action.body(values) : null;
      // /audit обрабатывает Rust (журнал в памяти приложения), а не мост:
      // в jsdom его нет, поэтому проверяем только форму запроса.
      if (path === '/api/v1/audit') {
        expect(action.method).toBe('GET');
        continue;
      }
      // Задание живёт в реестре приложения; в тесте его нет — проверяем форму.
      if (path.startsWith('/api/v1/jobs/')) {
        expect(action.method).toBe('GET');
        continue;
      }
      const result = await answer({ method: action.method, path, query, body }, deps);
      // 404 — значит кнопка ведёт «в никуда». Остальные коды (409/422/423)
      // допустимы: это ответ по существу на искусственные значения.
      if (result.status === 404 || result.status === 405)
        misses.push(`${action.id}: ${action.method} ${path} → ${result.status}`);
    }
    expect(misses).toEqual([]);
  });

  it('адреса и тела собираются так, как ждёт контракт', () => {
    const byId = Object.fromEntries(loadActions().map(action => [action.id, action]));
    // Стат: режим set → value, режим inc → mode+by.
    expect(byId['set-stat'].pathOf({ id: 'Mag_1', stat: 'hp' })).toBe('/api/v1/characters/Mag_1/stats/hp');
    expect(byId['set-stat'].body({ mode: 'set', value: '150' })).toEqual({ value: 150 });
    expect(byId['set-stat'].body({ mode: 'inc', value: '5' })).toEqual({ mode: 'inc', by: 5 });
    // Проходка: тело — просто число.
    expect(byId['set-pass'].body({ value: '7' })).toEqual({ value: 7 });
    // Список: запятые и пробелы одинаково.
    expect(byId['bulk-pass'].body({ ids: 'Mag_1, Luchnik_2', pass: 'weapon', value: '3' })).toEqual({
      ids: ['Mag_1', 'Luchnik_2'],
      patch: { dungeonPasses: { weapon: 3 } }
    });
    // Закрытие окон всегда с confirm: без него сервер откажет.
    expect(byId['close-windows'].body({ pids: '4321, 99' })).toEqual({ pids: [4321, 99], confirm: true });
    // Пустые необязательные поля не попадают в тело.
    expect(byId['patch-character'].body({ id: 'Mag_1', nick: 'Новый', class: '', level: '' })).toEqual({
      nick: 'Новый'
    });
    // Список персонажей: пустые параметры не засоряют адрес.
    expect(byId['list-characters'].query({ fields: '', lang: 'en', sort: 'id', order: 'asc', flat: true })).toBe('');
    expect(
      byId['list-characters'].query({ fields: 'id,class', lang: 'ru', sort: 'level', order: 'desc', flat: false })
    ).toBe('?fields=id%2Cclass&lang=ru&sort=level&order=desc&flat=false');
  });

  it('опасные действия требуют подтверждения, права указаны честно', () => {
    const actions = loadActions();
    for (const action of actions) {
      expect(['read', 'modify', 'launchClose']).toContain(action.scope);
      if (action.danger) expect(typeof action.confirmText).toBe('function');
      // Действие, меняющее данные, не может быть подписано как «чтение».
      if (action.method === 'PATCH' || action.method === 'POST') expect(action.scope).not.toBe('read');
      // У каждого действия есть заголовок и описание для человека.
      expect(action.title.length).toBeGreaterThan(4);
      expect(action.summary.length).toBeGreaterThan(10);
    }
    const close = actions.find(action => action.id === 'close-windows');
    expect(close.danger).toBe(true);
    expect(close.confirmText({ pids: '1,2' })).toMatch(/Закрыть/);
  });
});

describe('страница API: вкладка «Обзор»', () => {
  /** Ответы обзора: марафон с итогами, серия, планировщик, учёт, окна. */
  function overviewReply(path) {
    const reply = body => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body)
    });
    if (path === '/api/v1/marathons')
      return reply({
        marathons: [
          {
            id: 'm1',
            kind: 'single',
            title: 'Ноябрь',
            startDate: '2026-11-01',
            endDate: '2026-11-30',
            status: 'active',
            participantIds: ['Mag_1'],
            tasks: [{ id: 't1' }],
            totals: {
              checks: 12,
              maxChecks: 40,
              percent: 30,
              done: 3,
              cells: 16,
              coins: 500,
              maxCoins: 2000,
              failing: 1
            }
          },
          { id: 's1', kind: 'series', title: 'Серия', childIds: ['m1', 'm2'] }
        ]
      });
    if (path === '/api/v1/planner')
      return reply({
        entries: [
          { id: 'old', title: 'Прошлое', date: '2020-01-01' },
          { id: 'p1', title: 'Сбор пати', date: '2099-11-25', time: '19:00', kind: 'event', recurrence: 'weekly' }
        ]
      });
    if (path === '/api/v1/finance')
      return reply({
        operations: [
          { id: 'o1', kind: 'in', amount: 1000 },
          { id: 'o2', kind: 'out', amount: 250.5 }
        ],
        loans: [
          { id: 'l1', amount: 300, closed: false },
          { id: 'l2', amount: 999, closed: true }
        ],
        shopItems: [{ id: 's1' }],
        settings: { goldRate: 12.5 }
      });
    if (path === '/api/v1/windows')
      return reply({
        windows: [
          { pid: 4321, title: 'Lineage', nick: 'Маг', class: 'Маг', elevated: true, startedAt: '2026-11-24T10:00:00Z' },
          { pid: 555, title: 'Launcher', nick: null, class: null, elevated: null, startedAt: null }
        ]
      });
    return null;
  }

  async function mountOverview() {
    return mountPage({
      fetchImpl: async path => {
        if (path === '/api/v1/health')
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({ ok: true, app: { version: '3' }, scopes: { read: true }, storage: { writable: true } })
          };
        const reply = overviewReply(path);
        if (reply) return reply;
        const body =
          path === '/api/v1/characters'
            ? { characters: [] }
            : path === '/api/v1/parties'
              ? { parties: [] }
              : { audit: [] };
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(body)
        };
      }
    });
  }

  it('показывает прогресс марафонов, серии отдельно от марафонов', async () => {
    await mountOverview();
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 60));
    expect(document.getElementById('overview').hidden).toBe(false);
    const box = document.getElementById('overview-marathons');
    // Прогресс берётся из totals сервера, а не считается на странице.
    expect(box.textContent).toMatch(/30%|30 %/);
    expect(box.textContent).toMatch(/12 \/ 40|12 \/\s*40/);
    expect(box.textContent).toMatch(/01\.11\.2026 — 30\.11\.2026/);
    expect(box.textContent).toMatch(/Провалено/);
    // Серия — не марафон: показываем «папка марафонов», а не прогресс.
    expect(box.textContent).toMatch(/папка марафонов/);
    expect(box.textContent).toMatch(/2 шт\./);
  });

  it('планировщик показывает будущее, а прошлые записи — нет', async () => {
    await mountOverview();
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 60));
    const box = document.getElementById('overview-planner');
    expect(box.textContent).toMatch(/Сбор пати/);
    expect(box.textContent).toMatch(/25\.11\.2099, 19:00/);
    expect(box.textContent).not.toMatch(/Прошлое/);
  });

  it('учёт считает приход, расход, баланс и открытые долги', async () => {
    await mountOverview();
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 60));
    const box = document.getElementById('overview-finance');
    expect(box.textContent).toMatch(/1\s?000/);
    expect(box.textContent).toMatch(/250,5/);
    // 1000 − 250,5 = 749,5; закрытый долг на 999 в сумму не входит.
    expect(box.textContent).toMatch(/749,5/);
    expect(box.textContent).toMatch(/1 на 300/);
    expect(box.textContent).toMatch(/Курс золота: 12,5/);
  });

  it('окна показывают персонажа, права и подпись', async () => {
    await mountOverview();
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 60));
    const box = document.getElementById('overview-windows');
    expect(box.textContent).toMatch(/Маг \(Маг\)/);
    expect(box.textContent).toMatch(/повышенные/);
    expect(box.textContent).toMatch(/4321/);
    expect(box.textContent).toMatch(/Launcher/);
    // У окна без персонажа подпись — по PID, а не пустая строка.
    expect(box.textContent).toMatch(/PID 555/);
  });

  it('сбой одной части не скрывает остальные и назван в статусе', async () => {
    await mountPage({
      fetchImpl: async path => {
        if (path === '/api/v1/health')
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ ok: true, scopes: { read: true }, storage: { writable: true } })
          };
        if (path === '/api/v1/finance')
          return {
            ok: false,
            status: 403,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({ error: { code: 'forbidden_scope', message: 'Право «чтение» выключено' } })
          };
        const reply = overviewReply(path);
        if (reply) return reply;
        const body =
          path === '/api/v1/characters'
            ? { characters: [] }
            : path === '/api/v1/parties'
              ? { parties: [] }
              : { audit: [] };
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(body)
        };
      }
    });
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 80));
    // Марафоны и окна на месте, отказ учёта назван.
    expect(document.getElementById('overview-marathons').textContent).toMatch(/Ноябрь/);
    expect(document.getElementById('overview-windows').textContent).toMatch(/4321/);
    expect(document.getElementById('overview-status').textContent).toMatch(/forbidden_scope/);
    expect(document.getElementById('overview-status').textContent).toMatch(/учёт/);
  });

  it('«Обновить» перезапрашивает данные', async () => {
    const calls = await mountOverview();
    document.querySelector('[data-tab="overview"]').click();
    await new Promise(done => setTimeout(done, 60));
    const before = calls.filter(call => call.path === '/api/v1/marathons').length;
    document.getElementById('overview-refresh').click();
    await new Promise(done => setTimeout(done, 60));
    expect(calls.filter(call => call.path === '/api/v1/marathons').length).toBe(before + 1);
  });
});

describe('страница API: вкладка «Действия» в разметке', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('вкладка открывается и показывает все действия по группам', async () => {
    await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    expect(document.getElementById('actions').hidden).toBe(false);
    const cards = document.querySelectorAll('[data-action]');
    expect(cards.length).toBe(loadActions().length);
    const groups = [...document.querySelectorAll('.xapi-action-group h3')].map(node => node.textContent);
    expect(groups).toContain('Чтение данных');
    expect(groups).toContain('Изменение данных');
    expect(groups).toContain('Запуск и окна');
    expect(groups).toContain('Выгрузки');
  });

  it('поиск по действиям сужает список и объясняет пустой результат', async () => {
    await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    const filter = document.getElementById('actions-filter');
    filter.value = 'проходк';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    const found = document.querySelectorAll('[data-action]');
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(loadActions().length);
    expect(document.getElementById('actions-count').textContent).toMatch(/найдено/);
    filter.value = 'такого-точно-нет';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(document.getElementById('actions-list').textContent).toMatch(/Ничего не найдено/);
  });

  it('форма подставляет персонажа из загруженных и собирает верный запрос', async () => {
    const calls = await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    document.querySelector('[data-action="set-stat"]').click();
    const select = document.querySelector('#action-fields [data-field="id"]');
    // Не руками вводить id: варианты пришли из GET /characters.
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('Mag_1');
    expect(select.textContent).toContain('Маг');
    document.querySelector('#action-fields [data-field="stat"]').value = 'hp';
    document.querySelector('#action-fields [data-field="mode"]').value = 'inc';
    document.querySelector('#action-fields [data-field="value"]').value = '5';
    document.getElementById('action-fields').dispatchEvent(new window.Event('input', { bubbles: true }));
    // Маршрут виден до отправки — модель и адрес совпадают.
    expect(document.getElementById('action-route').textContent).toBe('PATCH /api/v1/characters/Mag_1/stats/hp');
    document.getElementById('action-send').click();
    await new Promise(done => setTimeout(done, 50));
    const sent = calls.find(call => call.method === 'PATCH');
    expect(sent.path).toBe('/api/v1/characters/Mag_1/stats/hp');
    expect(JSON.parse(sent.body)).toEqual({ mode: 'inc', by: 5 });
    expect(document.getElementById('action-status').textContent).toMatch(/hp: 40 → 45/);
  });

  it('обязательные поля проверяются до запроса, а 403 объясняется', async () => {
    const calls = await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    document.querySelector('[data-action="create-character"]').click();
    const nick = document.querySelector('#action-fields [data-field="nick"]');
    nick.value = '';
    const before = calls.length;
    document.getElementById('action-send').click();
    await new Promise(done => setTimeout(done, 20));
    expect(calls.length).toBe(before);
    expect(document.getElementById('action-status').textContent).toMatch(/Заполните: Ник/);

    // 403 — подсказка, где включить право.
    // Право «изменение» выключено: чтение работает, PATCH отвечает 403.
    const reply = (status, body) => ({
      ok: status < 400,
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body)
    });
    const forbidden = { error: { code: 'forbidden_scope', message: 'Право «modify» выключено' } };
    await mountPage({
      fetchImpl: async (path, options = {}) => {
        const method = options.method || 'GET';
        if (path === '/api/v1/health')
          return reply(200, { ok: true, scopes: { read: true, modify: false }, storage: { writable: true } });
        if (method === 'GET' && path === '/api/v1/characters') return reply(200, { characters: [], count: 0 });
        if (method === 'GET' && path === '/api/v1/parties') return reply(200, { parties: [] });
        if (method === 'GET' && path === '/api/v1/windows') return reply(200, { windows: [] });
        if (method === 'GET' && path === '/api/v1/audit') return reply(200, { audit: [] });
        return reply(403, forbidden);
      }
    });
    document.querySelector('[data-tab="actions"]').click();
    document.querySelector('[data-action="set-pass"]').click();
    // Список персонажей пуст: форма не должна блокировать отправку, а сервер
    // сам ответит 403 — важно, чтобы это было понятно человеку.
    const pick = document.querySelector('#action-fields [data-field="id"]');
    // Список пуст — это не тупик: поле становится ручным вводом.
    expect(pick.tagName).toBe('INPUT');
    pick.value = 'Mag_1';
    document.querySelector('#action-fields [data-field="value"]').value = '3';
    document.getElementById('action-send').click();
    await new Promise(done => setTimeout(done, 50));
    const status = document.getElementById('action-status').textContent;
    expect(status).toMatch(/forbidden_scope/);
    expect(status).toMatch(/Настройки → 🔌 Внешний API/);
  });

  it('действие с подтверждением спрашивает перед отправкой и уважает отказ', async () => {
    const calls = await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    document.querySelector('[data-action="bulk-pass"]').click();
    document.querySelector('#action-fields [data-field="ids"]').value = 'Mag_1,Luchnik_2';
    document.querySelector('#action-fields [data-field="value"]').value = '3';
    const before = calls.length;
    // Отказ: запрос уходить не должен.
    globalThis.confirm = () => false;
    document.getElementById('action-send').click();
    await new Promise(done => setTimeout(done, 20));
    expect(calls.length).toBe(before);
    expect(document.getElementById('action-status').textContent).toMatch(/Отменено/);
    // Согласие: уходит ровно один POST.
    globalThis.confirm = () => true;
    document.getElementById('action-send').click();
    await new Promise(done => setTimeout(done, 50));
    expect(calls.filter(call => call.method === 'POST').length).toBe(1);
  });

  it('из карточки персонажа действие открывается с подставленным id', async () => {
    await mountPage();
    // Карточка «Маг» на вкладке данных содержит ссылки-действия.
    const link = document.querySelector('#characters [data-char-action="set-stat"]');
    expect(link).toBeTruthy();
    link.click();
    // Произошло переключение на «Действия» с открытой формой и заполненным id.
    expect(document.getElementById('actions').hidden).toBe(false);
    expect(document.getElementById('actions-form').hidden).toBe(false);
    expect(document.querySelector('#action-fields [data-field="id"]').value).toBe('Mag_1');
    // Стат по умолчанию (hp) уже подставлен: маршрут читается как готовый.
    expect(document.getElementById('action-route').textContent).toBe('PATCH /api/v1/characters/Mag_1/stats/hp');
  });

  it('из карточки окна «Закрыть окно» — форма закрытия с PID', async () => {
    await mountPage();
    const link = document.querySelector('#windows [data-char-action="close-windows"]');
    expect(link).toBeTruthy();
    link.click();
    const pids = document.querySelector('#action-fields [data-field="pids"]');
    expect(pids.value).toBe('4321');
    expect(document.getElementById('action-route').textContent).toBe('POST /api/v1/windows/close');
    // Подтверждение обязательно: форма закрытия помечена как опасная.
    expect(document.getElementById('action-summary').textContent.length).toBeGreaterThan(10);
  });

  it('«Открыть в тестовой строке» переносит собранный запрос', async () => {
    await mountPage();
    document.querySelector('[data-tab="actions"]').click();
    document.querySelector('[data-action="set-pass"]').click();
    document.querySelector('#action-fields [data-field="value"]').value = '9';
    document.getElementById('action-open-playground').click();
    expect(document.getElementById('playground').hidden).toBe(false);
    expect(document.getElementById('play-method').value).toBe('PATCH');
    expect(document.getElementById('play-path').value).toBe('/api/v1/characters/Mag_1/dungeon-passes/weapon');
    expect(JSON.parse(document.getElementById('play-body').value)).toEqual({ value: 9 });
  });
});
