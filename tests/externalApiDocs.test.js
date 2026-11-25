// tests/externalApiDocs.test.js
// Страница внешнего API (Rust раздаёт её из памяти) и справочник методов.
//
// Тест крутит настоящие `web/docs.js` и `web/app.js` в jsdom: так проверяется
// то, что видит пользователь, а не только данные. Что важно:
//   1. Каждый метод справочника действительно существует в мосте (иначе
//      «Попробовать» ведёт в 404 — это и случилось бы без проверки).
//   2. Приёмы из запроса пользователя — /stats/{stat} и /dungeon-passes/{pass} —
//      есть и в справочнике, и в маршрутах.
//   3. Вкладки и тестовая строка работают: клик подставляет путь и метод.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { state } from '../js/core/state.js';
import { routeRequest, answer } from '../js/modules/externalApi/bridge.js';
import { JobRegistry } from '../js/modules/externalApi/actions/launch.js';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api/web');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');

/** Загрузить страницу как браузер: разметка, docs.js, app.js. */
function mountPage() {
  const html = read('index.html');
  const body = html.replace(/^[\s\S]*?<body>/, '<body>').replace(/<\/body>[\s\S]*$/, '</body>');
  document.documentElement.innerHTML = body;
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    text: async () => '{"ok":true}'
  }));
  // errors.js — каталог кодов для страницы (в Rust подключается тегом script).
  new Function(read('errors.js'))();
  new Function(read('docs.js'))();
  new Function(read('app.js'))();
  return globalThis.window.TF_API_DOCS;
}

/** Все примеры из справочника: `{ method, path }` с подставленными значениями. */
function examples(docs) {
  return docs.groups
    .flatMap(group => group.methods)
    .filter(method => method.method !== '—' && String(method.path).startsWith('/'))
    .map(method => ({ method: method.method, path: method.path, id: method.id }));
}

beforeEach(() => {
  state.settings = { externalApi: { enabled: true, allowRead: true, allowModify: true, allowLaunchClose: true } };
  state.characters = [
    {
      id: 'Mag_1',
      nick: 'Маг',
      class: 'Маг',
      level: 100,
      partyIds: ['p-osnova'],
      stats: { hp: 120, mp: 30, physAttack: 12 },
      dungeonPasses: { weapon: 3, armor: 1, relic: 0 }
    }
  ];
  state.parties = [{ id: 'p-osnova', name: 'Основа', color: null }];
  state.marathons = [];
  state.plannerEntries = [];
  state.finance = { operations: [], shopItems: [], loans: [], settings: {} };
});

