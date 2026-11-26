// demo/external-api/external-api.js
// Макет странички внешнего API: всё считается на странице, запросы никуда не уходят.
// Персонажи, окна и ответы сервера вымышлены — цель макета показать вид и порядок действий.

const state = {
  connected: false,
  token: '',
  calls: [],
  picked: null,
  job: null,
  jobTimer: null,
  characters: [
    {
      id: 'Mag_1',
      nick: 'Маг',
      class: 'Маг',
      level: 100,
      partyIds: ['p-osnova'],
      stats: { physAttack: 12000, magAttack: 96000, hp: 48000, critChance: 18 },
      dungeonPasses: { weapon: 3, armor: 2, relic: 1 },
      running: true
    },
    {
      id: 'Luchnik_2',
      nick: 'Лучник',
      class: 'Лучник',
      level: 100,
      partyIds: ['p-osnova'],
      stats: { physAttack: 91000, magAttack: 4000, hp: 41000, critChance: 24 },
      dungeonPasses: { weapon: 2, armor: 3, relic: 0 },
      running: false
    },
    {
      id: 'Zhrets_3',
      nick: 'Жрец',
      class: 'Жрец',
      level: 99,
      partyIds: ['p-osnova', 'p-farm'],
      stats: { physAttack: 3000, magAttack: 52000, hp: 38000, critChance: 9 },
      dungeonPasses: { weapon: 1, armor: 1, relic: 1 },
      running: false
    }
  ],
  parties: [
    { id: 'p-osnova', name: 'Основа', memberIds: ['Mag_1', 'Luchnik_2', 'Zhrets_3'] },
    { id: 'p-farm', name: 'Фарм', memberIds: ['Zhrets_3'] }
  ]
};

const STAT_FIELDS = [
  { key: 'physAttack', label: 'Физ. атака' },
  { key: 'magAttack', label: 'Маг. атака' },
  { key: 'hp', label: 'HP' },
  { key: 'critChance', label: 'Крит, %' }
];
const PASS_FIELDS = [
  { key: 'weapon', label: 'Оружие' },
  { key: 'armor', label: 'Доспех' },
  { key: 'relic', label: 'Реликвия' }
];

const $ = selector => document.querySelector(selector);
const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
const now = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function scopes() {
  return state.connected ? 'права: чтение · изменение · запуск' : 'права: нет (не подключено)';
}

function renderStatus() {
  const server = $('[data-chip="server"]');
  server.textContent = state.connected ? 'сервер: подключено' : 'сервер: не подключено';
  server.classList.toggle('is-ok', state.connected);
  $('[data-chip="scopes"]').textContent = scopes();
  const busy = state.job?.status === 'running';
  const port = $('[data-chip="port"]');
  port.textContent = busy ? '127.0.0.1:47831 · идёт запуск' : '127.0.0.1:47831';
  port.classList.toggle('is-warn', busy);
}

function logCall(method, path, status, ms, request, response) {
  state.calls.unshift({ at: now(), method, path, status, ms, request, response });
  state.calls = state.calls.slice(0, 100);
  renderCalls();
}

function renderCalls() {
  const body = $('#calls-table tbody');
  if (!state.calls.length) {
    body.innerHTML = '<tr class="xapi-empty"><td colspan="5">Пока пусто — подключитесь и что-нибудь нажмите.</td></tr>';
    $('#req-json').textContent = '—';
    $('#res-json').textContent = '—';
    return;
  }
  body.innerHTML = state.calls
    .map((call, index) => {
      const cls = call.status < 400 ? 'xapi-code-ok' : 'xapi-code-bad';
      return `<tr data-call="${index}" class="${index === (state.picked ?? 0) ? 'is-picked' : ''}">
        <td>${escapeHtml(call.at)}</td>
        <td>${escapeHtml(call.method)}</td>
        <td><code>${escapeHtml(call.path)}</code></td>
        <td class="${cls}">${call.status}</td>
        <td>${call.ms}</td>
      </tr>`;
    })
    .join('');
  const picked = state.calls[state.picked ?? 0];
  if (picked) {
    $('#req-json').textContent = JSON.stringify(picked.request, null, 2);
    $('#res-json').textContent = JSON.stringify(picked.response, null, 2);
  }
}

