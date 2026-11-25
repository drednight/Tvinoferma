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
  -d '{"partyName":"Основа"}' ${base}/api/v1/launch/party`;
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

  async function loadAll() {
    const health = await api('/api/v1/health');
    if (!health.ok) {
      setChip('server', `сервер: ${health.status === 401 ? 'токен не принят' : 'недоступен'}`, 'bad');
      $('#connect-note').textContent = `${errorText(health)}. Проверьте токен в настройках приложения.`;
      $('#panel').hidden = true;
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
  const saved = sessionStorage.getItem(storageKey);
  if (saved) {
    tokenInput.value = saved;
    token = saved;
  }
  renderRecipe();
})();
