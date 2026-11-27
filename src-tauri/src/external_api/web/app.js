// Страница внешнего API. Обычный скрипт без сборки: читает токен из sessionStorage,
// ходит на /api/v1 этого же адреса и ничего не хранит у себя. Токен в разметку не
// вшит — страница по адресу 127.0.0.1 ничем не отличается от любой другой вкладки.
(() => {
  'use strict';

  const STAT_LABELS = {
    endurance: 'Выносливость',
    intelligence: 'Интеллект',
    strength: 'Сила',
    agility: 'Ловкость',
    hp: 'HP',
    mp: 'MP',
    levelBonus: 'Бонус уровня',
    physAttack: 'Физ. атака',
    physDefense: 'Физ. защита',
    magAttack: 'Маг. атака',
    magDefense: 'Маг. защита',
    critChance: 'Крит, %',
    critDamage: 'Крит. урон',
    atkSpeed: 'Скорость атаки',
    evasion: 'Уклонение',
    accuracy: 'Меткость',
    pa: 'PA',
    pz: 'PZ',
    morale: 'Дух',
    pvePa: 'PvE PA',
    pvePz: 'PvE PZ',
    physPenetration: 'Физ. пробивание',
    magPenetration: 'Маг. пробивание'
  };
  const STAT_ORDER = ['physAttack', 'magAttack', 'hp', 'mp', 'physDefense', 'magDefense', 'critChance'];
  const PASS_LABELS = { weapon: 'Оружие', armor: 'Доспех', relic: 'Реликвия' };

  const $ = selector => document.querySelector(selector);
  const tokenInput = $('#token');
  const storageKey = 'tf-external-api-token';
  let token = '';
  let recipe = 'curl';
  let latest = { characters: [], parties: [], windows: [] };
  let activeTab = 'panel';
  // Права текущего токена (из /health) и подпись списков. Нужны вкладкам
  // «Справочник» и «Рецепты»: карточки показывают живые id и подсвечивают методы,
  // под которые право выключено, — а без этого они выглядят как сломанные.
  let grantedScopes = null;
  /** Пример ответа из документации по id панели: `[data-run]` сверяет с ним живой ответ. */
  const runExamples = new Map();
  /** Id задания из последнего ответа: нужен, чтобы карточка /jobs/{jobId} была рабочей. */
  let seenJobId = '';
  const docs = window.TF_API_DOCS || { groups: [], fieldLists: { stats: [], passes: [] } };
  // Действия описаны данными (web/actions.js): разметка и запрос строятся по ним,
  // поэтому кнопка не может разойтись с контрактом.
  const actions = Array.isArray(window.TF_API_ACTIONS) ? window.TF_API_ACTIONS : [];
  // Рецепты описаны данными (web/recipes.js) — тем же каталогом собран
  // docs/EXTERNAL-API-EXAMPLES.md, поэтому страница и документ не расходятся.
  const recipeCatalog = window.TF_API_RECIPES || [];
  const recipeGroupList = window.TF_API_RECIPE_GROUPS || [];
  const recipeSnippetBuilders = window.TF_API_RECIPE_SNIPPETS || {};
  // Язык примера в рецептах: curl, Python или PowerShell — на всех сразу.
  let recipeLanguage = 'curl';
  // Как показывать справку. Список из 40 методов — это прокрутка вслепую: человек
  // ищет одно, а видит сорок. По умолчанию справа лежит ровно то, что выбрано
  // слева, а «все списком» остаётся рядом — для Ctrl+F и для печати.
  const refViewKey = 'tf-api-ref-view';
  let refView = 'one';
  try {
    if (localStorage.getItem(refViewKey) === 'all') refView = 'all';
  } catch {
    /* приватный режим: выбор живёт до перезагрузки, это не ломает страницу */
  }
  /** Что открыто справа на каждой из страниц справки. */
  const refSelected = { docs: '', recipes: '' };
  let activeAction = null;

  /** Подставить пример запроса в тестовую строку. */
  function useExample(path, method, bodyText) {
    $('#play-method').value = method || 'GET';
    $('#play-path').value = path || '/api/v1/health';
    $('#play-body').value = bodyText || '';
    showTab('playground');
    $('#play-path').focus();
    setChip('play-code', 'код: —', null);
    $('#play-out').textContent = 'Нажмите «Отправить», чтобы выполнить запрос.';
  }

  /** Имя персонажа для примеров: первый из загруженных или «Mag_1». */
  function sampleCharId() {
    const first = latest.characters[0];
    return (first && first.id) || 'Mag_1';
  }

  const PLAY_PRESETS = () => [
    ['Все персонажи по id', 'GET', '/api/v1/characters', ''],
    ['id, класс, уровень, проходки', 'GET', '/api/v1/characters?fields=id,class,level,dungeonPasses', ''],
    ['По-русски, столбиком', 'GET', '/api/v1/characters?fields=id,class,level,dungeonPasses&lang=ru&flat=false', ''],
    ['Карточка персонажа', 'GET', `/api/v1/characters/${sampleCharId()}`, ''],
    ['Только HP', 'GET', `/api/v1/characters/${sampleCharId()}/stats/hp`, ''],
    ['Все проходки', 'GET', `/api/v1/characters/${sampleCharId()}/dungeon-passes`, ''],
    ['Оружие: сколько', 'GET', `/api/v1/characters/${sampleCharId()}/dungeon-passes/weapon`, ''],
    ['Проходки +5', 'PATCH', `/api/v1/characters/${sampleCharId()}/dungeon-passes/weapon`, '5'],
    ['HP +1', 'PATCH', `/api/v1/characters/${sampleCharId()}/stats/hp`, '{"mode":"inc","by":1}'],
    ['Список марафонов', 'GET', '/api/v1/marathons', ''],
    ['Окна игры', 'GET', '/api/v1/windows', ''],
    ['Выгрузка CSV', 'GET', '/api/v1/export/characters.csv', ''],
    ['Журнал вызовов', 'GET', '/api/v1/audit', '']
  ];

  const escapeHtml = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );

  function formatMs(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    if (total < 1000) return `${total} мс`;
    return `${(total / 1000).toFixed(2).replace('.', ',')} с`;
  }

  function formatTime(ms) {
    const date = new Date(Number(ms) || 0);
    return date.toLocaleTimeString('ru-RU', { hour12: false });
  }

  function setChip(name, text, tone) {
    const chip = document.querySelector(`[data-chip="${name}"]`);
    if (!chip) return;
    chip.textContent = text;
    chip.classList.remove('is-ok', 'is-warn', 'is-bad');
    if (tone) chip.classList.add(`is-${tone}`);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }

  function errorText(result) {
    const code = result?.body?.error?.code;
    const message = result?.body?.error?.message;
    if (message) return code ? `${code}: ${message}` : message;
    return `HTTP ${result?.status ?? '—'}`;
  }

  function valuesHtml(stats, passes) {
    const statKeys = [...STAT_ORDER.filter(key => stats && stats[key] !== undefined)];
    const extra = Object.keys(stats || {}).filter(key => !statKeys.includes(key) && stats[key] !== undefined);
    const rows = [...statKeys, ...extra]
      .slice(0, 14)
      .map(key => `<span>${escapeHtml(STAT_LABELS[key] || key)}: <b>${Number(stats[key] || 0)}</b></span>`);
    for (const key of Object.keys(PASS_LABELS)) {
      if (passes && passes[key] !== undefined && passes[key] !== null)
        rows.push(`<span>${escapeHtml(PASS_LABELS[key])}: <b>${Number(passes[key] || 0)}</b></span>`);
    }
    return rows.length ? `<div class="xapi-values">${rows.join('')}</div>` : '';
  }

  function renderCharacters(characters) {
    const box = $('#characters');
    if (!Array.isArray(characters) || !characters.length) {
      box.innerHTML = '<p class="xapi-note">Персонажей нет.</p>';
      return;
    }
    box.innerHTML = characters
      .map(char => {
        const running = char.running && char.running.pid ? `<span class="xapi-badge">окно ${char.running.pid}</span>` : '';
        const loggedIn = char.isLoggedIn === true ? '<span class="xapi-badge">вход проверен</span>' : '';
        const parties = Array.isArray(char.partyIds) && char.partyIds.length
          ? `<span class="xapi-meta">пати: ${escapeHtml(char.partyIds.join(', '))}</span>`
          : '';
        return `<article class="xapi-card">
          <div class="xapi-card-head">
            <span class="xapi-card-title">${escapeHtml(char.nick || char.id)}</span>
            <span class="xapi-badge is-idle">${escapeHtml(char.class || 'класс не указан')}</span>
            ${running}${loggedIn}
          </div>
          <div class="xapi-meta">${escapeHtml(char.id)} · уровень ${Number(char.level || 0)}${
            char.sky && char.sky.name ? ` · ${escapeHtml(char.sky.name)} ${Number(char.sky.level || 0)}` : ''
          }</div>
          ${parties}
          ${valuesHtml(char.stats, char.dungeonPasses)}
          <div class="xapi-card-actions">
            ${actionLink('character-card', 'Карточка', char.id)}
            ${actionLink('character-stats', 'Статы', char.id)}
            ${actionLink('character-passes', 'Проходки', char.id)}
            ${actionLink('set-stat', 'Изменить стат', char.id)}
            ${actionLink('launch-character', 'Запустить', char.id)}
          </div>
        </article>`;
      })
      .join('');
  }

  function renderParties(parties) {
    const box = $('#parties');
    if (!Array.isArray(parties) || !parties.length) {
      box.innerHTML = '<p class="xapi-note">Пати нет.</p>';
      return;
    }
    box.innerHTML = parties
      .map(party => {
        const members = (party.members || [])
          .map(member => `<span>${escapeHtml(member.nick || member.id)}</span>`)
          .join('');
        return `<article class="xapi-card">
          <div class="xapi-card-head">
            <span class="xapi-card-title">${escapeHtml(party.name || party.id)}</span>
            <span class="xapi-meta">${escapeHtml(party.id)}</span>
          </div>
          <div class="xapi-values">${members || '<span>пусто</span>'}</div>
        </article>`;
      })
      .join('');
  }

  /** Ссылка-действие из карточки: открывает форму с уже подставленным значением. */
  function actionLink(actionId, label, value) {
    return `<button type="button" class="xapi-link" data-char-action="${escapeHtml(actionId)}" data-char-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
  }

  function renderWindows(windows) {
    const box = $('#windows');
    if (!Array.isArray(windows) || !windows.length) {
      box.innerHTML = '<p class="xapi-note">Окон игры не запущено.</p>';
      return;
    }
    box.innerHTML = windows
      .map(row => {
        const who = row.nick ? `${escapeHtml(row.nick)}${row.class ? ` — ${escapeHtml(row.class)}` : ''}` : 'окно не сопоставлено';
        return `<article class="xapi-card">
          <div class="xapi-card-head">
            <span class="xapi-card-title">${who}</span>
            <span class="xapi-meta">PID ${Number(row.pid || 0)}</span>
          </div>
          <div class="xapi-meta">${escapeHtml(row.title || 'без заголовка')}${
            row.charId ? ` · ${escapeHtml(row.charId)}` : ''
          }</div>
          <div class="xapi-card-actions">
            <button type="button" class="xapi-link" data-char-action="close-windows" data-char-value="${Number(row.pid || 0)}">Закрыть окно</button>
          </div>
        </article>`;
      })
      .join('');
  }

  function renderAudit(entries) {
    const body = $('#audit-body');
    if (!Array.isArray(entries) || !entries.length) {
      body.innerHTML = '<tr><td colspan="5" class="xapi-empty">Журнал пуст: вызовов ещё не было.</td></tr>';
      return;
    }
    body.innerHTML = entries
      .slice()
      .reverse()
      .map(
        entry => `<tr>
          <td>${escapeHtml(formatTime(entry.atMs || entry.at_ms))}</td>
          <td>${escapeHtml(entry.method)}</td>
          <td>${escapeHtml(entry.path)}</td>
          <td class="${Number(entry.status) >= 400 ? 'xapi-bad' : 'xapi-ok'}">${Number(entry.status || 0)}</td>
          <td>${escapeHtml(formatMs(entry.ms))}</td>
        </tr>`
      )
      .join('');
  }

  function recipes() {
    const base = location.origin;
    const shown = token || '<токен>';
    if (recipe === 'python') {
      return `import json, urllib.request

TOKEN = "${shown}"
BASE = "${base}/api/v1"

def call(path, method="GET", body=None):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8") if body is not None else None,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

print(call("/health"))
for character in call("/characters")["characters"]:
    print(character["id"], character["nick"], character["dungeonPasses"])
# Изменение проходок: call("/characters/Mag_1", "PATCH", {"dungeonPasses": {"weapon": 2}})
# Запуск пати:           call("/launch/party", "POST", {"partyName": "Основа"})`;
    }
    if (recipe === 'powershell') {
      return `$token = "${shown}"
$base = "${base}/api/v1"
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

Invoke-RestMethod -Uri "$base/health" -Headers $headers
$characters = Invoke-RestMethod -Uri "$base/characters" -Headers $headers
$characters.characters | Select-Object id, nick, dungeonPasses

# Изменение статов:
# Invoke-RestMethod -Method Patch -Uri "$base/characters/Mag_1" -Headers $headers \`
#   -Body '{"stats":{"physAttack":12500}}'

# Запуск пати (ответ 202 и jobId):
# Invoke-RestMethod -Method Post -Uri "$base/launch/party" -Headers $headers \`
#   -Body '{"partyName":"Основа"}'`;
    }
    return `# Проверка связи
curl -s -H "Authorization: Bearer ${shown}" ${base}/api/v1/health

# Список персонажей
curl -s -H "Authorization: Bearer ${shown}" ${base}/api/v1/characters

# Изменить проходки персонажа
curl -s -X PATCH -H "Authorization: Bearer ${shown}" -H "Content-Type: application/json" \\
  -d '{"dungeonPasses":{"weapon":2}}' ${base}/api/v1/characters/Mag_1

# Запустить пати (ответ 202 и jobId)
curl -s -X POST -H "Authorization: Bearer ${shown}" -H "Content-Type: application/json" \\
  -d '{"partyName":"Основа"}' ${base}/api/v1/launch/party

# Запустить выбранных персонажей в заданном порядке
curl -s -X POST -H "Authorization: Bearer ${shown}" -H "Content-Type: application/json" \\
  -d '{"characterIds":["Mag_1","Luchnik_2"]}' ${base}/api/v1/launch/selection

# Марафоны: задания, прогресс и итоги
curl -s -H "Authorization: Bearer ${shown}" ${base}/api/v1/marathons

# Отметить день в марафоне
curl -s -X POST -H "Authorization: Bearer ${shown}" -H "Content-Type: application/json" \\
  -d '{"characterId":"Mag_1","taskId":"t1","date":"2026-11-24"}' \\
  ${base}/api/v1/marathons/m1/marks

# Выгрузить список в CSV (файл сохранится как tvinoferma_characters_ДАТА.csv)
curl -s -OJ -H "Authorization: Bearer ${shown}" ${base}/api/v1/export/characters.csv`;
  }

  function renderRecipe() {
    $('#recipe').textContent = recipes();
    for (const tab of document.querySelectorAll('.xapi-tab')) {
      const on = tab.dataset.recipe === recipe;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function fillBase() {
    $('#base-url').textContent = location.origin;
    $('#example-base').textContent = location.origin;
  }

  async function loadAudit() {
    if (!token) return;
    const result = await api('/api/v1/audit');
    if (result.ok) renderAudit(result.body && result.body.audit);
  }

  /* ------------------------------------------------------------------ */
  /*  Вкладки страницы                                                  */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /*  Страницы: /docs и /recipes — отдельные адреса, а не вкладки        */
  /* ------------------------------------------------------------------ */

  /**
   * Справочник и рецепты — страницы, у каждой свой адрес: на метод ссылаются
   * (`/docs#m-characters-list-characters`), страницу открывают новой вкладкой и
   * возвращаются к ней кнопкой «назад». Разделы консоли при этом остаются
   * переключателями — им свой адрес не нужен.
   */
  const PAGES = { docs: 'Справочник API', recipes: 'Рецепты' };

  function pageFromLocation() {
    const match = /^\/(docs|recipes)\/?$/.exec(location.pathname || '');
    return match ? match[1] : '';
  }

  let page = pageFromLocation();

  /** Раздел на экране: страница (`/docs`, `/recipes`) или вкладка консоли. */
  function currentSection() {
    return page || activeTab;
  }

  function applyRoute() {
    // По адресу понимают, какая страница открыта, — это нужно CSS (на справке
    // колонка шире). `body` может не быть только в тестовой разметке, поэтому
    // без него просто пропускаем: на раздел это не влияет.
    if (document.body) document.body.dataset.page = page || 'console';
    const shown = page || activeTab;
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== shown;
    }
    for (const tab of document.querySelectorAll('[data-tab]')) {
      const on = tab.dataset.tab === shown;
      tab.classList.toggle('is-on', on);
      if (on) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (page === 'docs') renderDocs();
    if (page === 'recipes') renderRecipes();
  }

  /**
   * Якорь, который имеет смысл на целевой странице: `#m-…` и `#g-…` живут в
   * справочнике, `#rp-…` и `#rg-…` — в рецептах. Тащить чужой якорь за собой
   * незачем: он никуда не ведёт, а адрес портит.
   */
  function anchorFor(pageName) {
    const hash = location.hash || '';
    if (pageName === 'docs' && /^#(m-|g-)/.test(hash)) return hash;
    if (pageName === 'recipes' && /^#(rp-|rg-)/.test(hash)) return hash;
    return '';
  }

  /**
   * Адрес меняем через history, а не переходом: разметка и состояние (токен,
   * списки, уже выполненные запросы) общие, а перезагрузкой человек потерял бы
   * введённый токен и ответы. Ссылки при этом настоящие — Rust отдаёт оболочку
   * страницы и на `/docs`, и на `/recipes`.
   */
  function goPage(name) {
    const next = PAGES[name] ? name : '';
    const url = next ? `/${next}${anchorFor(next)}` : '/';
    const changed = page !== next || location.pathname !== url;
    page = next;
    if (changed) {
      try {
        history.pushState({ page: next }, '', url);
      } catch {
        /* file:// или закрытый history: страницы это не ломает — просто адрес не меняется */
      }
      // Новая страница начинается с её верха; якорь (если его просили) докрутит сам.
      // scrollTop, а не scrollTo: в тестовой среде второго не существует, и он
      // только шумел бы «Not implemented», а эффект тот же.
      if (!location.hash) {
        const scroller = document.scrollingElement || document.documentElement;
        if (scroller) scroller.scrollTop = 0;
      }
    }
    applyRoute();
  }

  function showTab(name) {
    if (PAGES[name]) {
      goPage(name);
      return;
    }
    activeTab = name;
    goPage('');
    if (name === 'overview') loadOverview();
  }

  /* ------------------------------------------------------------------ */
  /*  Тестовый запрос                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Подсказка «что можно спросить»: поля персонажа кнопками, по группам.
   *
   * Группы — не украшение: 49 полей одним облаком не читаются, а так видно,
   * что статы и проходки спрашиваются точечно (`stats.hp`, `dungeonPasses.weapon`).
   */
  function renderHints() {
    const box = $('#play-hints');
    if (!box) return;
    const fields = (docs.fieldLists && docs.fieldLists.characterFields) || [];
    const groups = [
      {
        title: 'Основное',
        match: field => ['id', 'nick', 'class', 'level', 'favorite', 'partyIds', 'mainPartyId', 'ancientCoins', 'notes', 'tags'].includes(field)
      },
      {
        title: 'Небо и окно игры',
        match: field => field.startsWith('sky') || field.startsWith('running')
      },
      { title: 'Проходки', match: field => field.startsWith('dungeonPasses.') },
      { title: 'Статы', match: field => field.startsWith('stats.') }
    ];
    const used = new Set();
    const html = groups
      .map(group => {
        const items = fields.filter(field => !used.has(field) && group.match(field));
        items.forEach(field => used.add(field));
        if (!items.length) return '';
        const chips = items
          .map(field => `<button type="button" class="xapi-hint-chip" data-field="${escapeHtml(field)}">${escapeHtml(field)}</button>`)
          .join('');
        return `<div class="xapi-hint-group"><span class="xapi-hint-title">${escapeHtml(group.title)}</span><div class="xapi-hints">${chips}</div></div>`;
      })
      .join('');
    box.innerHTML = `
      <p class="xapi-note">Нажмите поля — они соберутся в <code>?fields=…</code>. Статы и проходки можно спрашивать по одному.</p>
      ${html}
      <button type="button" class="btn ghost small" id="play-use-fields">Подставить выбранные поля в запрос</button>`;
    const chosen = new Set();
    for (const chip of box.querySelectorAll('[data-field]'))
      chip.addEventListener('click', () => {
        const field = chip.dataset.field;
        if (chosen.has(field)) chosen.delete(field);
        else chosen.add(field);
        chip.classList.toggle('is-on', chosen.has(field));
      });
    const apply = box.querySelector('#play-use-fields');
    if (apply)
      apply.addEventListener('click', () => {
        if (!chosen.size) return;
        $('#play-method').value = 'GET';
        $('#play-path').value = `/api/v1/characters?fields=${[...chosen].join(',')}`;
        $('#play-body').value = '';
        setChip('play-code', 'код: —', null);
        $('#play-out').textContent = 'Нажмите «Отправить»: в ответе будут только выбранные поля.';
      });
  }

  function renderPresets() {
    const box = $('#play-presets');
    box.innerHTML = PLAY_PRESETS()
      .map(
        ([title, method, path, body], index) =>
          `<button type="button" class="xapi-preset" data-preset="${index}" title="${escapeHtml(method)} ${escapeHtml(path)}">${escapeHtml(title)}</button>`
      )
      .join('');
    for (const button of box.querySelectorAll('[data-preset]')) {
      button.addEventListener('click', () => {
        const [, method, path, body] = PLAY_PRESETS()[Number(button.dataset.preset)] || [];
        if (path) useExample(path, method, body);
      });
    }
  }

  /** Разбор тела: пусто → undefined, число → число, остальное → JSON. */
  function parsePlayBody(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return undefined;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Тело — не JSON: ${error.message}`);
    }
  }

  async function sendPlay() {
    const method = ($('#play-method').value || 'GET').toUpperCase();
    const path = ($('#play-path').value || '').trim();
    if (!path.startsWith('/')) {
      $('#play-status').textContent = 'Путь начинается с «/»: например /api/v1/health.';
      $('#play-path').focus();
      return;
    }
    let body;
    try {
      body = parsePlayBody($('#play-body').value);
    } catch (error) {
      $('#play-status').textContent = error.message;
      return;
    }
    const button = $('#play-send');
    button.disabled = true;
    button.textContent = 'Отправляю…';
    const startedAt = performance.now();
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const ms = Math.round(performance.now() - startedAt);
      const text = await response.text();
      const type = response.headers.get('Content-Type') || '—';
      // Выгрузка: показываем начало файла и имя из Content-Disposition.
      const disposition = response.headers.get('Content-Disposition') || '';
      const size = new Blob([text]).size;
      setChip('play-code', `код: ${response.status}`, response.ok ? 'ok' : 'bad');
      setChip('play-time', `время: ${formatMs(ms)}`, null);
      setChip('play-type', `тип: ${type.split(';')[0]}`, null);
      setChip('play-size', `размер: ${size < 1024 ? `${size} Б` : `${(size / 1024).toFixed(1)} КБ`}`, null);
      if (disposition) {
        $('#play-status').textContent = `Файл: ${disposition.replace(/^attachment;\s*filename="?/, '').replace(/"$/, '')} — показаны первые 2000 символов.`;
        $('#play-out').textContent = text.slice(0, 2000) + (text.length > 2000 ? '\n… (файл длиннее)' : '');
      } else {
        $('#play-status').textContent = '';
        try {
          $('#play-out').textContent = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          $('#play-out').textContent = text || '(пустой ответ)';
        }
      }
    } catch (error) {
      setChip('play-code', 'код: —', 'bad');
      $('#play-status').textContent = `Запрос не ушёл: ${error && error.message ? error.message : error}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Отправить';
    }
  }

  /** Тот же запрос, но текстом для терминала. */
  async function copyAsCurl() {
    const method = ($('#play-method').value || 'GET').toUpperCase();
    const path = ($('#play-path').value || '').trim() || '/api/v1/health';
    const bodyText = ($('#play-body').value || '').trim();
    const lines = [`curl -s -X ${method} \\`, `  -H "Authorization: Bearer ${token || '<токен>'}" \\`];
    if (bodyText) lines.push('  -H "Content-Type: application/json" \\', `  -d '${bodyText.replace(/'/g, `'\\''`)}' \\`);
    lines.push(`  ${location.origin}${path}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      $('#play-status').textContent = 'Команда curl скопирована в буфер обмена.';
    } catch {
      $('#play-out').textContent = lines.join('\n');
      $('#play-status').textContent = 'Буфер недоступен: команда показана в поле ответа.';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Живой запрос в карточке: справочник и рецепты должны выполняться   */
  /*  здесь, а не «подставь в другую вкладку и нажми там»               */
  /* ------------------------------------------------------------------ */

  /**
   * Право метода → ключ в `health.scopes`. Подписи в docs.js по-русски, в
   * recipes.js — коды; оба варианта приходят из одних и тех же карточек.
   */
  const SCOPE_KEYS = {
    'чтение': 'read',
    read: 'read',
    'изменение': 'modify',
    modify: 'modify',
    'запуск и закрытие': 'launchClose',
    launchClose: 'launchClose'
  };
  const SCOPE_TITLES = {
    read: 'чтение',
    modify: 'изменение статов и проходок',
    launchClose: 'запуск и закрытие окон'
  };

  /**
   * Какое значение подставить чипу параметра, чтобы запрос из карточки сразу работал,
   * а не возвращал 422 на пустом `?party=`. Известные имена — из `docs.js`; для
   * неизвестных оставляем `name=` и курсор после знака: человек допишет сам.
   */
  const RUN_PARAM_SAMPLES = {
    full: 'true',
    // `detail` — чем подробнее список: значение из справочника подставляется как есть,
    // и чип обязан вставлять рабочее, а не пустое `detail=`.
    detail: 'list',
    flat: 'true',
    lang: 'ru',
    sort: 'nick',
    order: 'asc',
    fields: 'stats.hp',
    format: 'csv'
  };
  function runParamSample(name) {
    if (name === 'party') return (latest.parties[0] && (latest.parties[0].name || latest.parties[0].id)) || '';
    return RUN_PARAM_SAMPLES[name] || '';
  }

  /** Строка «GET /api/v1/health» или просто путь → { method, path }; мусор → null. */
  function parseRunLine(text) {
    const parts = String(text || '').trim().split(/\s+/);
    const method = parts.length > 1 ? parts[0].toUpperCase() : 'GET';
    const path = parts.length > 1 ? parts[1] : parts[0];
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return null;
    if (!String(path).startsWith('/')) return null;
    return { method, path };
  }

  /**
   * Id из документации («Mag_1», «p-osnova») → id этого запуска, чтобы запрос из
   * карточки работал, а не возвращал 404 на вымышленном персонаже.
   */
  function localizeExample(text) {
    const charId = sampleCharId();
    const partyId = (latest.parties[0] && latest.parties[0].id) || '';
    return String(text)
      .replace(/\{id\}/g, charId)
      .replace(/\{charId\}/g, charId)
      .replace(/Mag_1/g, charId)
      .replace(/p-osnova/g, partyId || 'p-osnova');
  }

  /** Ключи формы ответа: для массива — ключи первой строки, иначе — свои. */
  function shapeKeys(value) {
    const source = Array.isArray(value) ? value[0] : value;
    return source && typeof source === 'object' ? Object.keys(source) : [];
  }

  /**
   * Чем живой ответ отличается от обещанного документом. Пустая строка — совпал.
   * Это не украшение: расхождение значит, что `docs/EXTERNAL-API-EXAMPLES.md`
   * устарел (или ответ изменили), и странице нельзя будет верить.
   */
  function compareShape(live, example) {
    if (!example || typeof example === 'string' || live === null || live === undefined) return '';
    const here = new Set(shapeKeys(live));
    const promised = new Set(shapeKeys(example));
    if (!here.size || !promised.size) return '';
    const missing = [...promised].filter(key => !here.has(key));
    const extra = [...here].filter(key => !promised.has(key));
    if (!missing.length && !extra.length) return 'форма ответа совпала с примером из документации';
    const bits = [];
    if (missing.length) bits.push(`в живом ответе нет: ${missing.join(', ')}`);
    if (extra.length) bits.push(`добавилось: ${extra.join(', ')}`);
    return `форма ответа отличается от примера — ${bits.join('; ')}. Значит, устарел либо документ, либо ответ: сверьте web/recipes.js с API.`;
  }

  /**
   * Панель выполнения внутри карточки: строка запроса (её можно поправить), тело,
   * «Выполнить» и ответ под кнопками. Строит app.js, данные — из docs.js/recipes.js.
   */
  function runPanelHtml({ id, method, path, body, scope, params = [] }) {
    const write = method !== 'GET';
    const chips = params.length
      ? `<div class="xapi-run-params"><span class="xapi-run-params-label">параметры:</span>${params
          .map(
            name =>
              `<button type="button" class="xapi-hint-chip" data-run-param="${escapeHtml(name)}" title="Дописать «${escapeHtml(name)}${
                runParamSample(name) ? `=${runParamSample(name)}` : '='
              }» в строку запроса">${escapeHtml(name)}</button>`
          )
          .join('')}</div>`
      : '';
    const bodyField = write
      ? `<label class="xapi-field xapi-run-body-field"><span>Тело запроса — JSON (для PATCH проходки можно просто число)</span><textarea class="xapi-run-body" rows="3" spellcheck="false">${escapeHtml(body || '')}</textarea></label>`
      : '';
    return `<div class="xapi-run" data-run="${escapeHtml(id)}" data-run-write="${write ? '1' : '0'}" data-run-scope="${escapeHtml(SCOPE_KEYS[scope] || '')}">
      <label class="xapi-field xapi-run-path-field"><span>Запрос — путь от корня, можно поправить и добавить параметры</span><input class="xapi-run-path" value="${escapeHtml(`${method} ${path}`)}" spellcheck="false" autocomplete="off" /></label>
      ${bodyField}
      ${chips}
      <div class="xapi-run-actions">
        <button type="button" class="btn primary small" data-run-go>▶ Выполнить</button>
        <button type="button" class="btn ghost small" data-run-play>→ в тестовую строку</button>
        <button type="button" class="btn ghost small" data-run-copy hidden>⧉ скопировать ответ</button>
        <span class="xapi-note" data-run-status role="status" aria-live="polite"></span>
      </div>
      <div class="xapi-run-result" data-run-result hidden>
        <div class="xapi-status" data-run-chips></div>
        <pre class="xapi-code xapi-code-sm" data-run-out tabindex="0"></pre>
        <p class="xapi-note" data-run-compare></p>
      </div>
    </div>`;
  }

  /** Подпись списков, из которых карточки берут id: поменялись — вкладки перерисовываем. */
  function referenceStampNow() {
    const first = latest.characters[0];
    return `${latest.characters.length}:${latest.parties.length}:${(first && first.id) || ''}`;
  }

  /** Панели рисуются строкой — обработчики навешиваем один раз после отрисовки. */
  function bindRunPanels(root) {
    for (const panel of root.querySelectorAll('[data-run]')) {
      if (panel.dataset.bound === '1') continue;
      panel.dataset.bound = '1';
      const go = panel.querySelector('[data-run-go]');
      const status = panel.querySelector('[data-run-status]');
      const pathField = panel.querySelector('.xapi-run-path');
      const disarm = () => {
        if (panel.dataset.armed !== '1') return;
        delete panel.dataset.armed;
        go.textContent = '▶ Выполнить';
      };
      for (const field of panel.querySelectorAll('.xapi-run-path, .xapi-run-body'))
        field.addEventListener('input', disarm);
      go.addEventListener('click', () => {
        const blocked = runBlockReason(panel);
        if (blocked) {
          status.textContent = blocked;
          if (!token && tokenInput) tokenInput.focus();
          return;
        }
        // Запрос, который меняет данные, не должен уходить с одного щелчка —
        // карточка справочника выглядит как обычный текст, и про METHOD легко
        // забыть. Первое нажатие готовит кнопку, второе выполняет.
        if (panel.dataset.runWrite === '1' && panel.dataset.armed !== '1') {
          panel.dataset.armed = '1';
          go.textContent = '⚠ Подтвердить: запрос меняет данные';
          status.textContent = 'Нажмите ещё раз, чтобы выполнить.';
          return;
        }
        void runFromPanel(panel);
      });
      panel.querySelector('[data-run-play]').addEventListener('click', () => {
        const parsed = parseRunLine(pathField.value) || { method: 'GET', path: '/api/v1/health' };
        const bodyField = panel.querySelector('.xapi-run-body');
        useExample(parsed.path, parsed.method, bodyField ? bodyField.value : '');
      });
      const copy = panel.querySelector('[data-run-copy]');
      copy.addEventListener('click', async () => {
        const text = panel.querySelector('[data-run-out]').textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = '⧉ скопировано';
          setTimeout(() => {
            copy.textContent = '⧉ скопировать ответ';
          }, 1600);
        } catch {
          status.textContent = 'Буфер недоступен: выделите ответ и скопируйте вручную.';
        }
      });
      for (const chip of panel.querySelectorAll('[data-run-param]'))
        chip.addEventListener('click', () => {
          const name = chip.dataset.runParam;
          const sample = runParamSample(name);
          const current = pathField.value.trim();
          // Параметр уже в строке: либо дописываем значение (если оно осталось пустым),
          // либо молчим — дублировать `party=x&party=y` незачем.
          if (current.includes(`${name}=`)) {
            if (!sample || !new RegExp(`${name}=(?=&|$|\\s)`).test(current)) return;
            pathField.value = current.replace(`${name}=`, `${name}=${sample}`);
          } else {
            pathField.value = `${current}${current.includes('?') ? '&' : '?'}${name}=${sample}`;
          }
          disarm();
          pathField.focus();
          const end = pathField.value.length;
          pathField.setSelectionRange(end, end);
        });
    }
  }

  /**
   * Почему запрос сейчас не выйдет: текст причины или пустая строка. Проверяется
   * до подтверждения опасного метода — иначе человек вводит второе нажатие ради 403.
   */
  function runBlockReason(panel) {
    const parsed = parseRunLine(panel.querySelector('.xapi-run-path').value);
    if (!parsed) return 'Формат: «GET /api/v1/health». Метод можно не писать — будет GET.';
    if (!token) return 'Нет токена: введите его в блоке «Подключение» и нажмите «Подключиться».';
    if (parsed && /\/jobs\/job_1$/.test(parsed.path) && !seenJobId)
      return 'Задания ещё не запускались: id из примера вернёт 404. Выполните запуск — страница подставит настоящий jobId.';
    const scopeKey = panel.dataset.runScope;
    if (grantedScopes && scopeKey && grantedScopes[scopeKey] !== true)
      return `Право «${SCOPE_TITLES[scopeKey] || scopeKey}» выключено — сервер ответит 403. Включите его в «Настройки → 🔌 Внешний API».`;
    return '';
  }

  async function runFromPanel(panel) {
    const status = panel.querySelector('[data-run-status]');
    const blocked = runBlockReason(panel);
    if (blocked) {
      status.textContent = blocked;
      if (!token && tokenInput) tokenInput.focus();
      return;
    }
    const parsed = parseRunLine(panel.querySelector('.xapi-run-path').value);
    let body;
    try {
      body = parsePlayBody((panel.querySelector('.xapi-run-body') || {}).value);
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    const go = panel.querySelector('[data-run-go]');
    const label = go.textContent;
    go.disabled = true;
    go.textContent = 'Выполняю…';
    status.textContent = '';
    try {
      const headers = { Accept: 'application/json' };
      headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const startedAt = performance.now();
      const response = await fetch(localizeExample(parsed.path), {
        method: parsed.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const ms = Math.round(performance.now() - startedAt);
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const size = new Blob([text]).size;
      const result = panel.querySelector('[data-run-result]');
      result.hidden = false;
      panel.querySelector('[data-run-chips]').innerHTML = [
        `<span class="xapi-chip ${response.ok ? 'is-ok' : 'is-bad'}">${escapeHtml(parsed.method)} ${response.status}</span>`,
        `<span class="xapi-chip">${escapeHtml(formatMs(ms))}</span>`,
        `<span class="xapi-chip">${size < 1024 ? `${size} Б` : `${(size / 1024).toFixed(1)} КБ`}</span>`
      ].join('');
      panel.querySelector('[data-run-out]').textContent =
        json !== null ? JSON.stringify(json, null, 2) : text || '(пустой ответ)';
      panel.querySelector('[data-run-copy]').hidden = false;
      const compare = panel.querySelector('[data-run-compare]');
      const note = response.ok ? compareShape(json, runExamples.get(panel.dataset.run)) : '';
      if (compare) {
        compare.textContent = note;
        compare.hidden = !note;
      }
      status.textContent = response.ok
        ? '✅ Ответ получен.'
        : `❌ ${errorText({ status: response.status, body: json })}${
            response.status === 403 ? ' Включите право в «Настройки → 🔌 Внешний API».' : ''
          }`;
      if (response.ok && json && typeof json.jobId === 'string') propagateJobId(json.jobId);
      // Списки могли измениться — формы и подсказки обновляем так же, как во «Действиях».
      if (/^(POST|PATCH|PUT|DELETE)$/.test(parsed.method) && response.ok) {
        refreshListsQuietly();
        loadOverview().catch(() => {});
      }
    } catch (error) {
      status.textContent = `Запрос не ушёл: ${error && error.message ? error.message : error}`;
    } finally {
      go.disabled = false;
      go.textContent = label;
      disarmPanel(panel);
    }
  }

  function disarmPanel(panel) {
    if (panel.dataset.armed !== '1') return;
    delete panel.dataset.armed;
    panel.querySelector('[data-run-go]').textContent = '▶ Выполнить';
  }

  /* ------------------------------------------------------------------ */
  /*  Справочник                                                        */
  /* ------------------------------------------------------------------ */

  function docsMethodId(group, method) {
    return `m-${group.id}-${method.id}`;
  }

  /**
   * Путь с подставленными значениями для «Попробовать»: `{id}` — первый
   * персонаж, пати или марафон в зависимости от маршрута, `{stat}` — hp,
   * `{pass}` — weapon, `{jobId}` — job_1, `{набор}.{csv|json}` — characters.csv.
   */
  /**
   * Появился настоящий id задания — переписываем его в строках запроса карточек
   * `/jobs/{jobId}`. Вкладки ради этого не перерисовываем: ответ только что
   * напечатали в этой же панели, и перерисовка выбросила бы её вместе с ним.
   */
  function propagateJobId(id) {
    if (!id || id === seenJobId) return;
    seenJobId = id;
    for (const field of document.querySelectorAll('[data-run] .xapi-run-path')) {
      if (!/\/jobs\/job_1(\s|$)/.test(field.value)) continue;
      field.value = field.value.replace('job_1', seenJobId);
      // Строка изменилась не руками человека, но подтверждение опасного метода
      // всё равно снимаем: арминг относился к другому запросу.
      const row = field.closest('[data-run]');
      const go = row.querySelector('[data-run-go]');
      if (row.dataset.armed) {
        delete row.dataset.armed;
        if (go) go.textContent = '▶ Выполнить';
      }
    }
  }

  function fillExamplePath(path) {
    let out = String(path);
    // id задания существует только после запуска: до него подставляем тот, что
    // страница увидела в ответе, иначе «▶ Выполнить» в карточке /jobs/{jobId}
    // возвращал бы 404 на вымышленный `job_1`.
    if (out.includes('{jobId}') && seenJobId) out = out.replace('{jobId}', seenJobId);
    if (out.includes('/parties/')) out = out.replace('{id}', (latest.parties[0] && latest.parties[0].id) || 'p-osnova');
    else if (out.includes('/marathons/')) out = out.replace('{id}', 'm1');
    else out = out.replace('{id}', sampleCharId());
    return out
      .replace('{stat}', 'hp')
      .replace('{pass}', 'weapon')
      .replace('{jobId}', seenJobId || 'job_1')
      .replace('{набор}.{csv|json}', 'characters.csv');
  }

  /**
   * Коды ошибок столбиками по HTTP-статусу: слева цифра, справа — коды и
   * подписи. Столбиком читается лучше, чем строкой через запятую.
   */
  function errorTableHtml() {
    const rows = (docs.errorCatalog || []).slice();
    if (!rows.length) return '<p class="xapi-note">Список кодов подключается из errors.js.</p>';
    const byStatus = new Map();
    for (const row of rows) {
      if (!byStatus.has(row.status)) byStatus.set(row.status, []);
      byStatus.get(row.status).push(row);
    }
    const columns = [...byStatus.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([status, items]) => `<div class="xapi-err-col">
          <div class="xapi-err-status">${status}</div>
          ${items
            .map(
              item =>
                `<div class="xapi-err-row"><code>${escapeHtml(item.code)}</code><span>${escapeHtml(item.title || '')}</span>${
                  item.hint ? `<em>${escapeHtml(item.hint)}</em>` : ''
                }</div>`
            )
            .join('')}
        </div>`
      )
      .join('');
    return `<div class="xapi-err-table">${columns}</div>`;
  }

  function methodHtml(group, method) {
    const id = docsMethodId(group, method);
    const badge = method.method === '—' ? 'правило' : method.method;
    const params = (method.params || []).length
      ? `<div class="xapi-table-wrap"><table class="xapi-table"><thead><tr><th scope="col">Имя</th><th scope="col">Где</th><th scope="col">Тип</th><th scope="col">Описание</th></tr></thead><tbody>${method.params
          .map(
            ([name, where, type, text]) =>
              `<tr><td><code>${escapeHtml(name)}</code></td><td>${escapeHtml(where)}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(text)}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      : '<p class="xapi-note">Параметров нет.</p>';
    const canRun = method.method !== '—' && !String(method.path).startsWith('http');
    const examplePath = canRun ? localizeExample(fillExamplePath(method.path)) : method.path;
    const bodyText = method.exampleBody ? JSON.stringify(method.exampleBody) : '';
    // Панель выполнения прямо в карточке метода. Кнопка «подставь в другую вкладку»
    // была полумерой: ради одного запроса приходилось прыгать между вкладками
    // и держать в голове, что куда вставилось.
    const panel = canRun
      ? runPanelHtml({
          id: `doc-${id}`,
          method: method.method,
          path: `/api/v1${examplePath}`,
          body: bodyText,
          scope: method.scope,
          params: [...new Set((method.params || []).filter(item => item[1] === 'query').flatMap(item => String(item[0]).split(',').map(name => name.trim())).filter(Boolean))]
        })
      : '';
    return `<article class="xapi-doc" id="${escapeHtml(id)}" data-doc data-doc-scope="${escapeHtml(SCOPE_KEYS[method.scope] || '')}" data-doc-read="${method.method === 'GET' ? '1' : '0'}">
      <div class="xapi-doc-head">
        <span class="xapi-doc-method is-${String(method.method).toLowerCase()}">${escapeHtml(badge)}</span>
        <code class="xapi-doc-path">${escapeHtml(method.path)}</code>
        <span class="xapi-chip">право: ${escapeHtml(method.scope)}</span>
        <button type="button" class="btn ghost small xapi-doc-link" data-doc-link="${escapeHtml(id)}" title="Скопировать ссылку на этот метод">🔗 ссылка</button>
      </div>
      <h4>${escapeHtml(method.summary)}</h4>
      <p class="xapi-note">${escapeHtml(method.description)}</p>
      ${method.errorTable ? errorTableHtml() : ''}
      <div class="xapi-doc-body">
        <h5>Параметры</h5>
        ${params}
        <h5>Ответ</h5>
        <p class="xapi-note">${escapeHtml(method.response)}</p>
        <h5>Пример</h5>
        <pre class="xapi-code xapi-code-sm">${escapeHtml(
          `${method.method === '—' ? '' : `${method.method} `}${method.path}${bodyText ? `\n${bodyText}` : ''}`
        )}</pre>
        ${panel}
      </div>
    </article>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Вкладка «Рецепты»: готовые сценарии «запрос → ответ → смысл»      */
  /* ------------------------------------------------------------------ */

  /** Название права по-человечески — как в настройках приложения. */
  const RECIPE_SCOPE_NAMES = {
    read: 'чтение',
    modify: 'изменение',
    launchClose: 'запуск и закрытие окон'
  };

  /**
   * Пример запроса с настоящим адресом и токеном.
   *
   * Сборщик примеров живёт в каталоге (web/recipes.js) — он же печатает примеры
   * в документ. Здесь только подставляются адрес этой страницы и токен, чтобы
   * команду можно было сразу скопировать и выполнить.
   */
  function recipeSnippet(item, language) {
    const builder = recipeSnippetBuilders[language] || recipeSnippetBuilders.curl;
    if (!builder) return '';
    return String(builder(item))
      .replace(/http:\/\/127\.0\.0\.1:47831/g, location.origin)
      .replace(/<токен>/g, token || '<токен>');
  }

  /** Тело запроса: пример из каталога, но с id этого запуска. */
  function recipeBody(item) {
    return item.body ? localizeExample(JSON.stringify(item.body)) : '';
  }

  /**
   * Параметры для чипов в рецепте: берём их из справочника по совпадению метода и
   * пути. Рецепт и метод — один и тот же запрос, а без чипов карточка рецепта
   * не даёт даже попробовать `?full=true`, хотя поле описано в документации.
   */
  function recipeQueryParams(item) {
    // Рецепт описан абсолютным путём (`/api/v1/characters`), справочник — относительным
    // (`/characters`): сравниваем без префикса, иначе чипов ни в одном рецепте не будет.
    const recipePath = String(item.template || item.path || '')
      .split('?')[0]
      .trim()
      .replace(/^\/api\/v1/, '');
    const key = `${String(item.method).toUpperCase()} ${recipePath}`;
    for (const group of docs.groups || []) {
      for (const method of group.methods || []) {
        if (`${method.method} ${method.path}` !== key) continue;
        return [
          ...new Set(
            (method.params || [])
              .filter(param => param[1] === 'query')
              .flatMap(param => String(param[0]).split(',').map(name => name.trim()))
              .filter(Boolean)
          )
        ];
      }
    }
    return [];
  }

  function recipeHtml(item) {
    const errors = (item.errors || []).length
      ? `<h5>Если придёт ошибка</h5>
        <div class="xapi-table-wrap"><table class="xapi-table"><thead><tr><th scope="col">Код</th><th scope="col">Что делать</th></tr></thead><tbody>${item.errors
          .map(error => `<tr><td><code>${escapeHtml(error.status)} ${escapeHtml(error.code)}</code></td><td>${escapeHtml(error.why)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '';
    const response = typeof item.response === 'string' ? item.response : JSON.stringify(item.response, null, 2);
    // Выполнение идёт по шаблону пути (`template`) с подстановкой реальных id:
    // `path` — это пример из документации, в нём «Mag_1», и на живом сервере
    // такой запрос вернул бы 404.
    const runLine = localizeExample(fillExamplePath(item.template || item.path));
    runExamples.set(`recipe-${item.id}`, item.response);
    return `<article class="xapi-doc" id="rp-${escapeHtml(item.id)}" data-recipe data-recipe-id="${escapeHtml(item.id)}" data-recipe-scope="${escapeHtml(SCOPE_KEYS[item.scope] || '')}">
      <div class="xapi-doc-head">
        <span class="xapi-doc-method is-${escapeHtml(String(item.method).toLowerCase())}">${escapeHtml(item.method)}</span>
        <code class="xapi-doc-path">${escapeHtml(item.template || item.path)}</code>
        <span class="xapi-chip">право: ${escapeHtml(RECIPE_SCOPE_NAMES[item.scope] || item.scope)}</span>
        <button type="button" class="btn ghost small xapi-doc-link" data-recipe-link="${escapeHtml(`rp-${item.id}`)}" title="Скопировать ссылку на этот рецепт">🔗 ссылка</button>
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p class="xapi-note">${escapeHtml(item.scenario)}</p>
      <div class="xapi-doc-body">
        <h5>Запрос</h5>
        <pre class="xapi-code xapi-code-sm" data-recipe-snippet>${escapeHtml(recipeSnippet(item, recipeLanguage))}</pre>
        ${runPanelHtml({
          id: `recipe-${item.id}`,
          method: item.method,
          path: runLine,
          body: recipeBody(item),
          scope: item.scope,
          params: recipeQueryParams(item)
        })}
        <h5>Ответ — как он описан в документации</h5>
        <pre class="xapi-code xapi-code-sm">${escapeHtml(response)}</pre>
        <h5>Что это значит</h5>
        <p class="xapi-note">${escapeHtml(item.explanation)}</p>
        ${errors}
      </div>
    </article>`;
  }

  function renderRecipes() {
    const body = $('#recipes-body');
    if (!body) return;
    if (!recipeCatalog.length) {
      body.innerHTML = '<p class="xapi-note">Рецепты не загрузились: файл recipes.js не подключён.</p>';
      return;
    }
    const stamp = referenceStampNow();
    if (body.dataset.stamp !== stamp) {
      body.dataset.stamp = stamp;
      body.innerHTML = recipeGroupList
        .map(group => {
          const inGroup = recipeCatalog.filter(item => item.group === group.id);
          if (!inGroup.length) return '';
          return `<section class="xapi-doc-group" id="rg-${escapeHtml(group.id)}" data-recipe-group>
            <h3>${escapeHtml(group.title)}</h3>
            ${inGroup.map(recipeHtml).join('')}
          </section>`;
        })
        .join('');
      $('#recipes-toc').innerHTML = recipesTocHtml();
      bindTocLinks($('#recipes-toc'));
      for (const button of body.querySelectorAll('[data-recipe-link]'))
        button.addEventListener('click', () => {
          void copyLink(button, pageUrl('recipes', button.dataset.recipeLink));
        });
      bindRunPanels(body);
      // Карточки перерисовались (подключились — подставились живые id), а человек
      // всё ещё смотрит на тот рецепт, по которому пришёл по ссылке. Возвращаем
      // якорь на место — но только при перерисовке: иначе каждый символ в поиске
      // мотал бы страницу к предыдущей ссылке.
      if (location.hash) goToAnchor(location.hash);
    }
    filterRecipes();
  }

  /**
   * Оглавление рецептов: разделы и сами рецепты. Список из 22 карточек без
   * навигации — это прокрутка вслепую, а с ним видно и состав каталога, и то,
   * сколько рецептов осталось под фильтром (ссылки прячутся вместе с карточками).
   */
  function recipesTocHtml() {
    return recipeGroupList
      .map(group => {
        const inGroup = recipeCatalog.filter(item => item.group === group.id);
        if (!inGroup.length) return '';
        return `<div class="xapi-toc-group" data-recipes-toc-group="${escapeHtml(group.id)}">
          <a class="xapi-toc-link" href="#rg-${escapeHtml(group.id)}" data-toc-group-link>${escapeHtml(group.title)}<span class="xapi-toc-count">${inGroup.length}</span></a>
          <ul class="xapi-toc-methods">${inGroup
            .map(
              item =>
                `<li class="xapi-toc-item"><a class="xapi-toc-method" href="#rp-${escapeHtml(item.id)}"><code>${escapeHtml(item.method)}</code><span>${escapeHtml(item.title)}</span></a></li>`
            )
            .join('')}</ul>
        </div>`;
      })
      .join('');
  }

  /**
   * Ссылка на страницу с якорем. Адрес собирается от корня, а не от текущего
   * пути: ссылку на метод копивируют из задач и `AGENTS.md`, и она должна вести
   * на `/docs` независимо от того, где человек стоял в момент копирования.
   */
  function pageUrl(pageName, hash) {
    return `${location.origin}/${pageName}${hash ? `#${hash}` : ''}`;
  }

  /** Кнопка «🔗 ссылка»: копирует адрес; без доступа к буферу — показывает его в prompt. */
  async function copyLink(button, url) {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = '🔗 скопировано';
      setTimeout(() => {
        button.textContent = '🔗 ссылка';
      }, 1600);
    } catch {
      window.prompt('Скопируйте ссылку:', url);
    }
  }

  /** Ссылки оглавления: переход без прыжка «якорем» по умолчанию, с подсветкой цели. */
  function bindTocLinks(box) {
    for (const link of box.querySelectorAll('a[href^="#"]'))
      link.addEventListener('click', e => {
        e.preventDefault();
        goToAnchor(link.getAttribute('href'));
      });
  }

  /** Перейти к якорю на любой из страниц: тот же выбор, что и по клику в оглавлении. */
  function goToAnchor(hash) {
    const id = String(hash || '').replace(/^#/, '');
    if (!id) return false;
    const kind = /^#?(m-|g-)/.test(`#${id}`) ? 'docs' : 'recipes';
    if (page !== kind && (kind === 'docs' || kind === 'recipes')) {
      if (!PAGES[kind]) return false;
      showTab(kind);
    }
    return refJump(kind, `#${id}`);
  }

  /**
   * Смена языка примеров: подменяем только текст команд, карточки не перерисовываем.
   */
  function setRecipeLanguage(language) {
    recipeLanguage = language;
    for (const tab of document.querySelectorAll('[data-recipe-lang]')) {
      const on = tab.dataset.recipeLang === language;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const article of document.querySelectorAll('[data-recipe]')) {
      const item = recipeCatalog.find(recipe => recipe.id === article.dataset.recipeId);
      const pre = article.querySelector('[data-recipe-snippet]');
      if (!item || !pre) continue;
      pre.textContent = recipeSnippet(item, recipeLanguage);
    }
  }

  /** Поиск и фильтр по правам: скрывают рецепты, где нет совпадения. */
  function filterRecipes() {
    const input = $('#recipes-filter');
    const query = (input ? input.value : '').trim().toLowerCase();
    const onlyAvailable = !!$('#recipes-only-available') && $('#recipes-only-available').checked;
    let shown = 0;
    for (const group of document.querySelectorAll('[data-recipe-group]')) {
      let any = false;
      for (const item of group.querySelectorAll('[data-recipe]')) {
        const key = item.dataset.recipeScope;
        const blocked = !!grantedScopes && !!key && grantedScopes[key] !== true;
        item.classList.toggle('is-blocked', blocked);
        let hit = !query || item.textContent.toLowerCase().includes(query);
        if (hit && onlyAvailable && blocked) hit = false;
        item.hidden = !hit;
        item.dataset.match = hit ? '1' : '0';
        if (hit) any = true;
      }
      group.hidden = !any;
      if (any) shown += 1;
    }
    if (query && shown === 0 && input) input.setAttribute('data-empty', '1');
    else if (input) input.removeAttribute('data-empty');
    // Оглавление разделов повторяет фильтр: ссылка остаётся только там, где
    // остались карточки, иначе список обещает то, чего на экране нет.
    for (const tocGroup of document.querySelectorAll('[data-recipes-toc-group]')) {
      let anyToc = false;
      for (const item of tocGroup.querySelectorAll('.xapi-toc-item')) {
        const card = document.getElementById(String(item.querySelector('a').getAttribute('href') || '').slice(1));
        const hit = !!card && !card.hidden;
        item.hidden = !hit;
        if (hit) anyToc = true;
      }
      tocGroup.hidden = !anyToc;
    }
    const counter = $('#recipes-count');
    if (counter) {
      counter.textContent =
        query || onlyAvailable
          ? shown
            ? `показано ${shown} групп из ${recipeGroupList.length}`
            : 'под фильтр не попал ни один рецепт — ослабьте запрос или снимите переключатель'
          : `рецептов: ${recipeCatalog.length}`;
      counter.classList.toggle('is-empty', (!!query || onlyAvailable) && !shown);
    }
    applyRefView('recipes');
  }

  /* ------------------------------------------------------------------ */
  /*  Вкладка «Обзор»: живая картина по всем разделам                    */
  /* ------------------------------------------------------------------ */

  const money = value =>
    new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value) || 0);

  /** Дата «2026-11-24» → «24.11.2026»; мусор не превращаем в NaN. */
  function ruDate(value) {
    const text = String(value ?? '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value ?? '—');
  }

  function overviewCard(title, rows, note = '') {
    return `<div class="xapi-card">
      <div class="xapi-card-head"><strong>${escapeHtml(title)}</strong></div>
      ${note ? `<p class="xapi-note">${escapeHtml(note)}</p>` : ''}
      <dl class="xapi-kv">${rows
        .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join('')}</dl>
    </div>`;
  }

  /** Марафоны: прогресс из totals (считает сервер), серии — отдельно. */
  function renderOverviewMarathons(list) {
    const box = $('#overview-marathons');
    if (!list.length) {
      box.innerHTML = '<p class="xapi-note">Марафонов нет.</p>';
      return;
    }
    box.innerHTML = list
      .map(marathon => {
        if (marathon.kind === 'series') {
          return overviewCard(marathon.title || marathon.id, [
            ['Тип', 'папка марафонов'],
            ['Внутри', `${(marathon.childIds || []).length} шт.`]
          ]);
        }
        const totals = marathon.totals || null;
        const rows = [
          ['Сроки', `${ruDate(marathon.startDate)} — ${ruDate(marathon.endDate)}`],
          ['Участников', String((marathon.participantIds || []).length)],
          ['Заданий', String((marathon.tasks || []).length)]
        ];
        if (totals) {
          rows.push(
            ['Проверок', `${money(totals.checks)} / ${money(totals.maxChecks)} (${totals.percent}%)`],
            ['Заданий сдано', `${money(totals.done)} из ${money(totals.cells)}`],
            ['Монет', `${money(totals.coins)} / ${money(totals.maxCoins)}`]
          );
          if (totals.failing) rows.push(['Провалено', money(totals.failing)]);
        }
        return overviewCard(marathon.title || marathon.id, rows, marathon.status === 'completed' ? 'завершён' : '');
      })
      .join('');
  }

  /** Планировщик: только ближайшие — дальше человеку не нужно. */
  function renderOverviewPlanner(entries) {
    const box = $('#overview-planner');
    const today = new Date().toISOString().slice(0, 10);
    const next = entries
      .filter(entry => !entry.date || String(entry.date).slice(0, 10) >= today)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .slice(0, 6);
    if (!next.length) {
      box.innerHTML = '<p class="xapi-note">Будущих записей нет.</p>';
      return;
    }
    box.innerHTML = next
      .map(entry =>
        overviewCard(entry.title || entry.id, [
          ['Когда', `${ruDate(entry.date)}${entry.time ? `, ${entry.time}` : ''}`],
          ['Вид', String(entry.kind || '—')],
          ['Повтор', String(entry.recurrence || 'нет')]
        ])
      )
      .join('');
  }

  /** Учёт: сколько пришло и ушло, сколько открытых долгов. */
  function renderOverviewFinance(finance) {
    const box = $('#overview-finance');
    const operations = finance.operations || [];
    const income = operations.filter(op => op.kind === 'in').reduce((sum, op) => sum + (Number(op.amount) || 0), 0);
    const outcome = operations.filter(op => op.kind === 'out').reduce((sum, op) => sum + (Number(op.amount) || 0), 0);
    const loans = (finance.loans || []).filter(loan => !loan.closed);
    const debt = loans.reduce((sum, loan) => sum + (Number(loan.amount) || 0), 0);
    box.innerHTML = overviewCard(
      'Итоги',
      [
        ['Операций', String(operations.length)],
        ['Пришло', money(income)],
        ['Ушло', money(outcome)],
        ['Баланс', money(income - outcome)],
        ['Открытых долгов', `${loans.length} на ${money(debt)}`],
        ['Позиций в магазине', String((finance.shopItems || []).length)]
      ],
      `Курс золота: ${money(finance.settings?.goldRate)}`
    );
  }

  /** Окна: кто открыт и сколько висит. */
  function renderOverviewWindows(windows) {
    const box = $('#overview-windows');
    if (!windows.length) {
      box.innerHTML = '<p class="xapi-note">Окон игры не запущено.</p>';
      return;
    }
    box.innerHTML = windows
      .map(window => {
        const rows = [['PID', String(window.pid ?? '—')]];
        if (window.nick) rows.push(['Персонаж', `${window.nick}${window.class ? ` (${window.class})` : ''}`]);
        rows.push(['Подпись окна', String(window.title || '—')]);
        if (window.startedAt) rows.push(['Запущено', String(window.startedAt)]);
        if (window.elevated !== null && window.elevated !== undefined)
          rows.push(['Права', window.elevated ? 'повышенные' : 'обычные']);
        return overviewCard(window.nick || `PID ${window.pid}`, rows);
      })
      .join('');
  }

  /** Загрузить всё для обзора одним заходом; отказ одной части не скрывает другие. */
  async function loadOverview() {
    const status = $('#overview-status');
    status.textContent = 'Загружаю…';
    const [marathons, planner, finance, windows] = await Promise.all([
      api('/api/v1/marathons'),
      api('/api/v1/planner'),
      api('/api/v1/finance'),
      api('/api/v1/windows')
    ]);
    const failed = [];
    const pick = (result, name, render) => {
      if (result.ok && result.body) render(result.body);
      else {
        failed.push(`${name}: ${errorText(result)}`);
        render({});
      }
    };
    pick(marathons, 'марафоны', body => renderOverviewMarathons(Array.isArray(body.marathons) ? body.marathons : []));
    pick(planner, 'планировщик', body => renderOverviewPlanner(Array.isArray(body.entries) ? body.entries : []));
    pick(finance, 'учёт', body => renderOverviewFinance(body || {}));
    pick(windows, 'окна', body => renderOverviewWindows(Array.isArray(body.windows) ? body.windows : []));
    status.textContent = failed.length ? `Часть данных не загрузилась — ${failed.join('; ')}` : '';
  }

  /* ------------------------------------------------------------------ */
  /*  Вкладка «Действия»: форма → запрос → результат                     */
  /* ------------------------------------------------------------------ */

  /** Значения формы действия по умолчанию (учитывая уже загруженные списки). */
  function actionDefaults(action) {
    const values = {};
    for (const field of action.fields || []) {
      if (field.default !== undefined) values[field.name] = field.default;
      else if (field.type === 'checkbox') values[field.name] = false;
    }
    // Персонажа и пати подставляем из загруженного: меньше ручного ввода.
    const firstChar = latest.characters[0];
    const firstParty = latest.parties[0];
    for (const field of action.fields || []) {
      if (field.type === 'character' && firstChar) values[field.name] = firstChar.id;
      if (field.type === 'party' && firstParty) values[field.name] = firstParty.id;
    }
    return values;
  }

  /** Варианты выбора для поля: из загруженных данных или из описания. */
  /**
   * Поле «id персонажа/пати» — это select с подставленными вариантами, но рядом
   * есть и ручной ввод: если список не загрузился (нет права чтения) или нужного
   * id нет в списке, форма обязана работать, а не блокировать отправку.
   */
  function actionPickHtml(field, values, options, id) {
    const hint = field.hint ? `<span class="xapi-field-hint">${escapeHtml(field.hint)}</span>` : '';
    if (!options.length) {
      return `<label class="xapi-field">${escapeHtml(field.label)}
        <input id="${id}" type="text" data-field="${escapeHtml(field.name)}" value="${escapeHtml(String(values[field.name] ?? ''))}" autocomplete="off" spellcheck="false"${field.required ? ' required' : ''} />${hint}</label>`;
    }
    return `<label class="xapi-field">${escapeHtml(field.label)}
      <select id="${id}" data-field="${escapeHtml(field.name)}"${field.required ? ' required' : ''}>
        ${field.required ? '' : '<option value="">— не важно —</option>'}
        ${options
          .map(option => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(values[field.name]) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
          .join('')}
      </select>${hint}</label>`;
  }
  function actionOptions(field) {
    if (field.options) return field.options.map(value => ({ value, label: value }));
    if (field.type === 'character')
      return latest.characters.map(char => ({ value: char.id, label: `${char.nick || char.id} (${char.id})` }));
    if (field.type === 'party')
      return latest.parties.map(party => ({ value: party.id, label: party.name || party.id }));
    return [];
  }

  /** Поле формы: тип берётся из описания действия. */
  function actionFieldHtml(field, values) {
    const value = values[field.name] ?? '';
    const id = `act-${field.name}`;
    const required = field.required ? ' required' : '';
    const hint = field.hint ? `<span class="xapi-field-hint">${escapeHtml(field.hint)}</span>` : '';
    if (field.type === 'select' || field.type === 'character' || field.type === 'party') {
      return actionPickHtml(field, values, actionOptions(field), id);
    }
    if (field.type === 'checkbox') {
      const on = value === true || value === 'true';
      return `<label class="xapi-field xapi-field-check"><input id="${id}" type="checkbox" data-field="${escapeHtml(field.name)}"${on ? ' checked' : ''} /> ${escapeHtml(field.label)}${hint}</label>`;
    }
    const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    return `<label class="xapi-field">${escapeHtml(field.label)}
      <input id="${id}" type="${type}" data-field="${escapeHtml(field.name)}" value="${escapeHtml(String(value))}" autocomplete="off" spellcheck="false"${required} />${hint}</label>`;
  }

  /** Прочитать значения формы. */
  function readActionValues(action) {
    const values = {};
    for (const field of action.fields || []) {
      const input = document.querySelector(`#action-fields [data-field="${field.name}"]`);
      if (!input) continue;
      if (field.type === 'checkbox') values[field.name] = !!input.checked;
      else values[field.name] = String(input.value || '').trim();
    }
    return values;
  }

  /** Готовый путь и тело запроса по значениям формы. */
  function buildActionRequest(action, values) {
    const path = action.pathOf ? action.pathOf(values) : action.path;
    const query = action.query ? action.query(values) : '';
    const body = action.body ? action.body(values) : undefined;
    return { path: `${path}${query}`, body };
  }

  /** Проверка обязательных полей: лучше сказать до запроса, чем получить 422. */
  function missingActionFields(action, values) {
    return (action.fields || [])
      .filter(field => field.required && (values[field.name] === '' || values[field.name] === undefined || values[field.name] === null))
      .map(field => field.label);
  }

  function renderActionsList() {
    const box = $('#actions-list');
    const query = String($('#actions-filter')?.value || '').trim().toLowerCase();
    if (!actions.length) {
      box.innerHTML = '<p class="xapi-note">Файл actions.js не подключён: список действий недоступен.</p>';
      return;
    }
    const groups = new Map();
    for (const action of actions) {
      const text = `${action.title} ${action.summary} ${action.method} ${action.path}`.toLowerCase();
      if (query && !text.includes(query)) continue;
      if (!groups.has(action.group)) groups.set(action.group, []);
      groups.get(action.group).push(action);
    }
    const shown = [...groups.values()].reduce((sum, listOf) => sum + listOf.length, 0);
    const count = $('#actions-count');
    if (count) count.textContent = query ? `найдено: ${shown} из ${actions.length}` : `всего действий: ${actions.length}`;
    if (!shown) {
      box.innerHTML = '<p class="xapi-note">Ничего не найдено: попробуйте «стат», «проходки», «запуск», «выгрузка».</p>';
      return;
    }
    box.innerHTML = [...groups.entries()]
      .map(
        ([group, listOf]) => `<div class="xapi-action-group">
          <h3 class="xapi-sub">${escapeHtml(group)}</h3>
          <div class="xapi-actions-cards">${listOf
            .map(action => {
              const badge = action.danger ? '<span class="xapi-badge is-warn">⚠ подтверждение</span>' : '';
              const scope = `<span class="xapi-badge is-idle">${escapeHtml(scopeLabel(action.scope))}</span>`;
              return `<button type="button" class="xapi-action-card" data-action="${escapeHtml(action.id)}">
                <span class="xapi-action-title">${escapeHtml(action.title)} ${badge}</span>
                <span class="xapi-action-summary">${escapeHtml(action.summary)}</span>
                <span class="xapi-action-route">${escapeHtml(action.method)} ${escapeHtml(action.path)} ${scope}</span>
              </button>`;
            })
            .join('')}</div>
        </div>`
      )
      .join('');
    for (const card of box.querySelectorAll('[data-action]'))
      card.addEventListener('click', () => openAction(card.dataset.action));
  }

  function scopeLabel(scope) {
    if (scope === 'modify') return 'право: изменение';
    if (scope === 'launchClose') return 'право: запуск';
    return 'право: чтение';
  }

  /** Открыть форму действия. */
  function openAction(id) {
    const action = actions.find(item => item.id === id);
    if (!action) return;
    activeAction = action;
    const values = actionDefaults(action);
    $('#actions-form').hidden = false;
    $('#action-title').textContent = action.title;
    // Маршрут показываем с подставленными значениями; незаполненное — как есть,
    // чтобы было видно, чего не хватает (например «{stat}»).
    $('#action-route').textContent = `${action.method} ${action.path}`;
    updateActionRoute();
    $('#action-summary').textContent = action.summary;
    $('#action-fields').innerHTML = (action.fields || []).length
      ? action.fields.map(field => actionFieldHtml(field, values)).join('')
      : '<p class="xapi-note">Параметров нет: запрос выполнится как есть.</p>';
    $('#action-out').textContent = 'Здесь появится ответ сервера.';
    $('#action-status').textContent = '';
    // scrollIntoView есть не везде (например в jsdom) — без него форма всё равно работает.
    $('#actions-form').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  function closeAction() {
    activeAction = null;
    $('#actions-form').hidden = true;
    $('#actions-list').hidden = false;
  }

  /** Обновить подпись маршрута по текущим значениям формы. */
  function updateActionRoute() {
    if (!activeAction) return;
    const request = buildActionRequest(activeAction, readActionValues(activeAction));
    $('#action-route').textContent = `${activeAction.method} ${request.path}`;
  }

  /** Выполнить действие: проверка → подтверждение → запрос → результат. */
  async function runAction() {
    const action = activeAction;
    if (!action) return;
    const values = readActionValues(action);
    const missing = missingActionFields(action, values);
    if (missing.length) {
      $('#action-status').textContent = `Заполните: ${missing.join(', ')}.`;
      return;
    }
    const request = buildActionRequest(action, values);
    if (action.danger && action.confirmText && !window.confirm(action.confirmText(values))) {
      $('#action-status').textContent = 'Отменено: подтверждение не получено.';
      return;
    }
    const status = $('#action-status');
    const button = $('#action-send');
    button.disabled = true;
    status.textContent = 'Отправляю…';
    try {
      const result = await api(request.path, {
        method: action.method,
        body: action.method === 'GET' ? undefined : request.body
      });
      renderActionResult(action, values, request, result);
    } catch (error) {
      status.textContent = `Сеть не ответила: ${error && error.message ? error.message : error}`;
    } finally {
      button.disabled = false;
    }
  }

  function renderActionResult(action, values, request, result) {
    const status = $('#action-status');
    const out = $('#action-out');
    if (result.ok) {
      const summary = action.result ? action.result(result.body, values) : 'готово';
      status.textContent = `✅ ${result.status} · ${summary}`;
      out.textContent = JSON.stringify(result.body, null, 2);
      // Списки могли измениться (создали персонажа, переименовали пати) — обновим.
      if (/^(POST|PATCH)$/.test(action.method)) {
        refreshListsQuietly();
        // Показанное в «Обзоре» тоже устарело — обновим тихо, без сообщений.
        loadOverview().catch(() => {});
      }
      return;
    }
    status.textContent = `❌ ${errorText(result)}`;
    out.textContent = `${request.path}\n\n${JSON.stringify(result.body, null, 2)}`;
    // 403 — права выключены в настройках: подсказываем, где включить.
    if (result.status === 403) status.textContent += ' Включите право в «Настройки → 🔌 Внешний API».';
  }

  /** Тихо обновить персонажей и пати после изменения, чтобы формы были актуальны. */
  async function refreshListsQuietly() {
    try {
      // `full=true`: панель показывает статы и проходки каждой карточки, а список по
      // умолчанию их не отдаёт — без флага блок со статами просто опустел бы.
      const [characters, parties] = await Promise.all([
        api('/api/v1/characters?full=true'),
        api('/api/v1/parties')
      ]);
      if (characters.ok && characters.body) latest.characters = characters.body.characters || [];
      if (parties.ok && parties.body) latest.parties = parties.body.parties || [];
    } catch {
      /* список не критичен: форма уже показала результат */
    }
  }

  /**
   * Перейти к разделу справочника: вкладка «Справочник», прокрутка, подсветка.
   *
   * Адрес (`#m-chtenie-characters`) меняется сразу, поэтому ссылку можно
   * скопировать из строки браузера и отдать другому — она приведёт ровно к одному
   * методу, а не к началу страницы. Ссылки из оглавления настоящие, поэтому
   * переход работает и без JS: обработчик добавляет только прокрутку и подсветку.
   */
  /* ------------------------------------------------------------------ */
  /*  Режим показа справок: «по одной карточке» или «все списком»        */
  /* ------------------------------------------------------------------ */

  const refCardSel = kind => (kind === 'docs' ? '[data-doc]' : '[data-recipe]');
  const refGroupSel = kind => (kind === 'docs' ? '[data-doc-group]' : '[data-recipe-group]');
  const refRoot = kind => document.getElementById(kind === 'docs' ? 'docs-body' : 'recipes-body');

  /** Все карточки страницы. */
  function refCards(kind) {
    const root = refRoot(kind);
    return root ? [...root.querySelectorAll(refCardSel(kind))] : [];
  }

  /**
   * Карточки, прошедшие фильтр. Отличаем от `hidden`: в режиме «по одной» скрыто всё
   * кроме выбранного, и если читать `hidden`, список для листания схлопнулся бы до
   * одной строки — «следующий» и «предыдущий» перестали бы ходить.
   */
  function refMatched(kind) {
    return refCards(kind).filter(card => card.dataset.match !== '0');
  }

  /**
   * Применить режим и выбор: какая карточка открыта, какая группа вокруг неё,
   * что подсвечено в оглавлении и какие строки показывать в панели перехода.
   */
  function applyRefView(kind) {
    const root = refRoot(kind);
    if (!root) return;
    const one = refView === 'one';
    const matched = refMatched(kind);
    let selected = refSelected[kind];
    if (one && (!selected || !matched.some(card => card.id === selected))) {
      // Выбор не должен висеть на том, что фильтр уже убрал, и не должен быть
      // пустым, когда под фильтр что-то попало: справа всегда есть что читать.
      selected = matched.length ? matched[0].id : '';
      refSelected[kind] = selected;
    }
    root.dataset.view = one ? 'one' : 'all';
    // `hidden` остаётся собственностью фильтра, режим показа — классы: два
    // независимых смысла в одном флаге неизбежно разошлись бы (и тесты, и CSS).
    for (const card of refCards(kind)) card.classList.toggle('is-selected', one && card.id === selected);
    for (const group of root.querySelectorAll(refGroupSel(kind)))
      group.classList.toggle(
        'is-open',
        one && [...group.querySelectorAll(refCardSel(kind))].some(card => card.id === selected)
      );
    const toc = document.getElementById(kind === 'docs' ? 'docs-toc' : 'recipes-toc');
    if (toc) {
      // Подсвечивается и строка, и её раздел: в списке из сорока ссылок без
      // заголовка непонятно, в какой половине страницы смотришь.
      const groupId = one && selected ? document.getElementById(selected)?.closest(refGroupSel(kind))?.id || '' : '';
      for (const link of toc.querySelectorAll('a[href^="#"]')) {
        const href = link.getAttribute('href');
        const on = one && (href === `#${selected}` || (!!groupId && href === `#${groupId}`));
        link.classList.toggle('is-on', on);
        if (on) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    }
    renderRefNav(kind, matched, selected);
  }

  /** Панель «← предыдущий · 7 из 40 · следующий →»: листание по тому, что не скрыто фильтром. */
  function renderRefNav(kind, matched, selected) {
    const nav = document.querySelector(`[data-refnav="${kind}"]`);
    if (!nav) return;
    const index = matched.findIndex(card => card.id === selected);
    const show = refView === 'one' && matched.length > 0;
    nav.hidden = !show;
    if (!show) return;
    // Подпись: заголовок карточки — `h4` есть и в методах (краткое описание), и в
    // рецептах (название): «5 из 40 · Список персонажей» отвечает на «где я» лучше,
    // чем номер без контекста.
    const title = index >= 0 ? (matched[index].querySelector('h4')?.textContent || '').trim().slice(0, 60) : '';
    const note = nav.querySelector('[data-ref-pos]');
    if (note) note.textContent = `${index + 1} из ${matched.length}${title ? ` · ${title}` : ''}`;
    const prev = nav.querySelector('[data-ref-step="-1"]');
    const next = nav.querySelector('[data-ref-step="1"]');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index < 0 || index >= matched.length - 1;
  }

  /** Открыть карточку: выбор, адрес и подсветка. Прокрутка нужна только в режиме списка. */
  function selectRef(kind, id) {
    if (!id) return false;
    refSelected[kind] = id;
    applyRefView(kind);
    if (location.hash.slice(1) !== id) {
      try {
        history.replaceState(null, '', `#${id}`);
      } catch {
        /* file:// — адрес не пишется, выбор работает и без него */
      }
    }
    const card = document.getElementById(id);
    if (!card) return true;
    // Прокрутка — только в режиме списка, где карточку надо ещё догнать. В режиме
    // «по одной» прокрутка не нужна вовсе, и тем более не нужен возврат наверх:
    // оглавление липкое, выбор в нём человек делает, не отрывая глаз от детали
    // справа, а прыжок страницы каждый раз уносил бы его к шапке.
    if (refView === 'all') card.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    card.classList.add('is-target');
    setTimeout(() => card.classList.remove('is-target'), 1600);
    return true;
  }

  /** Шаг по списку: `delta` = ±1, в пределах того, что оставил фильтр. */
  function stepRef(kind, delta) {
    const matched = refMatched(kind);
    if (!matched.length) return;
    const index = matched.findIndex(card => card.id === refSelected[kind]);
    const next = matched[Math.min(matched.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))];
    if (next) selectRef(kind, next.id);
  }

  /**
   * Ссылка или клик в оглавлении. Ссылка на раздел (`#g-…`, `#rg-…`) в режиме
   * «по одной» открывает первую карточку раздела: раздел сам по себе читать нечего,
   * а молча ничего не делать — значит обмануть ожидание от клика.
   */
  /**
   * Сброс фильтра перед переходом по якорю. Ссылка на то, что фильтр сейчас спрятал,
   * важнее фильтра: такой адрес дают в чате и в задаче ради конкретного метода, и
   * показывать вместо него первую совпавшую карточку — значит привести не туда.
   */
  function clearRefFilter(kind) {
    if (kind === 'docs') {
      const box = $('#docs-filter');
      if (box) box.value = '';
      for (const id of ['docs-only-read', 'docs-only-available']) {
        const el = document.getElementById(id);
        if (el && !el.disabled) el.checked = false;
      }
      filterDocs();
      return;
    }
    const box = $('#recipes-filter');
    if (box) box.value = '';
    const available = $('#recipes-only-available');
    if (available && !available.disabled) available.checked = false;
    filterRecipes();
  }

  function refJump(kind, hash) {
    const id = String(hash || '').replace(/^#/, '');
    if (!id) return false;
    const target = document.getElementById(id);
    if (!target) return false;
    if (refView === 'one' && target.matches(refCardSel(kind)) && target.dataset.match === '0') clearRefFilter(kind);
    if (refView === 'one' && target.matches(refGroupSel(kind))) {
      const first = [...target.querySelectorAll(refCardSel(kind))].find(card => card.dataset.match !== '0');
      return selectRef(kind, first ? first.id : id);
    }
    return selectRef(kind, target.id);
  }

  /** Режим показа для обеих страниц сразу: выбор человек делает один, а не на каждой. */
  function setRefView(value) {
    refView = value === 'all' ? 'all' : 'one';
    try {
      localStorage.setItem(refViewKey, refView);
    } catch {
      /* приватный режим */
    }
    for (const button of document.querySelectorAll('[data-ref-mode]')) {
      const on = button.dataset.refMode === refView;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    applyRefView('docs');
    applyRefView('recipes');
  }

  function goToDoc(hash) {
    if (page !== 'docs') showTab('docs');
    return refJump('docs', hash);
  }

  /**
   * Оглавление справочника: группа и каждый её метод отдельной строкой.
   *
   * Раньше были только ссылки на группы: при тридцати с лишним методах это
   * «нажми и листай». Метод подписан методом и путём — так его находят по имени
   * пути, а не по названию группы, и тот же текст служит ключом поиска.
   */
  function docsTocHtml() {
    return docs.groups
      .map(group => {
        const items = group.methods
          .map(
            method =>
              `<li class="xapi-toc-item"><a class="xapi-toc-method" data-toc-method href="#${escapeHtml(docsMethodId(group, method))}"><code>${escapeHtml(method.method)}</code><span>${escapeHtml(method.path)}</span></a></li>`
          )
          .join('');
        return `<div class="xapi-toc-group" data-toc-group>
          <a class="xapi-toc-link" href="#g-${escapeHtml(group.id)}">${escapeHtml(group.title)}<span class="xapi-toc-count">${group.methods.length}</span></a>
          <ul class="xapi-toc-methods">${items}</ul>
        </div>`;
      })
      .join('');
  }

  function renderDocs() {
    const body = $('#docs-body');
    if (!docs.groups.length) {
      body.innerHTML = '<p class="xapi-note">Справочник не загрузился: файл docs.js не подключён.</p>';
      return;
    }
    // Карточки рисуются один раз, но в них подставлены id из «Данных»: поменялись
    // списки (подключились, обновили) — значит пора перерисовать, а не показывать
    // чужие «Mag_1» из документации.
    const stamp = referenceStampNow();
    if (body.dataset.stamp !== stamp) {
      body.dataset.stamp = stamp;
      $('#docs-toc').innerHTML = docsTocHtml();
      body.innerHTML = docs.groups
        .map(
          group => `<section class="xapi-doc-group" id="g-${escapeHtml(group.id)}" data-doc-group>
        <h3>${escapeHtml(group.title)}</h3>
        <p class="xapi-note">${escapeHtml(group.summary)}</p>
        ${group.methods.map(method => methodHtml(group, method)).join('')}
      </section>`
        )
        .join('');
      bindRunPanels(body);
      // Оглавление — настоящие ссылки: работают и без JS-переходов. Обработчик
      // добавляет прокрутку и запись адреса; группы и методы идут одним путём.
      for (const link of document.querySelectorAll('#docs-toc a[href^="#"]'))
        link.addEventListener('click', event => {
          event.preventDefault();
          goToDoc(link.getAttribute('href'));
        });
      // Кнопка «ссылка» в карточке метода: адрес в буфер — вставить в чат, задачу
      // или AGENTS.md, чтобы другой человек открыл ровно этот метод.
      for (const button of body.querySelectorAll('[data-doc-link]'))
        button.addEventListener('click', async () => {
          void copyLink(button, pageUrl('docs', button.dataset.docLink));
        });
    }
    filterDocs();
    // Ссылка с якорем важнее начала страницы: `#m-…` открывают ради конкретного метода.
    if (location.hash) goToDoc(location.hash);
  }

  /**
   * Доступность права для карточки: «изменение» и «запуск» выключены по умолчанию,
   * и без этой отметки метод выглядит сломанным, хотя он просто закрыт токеном.
   */
  function docCardBlocked(doc) {
    const key = doc.dataset.docScope;
    return !!grantedScopes && !!key && grantedScopes[key] !== true;
  }

  /** Переключатели «только …» рядом с поиском. */
  function syncDocsFilter() {
    const available = $('#docs-only-available');
    if (!available) return;
    available.disabled = !grantedScopes;
    if (!grantedScopes) available.checked = false;
    filterDocs();
  }

  /**
   * Подсказка под фильтрами. Пустой результат надо называть словами: без этого
   * человек видит пустое место и не понимает, что фильтр просто слишком узкий.
   */
  function docsFilterHint(shown, total) {
    const hint = $('#docs-filter-hint');
    if (!hint) return;
    const access = grantedScopes
      ? 'Фильтры работают по правам вашего токена.'
      : 'Подключитесь токеном — тогда появятся фильтры по правам.';
    if (shown === total) {
      hint.textContent = access;
      hint.classList.remove('is-empty');
      return;
    }
    hint.textContent = shown
      ? `${access} Показано методов: ${shown} из ${total}.`
      : `${access} Под фильтр не попал ни один метод — ослабьте запрос или снимите переключатели.`;
    hint.classList.toggle('is-empty', !shown);
  }

  /** Все карточки методов: нужны, чтобы сказать «показано N из M». */
  function docCards() {
    return [...document.querySelectorAll('#docs-body [data-doc]')];
  }

  /** Поиск и фильтры: скрывают группы и методы, где нет совпадения. */
  function filterDocs() {
    const input = $('#docs-filter');
    const query = (input ? input.value : '').trim().toLowerCase();
    const onlyRead = !!$('#docs-only-read') && $('#docs-only-read').checked;
    const onlyAvailable = !!$('#docs-only-available') && $('#docs-only-available').checked;
    let groups = 0;
    let shown = 0;
    for (const group of document.querySelectorAll('[data-doc-group]')) {
      let any = false;
      for (const doc of group.querySelectorAll('[data-doc]')) {
        doc.classList.toggle('is-blocked', docCardBlocked(doc));
        let hit = !query || doc.textContent.toLowerCase().includes(query);
        if (hit && onlyRead && doc.dataset.docRead !== '1') hit = false;
        if (hit && onlyAvailable && docCardBlocked(doc)) hit = false;
        doc.hidden = !hit;
        // Отдельная отметка «прошёл фильтр»: режим «по одной» прячет карточки сам,
        // и по одному `hidden` было бы не понять, отфильтровано или просто не выбрано.
        doc.dataset.match = hit ? '1' : '0';
        if (hit) {
          any = true;
          shown += 1;
        }
      }
      group.hidden = !any;
      if (any) groups += 1;
    }
    if (query && !shown && input) input.setAttribute('data-empty', '1');
    else if (input) input.removeAttribute('data-empty');
    docsFilterHint(shown, docCards().length);
    // Оглавление повторяет результат по карточкам: ссылка остаётся ровно там, где
    // остался сам метод. Искать отдельно по подписям ссылок — два списка, которые
    // неизбежно разъезжаются (текста в карточке больше, чем в подписи).
    let tocHits = 0;
    for (const tocGroup of document.querySelectorAll('[data-toc-group]')) {
      let anyToc = false;
      for (const link of tocGroup.querySelectorAll('[data-toc-method]')) {
        const card = document.getElementById(String(link.getAttribute('href') || '').slice(1));
        const hit = !!card && !card.hidden;
        const item = link.closest('li') || link;
        item.hidden = !hit;
        if (hit) {
          anyToc = true;
          tocHits += 1;
        }
      }
      tocGroup.hidden = !anyToc;
    }
    const counter = $('#docs-toc-count');
    if (counter) {
      const total = docs.groups.reduce((sum, group) => sum + group.methods.length, 0);
      const filtered = query || onlyRead || onlyAvailable;
      counter.textContent = filtered ? `показано ${tocHits} из ${total}` : `методов: ${total}`;
    }
    applyRefView('docs');
  }

  async function loadAll() {
    const health = await api('/api/v1/health');
    if (!health.ok) {
      setChip('server', `сервер: ${health.status === 401 ? 'токен не принят' : 'недоступен'}`, 'bad');
      $('#connect-note').textContent = `${errorText(health)}. Проверьте токен в настройках приложения.`;
      // Справочник не зависит от токена: его можно читать и без подключения.
      if (!page && activeTab === 'panel') showTab('docs');
      return false;
    }
    const info = health.body || {};
    setChip('server', `сервер: работает${info.app && info.app.version ? `, версия ${info.app.version}` : ''}`, 'ok');
    setChip('port', `порт: ${location.port || '—'}`, 'ok');
    const scopes = info.scopes || {};
    grantedScopes = scopes;
    const scopeNames = [
      scopes.read ? 'чтение' : null,
      scopes.modify ? 'изменение' : null,
      scopes.launchClose ? 'запуск и закрытие' : null
    ].filter(Boolean);
    setChip('scopes', `права: ${scopeNames.length ? scopeNames.join(' · ') : 'нет'}`, scopeNames.length ? 'ok' : 'warn');
    const writable = info.storage && info.storage.writable !== false;
    setChip('storage', writable ? 'запись: разрешена' : 'запись: остановлена защитой', writable ? 'ok' : 'bad');
    $('#connect-note').textContent = writable
      ? 'Токен принят. Все запросы ниже идут с ним.'
      : 'Токен принят, но запись состояния остановлена: изменения вернут 423 storage_blocked.';

    // Список по умолчанию лёгкий (без статов), а «Данные» рисуют статы — поэтому
    // страница просит полные карточки явно. Молча потерять блок со статами —
    // значит оставить пользователя гадать, то ли их удалили, то ли не было.
    const [characters, parties, windows] = await Promise.all([
      api('/api/v1/characters?full=true'),
      api('/api/v1/parties'),
      api('/api/v1/windows')
    ]);
    latest = {
      characters: characters.ok && characters.body ? characters.body.characters || [] : [],
      parties: parties.ok && parties.body ? parties.body.parties || [] : [],
      windows: windows.ok && windows.body ? windows.body.windows || [] : []
    };
    renderCharacters(latest.characters);
    renderParties(latest.parties);
    renderWindows(latest.windows);
    // «Данные» показываем, только если они и есть открытая вкладка: иначе загрузка
    // прилепляла вторую панель под той, на которой человек стоит (две сразу).
    if (!page && activeTab === 'panel') $('#panel').hidden = false;
    $('#reload-audit').hidden = false;
    // Списки персонажей и пати могли поменяться — формы действий строятся из них.
    renderActionsList();
    // Справочник и рецепты строятся из этих списков (в них подставлены id): после
    // подключения они обязаны показывать ваши id, а не те, что были на экране до.
    if (currentSection() === 'docs') renderDocs();
    if (currentSection() === 'recipes') renderRecipes();
    syncDocsFilter();
    const recipesToggle = $('#recipes-only-available');
    if (recipesToggle) {
      recipesToggle.disabled = !grantedScopes;
      if (!grantedScopes) recipesToggle.checked = false;
    }
    if (currentSection() === 'recipes') renderRecipes();
    await loadAudit();
    return true;
  }

  async function connect() {
    token = tokenInput.value.trim();
    if (!token) {
      $('#connect-note').textContent = 'Введите токен: он создан в настройках приложения.';
      tokenInput.focus();
      return;
    }
    sessionStorage.setItem(storageKey, token);
    renderRecipe();
    const button = $('#connect');
    button.disabled = true;
    button.textContent = 'Проверяю…';
    try {
      await loadAll();
    } catch (error) {
      setChip('server', 'сервер: не отвечает', 'bad');
      $('#connect-note').textContent = `Сервер не ответил: ${error && error.message ? error.message : error}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Подключиться';
    }
  }

  function forget() {
    token = '';
    grantedScopes = null;
    sessionStorage.removeItem(storageKey);
    tokenInput.value = '';
    $('#panel').hidden = true;
    $('#reload-audit').hidden = true;
    renderAudit([]);
    setChip('server', 'сервер: не подключено', null);
    setChip('port', 'порт: —', null);
    setChip('scopes', 'права: —', null);
    setChip('storage', 'запись: —', null);
    $('#connect-note').textContent = 'Токен удалён из вкладки. Сами запросы от этого не выключаются.';
    syncDocsFilter();
    renderRecipe();
  }

  async function reload() {
    const button = $('#reload');
    button.disabled = true;
    button.textContent = 'Обновляю…';
    try {
      await loadAll();
    } finally {
      button.disabled = false;
      button.textContent = 'Обновить';
    }
  }

  function bind() {
    for (const tab of document.querySelectorAll('[data-tab]'))
      tab.addEventListener('click', e => {
        // Ссылка ведёт в то же приложение: перезагружать его ради смены раздела
        // незачем, адрес подставит history — и «назад» в браузере работает.
        if (tab.tagName === 'A') e.preventDefault();
        showTab(tab.dataset.tab || 'panel');
      });
    // Кнопка «назад» в браузере должна возвращать и на страницу, и с неё.
    window.addEventListener('popstate', () => {
      page = pageFromLocation();
      applyRoute();
      if (location.hash) goToDoc(location.hash);
    });
    $('#play-send').addEventListener('click', sendPlay);
    $('#play-clear').addEventListener('click', () => {
      $('#play-method').value = 'GET';
      $('#play-path').value = '';
      $('#play-body').value = '';
      $('#play-out').textContent = 'Здесь появится ответ сервера.';
      $('#play-status').textContent = '';
      setChip('play-code', 'код: —', null);
      setChip('play-time', 'время: —', null);
      setChip('play-type', 'тип: —', null);
      setChip('play-size', 'размер: —', null);
    });
    $('#play-copy').addEventListener('click', copyAsCurl);
    $('#play-path').addEventListener('keydown', event => {
      if (event.key === 'Enter') sendPlay();
    });
    $('#docs-filter').addEventListener('input', filterDocs);
    // Режим показа справок и переход по карточкам. Один клик — на обеих страницах:
    // человек выбирает, как читать, а не на каждой странице заново.
    for (const button of document.querySelectorAll('[data-ref-mode]'))
      button.addEventListener('click', () => setRefView(button.dataset.refMode));
    for (const nav of document.querySelectorAll('[data-refnav]')) {
      const kind = nav.dataset.refnav;
      for (const button of nav.querySelectorAll('[data-ref-step]'))
        button.addEventListener('click', () => stepRef(kind, Number(button.dataset.refStep)));
    }
    // Оглавление — список: ↑/↓ переставляют выбор, как в tabs. Мышь для этого
    // не нужна, а с клавиатуры справку листать быстрее всего.
    for (const id of ['docs-toc', 'recipes-toc']) {
      const toc = document.getElementById(id);
      if (!toc) continue;
      toc.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        stepRef(id === 'docs-toc' ? 'docs' : 'recipes', event.key === 'ArrowDown' ? 1 : -1);
        // `preventScroll`: фокус нужен, чтобы стрелки продолжали работать, но
        // перевод фокуса сам по себе прокручивает страницу к элементу — на узком
        // экране, где оглавление не липкое, это выглядело бы как прыжок.
        const link = document.querySelector(`#${id} a.is-on`);
        link?.focus?.({ preventScroll: true });
      });
    }
    for (const id of ['docs-only-read', 'docs-only-available'])
      $(`#${id}`)?.addEventListener('change', filterDocs);
    // Якорь, вставленный в адрес уже открытой страницы, тоже работает.
    window.addEventListener('hashchange', () => {
      if (!location.hash) return;
      // Якорь рецептов (`#rp-…`, `#rg-…`) означает «открой рецепты» — так же,
      // как `#m-…`/`#g-…` означают справочник.
      if (/^#(rp-|rg-)/.test(location.hash)) {
        if (page !== 'recipes') showTab('recipes');
        goToAnchor(location.hash);
        return;
      }
      goToDoc(location.hash);
    });
    // Вкладка «Рецепты».
    $('#recipes-filter')?.addEventListener('input', filterRecipes);
    $('#recipes-only-available')?.addEventListener('change', filterRecipes);
    for (const tab of document.querySelectorAll('[data-recipe-lang]')) {
      tab.addEventListener('click', () => setRecipeLanguage(tab.dataset.recipeLang || 'curl'));
    }
    // Вкладка «Действия».
    $('#overview-refresh')?.addEventListener('click', loadOverview);
    $('#actions-filter')?.addEventListener('input', renderActionsList);
    // Кнопки в карточках данных открывают форму действия с подставленным id.
    for (const box of ['#characters', '#windows']) {
      $(box)?.addEventListener('click', event => {
        const button = event.target.closest('[data-char-action]');
        if (!button) return;
        const action = actions.find(item => item.id === button.dataset.charAction);
        if (!action) return;
        showTab('actions');
        openAction(action.id);
        const value = button.dataset.charValue;
        // Подставить id в первое текстовое/выборочное поле (id персонажа или PID).
        const field = action.fields.find(item => item.name === 'id' || item.name === 'pids' || item.name === 'jobId');
        const input = field ? document.querySelector(`#action-fields [data-field="${field.name}"]`) : null;
        if (input && value) {
          input.value = value;
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        }
      });
    }
    $('#action-send')?.addEventListener('click', runAction);
    $('#action-cancel')?.addEventListener('click', closeAction);
    $('#action-open-playground')?.addEventListener('click', () => {
      if (!activeAction) return;
      const values = readActionValues(activeAction);
      const request = buildActionRequest(activeAction, values);
      useExample(request.path, activeAction.method, request.body ? JSON.stringify(request.body) : '');
    });
    // Живая подсказка маршрута: видно, какой адрес уйдёт на сервер.
    $('#action-fields')?.addEventListener('input', updateActionRoute);
    $('#connect').addEventListener('click', connect);
    $('#forget').addEventListener('click', forget);
    $('#reload').addEventListener('click', reload);
    $('#reload-audit').addEventListener('click', loadAudit);
    tokenInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') connect();
    });
    $('#copy-recipe').addEventListener('click', async () => {
      const text = $('#recipe').textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        $('#recipe-copied').textContent = 'Пример скопирован в буфер обмена.';
      } catch {
        $('#recipe-copied').textContent = 'Браузер не разрешил копирование: выделите пример и нажмите Ctrl+C.';
      }
    });
    for (const tab of document.querySelectorAll('.xapi-tab'))
      tab.addEventListener('click', () => {
        recipe = tab.dataset.recipe || 'curl';
        renderRecipe();
      });
  }

  fillBase();
  bind();
  // Разворачиваем режим показа до первой отрисовки: иначе на миг мелькает весь список,
  // а человек открывал один метод.
  setRefView(refView);
  syncDocsFilter();
  renderPresets();
  renderHints();
  renderActionsList();
  applyRoute();
  if (!page) showTab('panel');
  // Якорь рецепта на открытой странице рецептов: `#rp-…`/`#rg-…` должны найти цель
  // и на первой загрузке, а не только когда их вставили в адрес позже.
  if (page === 'recipes' && /^#(rp-|rg-)/.test(location.hash)) goToAnchor(location.hash);
  // Якорь справочника (`#m-…`, `#g-…`) означает «открой справочник»: иначе ссылка
  // привела бы на вкладку «Данные» и промахнулась бы по разделу, ради которого её
  // и вставили (а ссылки на методы — это то, чем делятся в задачах и AGENTS.md).
  if (/^#(m-|g-)/.test(location.hash)) showTab('docs');
  const saved = sessionStorage.getItem(storageKey);
  if (saved) {
    tokenInput.value = saved;
    token = saved;
    // Токен уже в этой вкладке — значит человек уже подключался. Заставлять его
    // жать «Подключиться» второй раз, чтобы увидеть данные и свои id в карточках,
    // значит оставить страницу «пустой» при каждом возврате на неё.
    loadAll().catch(() => setChip('server', 'сервер: недоступен', 'bad'));
  }
  renderRecipe();
})();
