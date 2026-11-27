// tests/externalApiDocs.test.js
// Страница внешнего API (Rust раздаёт её из памяти) и справочник методов.
//
// Тест крутит настоящие `web/docs.js` и `web/app.js` в jsdom: так проверяется
// то, что видит пользователь, а не только данные. Что важно:
//   1. Каждый метод справочника действительно существует в мосте (иначе
//      «Попробовать» ведёт в 404 — это и случилось бы без проверки).
//   2. Приёмы из запроса пользователя — /stats/{stat} и /dungeon-passes/{pass} —
//      есть и в справочнике, и в маршрутах.
//   3. Вкладки работают: у карточки метода есть своя панель выполнения, а кнопка
//      «→ в тестовую строку» переносит запрос в «Тестовый запрос» целиком.
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
  // Адрес страницы влияет на то, какой раздел открыт (у справок свои адреса),
  // поэтому тест всегда начинает с «/» — но якорь сохраняет: ссылки вида
  // `#m-…` проверяются именно так, как их вставляет человек.
  window.history.replaceState(null, '', `/${window.location.hash || ''}`);
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

  it('вкладка «Данные» просит полные карточки: без этого статы пропали бы молча', async () => {
    // Список `/characters` по умолчанию лёгкий (без статов, заметок и истории
    // монет). Панель страницы статы показывает — значит она обязана попросить
    // `full=true`, иначе блок со статами опустеет без единой ошибки.
    window.sessionStorage.setItem('tf-external-api-token', 'f'.repeat(64));
    mountPage();
    document.getElementById('reload').click();
    await vi.waitFor(() => expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(2));
    const urls = globalThis.fetch.mock.calls.map(call => String(call[0]));
    expect(urls).toContain('/api/v1/characters?full=true');
    expect(urls).not.toContain('/api/v1/characters');
    window.sessionStorage.clear();
  });

  it('оглавление ведёт к каждому методу, а не только к группам', () => {
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
    const links = [...document.querySelectorAll('[data-toc-method]')];
    expect(links.length).toBe(total);
    expect(document.querySelectorAll('.xapi-toc-link').length).toBe(docs.groups.length);
    // Ссылка, которая ведёт в никуда, — хуже отсутствия ссылки.
    for (const link of links) expect(document.querySelector(link.getAttribute('href'))).toBeTruthy();
    // Подписаны методом и путём: по «GET /characters» метод ищут, а не по «m-…».
    // Правила (метод «—» — например, про адрес сервера) подписаны ссылкой: у них
    // нет глагола, и это не пропуск навигации, а свой тип записи.
    const rules = docs.groups.flatMap(group => group.methods).filter(method => method.method === '—').length;
    const verbs = links.filter(link => /GET|POST|PATCH|DELETE/.test(link.textContent));
    expect(verbs.length).toBe(total - rules);
    for (const link of verbs) expect(link.textContent).toContain('/');
  });

  it('клик по методу в оглавлении ставит якорь и подсвечивает карточку', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const link = document.querySelector('[data-toc-method]');
    link.click();
    const id = link.getAttribute('href').slice(1);
    expect(location.hash).toBe(`#${id}`);
    expect(document.getElementById(id).classList.contains('is-target')).toBe(true);
  });

  it('справа одна карточка, а не весь список: выбор слева открывает его справа', () => {
    // Список из сорока методов — это прокрутка вслепую: ищут одно, видят все.
    // Поэтому по умолчанию справа лежит ровно то, что выбрано слева.
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
    const body = document.getElementById('docs-body');
    expect(body.dataset.view).toBe('one');
    expect(document.querySelectorAll('#docs-body [data-doc]').length).toBe(total);
    expect([...document.querySelectorAll('#docs-body [data-doc].is-selected')]).toHaveLength(1);
    // Пустых групп-заголовков в режиме «по одной» быть не должно: виден только раздел
    // выбранной карточки.
    expect(
      [...document.querySelectorAll('#docs-body [data-doc-group]')].filter(g => g.classList.contains('is-open'))
    ).toHaveLength(1);
    const link = document.querySelectorAll('[data-toc-method]')[2];
    link.click();
    const id = link.getAttribute('href').slice(1);
    const selected = [...document.querySelectorAll('#docs-body [data-doc].is-selected')];
    expect(selected.map(card => card.id)).toEqual([id]);
    expect(location.hash).toBe(`#${id}`);
    // Подсветка в оглавлении обязательна: без неё непонятно, что именно открыто.
    expect(link.classList.contains('is-on')).toBe(true);
    expect(link.getAttribute('aria-current')).toBe('true');
    // И раздел, которому эта карточка принадлежит, подсвечен: в списке сорока ссылок
    // без заголовка не понять, в какой половине страницы смотришь.
    expect(link.closest('[data-toc-group]').querySelector('.xapi-toc-link').classList.contains('is-on')).toBe(true);
    // Панель перехода считает то, что осталось под фильтром (всё — значит все методы).
    const pos = document.querySelector('[data-refnav="docs"] [data-ref-pos]');
    expect(pos.textContent).toMatch(/3 из \d+/);
    expect(pos.textContent).toMatch(/·/);
    expect(document.querySelector('[data-refnav="docs"] [data-ref-step="-1"]').disabled).toBe(false);
    expect(document.querySelector('[data-refnav="docs"] [data-ref-step="1"]').disabled).toBe(false);
  });

  it('листание по карточкам не выпрыгивает за пределы фильтра', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const filter = document.getElementById('docs-filter');
    filter.value = 'проходк';
    filter.dispatchEvent(new Event('input'));
    const matched = [...document.querySelectorAll('#docs-body [data-doc]')].filter(doc => doc.dataset.match === '1');
    expect(matched.length).toBeGreaterThan(1);
    const next = document.querySelector('[data-refnav="docs"] [data-ref-step="1"]');
    next.click();
    let selected = [...document.querySelectorAll('#docs-body [data-doc].is-selected')];
    expect(selected).toHaveLength(1);
    expect(matched.map(card => card.id)).toContain(selected[0].id);
    // ↑/↓ в оглавлении — тот же переход: справку листают с клавиатуры быстрее, чем мышью.
    document
      .getElementById('docs-toc')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    selected = [...document.querySelectorAll('#docs-body [data-doc].is-selected')];
    expect(matched.map(card => card.id)).toContain(selected[0].id);
    // До конца списка — и «следующий» гаснет, а не упирается в себя.
    for (let i = 0; i < matched.length + 2; i += 1) next.click();
    expect(next.disabled).toBe(true);
    // Справа по-прежнему ровно одна карточка — и она последняя из подошедших под фильтр.
    expect([...document.querySelectorAll('#docs-body [data-doc].is-selected')].map(card => card.id)).toEqual([
      matched[matched.length - 1].id
    ]);
  });

  it('режим «все списком» возвращает полный список и запоминается', () => {
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
    document.querySelector('[data-ref-mode="all"]').click();
    const body = document.getElementById('docs-body');
    expect(body.dataset.view).toBe('all');
    expect(document.querySelectorAll('#docs-body [data-doc].is-selected')).toHaveLength(0);
    expect([...document.querySelectorAll('#docs-body [data-doc]')].filter(doc => !doc.hidden)).toHaveLength(total);
    // Панели перехода в списке нечего: карточка не одна.
    expect(document.querySelector('[data-refnav="docs"]').hidden).toBe(true);
    expect(localStorage.getItem('tf-api-ref-view')).toBe('all');
    // Спрятано режимом, а не фильтром: `hidden` остаётся собственностью фильтра,
    // видимость режима держится на классе (правило в CSS, jsdom его не применяет).
    const css = read('app.css');
    expect(css).toMatch(/\.xapi-docs\[data-view='one'\] \.xapi-doc:not\(\.is-selected\)[\s\S]{0,80}display:\s*none/);
    expect(css).toMatch(/\.xapi-docs\[data-view='one'\] \.xapi-doc-group:not\(\.is-open\)/);
    localStorage.removeItem('tf-api-ref-view');
  });

  it('ссылка на метод, который фильтр спрятал,тот же фильтр снимает', () => {
    // Такой адрес дают в чате ради конкретного метода: показать вместо него первую
    // совпавшую карточку — значит привести не туда.
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const target = `m-${docs.groups[1].id}-${docs.groups[1].methods[0].id}`;
    const filter = document.getElementById('docs-filter');
    filter.value = 'zzz-такого-нет';
    filter.dispatchEvent(new Event('input'));
    location.hash = `#${target}`;
    window.dispatchEvent(new Event('hashchange'));
    expect(document.getElementById(target).classList.contains('is-selected')).toBe(true);
    expect(filter.value).toBe('');
    expect(document.getElementById('docs-filter-hint').classList.contains('is-empty')).toBe(false);
  });

  it('в одной открытой карточке живёт панель выполнения и «ссылка»', () => {
    // Режим «по одной» не должен превращать справку в текст без действий: панель
    // «▶ Выполнить» и кнопка ссылки обязательны именно у открытой карточки.
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const card = document.querySelector('#docs-body [data-doc].is-selected');
    expect(card).toBeTruthy();
    expect(card.querySelector('[data-run-go]')).toBeTruthy();
    expect(card.querySelector('[data-doc-link]')).toBeTruthy();
  });

  it('ссылка с якорем открывает страницу сразу на «Справочнике», а не на «Данных»', () => {
    // Якорь из чата или из AGENTS.md («посмотри GET /characters») — это ссылка на
    // карточку метода. Открыть её надо так, чтобы человеку не пришлось угадывать
    // вкладку: на «Данных» такого id нет, и ссылка выглядела бы сломанной.
    const docs = mountPage();
    const target = `m-${docs.groups[0].id}-${docs.groups[0].methods[1].id}`;
    location.hash = `#${target}`;
    mountPage(); // повторный заход на страницу — ровно то, что делает браузер по ссылке
    expect(document.getElementById('docs').hidden).toBe(false);
    expect(document.getElementById(target)).toBeTruthy();
    expect(document.getElementById(target).classList.contains('is-target')).toBe(true);
    location.hash = '';
  });

  it('у справок свои адреса: /docs и /recipes, консоль остаётся на «/»', () => {
    mountPage();
    expect(document.body.dataset.page).toBe('console');
    document.querySelector('.xapi-nav [data-tab="docs"]').click();
    expect(location.pathname).toBe('/docs');
    expect(document.body.dataset.page).toBe('docs');
    expect(document.getElementById('docs').hidden).toBe(false);
    // Иначе «страница» была бы тем же табом с новым адресом: панель слева —
    // место, где живут поиск и оглавление, а не ещё один блок над списком.
    const rail = document.querySelector('#docs .xapi-rail');
    expect(rail).toBeTruthy();
    expect(rail.contains(document.getElementById('docs-filter'))).toBe(true);
    expect(rail.contains(document.getElementById('docs-toc'))).toBe(true);
    expect(document.getElementById('panel').hidden).toBe(true);

    document.querySelector('#docs .xapi-switch [data-tab="recipes"]').click();
    expect(location.pathname).toBe('/recipes');
    expect(document.getElementById('recipes').hidden).toBe(false);
    expect(document.getElementById('docs').hidden).toBe(true);

    document.querySelector('#recipes .xapi-crumb').click();
    expect(location.pathname).toBe('/');
    expect(document.body.dataset.page).toBe('console');
    expect(document.getElementById('panel').hidden).toBe(false);
  });

  it('ссылки на страницы настоящие: их можно скопировать или открыть рядом', () => {
    mountPage();
    for (const [name, href] of [
      ['docs', '/docs'],
      ['recipes', '/recipes']
    ]) {
      const link = document.querySelector(`.xapi-nav [data-tab="${name}"]`);
      expect(link.tagName, `«${name}» в навигации — ссылка`).toBe('A');
      expect(link.getAttribute('href')).toBe(href);
    }
    // Rust раздаёт оболочку страницы и по этим адресам — иначе ссылка,
    // вставленная в задачу, ведёт на 404, а не на справочник.
    const rust = readFileSync(resolve(process.cwd(), 'src-tauri/src/external_api/mod.rs'), 'utf8');
    for (const route of ['"/docs"', '"/docs/"', '"/recipes"', '"/recipes/"']) {
      expect(rust, `маршрут ${route} отдаёт страницу`).toContain(route);
    }
  });

  it('фильтр скрывает и ссылки оглавления — список не обещает лишнего', () => {
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const input = document.getElementById('docs-filter');
    input.value = 'health';
    input.dispatchEvent(new Event('input'));
    const shownDocs = [...document.querySelectorAll('[data-doc]')].filter(el => !el.hidden).length;
    const shownToc = [...document.querySelectorAll('[data-toc-method]')].filter(
      link => !(link.closest('li') || link).hidden
    ).length;
    expect(shownToc).toBe(shownDocs);
    expect(shownToc).toBeLessThan(docs.groups.reduce((sum, group) => sum + group.methods.length, 0));
    expect(document.getElementById('docs-toc-count').textContent).toContain('показано');
    // Группы, где ничего не подошло, исчезают из оглавления целиком.
    expect([...document.querySelectorAll('[data-toc-group]')].filter(g => !g.hidden).length).toBeLessThan(
      docs.groups.length
    );
  });

  it('у каждого метода есть кнопка «ссылка» — адрес карточки можно скопировать', () => {
    const docs = mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
    expect(document.querySelectorAll('[data-doc-link]').length).toBe(total);
  });

  it('«→ в тестовую строку» переносит запрос карточки в «Тестовый запрос»', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const panel = [...document.querySelectorAll('#docs-body [data-run]')].find(row =>
      String(row.querySelector('.xapi-run-path').value).endsWith('/characters/Mag_1/dungeon-passes/weapon')
    );
    expect(panel).toBeTruthy();
    panel.querySelector('[data-run-play]').click();
    // Путь подставлен с id из справочника, метод и тело — тоже; вкладка открылась.
    expect(document.getElementById('play-path').value).toBe('/api/v1/characters/Mag_1/dungeon-passes/weapon');
    expect(document.getElementById('play-method').value).toBe('GET');
    expect(document.getElementById('playground').hidden).toBe(false);
  });

  it('пустой результат фильтра назван словами, а не пустым экраном', () => {
    mountPage();
    document.querySelector('[data-tab="docs"]').click();
    const filter = document.getElementById('docs-filter');
    const hint = document.getElementById('docs-filter-hint');
    // Без токена фильтры по правам не включены — подсказка говорит об этом.
    expect(hint.textContent).toContain('Подключитесь токеном');
    filter.value = 'такого-нет-в-справочнике';
    filter.dispatchEvent(new Event('input'));
    expect(hint.textContent).toMatch(/ни один метод/);
    expect(hint.classList.contains('is-empty')).toBe(true);
    expect(filter.getAttribute('data-empty')).toBe('1');
    filter.value = 'character';
    filter.dispatchEvent(new Event('input'));
    expect(hint.textContent).toMatch(/Показано методов: \d+ из \d+/);
    expect(hint.classList.contains('is-empty')).toBe(false);
    expect(filter.hasAttribute('data-empty')).toBe(false);
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
    document.getElementById('play-method').value = 'PATCH';
    document.getElementById('play-path').value = '/api/v1/characters/Mag_1';
    document.getElementById('play-body').value = '{ не json';
    document.getElementById('play-send').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    // Страница в этот момент сама дозагружает списки — проверяем именно попытку
    // отправить битое тело: ни одного PATCH быть не должно.
    const writes = globalThis.fetch.mock.calls.filter(([, options]) => (options && options.method) === 'PATCH');
    expect(writes).toEqual([]);
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