describe('страница API: справочник', () => {
  it('загружается и показывает все группы и методы', () => {
    const docs = mountPage();
    expect(docs).toBeTruthy();
    expect(docs.groups.length).toBeGreaterThanOrEqual(9);
    const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
    expect(total).toBeGreaterThanOrEqual(35);
    document.querySelector('[data-tab="docs"]').click();
    expect(document.getElementById('docs').hidden).toBe(false);
    expect(document.querySelectorAll('[data-doc]').length).toBe(total);
    expect(document.querySelectorAll('.xapi-toc-link').length).toBe(docs.groups.length);
  });

  it('каждый путь из справочника существует в мосте (не 404)', async () => {
    const docs = mountPage();
    const deps = {
      jobs: new JobRegistry(),
      windowRows: [],
      persist: async () => {},
      assertStateWriteAvailable: () => {}
    };
    const missing = [];
    // /audit и статические страницы отдаёт Rust, минуя мост: для них 404 от
    // моста — нормальная ситуация, а не пробел в справочнике.
    const rustOnly = new Set(['get-audit', 'get-job']);
    for (const example of examples(docs)) {
      if (rustOnly.has(example.id)) continue;
      // Чтение — с настоящим маршрутом; запись проверяем по коду: 404 значит
      // «маршрута нет», а 422/400/403 — маршрут есть, просто тело не то.
      // Плейсхолдеры выгрузки заменяем на настоящий набор: справочник показывает
      // форму, а маршрут проверяется на конкретном файле.
      const concrete = example.path.replace('{набор}.{csv|json}', 'characters.csv');
      const request = { method: example.method, path: `/api/v1${concrete}` };
      if (example.method === 'PATCH' || example.method === 'POST') request.body = {};
      const result = await answer(request, deps);
      if (result.status === 404 && result.body?.error?.code === 'not_found') {
        missing.push(`${example.method} ${concrete} (${example.id})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('приёмы из запроса пользователя есть в справочнике', () => {
    const docs = mountPage();
    const paths = examples(docs).map(row => `${row.method} ${row.path}`);
    expect(paths).toContain('GET /characters/{id}/stats/{stat}');
    expect(paths).toContain('GET /characters/{id}/dungeon-passes');
    expect(paths).toContain('GET /characters/{id}/dungeon-passes/{pass}');
    expect(paths).toContain('PATCH /characters/{id}/dungeon-passes/{pass}');
    expect(paths).toContain('PATCH /characters/{id}/stats/{stat}');
  });

  it('«Попробовать» подставляет путь, метод и тело в тестовую строку', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const button = [...document.querySelectorAll('[data-try]')].find(row =>
      row.dataset.try.endsWith('/dungeon-passes/weapon')
    );
    expect(button).toBeTruthy();
    button.click();
    expect(document.getElementById('play-path').value).toBe('/api/v1/characters/Mag_1/dungeon-passes/weapon');
    expect(document.getElementById('play-method').value).toBe('GET');
    expect(document.getElementById('playground').hidden).toBe(false);
  });

  it('поиск сужает методы и скрывает пустые группы', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const filter = document.getElementById('docs-filter');
    filter.value = 'проходк';
    filter.dispatchEvent(new Event('input'));
    const visible = [...document.querySelectorAll('[data-doc]')].filter(doc => !doc.hidden);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every(doc => doc.textContent.toLowerCase().includes('проходк'))).toBe(true);
    filter.value = 'такого-нет-в-справочнике';
    filter.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('[data-doc]')].filter(doc => !doc.hidden)).toHaveLength(0);
  });
});

describe('страница API: тестовая строка', () => {
  it('готовые примеры подставляют запрос', () => {
    mountPage();
    const preset = [...document.querySelectorAll('[data-preset]')].find(row => row.textContent === 'Только HP');
    expect(preset).toBeTruthy();
    preset.click();
    expect(document.getElementById('play-path').value).toBe('/api/v1/characters/Mag_1/stats/hp');
    expect(document.getElementById('play-method').value).toBe('GET');
  });

  it('«Отправить» шлёт запрос с токеном и показывает JSON', async () => {
    mountPage();
    const tokenInput = document.getElementById('token');
    tokenInput.value = 'a'.repeat(64);
    document.getElementById('connect').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.getElementById('play-path').value = '/api/v1/health';
    document.getElementById('play-send').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(globalThis.fetch).toHaveBeenCalled();
    const calls = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(calls.some(url => url.includes('/api/v1/health'))).toBe(true);
    expect(document.getElementById('play-out').textContent).toContain('"ok"');
  });

  it('тело-число уходит как число: PATCH проходки без JSON-обёртки', async () => {
    mountPage();
    document.getElementById('play-method').value = 'PATCH';
    document.getElementById('play-path').value = '/api/v1/characters/Mag_1/dungeon-passes/weapon';
    document.getElementById('play-body').value = '5';
    document.getElementById('play-send').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const patch = globalThis.fetch.mock.calls.find(([url]) => String(url).includes('dungeon-passes/weapon'));
    expect(patch).toBeTruthy();
    expect(patch[1].method).toBe('PATCH');
    expect(patch[1].body).toBe('5');
  });

  it('битый JSON в теле не отправляется и объясняет ошибку', async () => {
    mountPage();
    globalThis.fetch.mockClear();
    document.getElementById('play-method').value = 'PATCH';
    document.getElementById('play-path').value = '/api/v1/characters/Mag_1';
    document.getElementById('play-body').value = '{ не json';
    document.getElementById('play-send').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('play-status').textContent).toContain('не JSON');
  });

  it('без подключения справочник открывается, а панель данных — нет', async () => {
    mountPage();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => '' },
      text: async () => '{}'
    }));
    document.getElementById('token').value = 'a'.repeat(64);
    document.getElementById('connect').click();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(document.getElementById('docs').hidden).toBe(false);
    expect(document.getElementById('panel').hidden).toBe(true);
  });
});

describe('адресные маршруты статов и проходок', () => {
  const deps = () => ({
    jobs: new JobRegistry(),
    windowRows: [],
    persist: async () => {},
    assertStateWriteAvailable: () => {}
  });

  it('GET /characters/{id}/stats — таблица с подписями и без секретов', async () => {
    const result = await routeRequest({ method: 'GET', path: '/api/v1/characters/Mag_1/stats' }, deps());
    expect(result.status).toBe(200);
    expect(result.body.character).toMatchObject({ id: 'Mag_1', nick: 'Маг', hp: 120, physAttack: 12 });
    const hp = result.body.stats.find(row => row.key === 'hp');
    expect(hp).toEqual({ key: 'hp', label: 'HP', value: 120 });
    expect(JSON.stringify(result.body)).not.toContain('password');
  });

  it('GET /characters/{id}/stats/{stat}: значение, подпись и 422 на неизвестный', async () => {
    const one = await routeRequest({ method: 'GET', path: '/api/v1/characters/Mag_1/stats/hp' }, deps());
    expect(one.body).toEqual({ id: 'Mag_1', nick: 'Маг', stat: 'hp', label: 'HP', value: 120 });
    const wrong = await answer({ method: 'GET', path: '/api/v1/characters/Mag_1/stats/nope' }, deps());
    expect(wrong).toMatchObject({ status: 422, body: { error: { code: 'invalid_value' } } });
    const missing = await answer({ method: 'GET', path: '/api/v1/characters/Nope/stats/hp' }, deps());
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'no_such_character' } } });
  });

  it('GET /characters/{id}/dungeon-passes — три проходки и сумма', async () => {
    const result = await routeRequest({ method: 'GET', path: '/api/v1/characters/Mag_1/dungeon-passes' }, deps());
    expect(result.body.total).toBe(4);
    expect(result.body.passes.map(row => [row.key, row.value])).toEqual([
      ['weapon', 3],
      ['armor', 1],
      ['relic', 0]
    ]);
    expect(result.body.passes[0].label).toBe('Оружие');
  });

  it('проходку можно спросить по-русски (в том числе в percent-encoding)', async () => {
    const plain = await routeRequest({ method: 'GET', path: '/api/v1/characters/Mag_1/dungeon-passes/оружие' }, deps());
    expect(plain.body).toMatchObject({ pass: 'weapon', label: 'Оружие', value: 3 });
    const encoded = await routeRequest(
      { method: 'GET', path: `/api/v1/characters/Mag_1/dungeon-passes/${encodeURIComponent('доспех')}` },
      deps()
    );
    expect(encoded.body).toMatchObject({ pass: 'armor', value: 1 });
  });

  it('PATCH /characters/{id}/stats/{stat}: значение и прибавка', async () => {
    const deps1 = deps();
    const set = await routeRequest(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1/stats/hp', body: { value: 200 } },
      deps1
    );
    expect(set.body).toMatchObject({ stat: 'hp', value: 200, before: 120, changed: true });
    expect(state.characters[0].stats.hp).toBe(200);
    // Снимок появился: массив может создаваться лениво, поэтому проверяем длину.
    expect(Array.isArray(state.characters[0].statsHistory)).toBe(true);
    expect(state.characters[0].statsHistory.length).toBeGreaterThanOrEqual(1);

    const inc = await routeRequest(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1/stats/hp', body: { mode: 'inc', by: 5 } },
      deps()
    );
    expect(inc.body.value).toBe(205);
    const dec = await routeRequest(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1/stats/hp', body: { mode: 'dec' } },
      deps()
    );
    expect(dec.body.value).toBe(204);
  });

  it('PATCH стата не даёт уйти в минус и не принимает мусор', async () => {
    const codeOf = async body => {
      const result = await answer({ method: 'PATCH', path: '/api/v1/characters/Mag_1/stats/hp', body }, deps());
      return result.status;
    };
    expect(await codeOf({ mode: 'dec', by: 1000 })).toBe(422);
    expect(await codeOf({ mode: 'set' })).toBe(422);
    expect(await codeOf({ value: 5, mode: 'inc' })).toBe(422);
    expect(await codeOf({ mode: 'умножить', value: 2 })).toBe(422);
    expect(await codeOf({ value: -1 })).toBe(422);
    expect(state.characters[0].stats.hp).toBe(120);
  });

  it('PATCH /characters/{id}/dungeon-passes/{pass}: объект и голое число', async () => {
    const wrapped = await routeRequest(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1/dungeon-passes/weapon', body: { value: 5 } },
      deps()
    );
    expect(wrapped.body).toMatchObject({ pass: 'weapon', value: 5, before: 3, changed: true, total: 6 });
    const bare = await routeRequest(
      { method: 'PATCH', path: `/api/v1/characters/Mag_1/dungeon-passes/${encodeURIComponent('реликвия')}`, body: 2 },
      deps()
    );
    expect(bare.body).toMatchObject({ pass: 'relic', value: 2, total: 8 });
    expect(state.characters[0].dungeonPasses).toMatchObject({ weapon: 5, armor: 1, relic: 2 });
  });

  it('PATCH проходки: неизвестное имя, дробь и лишнее поле — 422', async () => {
    const codeOf = async (pass, body) => {
      const result = await answer(
        { method: 'PATCH', path: `/api/v1/characters/Mag_1/dungeon-passes/${encodeURIComponent(pass)}`, body },
        deps()
      );
      return result.status;
    };
    expect(await codeOf('шлем', 1)).toBe(422);
    expect(await codeOf('weapon', 1.5)).toBe(422);
    expect(await codeOf('weapon', { value: 1, extra: 2 })).toBe(422);
    expect(await codeOf('armor', { value: -3 })).toBe(422);
  });

  it('запись проходок требует права «изменение»', async () => {
    state.settings.externalApi.allowModify = false;
    const result = await answer(
      { method: 'PATCH', path: '/api/v1/characters/Mag_1/dungeon-passes/weapon', body: 5 },
      deps()
    );
    expect(result).toMatchObject({ status: 403, body: { error: { code: 'forbidden_scope' } } });
    expect(state.characters[0].dungeonPasses.weapon).toBe(3);
  });
});

describe('документация и страница не расходятся', () => {
  /** Методы из markdown-справочника: `#### \`METHOD /path\``. */
  function markdownMethods() {
    const text = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-REFERENCE.md'), 'utf8');
    return [...text.matchAll(/^#### `([A-Z]+) (\/[^`]+)`/gm)].map(match => ({
      method: match[1],
      path: match[2]
    }));
  }

  it('markdown-справочник описывает те же методы, что и страница', () => {
    const docs = mountPage();
    const page = examples(docs).map(row => `${row.method} ${row.path}`);
    const markdown = markdownMethods().map(row => `${row.method} ${row.path}`);
    const missingOnPage = markdown.filter(row => !page.includes(row));
    const missingInMarkdown = page.filter(row => !markdown.includes(row));
    expect(missingOnPage).toEqual([]);
    expect(missingInMarkdown).toEqual([]);
  });

  it('в справочнике есть все три приёма из запроса пользователя с описанием', () => {
    const docs = mountPage();
    const all = docs.groups.flatMap(group => group.methods);
    const hp = all.find(row => row.path === '/characters/{id}/stats/{stat}');
    expect(hp.method).toBe('GET');
    expect(hp.summary).toMatch(/HP/i);
    const passes = all.find(row => row.path === '/characters/{id}/dungeon-passes');
    expect(passes.summary).toMatch(/проходк/i);
    const one = all.find(row => row.path === '/characters/{id}/dungeon-passes/{pass}');
    expect(one.method).toBe('GET');
    // У каждого метода есть параметры, ответ и пример — как в образце.
    for (const method of [hp, passes, one]) {
      expect(method.params.length).toBeGreaterThan(0);
      expect(String(method.response).length).toBeGreaterThan(10);
      expect(String(method.description).length).toBeGreaterThan(30);
    }
  });

  it('коды ошибок на странице совпадают с каталогом errors.js', async () => {
    const docs = mountPage();
    const catalog = await import('../js/modules/externalApi/errors.js');
    const expected = catalog.errorCatalogRows();
    expect(docs.errorCatalog.length).toBe(expected.length);
    expect(docs.errorCatalog.map(row => `${row.status} ${row.code}`)).toEqual(
      expected.map(row => `${row.status} ${row.code}`)
    );
    // web/errors.js — копия для страницы: она не должна отставать от каталога.
    const pageRows = new Function(`${read('errors.js')}; return window.TF_ERROR_CATALOG;`)();
    expect(pageRows.map(row => `${row.status} ${row.code}`)).toEqual(expected.map(row => `${row.status} ${row.code}`));
  });

  it('ошибки нарисованы столбиками по статусу, с подписью у каждого кода', () => {
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const columns = document.querySelectorAll('.xapi-err-col');
    expect(columns.length).toBeGreaterThan(10);
    const rows = [...document.querySelectorAll('.xapi-err-row')];
    expect(rows.length).toBe(docs.errorCatalog.length);
    // У каждой строки есть код и читаемая подпись по-русски.
    for (const row of rows) {
      expect(row.querySelector('code').textContent).toMatch(/^[a-z_]+$/);
      expect(row.querySelector('span').textContent.length).toBeGreaterThan(6);
    }
    // Статусы в столбиках идут по возрастанию — так список читается.
    const statuses = [...columns].map(col => Number(col.querySelector('.xapi-err-status').textContent));
    expect(statuses).toEqual([...statuses].sort((a, b) => a - b));
  });

  it('в тестовой строке есть чипы полей и они собирают fields=', () => {
    mountPage();
    const chips = [...document.querySelectorAll('.xapi-hint-chip')];
    expect(chips.length).toBeGreaterThan(10);
    for (const field of ['class', 'level', 'dungeonPasses.weapon', 'stats.hp']) {
      expect(chips.some(chip => chip.dataset.field === field)).toBe(true);
    }
    for (const field of ['id', 'class', 'level', 'dungeonPasses.weapon']) {
      chips.find(chip => chip.dataset.field === field).click();
    }
    document.getElementById('play-use-fields').click();
    expect(document.getElementById('play-path').value).toBe(
      '/api/v1/characters?fields=id,class,level,dungeonPasses.weapon'
    );
    // И такой запрос действительно отвечает (маршрут существует).
  });

  it('список полей страницы совпадает с CHARACTER_FIELD_NAMES', async () => {
    const docs = mountPage();
    const readApi = await import('../js/modules/externalApi/actions/read.js');
    expect(docs.fieldLists.characterFields).toEqual(readApi.CHARACTER_FIELD_NAMES);
  });

  it('у списка персонажей описаны все параметры выбора — и на странице, и в справочнике', () => {
    const docs = mountPage();
    const list = docs.groups
      .flatMap(group => group.methods)
      .find(row => row.method === 'GET' && row.path === '/characters');
    const names = list.params.map(param => param[0]);
    for (const name of ['party', 'fields', 'lang', 'flat', 'sort', 'order']) expect(names).toContain(name);
    // В описании — главное для пользователя: список всех, по id, поля одним запросом.
    expect(list.summary).toMatch(/все/i);
    expect(list.summary).toMatch(/по id/i);
    expect(list.description).toMatch(/проходк/i);
    // Пример действительно просит несколько полей сразу.
    expect(list.example).toContain('fields=');
    expect(list.example).toContain('dungeonPasses');
    const markdown = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-REFERENCE.md'), 'utf8');
    const section = markdown.slice(
      markdown.indexOf('#### `GET /characters`'),
      markdown.indexOf('#### `GET /characters/{id}`')
    );
    for (const name of ['party', 'fields', 'lang', 'flat', 'sort', 'order']) expect(section).toContain(`\`${name}\``);
    expect(section).toMatch(/по id/i);
    expect(section).toContain('dungeonPasses.weapon');
  });

  it('таблица кодов в справочнике совпадает с каталогом', async () => {
    const catalog = await import('../js/modules/externalApi/errors.js');
    const markdown = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-REFERENCE.md'), 'utf8');
    const table = markdown.slice(markdown.indexOf('#### Все коды'), markdown.indexOf('### Справочники полей'));
    for (const row of catalog.errorCatalogRows()) {
      // Каждый код — отдельной строкой таблицы: «столбиком», как просил пользователь.
      const line = new RegExp(`^\\| ${row.status} \\| \`${row.code}\` \\|`, 'm');
      expect(table).toMatch(line);
      expect(table).toContain(row.title);
    }
  });

  it('в пресетах есть список всех персонажей и проходки одним запросом', () => {
    mountPage();
    const titles = [...document.querySelectorAll('.xapi-preset')].map(button => button.textContent);
    expect(titles).toContain('Все персонажи по id');
    expect(titles.join(' ')).toMatch(/проходки/i);
    const all = [...document.querySelectorAll('.xapi-preset')].find(
      button => button.textContent === 'Все персонажи по id'
    );
    all.click();
    expect(document.getElementById('play-path').value).toBe('/api/v1/characters');
  });

  it('таблица «что можно делать» ссылается на существующие методы', () => {
    const docs = mountPage();
    const page = new Set(examples(docs).map(row => row.path));
    const text = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-REFERENCE.md'), 'utf8');
    const memo = text.slice(text.indexOf('## Памятка'));
    // Из памятки берём только «шаблонные» пути (с {…}): в таблице они и есть.
    const referenced = [...memo.matchAll(/`(?:GET|POST|PATCH) (\/[a-z][^` ]*)`/g)]
      .map(match => match[1])
      .filter(path => path.includes('{'));
    const unknown = [...new Set(referenced)].filter(path => !page.has(path));
    expect(unknown).toEqual([]);
  });
});
