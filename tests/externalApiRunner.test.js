// tests/externalApiRunner.test.js
// Панели живого запроса во вкладках «Справочник API» и «Рецепты».
//
// Зачем. Раньше обе вкладки были только чтением: «Попробовать» подставляло запрос
// в другую вкладку, а в качестве ответа показывался нарисованный пример из
// документации. Справочник выглядел сломанным у каждого, у кого право на метод
// выключено (ответ 403 без объяснения) или у кого в данных другие id. Теперь
// карточка метода и карточка рецепта выполняют запрос сами — что и проверяют тесты:
//   1. строка запроса в карточке содержит реальные id, а не «Mag_1» из документа;
//   2. «▶ Выполнить» отправляет запрос и печатает ответ в этой же карточке;
//   3. изменяющий метод не уходит с одного нажатия, а правка запроса сбрасывает
//      подтверждение;
//   4. страница предупреждает до запроса, если токена нет или право выключено;
//   5. форма живого ответа сверяется с примером из документации;
//   6. фильтры «только чтение» и «только доступные» не врут.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { state } from '../js/core/state.js';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api/web');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');

const TOKEN = 'f'.repeat(64);
const NEEDLE_GET = '/api/v1/characters/Luchnik_7/dungeon-passes/weapon';
const NEEDLE_PATCH = 'PATCH /api/v1/characters/Luchnik_7/stats/hp';

/** Ответы «приложения»: достаточно, чтобы страница жила без Rust. */
function fakeApi({ scopes = { read: true, modify: true, launchClose: true } } = {}) {
  const characters = [
    {
      id: 'Luchnik_7',
      nick: 'Лучник',
      class: 'Лучник',
      level: 99,
      'dungeonPasses.weapon': 2,
      stats: { hp: 150 }
    }
  ];
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    text: async () => JSON.stringify(body)
  });
  return async (path, fetchOptions = {}) => {
    const url = String(path).split('?')[0];
    const method = (fetchOptions.method || 'GET').toUpperCase();
    if (url === '/api/v1/health')
      return json({
        ok: true,
        app: { version: '3.0.0', build: 'stable' },
        api: { version: 1, uptimeSec: 10 },
        storage: { writable: true },
        scopes,
        launch: { busy: false }
      });
    if (url === '/api/v1/characters') return json({ characters, count: 1, fields: null, detail: 'list' });
    if (url === '/api/v1/parties') return json({ parties: [{ id: 'p-grom', name: 'Гром', count: 1 }], count: 1 });
    if (url === '/api/v1/windows') return json({ windows: [], count: 0 });
    if (url === '/api/v1/audit') return json({ entries: [], count: 0 });
    if (url === '/api/v1/marathons') return json({ marathons: [], count: 0 });
    if (url === '/api/v1/planner') return json({ entries: [], count: 0 });
    if (url === '/api/v1/finance') return json({ balances: {}, operations: [], count: 0 });
    if (url === '/api/v1/status')
      return json({
        ok: true,
        app: { version: '3.0.0' },
        api: { version: 1 },
        storage: { writable: true },
        scopes,
        launch: { busy: false },
        counts: { characters: 1, parties: 1, marathons: 0, plannerEntries: 0, windows: 0, financeOperations: 0 },
        today: { date: '2026-11-26', total: 0, done: 0 },
        finance: { balances: {} }
      });
    if (url.endsWith('/stats/hp'))
      return json({ id: 'Luchnik_7', nick: 'Лучник', stat: 'hp', value: 151, changed: true });
    if (url.endsWith('/dungeon-passes/weapon'))
      return json({ id: 'Luchnik_7', nick: 'Лучник', pass: 'weapon', value: 2, total: 2, changed: false });
    if (url === '/api/v1/characters/Luchnik_7') return json({ characters: characters, count: 1, detail: 'full' });
    // Запуск — задание: настоящий id появляется только в ответе, и страница
    // обязана подставить его в карточку `/jobs/{jobId}`, а не оставлять `job_1`.
    if (url === '/api/v1/launch/party' && method === 'POST')
      return json({ ok: true, jobId: 'job_42', state: 'queued' }, 202);
    if (url.startsWith('/api/v1/jobs/')) return json({ job: { id: url.split('/').pop(), state: 'queued' } });
    return json({ ok: true });
  };
}

/**
 * Страница как в браузере: разметка + данные + app.js. Токен кладётся в
 * sessionStorage до исполнения скрипта: с ним страница считает себя
 * подключённой, сама загружает списки и подставляет их id в карточки.
 */