function renderCharacters() {
  const box = $('#characters');
  box.innerHTML = state.characters
    .map(char => {
      const stats = STAT_FIELDS.map(
        field => `<label class="xapi-field-sm">${escapeHtml(field.label)}
          <input class="input" type="number" data-char="${escapeHtml(char.id)}" data-stat="${field.key}" value="${Number(
            char.stats[field.key] || 0
          )}" />
        </label>`
      ).join('');
      const passes = PASS_FIELDS.map(
        field => `<label class="xapi-pass">${escapeHtml(field.label)}
          <input class="input" type="number" min="0" data-char="${escapeHtml(
            char.id
          )}" data-pass="${field.key}" value="${Number(char.dungeonPasses[field.key] || 0)}" />
        </label>`
      ).join('');
      return `<article class="xapi-card">
        <header class="xapi-card-head">
          <strong>${escapeHtml(char.nick)}</strong>
          <span class="muted">${escapeHtml(char.class)} · ${char.level} ур. · ${escapeHtml(char.id)}</span>
          <span class="xapi-badge ${char.running ? 'is-live' : ''}">${char.running ? 'окно запущено' : 'окно закрыто'}</span>
        </header>
        <div class="xapi-fields">${stats}</div>
        <div class="xapi-passes">${passes}</div>
        <div class="xapi-card-actions">
          <button class="btn secondary small" type="button" data-save="${escapeHtml(char.id)}">Сохранить</button>
          <button class="btn ghost small" type="button" data-launch="${escapeHtml(char.id)}">▶ Запустить окно</button>
          <span class="xapi-dirty" data-dirty="${escapeHtml(char.id)}"></span>
        </div>
      </article>`;
    })
    .join('');
}

function renderParties() {
  $('#parties').innerHTML = state.parties
    .map(party => {
      const members = party.memberIds
        .map(id => state.characters.find(char => char.id === id))
        .filter(Boolean)
        .map(char => escapeHtml(char.nick))
        .join(', ');
      return `<div class="xapi-party">
        <span class="xapi-party-name">${escapeHtml(party.name)}</span>
        <span class="xapi-party-members">${members}</span>
        <button class="btn secondary small" type="button" data-launch-party="${escapeHtml(party.id)}">▶ Запустить пати</button>
      </div>`;
    })
    .join('');
}

function renderWindows() {
  const rows = state.characters
    .filter(char => char.running)
    .map(char => {
      const pid = 12000 + state.characters.indexOf(char) * 111;
      return `<div class="xapi-window">
        <span>${escapeHtml(char.nick)} — ${escapeHtml(char.class)}</span>
        <span class="xapi-pid">pid ${pid}</span>
        <button class="btn ghost small" type="button" data-close="${pid}">Закрыть</button>
      </div>`;
    });
  $('#windows').innerHTML = rows.length
    ? rows.join('')
    : '<p class="muted">Окон игры нет. Запустите персонажа или пати.</p>';
}

function renderJob() {
  const box = $('#job');
  if (!state.job) {
    box.innerHTML = '<p class="muted">Заданий нет. Запустите персонажа или пати — здесь появится ход и итог.</p>';
    return;
  }
  const job = state.job;
  const rows = job.items
    .map(item => {
      const cls = item.status === 'ok' ? 'ok' : item.status === 'failed' ? 'err' : 'skip';
      const note = item.status === 'ok' ? 'окно запущено' : item.status === 'failed' ? item.error : item.note;
      return `<li><span class="${cls}">${escapeHtml(item.nick)}</span><span class="muted">${escapeHtml(note || '')}</span></li>`;
    })
    .join('');
  const done = job.items.filter(item => item.status !== 'running').length;
  const percent = Math.round((done / Math.max(1, job.items.length)) * 100);
  box.innerHTML = `<div><strong>${escapeHtml(job.title)}</strong> · <span class="muted">${escapeHtml(
    job.status === 'running' ? `выполняется, ${done}/${job.items.length}` : `готово, ${done}/${job.items.length}`
  )}</span></div>
    <div class="xapi-job-bar"><span style="width:${job.status === 'running' ? percent : 100}%"></span></div>
    <ul class="xapi-job-rows">${rows}</ul>`;
}

