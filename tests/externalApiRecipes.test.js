// tests/externalApiRecipes.test.js
// Каталог примеров внешнего API: один источник правды для страницы и для
// документа. Проверяем, что:
//   1. каталог цел: у каждого рецепта есть сценарий, запрос, ответ и разбор;
//   2. каждый рецепт ведёт в существующий маршрут моста (иначе «рецепт» врёт);
//   3. документ docs/EXTERNAL-API-EXAMPLES.md собран из этого же каталога;
//   4. вкладка «Рецепты» на странице рисует те же рецепты.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { state } from '../js/core/state.js';
import { answer } from '../js/modules/externalApi/bridge.js';
import { renderExamplesMarkdown } from '../scripts/lib/api-examples.mjs';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api/web');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');

/** Каталог примеров так же, как его видит страница. */
function loadCatalog() {
  const scope = {};
  new Function('window', read('recipes.js'))(scope);
  return {
    groups: scope.TF_API_RECIPE_GROUPS || [],
    recipes: scope.TF_API_RECIPES || [],
    snippets: scope.TF_API_RECIPE_SNIPPETS || {}
  };
}

/** Состояние, на котором рецепты должны отвечать, а не 404. */
function seedState() {
  state.settings = { externalApi: { allowRead: true, allowModify: true, allowLaunchClose: true } };
  state.characters = [
    {
      id: 'Mag_1',
      nick: 'Маг',
      class: 'Маг',
      level: 100,
      partyIds: ['p-osnova'],
      stats: { hp: 35 },
      dungeonPasses: { weapon: 1 }
    }
  ];
  state.parties = [{ id: 'p-osnova', name: 'Основа', members: ['Mag_1'] }];
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
  state.plannerEntries = [
    {
      id: 'pe_1',
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
  return { persist: async () => {}, storageWritable: () => true };
}

describe('внешний API: каталог примеров', () => {
  beforeEach(() => {
    seedState();
  });

  it('у каждого рецепта есть сценарий, запрос, ответ и разбор', () => {
    const { groups, recipes } = loadCatalog();
    expect(recipes.length).toBeGreaterThanOrEqual(15);
    const ids = new Set();
    for (const recipe of recipes) {
      expect(recipe.id, 'у рецепта есть id').toBeTruthy();
      expect(ids.has(recipe.id), `id «${recipe.id}» уникален`).toBe(false);
      ids.add(recipe.id);
      expect(
        groups.some(group => group.id === recipe.group),
        `группа «${recipe.group}» есть`
      ).toBe(true);
      expect(recipe.title).toBeTruthy();
      expect(recipe.scenario.length).toBeGreaterThan(20);
      expect(['GET', 'POST', 'PATCH']).toContain(recipe.method);
      expect(recipe.path.startsWith('/api/v1/')).toBe(true);
      expect(recipe.template).toBeTruthy();
      expect(['read', 'modify', 'launchClose']).toContain(recipe.scope);
      expect(recipe.response).toBeTruthy();
      expect(recipe.explanation.length).toBeGreaterThan(40);
      expect(Array.isArray(recipe.errors)).toBe(true);
    }
  });

  it('каждый рецепт ведёт в существующий маршрут моста', async () => {
    const deps = seedState();
    const { recipes } = loadCatalog();
    const misses = [];
    for (const recipe of recipes) {
      // Журнал и задания живут в Rust, в мосте их нет: проверяем только форму.
      if (recipe.path.startsWith('/api/v1/jobs/') || recipe.path.startsWith('/api/v1/audit')) continue;
      const [path, query = ''] = recipe.path.split('?');
      const result = await answer({ method: recipe.method, path, query, body: recipe.body || null }, deps);
      if (result.status === 404 || result.status === 405) {
        misses.push(`${recipe.id}: ${recipe.method} ${recipe.path} → ${result.status}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('примеры собираются в запрос для curl, Python и PowerShell', () => {
    const { recipes, snippets } = loadCatalog();
    for (const recipe of recipes) {
      const curl = snippets.curl(recipe);
      expect(curl).toContain(recipe.method);
      expect(curl).toContain(recipe.path);
      if (recipe.body) expect(curl).toContain('Content-Type: application/json');
      const python = snippets.python(recipe);
      expect(python).toContain('urllib.request');
      const powershell = snippets.powershell(recipe);
      expect(powershell).toContain('Invoke-RestMethod');
      expect(powershell).toContain('$headers');
    }
  });
});

describe('внешний API: документ с примерами', () => {
  it('docs/EXTERNAL-API-EXAMPLES.md собран из каталога', () => {
    const catalog = loadCatalog();
    const markdown = renderExamplesMarkdown(catalog);
    const file = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-EXAMPLES.md'), 'utf8');
    expect(file).toBe(markdown);
  });

  it('в документе есть каждый рецепт каталога', () => {
    const catalog = loadCatalog();
    const file = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API-EXAMPLES.md'), 'utf8');
    for (const recipe of catalog.recipes) {
      expect(file, `рецепт «${recipe.id}» есть в документе`).toContain(`### ${recipe.title}`);
      expect(file).toContain(recipe.scenario);
    }
  });
});

describe('внешний API: вкладка «Рецепты» на странице', () => {
  it('страница подключает каталог и рисует рецепты', async () => {
    window.history.replaceState(null, '', `/${window.location.hash || ''}`);
    document.documentElement.innerHTML = read('index.html')
      .replace(/^[\s\S]*?<body>/, '<body>')
      .replace(/<\/body>[\s\S]*$/, '</body>');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () =>
        JSON.stringify({
          ok: true,
          app: { version: '3.0.0' },
          scopes: { read: true, modify: true, launchClose: true },
          storage: { writable: true }
        })
    });
    for (const file of ['errors.js', 'docs.js', 'actions.js', 'recipes.js', 'app.js']) {
      new Function(read(file))();
    }
    const nav = document.querySelector('[data-tab="recipes"]');
    expect(nav, 'в навигации есть вкладка «Рецепты»').toBeTruthy();
    nav.click();
    const body = document.getElementById('recipes-body');
    expect(body.innerHTML).toContain('Начало работы');
    const catalog = loadCatalog();
    for (const recipe of catalog.recipes) {
      expect(body.textContent, `рецепт «${recipe.id}» нарисован`).toContain(recipe.title);
    }
    // Поиск по рецептам работает: лишние рецепты прячутся.
    const filter = document.getElementById('recipes-filter');
    filter.value = 'планировщик';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    const visible = [...body.querySelectorAll('[data-recipe]')].filter(item => !item.hidden);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(catalog.recipes.length);
    // Пустой результат надо объяснить, а не показывать пустой экран.
    filter.value = 'такого-нет-в-каталоге';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(document.getElementById('recipes-count').textContent).toMatch(/ни один рецепт/);
  });

  it('рецепты читаются по одному: выбор слева открывает деталь справа', async () => {
    // Справа длинный список из 23 рецептов — то, на что жаловались: ищут один,
    // видят все. Ожидаемое поведение — как в справочнике: одна выбранная карточка.
    window.history.replaceState(null, '', '/recipes');
    document.documentElement.innerHTML = read('index.html')
      .replace(/^[\s\S]*?<body>/, '<body>')
      .replace(/<\/body>[\s\S]*$/, '</body>');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify({ ok: true })
    });
    for (const file of ['errors.js', 'docs.js', 'actions.js', 'recipes.js', 'app.js']) {
      new Function(read(file))();
    }
    const body = document.getElementById('recipes-body');
    const catalog = loadCatalog();
    expect(body.dataset.view).toBe('one');
    expect([...body.querySelectorAll('[data-recipe].is-selected')]).toHaveLength(1);
    expect(
      [...body.querySelectorAll('[data-recipe-group]')].filter(group => group.classList.contains('is-open'))
    ).toHaveLength(1);
    expect(document.querySelector('[data-refnav="recipes"]').hidden).toBe(false);
    expect(document.querySelector('[data-refnav="recipes"] [data-ref-pos]').textContent).toMatch(/1 из \d+/);
    expect(document.querySelectorAll('#recipes-body [data-recipe]').length).toBe(catalog.recipes.length);
    // Клик по ссылке рецепта в оглавлении открывает именно его.
    const cards = [...body.querySelectorAll('[data-recipe]')];
    const wanted = cards[3];
    const link = document.querySelector(`#recipes-toc a[href="#${wanted.id}"]`);
    expect(link, 'оглавление ссылается на карточку рецепта').toBeTruthy();
    link.click();
    expect([...body.querySelectorAll('[data-recipe].is-selected')].map(card => card.id)).toEqual([wanted.id]);
    expect(location.hash).toBe(`#${wanted.id}`);
    expect(link.classList.contains('is-on')).toBe(true);
    // Выбор под фильтром не теряется и не показывает то, что фильтр убрал.
    const filter = document.getElementById('recipes-filter');
    filter.value = wanted.textContent.slice(0, 18);
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect([...body.querySelectorAll('[data-recipe].is-selected')].map(card => card.id)).toEqual([wanted.id]);
    // «все списком» — тот же переключатель, что и в справочнике, и он возвратный.
    document.querySelector('[data-ref-mode="all"]').click();
    expect(body.dataset.view).toBe('all');
    expect(body.querySelectorAll('[data-recipe].is-selected')).toHaveLength(0);
    expect(document.querySelector('[data-refnav="recipes"]').hidden).toBe(true);
    document.querySelector('[data-ref-mode="one"]').click();
    expect(body.dataset.view).toBe('one');
    localStorage.removeItem('tf-api-ref-view');
    // Язык примера и панель выполнения живут в открытой карточке, а не в тексте справки.
    const selected = body.querySelector('[data-recipe].is-selected');
    expect(selected.querySelector('[data-run-go]')).toBeTruthy();
    expect(selected.querySelector('[data-recipe-snippet]')).toBeTruthy();
  });

  it('у рецептов своё оглавление разделов и ссылки на карточку', async () => {
    window.history.replaceState(null, '', '/recipes');
    document.documentElement.innerHTML = read('index.html')
      .replace(/^[\s\S]*?<body>/, '<body>')
      .replace(/<\/body>[\s\S]*$/, '</body>');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify({ ok: true })
    });
    for (const file of ['errors.js', 'docs.js', 'actions.js', 'recipes.js', 'app.js']) {
      new Function(read(file))();
    }
    const toc = document.getElementById('recipes-toc');
    expect(toc).toBeTruthy();
    const groups = [...toc.querySelectorAll('[data-recipes-toc-group]')];
    expect(groups.length).toBeGreaterThan(1);
    // Ссылка ведёт на раздел, а каждая карточка recipe — на свой якорь `#rp-…`:
    // на рецепт ссылаются из задач, и он должен открываться сразу на нём.
    for (const group of groups) {
      const id = group.dataset.recipesTocGroup;
      expect(document.getElementById(`rg-${id}`), `раздел ${id} имеет якорь`).toBeTruthy();
      expect(toc.querySelector(`a[href="#rg-${id}"]`)).toBeTruthy();
    }
    const first = document.querySelector('#recipes-body [data-recipe]');
    expect(first.id).toMatch(/^rp-/);
    expect(toc.querySelector(`a[href="#${first.id}"]`)).toBeTruthy();
    // Оглавление следует за фильтром: под фильтр не попало ничего — ссылок нет.
    const filter = document.getElementById('recipes-filter');
    filter.value = 'такого-нет-в-каталоге';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(groups.every(group => group.hidden)).toBe(true);
    filter.value = '';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(groups.some(group => !group.hidden)).toBe(true);
    // Кнопка «🔗 ссылка» даёт адрес страницы, а не текущего места.
    const linkButton = document.querySelector('#recipes-body [data-recipe-link]');
    let copied = '';
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => (copied = text) }
    });
    linkButton.click();
    await vi.waitFor(() => expect(copied).not.toBe(''));
    // Адрес берётся от страницы рецептов, а не от текущего пути: ссылку
    // копируют из любой точки, и она должна вести туда же.
    expect(copied).toContain(`/recipes#${linkButton.dataset.recipeLink}`);
  });

  it('подключение не сбрасывает подсветку карточки, открытой по ссылке', async () => {
    // Ссылку вида `/recipes#rp-health` вставляют в задачи и чаты. Ответ /health
    // перерисовывает карточки — в них подставляются живые id, — и если при этом
    // подсветка гаснет, человек теряет ровно то место, ради которого шёл.
    window.sessionStorage.setItem('tf-external-api-token', 'f'.repeat(64));
    window.history.replaceState(null, '', '/recipes#rp-health');
    document.documentElement.innerHTML = read('index.html')
      .replace(/^[\s\S]*?<body>/, '<body>')
      .replace(/<\/body>[\s\S]*$/, '</body>');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () =>
        JSON.stringify({
          ok: true,
          app: { version: '3.0.0' },
          scopes: { read: true, modify: true, launchClose: true },
          storage: { writable: true },
          characters: [],
          parties: [],
          windows: []
        })
    });
    for (const file of ['errors.js', 'docs.js', 'actions.js', 'recipes.js', 'app.js']) {
      new Function(read(file))();
    }
    expect(document.getElementById('rp-health').classList.contains('is-target')).toBe(true);
    await vi.waitFor(() => expect(document.getElementById('recipes-count').textContent).toMatch(/рецептов/));
    expect(document.getElementById('rp-health').classList.contains('is-target')).toBe(true);
    window.sessionStorage.removeItem('tf-external-api-token');
    window.history.replaceState(null, '', '/');
  });

  it('язык примера переключается: curl, Python и PowerShell', async () => {
    window.history.replaceState(null, '', `/${window.location.hash || ''}`);
    document.documentElement.innerHTML = read('index.html')
      .replace(/^[\s\S]*?<body>/, '<body>')
      .replace(/<\/body>[\s\S]*$/, '</body>');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify({ ok: true })
    });
    for (const file of ['errors.js', 'docs.js', 'actions.js', 'recipes.js', 'app.js']) {
      new Function(read(file))();
    }
    document.querySelector('[data-tab="recipes"]').click();
    const body = document.getElementById('recipes-body');
    const snippet = () => body.querySelector('[data-recipe-snippet]').textContent;
    expect(snippet()).toContain('curl -s');
    document.querySelector('[data-recipe-lang="python"]').click();
    expect(snippet()).toContain('urllib.request');
    document.querySelector('[data-recipe-lang="powershell"]').click();
    expect(snippet()).toContain('Invoke-RestMethod');
  });
});
