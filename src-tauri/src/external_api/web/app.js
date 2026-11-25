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
  const docs = window.TF_API_DOCS || { groups: [], fieldLists: { stats: [], passes: [] } };

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

  function showTab(name) {
    activeTab = name;
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== name;
    }
    for (const tab of document.querySelectorAll('[data-tab]')) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-on', on);
      if (on) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (name === 'docs') renderDocs();
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
  function fillExamplePath(path) {
    let out = String(path);
    if (out.includes('/parties/')) out = out.replace('{id}', (latest.parties[0] && latest.parties[0].id) || 'p-osnova');
    else if (out.includes('/marathons/')) out = out.replace('{id}', 'm1');
    else out = out.replace('{id}', sampleCharId());
    return out
      .replace('{stat}', 'hp')
      .replace('{pass}', 'weapon')
      .replace('{jobId}', 'job_1')
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
    const canTry = method.method !== '—' && !String(method.path).startsWith('http');
    const examplePath = canTry ? fillExamplePath(method.path) : method.path;
    const bodyText = method.exampleBody ? JSON.stringify(method.exampleBody) : '';
    const tryButton = canTry
      ? `<button type="button" class="btn secondary small" data-try="${escapeHtml(examplePath)}" data-try-method="${escapeHtml(method.method)}" data-try-body="${escapeHtml(bodyText)}">Попробовать в тестовой строке</button>`
      : '';
    return `<article class="xapi-doc" id="${escapeHtml(id)}" data-doc>
      <div class="xapi-doc-head">
        <span class="xapi-doc-method is-${String(method.method).toLowerCase()}">${escapeHtml(badge)}</span>
        <code class="xapi-doc-path">${escapeHtml(method.path)}</code>
        <span class="xapi-chip">право: ${escapeHtml(method.scope)}</span>
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
        ${tryButton}
      </div>
    </article>`;
  }

  function renderDocs() {
    const body = $('#docs-body');
    if (!docs.groups.length) {
      body.innerHTML = '<p class="xapi-note">Справочник не загрузился: файл docs.js не подключён.</p>';
      return;
    }
    const onlyOnce = body.dataset.rendered === '1';
    if (!onlyOnce) {
      $('#docs-toc').innerHTML = docs.groups
        .map(
          group =>
            `<a class="xapi-toc-link" href="#g-${escapeHtml(group.id)}">${escapeHtml(group.title)} <span class="xapi-toc-count">${group.methods.length}</span></a>`
        )
        .join('');
      body.innerHTML = docs.groups
        .map(
          group => `<section class="xapi-doc-group" id="g-${escapeHtml(group.id)}" data-doc-group>
        <h3>${escapeHtml(group.title)}</h3>
        <p class="xapi-note">${escapeHtml(group.summary)}</p>
        ${group.methods.map(method => methodHtml(group, method)).join('')}
      </section>`
        )
        .join('');
      body.dataset.rendered = '1';
      for (const button of body.querySelectorAll('[data-try]'))
        button.addEventListener('click', () =>
          useExample(`/api/v1${button.dataset.try}`, button.dataset.tryMethod, button.dataset.tryBody)
        );
      // Оглавление — настоящие ссылки: работают и без JS-переходов.
      for (const link of document.querySelectorAll('.xapi-toc-link'))
        link.addEventListener('click', event => {
          event.preventDefault();
          const target = document.querySelector(link.getAttribute('href'));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    filterDocs();
  }

  /** Поиск: скрывает группы и методы, где нет совпадения. */
  function filterDocs() {
    const input = $('#docs-filter');
    const query = (input ? input.value : '').trim().toLowerCase();
    let shown = 0;
    for (const group of document.querySelectorAll('[data-doc-group]')) {
      let any = false;
      for (const doc of group.querySelectorAll('[data-doc]')) {
        const hit = !query || doc.textContent.toLowerCase().includes(query);
        doc.hidden = !hit;
        if (hit) any = true;
      }
      group.hidden = !any;
      if (any) shown += 1;
    }
    if (query && shown === 0 && input) input.setAttribute('data-empty', '1');
    else if (input) input.removeAttribute('data-empty');
  }

  async function loadAll() {
    const health = await api('/api/v1/health');
    if (!health.ok) {
      setChip('server', `сервер: ${health.status === 401 ? 'токен не принят' : 'недоступен'}`, 'bad');
      $('#connect-note').textContent = `${errorText(health)}. Проверьте токен в настройках приложения.`;
      // Справочник не зависит от токена: его можно читать и без подключения.
      if (activeTab === 'panel') showTab('docs');
      return false;
    }
    const info = health.body || {};
    setChip('server', `сервер: работает${info.app && info.app.version ? `, версия ${info.app.version}` : ''}`, 'ok');
    setChip('port', `порт: ${location.port || '—'}`, 'ok');
    const scopes = info.scopes || {};
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

    const [characters, parties, windows] = await Promise.all([
      api('/api/v1/characters'),
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
    $('#panel').hidden = false;
    $('#reload-audit').hidden = false;
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
      tab.addEventListener('click', () => showTab(tab.dataset.tab || 'panel'));
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
  renderPresets();
  renderHints();
  showTab('panel');
  const saved = sessionStorage.getItem(storageKey);
  if (saved) {
    tokenInput.value = saved;
    token = saved;
  }
  renderRecipe();
})();