function mountPage(options = {}) {
  const html = read('index.html');
  const body = html.replace(/^[\s\S]*?<body>/, '<body>').replace(/<\/body>[\s\S]*$/, '</body>');
  // Адрес страницы влияет на то, какой раздел открыт (у справок свои адреса),
  // поэтому тест всегда начинает с «/» — но якорь сохраняет: ссылки вида
  // `#m-…` проверяются именно так, как их вставляет человек.
  window.history.replaceState(null, '', `/${window.location.hash || ''}`);
  document.documentElement.innerHTML = body;
  const calls = [];
  const impl = fakeApi(options);
  globalThis.fetch = vi.fn(async (path, fetchOptions = {}) => {
    calls.push({
      path: String(path).split('?')[0],
      query: String(path),
      method: (fetchOptions.method || 'GET').toUpperCase(),
      body: fetchOptions.body
    });
    return impl(path, fetchOptions);
  });
  globalThis.navigator.clipboard = { writeText: vi.fn(async () => {}) };
  new Function(read('errors.js'))();
  new Function(read('docs.js'))();
  new Function(read('actions.js'))();
  new Function(read('recipes.js'))();
  new Function(read('app.js'))();
  return { calls };
}

// Открытая вкладка определяет, где искать панели: карточка «GET /api/v1/health»
// есть и в справочнике, и в рецептах, а искать надо в том, что человек видит.
let referenceBody = () => document.getElementById('docs-body');
const openTab = name => {
  document.querySelector(`[data-tab="${name}"]`).click();
  referenceBody = () => document.getElementById(name === 'recipes' ? 'recipes-body' : 'docs-body');
};
/**
 * Дать странице закончить первую загрузку. Пока она идёт, вкладки перерисовываются
 * (в строки запросов подставляются id из списков), и клик по «до перезагрузки»
 * попадает в узел, который сейчас заменят.
 */
const settle = async () => {
  await vi.waitFor(() => expect(document.getElementById('reload-audit').hidden).toBe(false));
  await wait();
};
const wait = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise(done => setTimeout(done, 0));
};

/**
 * Панель по кусочку строки запроса. Искать приходится каждый раз заново: после
 * загрузки списков вкладки перерисовываются (в строки подставляются реальные id),
 * и сохранённая ссылка осталась бы на выброшенный узел.
 */
const panelWith = needle =>
  [...referenceBody().querySelectorAll('[data-run]')].find(row =>
    String(row.querySelector('.xapi-run-path').value).includes(needle)
  );
const statusOf = panel => panel.querySelector('[data-run-status]').textContent;
const outOf = panel => panel.querySelector('[data-run-out]').textContent;
const goButton = needle => panelWith(needle).querySelector('[data-run-go]');
const pathField = needle => panelWith(needle).querySelector('.xapi-run-path');

/** Нажатие «Выполнить» и, если метод изменяющий, второе — подтверждение. */
async function run(needle, { confirm = true } = {}) {
  await vi.waitFor(() => expect(panelWith(needle)).toBeTruthy());
  goButton(needle).click();
  await wait();
  if (confirm && panelWith(needle).dataset.armed === '1') {
    goButton(needle).click();
    await wait();
  }
  return panelWith(needle);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
  state.settings = { externalApi: { enabled: true, allowRead: true, allowModify: true, allowLaunchClose: true } };
  state.characters = [];
  state.parties = [];
  state.archivedCharacters = [];
});