function renderRecipe() {
  const token = state.token || '<ТОКЕН>';
  const lang = $('.xapi-tab.is-on')?.dataset.recipe || 'curl';
  const base = 'http://127.0.0.1:47831/api/v1';
  const partyName = state.parties[0]?.name || 'Основа';
  const charId = state.characters[0]?.id || 'Mag_1';
  const text = {
    curl: `# Список персонажей и их проходок
curl -s ${base}/characters \\
  -H "Authorization: Bearer ${token}"

# Изменить статы одного персонажа
curl -s -X PATCH ${base}/characters/${charId} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"stats":{"physAttack":12500},"dungeonPasses":{"weapon":2}}'

# Запустить пати: ответ 202 и jobId, ход забираем опросом
curl -s -X POST ${base}/launch/party \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"partyName":"${partyName}"}'
curl -s ${base}/jobs/job_8f2c1a \\
  -H "Authorization: Bearer ${token}"`,
    python: `import json
import os
import time
import urllib.request

BASE = "http://127.0.0.1:47831/api/v1"
TOKEN = os.environ["TVINOFERMA_API_TOKEN"]


def api(method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE + path,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


# Кто из пати сейчас без окна
chars = api("GET", "/characters?party=Основа")["characters"]
for char in chars:
    if not char.get("running"):
        print(char["nick"], char["dungeonPasses"])

# Поднять пати и дождаться итога
job = api("POST", "/launch/party", {"partyName": "${partyName}"})
while True:
    status = api("GET", f"/jobs/{job['jobId']}")
    print(status["progress"].get("stage", status["status"]))
    if status["status"] != "queued" and status["status"] != "running":
        break
    time.sleep(2)
print(json.dumps(status["result"], ensure_ascii=False, indent=2))`,
    powershell: `$token = $env:TVINOFERMA_API_TOKEN
$base = 'http://127.0.0.1:47831/api/v1'
$headers = @{ Authorization = "Bearer $token" }

# Проходки всех персонажей пати
$chars = (Invoke-RestMethod -Uri "$base/characters?party=${partyName}" -Headers $headers).characters
$chars | Select-Object nick, @{ n = 'passes'; e = { $_.dungeonPasses } } | Format-Table

# Запуск пати: 202 + jobId, затем опрос
$job = Invoke-RestMethod -Method Post -Uri "$base/launch/party" -Headers $headers \`
  -ContentType 'application/json' -Body '{"partyName":"${partyName}"}'
do {
  Start-Sleep -Seconds 2
  $status = Invoke-RestMethod -Uri "$base/jobs/$($job.jobId)" -Headers $headers
  Write-Host $status.progress.stage
} while ($status.status -in @('queued', 'running'))
$status.result`
  }[lang];
  $('#recipe').textContent = text;
}

function ensureConnected() {
  if (state.connected) return true;
  logCall(
    'GET',
    '/characters',
    401,
    1,
    {},
    { error: { code: 'unauthorized', message: 'Введите токен и подключитесь' } }
  );
  return false;
}

function connect() {
  const token = $('#token').value.trim();
  state.token = token;
  state.connected = token.length > 0;
  renderStatus();
  renderRecipe();
  logCall(
    'GET',
    '/health',
    state.connected ? 200 : 401,
    state.connected ? 3 : 1,
    {},
    {
      ok: state.connected,
      app: { version: '3.0.0', build: 'stable' },
      storage: { writable: true },
      launch: { busy: false }
    }
  );
}

function disconnect() {
  state.connected = false;
  state.token = '';
  renderStatus();
  renderRecipe();
  logCall('GET', '/health', 401, 1, {}, { error: { code: 'unauthorized', message: 'Отключено' } });
}

function newJobId() {
  return `job_${Math.random().toString(16).slice(2, 8)}`;
}

function finishJob(jobId, extra = {}) {
  const job = state.job;
  if (!job || job.status !== 'running') return;
  clearInterval(state.jobTimer);
  job.status = 'done';
  job.items.forEach(item => {
    if (item.status === 'running') {
      item.status = 'skipped';
      item.note = 'не дождались: задание завершилось';
    }
  });
  const launched = job.items.filter(item => item.status === 'ok').length;
  const skipped = job.items.filter(item => item.status === 'skipped').length;
  const failed = job.items.filter(item => item.status === 'failed').length;
  logCall(
    'GET',
    `/jobs/${jobId}`,
    200,
    2,
    {},
    {
      id: jobId,
      kind: 'launch',
      status: 'done',
      result: { requested: job.items.length, launched, skipped, failed, ignoredIds: [], ...extra }
    }
  );
  renderStatus();
  renderJob();
}