describe('справочник: панель запроса в карточке метода', () => {
  it('панель есть у каждого выполняемого метода и нет у правил', () => {
    mountPage();
    openTab('docs');
    const docs = window.TF_API_DOCS;
    const runnable = docs.groups
      .flatMap(group => group.methods)
      .filter(method => method.method !== '—' && String(method.path).startsWith('/')).length;
    expect(document.querySelectorAll('[data-doc] [data-run]').length).toBe(runnable);
    // Правила («—») и внешние адреса выполнить нельзя: карточка без панели — не дырка, а смысл.
    const rules = [...document.querySelectorAll('[data-doc]')].filter(
      doc => doc.querySelector('.xapi-doc-method')?.textContent === 'правило'
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every(doc => !doc.querySelector('[data-run]'))).toBe(true);
  });

  it('после загрузки в строку запроса подставлены реальные id, а не «Mag_1»', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage();
    openTab('docs');
    await vi.waitFor(() => expect(panelWith(NEEDLE_GET)).toBeTruthy());
    expect(pathField(NEEDLE_GET).value).toBe(`GET ${NEEDLE_GET}`);
  });

  it('«▶ Выполнить» отправляет запрос и печатает ответ в этой же карточке', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    const { calls } = mountPage();
    openTab('docs');
    await settle();
    calls.length = 0;
    const panel = await run(NEEDLE_GET, { confirm: false });
    expect(calls.filter(call => call.method === 'GET').map(call => call.path)).toContain(
      '/api/v1/characters/Luchnik_7/dungeon-passes/weapon'
    );
    expect(outOf(panel)).toContain('"pass": "weapon"');
    expect(panel.querySelector('[data-run-chips]').textContent).toContain('GET 200');
    expect(statusOf(panel)).toContain('Ответ получен');
    expect(panel.querySelector('[data-run-result]').hidden).toBe(false);
    expect(panel.querySelector('[data-run-copy]').hidden).toBe(false);
  });

  it('изменяющий метод требует второго нажатия и не уходит с одного', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    const { calls } = mountPage();
    openTab('docs');
    await settle();
    await vi.waitFor(() => expect(panelWith(NEEDLE_PATCH)).toBeTruthy());
    panelWith(NEEDLE_PATCH).querySelector('.xapi-run-body').value = '{"mode":"inc","by":1}';
    calls.length = 0;
    goButton(NEEDLE_PATCH).click();
    await wait();
    expect(calls).toEqual([]);
    expect(goButton(NEEDLE_PATCH).textContent).toContain('Подтвердить');
    const panel = await run(NEEDLE_PATCH);
    const writes = calls.filter(call => call.method === 'PATCH');
    expect(writes.map(call => call.path)).toEqual(['/api/v1/characters/Luchnik_7/stats/hp']);
    expect(JSON.parse(writes[0].body)).toEqual({ mode: 'inc', by: 1 });
    expect(statusOf(panel)).toContain('Ответ получен');
    // Кнопка возвращается в исходное состояние, иначе «Подтвердить» осталось бы висеть
    expect(goButton(NEEDLE_PATCH).textContent).toContain('Выполнить');
  });

  it('правка строки запроса снимает подтверждение', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage();
    openTab('docs');
    await settle();
    await vi.waitFor(() => expect(panelWith(NEEDLE_PATCH)).toBeTruthy());
    goButton(NEEDLE_PATCH).click();
    await wait();
    expect(panelWith(NEEDLE_PATCH).dataset.armed).toBe('1');
    const field = pathField(NEEDLE_PATCH);
    field.value = `${field.value}?x=1`;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panelWith(NEEDLE_PATCH).dataset.armed).toBeUndefined();
    expect(goButton(NEEDLE_PATCH).textContent).toContain('Выполнить');
  });

  it('без токена запрос не уходит — вместо 401 видно, что нужно подключиться', async () => {
    const { calls } = mountPage();
    openTab('docs');
    await vi.waitFor(() => expect(document.querySelector('[data-doc] [data-run]')).toBeTruthy());
    calls.length = 0;
    const panel = document.querySelector('[data-doc] [data-run]');
    panel.querySelector('[data-run-go]').click();
    await wait();
    expect(calls).toEqual([]);
    expect(statusOf(panel)).toContain('Нет токена');
  });

  it('выключенное право видно до подтверждения: подсказка вместо 403', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    const { calls } = mountPage({ scopes: { read: true, modify: false, launchClose: false } });
    openTab('docs');
    await settle();
    await vi.waitFor(() => expect(panelWith(NEEDLE_PATCH)).toBeTruthy());
    calls.length = 0;
    goButton(NEEDLE_PATCH).click();
    await wait();
    expect(calls).toEqual([]);
    // Важно: сообщение приходит с первого нажатия, а не после второго
    expect(statusOf(panelWith(NEEDLE_PATCH))).toContain('Право «изменение статов и проходок» выключено');
    expect(panelWith(NEEDLE_PATCH).dataset.armed).toBeUndefined();
  });

  it('чипы параметров дописывают query, и получившийся запрос выполняется', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    const { calls } = mountPage();
    openTab('docs');
    await settle();
    await vi.waitFor(() => expect(panelWith('GET /api/v1/characters')).toBeTruthy());
    const chip = [...panelWith('GET /api/v1/characters').querySelectorAll('[data-run-param]')].find(
      button => button.dataset.runParam === 'full'
    );
    expect(chip).toBeTruthy();
    chip.click();
    // Чип вставляет параметр со значением, а не «full=»: запрос из карточки
    // должен быть рабочим сразу, без ручного редактирования строки.
    expect(pathField('GET /api/v1/characters').value).toBe('GET /api/v1/characters?full=true');
    // Повторное нажатие не дублирует параметр.
    chip.click();
    expect(pathField('GET /api/v1/characters').value).toBe('GET /api/v1/characters?full=true');
    // «party» получает название первой пати из живых списков, присоединяется через &.
    const partyChip = [...panelWith('GET /api/v1/characters').querySelectorAll('[data-run-param]')].find(
      button => button.dataset.runParam === 'party'
    );
    partyChip.click();
    expect(pathField('GET /api/v1/characters').value).toBe('GET /api/v1/characters?full=true&party=Гром');
    calls.length = 0;
    await run('GET /api/v1/characters?full=true&party=Гром', { confirm: false });
    expect(statusOf(panelWith('GET /api/v1/characters?full=true'))).toContain('✅');
    const requested = calls.map(call => call.query).filter(query => query.includes('full=true'));
    expect(requested).toEqual(['/api/v1/characters?full=true&party=Гром']);
  });

  it('рецепт получает параметры того же метода из справочника', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage();
    openTab('recipes');
    await settle();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-recipe-id="characters"] [data-run-param]')).toBeTruthy()
    );
    const recipePanel = document.querySelector('[data-recipe-id="characters"] [data-run]');
    const names = [...recipePanel.querySelectorAll('[data-run-param]')].map(chip => chip.dataset.runParam);
    // Тот же GET /characters, что и в справочнике: значит, те же query-параметры.
    expect(names).toEqual(expect.arrayContaining(['party', 'full', 'fields']));
    [...recipePanel.querySelectorAll('[data-run-param]')].find(chip => chip.dataset.runParam === 'full').click();
    expect(recipePanel.querySelector('.xapi-run-path').value).toBe('GET /api/v1/characters?full=true');
    // Рецепт выгрузки получает параметр формата — «csv» вместо пустого `format=`.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-recipe-id="export-csv"] [data-run-param]')).toBeTruthy()
    );
    const exportPanel = document.querySelector('[data-recipe-id="export-csv"] [data-run]');
    const formatChip = [...exportPanel.querySelectorAll('[data-run-param]')].find(
      chip => chip.dataset.runParam === 'format'
    );
    expect(formatChip).toBeTruthy();
    formatChip.click();
    expect(exportPanel.querySelector('.xapi-run-path').value).toMatch(/format=csv$/);
  });

  it('id задания из запуска подставляется в карточку /jobs/{jobId}', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage();
    openTab('docs');
    await settle();
    await vi.waitFor(() => expect(panelWith('/api/v1/jobs/job_1')).toBeTruthy());
    // Пока заданий не было, страница не отправляет заведомый 404, а объясняет почему.
    goButton('/api/v1/jobs/job_1').click();
    await wait();
    expect(statusOf(panelWith('/api/v1/jobs/job_1'))).toContain('Задания ещё не запускались');
    // Выполняем запуск пати (изменяющий метод — два нажатия) и ждём подстановки.
    await run('/api/v1/launch/party');
    await vi.waitFor(() =>
      expect(panelWith('/api/v1/jobs/').querySelector('.xapi-run-path').value).toBe('GET /api/v1/jobs/job_42')
    );
    const jobs = panelWith('/api/v1/jobs/job_42');
    goButton('/api/v1/jobs/job_42').click();
    await wait();
    expect(statusOf(jobs)).toContain('✅');
    expect(outOf(jobs)).toContain('job_42');
  });

  it('фильтры: «только чтение» и «только доступные по правам»', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage({ scopes: { read: true, modify: false, launchClose: false } });
    openTab('docs');
    await vi.waitFor(() => expect(document.getElementById('docs-only-available').disabled).toBe(false));
    const visible = () => [...document.querySelectorAll('[data-doc]')].filter(doc => !doc.hidden);
    const total = visible().length;
    const onlyRead = document.getElementById('docs-only-read');
    onlyRead.checked = true;
    onlyRead.dispatchEvent(new Event('change'));
    expect(visible().length).toBeLessThan(total);
    expect(visible().every(doc => doc.dataset.docRead === '1')).toBe(true);
    onlyRead.checked = false;
    onlyRead.dispatchEvent(new Event('change'));

    const onlyAvailable = document.getElementById('docs-only-available');
    onlyAvailable.checked = true;
    onlyAvailable.dispatchEvent(new Event('change'));
    const left = visible();
    expect(left.length).toBeGreaterThan(0);
    expect(left.every(doc => !doc.classList.contains('is-blocked'))).toBe(true);
    expect(document.getElementById('docs-toc-count').textContent).toContain('показано');
    // Оглавление не оставляет ссылок на скрытые методы
    const tocLinks = [...document.querySelectorAll('[data-toc-method]')].filter(link => !link.closest('li').hidden);
    expect(tocLinks.length).toBe(left.length);
  });

  it('фильтр по правам недоступен без подключения и включается после', async () => {
    mountPage();
    openTab('docs');
    expect(document.getElementById('docs-only-available').disabled).toBe(true);
    expect(document.getElementById('docs-filter-hint').textContent).toContain('Подключитесь токеном');
    document.getElementById('token').value = TOKEN;
    document.getElementById('connect').click();
    await vi.waitFor(() => expect(document.getElementById('docs-only-available').disabled).toBe(false));
    expect(document.getElementById('docs-filter-hint').textContent).toContain('по правам');
  });
});

describe('рецепты: выполнение и сверка с документом', () => {
  it('у каждого рецепта есть панель выполнения', () => {
    mountPage();
    openTab('recipes');
    const recipes = window.TF_API_RECIPES;
    expect(document.querySelectorAll('[data-recipe] [data-run]').length).toBe(recipes.length);
  });

  it('рецепт выполняется по шаблону с id этого запуска, а не по примеру «Mag_1»', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    const { calls } = mountPage();
    openTab('recipes');
    // Первый экран мог быть нарисован без данных — ждём перерисовки с реальными id.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-recipe-id="character-card"] .xapi-run-path').value).toBe(
        'GET /api/v1/characters/Luchnik_7'
      )
    );
    calls.length = 0;
    const panel = await run('GET /api/v1/characters/Luchnik_7', { confirm: false });
    expect(calls.some(call => call.path === '/api/v1/characters/Luchnik_7')).toBe(true);
    expect(outOf(panel)).toContain('Luchnik_7');
  });

  it('форма живого ответа сверяется с примером: совпадение подтверждается, расхождение называется', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage();
    openTab('recipes');
    await settle();
    await vi.waitFor(() => expect(panelWith('GET /api/v1/health')).toBeTruthy());
    // Документ обещает ровно те поля, что приносит /health — расхождения нет.
    const same = await run('GET /api/v1/health', { confirm: false });
    expect(same.querySelector('[data-run-compare]').textContent).toContain('совпала');
    // В рецепте окон описан только `windows`, а ответ приносит и `count`.
    await vi.waitFor(() => expect(panelWith('GET /api/v1/windows')).toBeTruthy());
    const other = await run('GET /api/v1/windows', { confirm: false });
    const compare = other.querySelector('[data-run-compare]');
    expect(compare.hidden).toBe(false);
    expect(compare.textContent).toContain('отличается');
    expect(compare.textContent).toContain('добавилось: count');
  });

  it('фильтр «только доступные моим правам» скрывает рецепты чужих прав', async () => {
    window.sessionStorage.setItem('tf-external-api-token', TOKEN);
    mountPage({ scopes: { read: true, modify: false, launchClose: false } });
    openTab('recipes');
    await vi.waitFor(() => expect(document.getElementById('recipes-only-available').disabled).toBe(false));
    const toggle = document.getElementById('recipes-only-available');
    const visibleBefore = [...document.querySelectorAll('[data-recipe]')].filter(row => !row.hidden).length;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const visible = [...document.querySelectorAll('[data-recipe]')].filter(row => !row.hidden);
    expect(visible.length).toBeLessThan(visibleBefore);
    expect(visible.every(row => !row.classList.contains('is-blocked'))).toBe(true);
    expect(document.getElementById('recipes-count').textContent).toContain('показано');
  });

  it('язык примера меняется, панель выполнения остаётся на месте', async () => {
    mountPage();
    openTab('recipes');
    const first = document.querySelector('[data-recipe]');
    const id = first.dataset.recipeId;
    expect(first.querySelector('[data-run]')).toBeTruthy();
    document.querySelector('[data-recipe-lang="python"]').click();
    expect(document.querySelector(`[data-recipe-id="${id}"] [data-recipe-snippet]`).textContent).toContain('urllib');
    expect(document.querySelector(`[data-recipe-id="${id}"] [data-run]`)).toBeTruthy();
  });
});