/** Все строки получили итог — задание завершается сразу, не дожидаясь следующего тика. */
function finishWhenIdle(jobId) {
  const job = state.job;
  if (!job || job.items.some(item => item.status === 'running')) return false;
  finishJob(jobId);
  return true;
}

function startJob(title, items) {
  state.job = { title, status: 'running', items };
  renderStatus();
  renderJob();
}

function readyChar(char) {
  if (!char) return;
  if (!ensureConnected()) return;
  const jobId = newJobId();
  startJob(`Запуск игры: ${char.nick}`, [
    { id: char.id, nick: char.nick, status: 'running', note: 'запуск лаунчера…' }
  ]);
  logCall('POST', '/launch/character', 202, 4, { characterId: char.id }, { jobId, status: 'queued' });
  let ticks = 0;
  clearInterval(state.jobTimer);
  state.jobTimer = setInterval(() => {
    ticks += 1;
    const item = state.job?.items[0];
    if (!item || item.status !== 'running') return finishJob(jobId);
    // Третий персонаж в макете — пример «вход не запомнен»: задание завершается пропуском.
    if (char.id === 'Zhrets_3') {
      if (ticks < 3) {
        item.note = 'ожидание нового игрового клиента…';
      } else {
        item.status = 'skipped';
        item.note = 'пропущен: не запомнен вход в GameCenter';
      }
      renderJob();
      if (finishWhenIdle(jobId)) return;
      return;
    }
    item.status = 'ok';
    item.note = 'клиент игры запущен';
    char.running = true;
    renderCharacters();
    renderWindows();
    renderJob();
    finishWhenIdle(jobId);
  }, 1400);
}

function readyParty(partyId) {
  const party = state.parties.find(row => row.id === partyId);
  if (!party || !ensureConnected()) return;
  const members = party.memberIds.map(id => state.characters.find(char => char.id === id)).filter(Boolean);
  const jobId = newJobId();
  startJob(
    `Запуск игры: ${party.name}`,
    members.map((char, index) => ({
      id: char.id,
      nick: char.nick,
      status: 'running',
      note: index === 0 ? 'запуск лаунчера…' : 'в очереди'
    }))
  );
  logCall('POST', '/launch/party', 202, 5, { partyName: party.name }, { jobId, status: 'queued' });
  let index = 0;
  clearInterval(state.jobTimer);
  state.jobTimer = setInterval(() => {
    const item = state.job?.items[index];
    if (!item) return finishJob(jobId);
    // Первый тик строки — «в очереди → запускаюсь», второй — итог. Так видно,
    // что персонажи идут по одному, как в очереди приложения.
    if (item.note === 'в очереди') {
      item.note = 'запуск лаунчера…';
      renderJob();
      return;
    }
    if (item.id === 'Zhrets_3') {
      item.status = 'skipped';
      item.note = 'пропущен: не запомнен вход в GameCenter';
    } else {
      item.status = 'ok';
      item.note = 'окно запущено';
      const target = state.characters.find(char => char.id === item.id);
      if (target) target.running = true;
    }
    index += 1;
    const next = state.job.items[index];
    if (next && next.note === 'в очереди') next.note = 'запуск лаунчера…';
    renderCharacters();
    renderWindows();
    renderJob();
    finishWhenIdle(jobId);
  }, 1600);
}

function saveChar(id) {
  if (!ensureConnected()) return;
  const char = state.characters.find(row => row.id === id);
  if (!char) return;
  const patch = { stats: {}, dungeonPasses: {} };
  document.querySelectorAll(`[data-char="${id}"]`).forEach(input => {
    const value = Math.max(0, Number(input.value) || 0);
    if (input.dataset.stat) {
      if (value !== char.stats[input.dataset.stat]) patch.stats[input.dataset.stat] = value;
    } else if (input.dataset.pass && value !== char.dungeonPasses[input.dataset.pass]) {
      patch.dungeonPasses[input.dataset.pass] = value;
    }
  });
  if (!Object.keys(patch.stats).length) delete patch.stats;
  if (!Object.keys(patch.dungeonPasses).length) delete patch.dungeonPasses;
  if (!Object.keys(patch).length) {
    logCall('PATCH', `/characters/${encodeURIComponent(id)}`, 200, 2, {}, { changed: [], statsHistoryAdded: false });
    return;
  }
  Object.assign(char.stats, patch.stats || {});
  Object.assign(char.dungeonPasses, patch.dungeonPasses || {});
  const changed = [
    ...Object.keys(patch.stats || {}).map(key => `stats.${key}`),
    ...Object.keys(patch.dungeonPasses || {}).map(key => `dungeonPasses.${key}`)
  ];
  logCall('PATCH', `/characters/${encodeURIComponent(id)}`, 200, 9, patch, {
    character: { id, stats: char.stats, dungeonPasses: char.dungeonPasses },
    changed,
    statsHistoryAdded: true
  });
  const note = document.querySelector(`[data-dirty="${id}"]`);
  if (note) note.textContent = '';
  renderCharacters();
}

function bulkUpdate() {
  if (!ensureConnected()) return;
  const ids = state.characters.map(char => char.id);
  state.characters.forEach(char => (char.dungeonPasses.relic += 1));
  logCall(
    'POST',
    '/characters/bulk-update',
    200,
    11,
    { ids, patch: { dungeonPasses: { relic: '+1' } } },
    {
      updated: ids.map(id => ({ id, changed: ['dungeonPasses.relic'] })),
      failed: []
    }
  );
  renderCharacters();
}

function closeWindow(pid) {
  const number = Number(pid);
  const index = state.characters.findIndex((char, row) => char.running && 12000 + row * 111 === number);
  if (index < 0 || !ensureConnected()) return;
  state.characters[index].running = false;
  logCall('POST', '/windows/close', 200, 6, { pids: [number], confirm: true }, { closed: 1, failed: 0, pending: 0 });
  renderCharacters();
  renderWindows();
}

function markDirty(event) {
  const id = event.target.dataset.char;
  if (!id) return;
  const note = document.querySelector(`[data-dirty="${id}"]`);
  if (note) note.textContent = 'есть несохранённые изменения';
}

async function copyRecipe() {
  try {
    await navigator.clipboard.writeText($('#recipe').textContent);
    const button = $('[data-copy-recipe]');
    button.textContent = '✅ Скопировано';
    setTimeout(() => (button.textContent = '📋 Скопировать'), 1500);
  } catch {
    /* в макете буфер может быть недоступен */
  }
}

function bind() {
  $('#connect-btn').addEventListener('click', connect);
  $('#token').addEventListener('keydown', event => {
    if (event.key === 'Enter') connect();
  });
  $('#disconnect-btn').addEventListener('click', disconnect);
  $('#bulk-btn').addEventListener('click', bulkUpdate);
  $('#characters').addEventListener('click', event => {
    const save = event.target.closest('[data-save]');
    if (save) return saveChar(save.dataset.save);
    const launch = event.target.closest('[data-launch]');
    if (launch) return readyChar(state.characters.find(char => char.id === launch.dataset.launch));
  });
  $('#characters').addEventListener('input', event => {
    if (event.target.matches('input[data-char]')) markDirty(event);
  });
  $('#parties').addEventListener('click', event => {
    const button = event.target.closest('[data-launch-party]');
    if (button) readyParty(button.dataset.launchParty);
  });
  $('#windows').addEventListener('click', event => {
    const button = event.target.closest('[data-close]');
    if (button) closeWindow(button.dataset.close);
  });
  $('#calls-table').addEventListener('click', event => {
    const row = event.target.closest('[data-call]');
    if (!row) return;
    state.picked = Number(row.dataset.call);
    renderCalls();
  });
  document.querySelectorAll('.xapi-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.xapi-tab').forEach(other => {
        other.classList.toggle('is-on', other === tab);
        other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
      });
      renderRecipe();
    });
  });
  $('[data-copy-recipe]').addEventListener('click', copyRecipe);
}

function init() {
  renderCharacters();
  renderParties();
  renderWindows();
  renderJob();
  renderCalls();
  renderStatus();
  renderRecipe();
  bind();
}

init();
