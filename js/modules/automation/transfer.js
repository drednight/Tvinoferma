// js/modules/automation/transfer.js
// 📦 Передача предметов в игру (Issue #26): диалог «браузеры → сервер → получатель → сводка → передача → итог».
// Подарки лежат на аккаунте сайта; приложение управляет страницей /promo_items.php в окне каждого браузера.
// Rust-команды: read_transfer_page, transfer_items (src-tauri/src/automation/transfer.rs). Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmDialog } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import {
  serverList, charsOnServer, planTransfer, statusInfo, rowLabel, isOk, isRerunnable, summarize, totalsText
} from './transferCore.js';
import { loadRosters, loadPrefs, savePrefs, setRoster, clearPending, pruneRosters, recordTransfer } from './transferStore.js';
import { scanRosters, runTransferBatch } from './transferRunner.js';
import { openTransferLog } from './transferLogView.js';

const dot = (c) => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const charLine = (c) => `${c.name} (${c.cls || '?'}, ур. ${c.level})`;

/** Резервная копия данных перед первой передачей за сессию приложения. */
let backedUp = false;
async function ensureBackup() {
  if (backedUp) return true;
  try {
    const { createBackup } = await import('../../core/storage.js');
    await createBackup('transfer');
    backedUp = true;
    return true;
  } catch (e) {
    return confirmDialog(`Не удалось создать резервную копию данных (${e?.message || e}).\nПродолжить передачу без неё?`);
  }
}

const rowDetail = (r) => {
  if (r.status === 'error') return errorText(r.error);
  if (r.status === 'unknown' && r.error) return errorText(r.error);
  return r.detail || '';
};

const cellHtml = (row) => {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  const info = statusInfo(row.status);
  const tip = [rowLabel(row), rowDetail(row)].filter(Boolean).join(' — ');
  return `<span title="${escapeHtml(tip)}">${info.icon} ${escapeHtml(rowLabel(row))}${row.status === 'error' && row.error ? ` <span class="promo-muted">${escapeHtml(errorText(row.error))}</span>` : ''}</span>`;
};

/**
 * Открывает диалог передачи предметов.
 * @param {{ ids?: string[] }} [opts] ids — браузеры (персонажи приложения), выбранные заранее
 */
export function openTransferDialog({ ids = [] } = {}) {
  if (!state.characters.length) { toast('Сначала добавьте персонажей', 'info'); return null; }
  pruneRosters(state.characters.map(c => c.id));
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let rosters = loadRosters();
  const prefs = loadPrefs();
  let serverId = '';
  let scanNotes = [];        // что не удалось прочитать при последнем чтении
  let running = null;        // { cancelled } пока идёт чтение или передача
  let lastRows = [];
  let lastPlans = [];
  let lastDry = false;

  const dlg = openOverlay({ title: '📦 Передача предметов в игру', wide: true, onClose: () => { if (running) running.cancelled = true; } });
  const alive = () => dlg.el.isConnected;
  const servers = () => serverList(rosters);
  // Прежний сервер подставляется, если он ещё есть на сайте; пустого значения по умолчанию нет
  serverId = servers().some(s => s.id === prefs.server) ? prefs.server : '';

  const selectedChars = () => state.characters.filter(c => selected.has(c.id)).sort(byNick);
  const picksOf = () => prefs.picks;

  /* ---------------------------- форма ---------------------------- */

  function visibleChars() {
    const q = search.trim().toLowerCase();
    return [...state.characters].sort(byNick).filter(c => !q || [c.nick, c.className, ...(c.tags || [])].join(' ').toLowerCase().includes(q));
  }

  function infoText(c) {
    const r = rosters[c.id];
    if (!r) return 'серверы не загружены';
    const n = r.shards.reduce((s, x) => s + x.chars.length, 0);
    const p = r.pending && !r.pending.stale ? `к передаче: ${r.pending.items.length}${r.pending.chests ? `, сундуков: ${r.pending.chests}` : ''}` : 'к передаче: обновите';
    return `${r.shards.length ? r.shards.map(s => s.name).join(', ') : 'нет персонажей'} · перс.: ${n} · ${p} · ${when(r.at)}`;
  }

  function recipientHtml(c) {
    const r = rosters[c.id];
    if (!r) return '<select class="input tr-recipient" disabled><option>не загружено</option></select>';
    if (!serverId) return '<select class="input tr-recipient" disabled><option>сначала выберите сервер</option></select>';
    const list = charsOnServer(r, serverId);
    if (!list.length) return '<select class="input tr-recipient" disabled><option>на сервере нет персонажей</option></select>';
    const pick = picksOf()[c.id]?.[serverId] || '';
    const first = list.length === 1 ? `Авто: ${charLine(list[0])}` : '— не выбран: не передавать —';
    return `<select class="input tr-recipient" data-pick="${escapeHtml(c.id)}">
      <option value="">${escapeHtml(first)}</option>
      ${list.map(ch => `<option value="${escapeHtml(ch.key)}" ${pick === ch.key ? 'selected' : ''}>${escapeHtml(charLine(ch))}</option>`).join('')}
    </select>`;
  }

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty">Никого не найдено</div>';
    return list.map(c => `
      <div class="promo-item tr-row" data-row="${escapeHtml(c.id)}">
        <label class="tr-pick"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
          <span>${dot(c)}</span><b>${escapeHtml(c.nick)}</b></label>
        <span class="promo-muted tr-info">${escapeHtml(infoText(c))}</span>
        ${recipientHtml(c)}
      </div>`).join('');
  }

  function serverOptions() {
    const list = servers();
    if (!list.length) return '<option value="">Серверов пока нет — отметьте браузеры и нажмите «Подтянуть»</option>';
    return `<option value="">— выберите сервер —</option>${list.map(s =>
      `<option value="${escapeHtml(s.id)}" ${s.id === serverId ? 'selected' : ''}>${escapeHtml(s.name)} (перс.: ${s.chars})</option>`).join('')}`;
  }

  function renderForm() {
    dlg.sub.textContent = '';
    dlg.body.innerHTML = `
      <div class="tr-top">
        <div class="field"><label for="tr-server">Сервер назначения</label>
          <select class="input" id="tr-server" ${servers().length ? '' : 'disabled'}>${serverOptions()}</select></div>
        <button class="btn secondary small" data-act="scan" title="Прочитать со страницы сайта, какие у аккаунта серверы и персонажи и что ждёт передачи">🔄 Подтянуть серверы и персонажей</button>
      </div>
      <p class="promo-muted promo-hint">Предметы передаются <b>с сайта в игру</b>: всё, что ждёт передачи на аккаунте браузера, уходит выбранному персонажу на выбранном сервере.
        Получатель не выбран, а на сервере один персонаж — передаём ему; персонажей несколько и никто не выбран — не передаём. Сундуки не открываются (награду выбирают на сайте).</p>
      <div id="tr-notes">${notesHtml()}</div>
      <div class="promo-quick">
        <input class="input" id="tr-search" placeholder="Поиск: ник, класс, тег" value="${escapeHtml(search)}">
        <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
        <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
        <button class="btn ghost small" data-q="none">Снять выбор</button>
      </div>
      <div class="promo-list tr-list" id="tr-list">${listHtml()}</div>
      <div class="promo-count" id="tr-count"></div>
      <div class="tr-summary" id="tr-summary"></div>
      <label class="promo-opt"><input type="checkbox" id="tr-ack"> <span>Понимаю, что передача необратима: предметы уйдут в игру и вернуть их нельзя.</span></label>`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log" title="Журнал передач">📜 Журнал</button>
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      <button class="btn secondary" data-act="dry" title="Пройти все шаги, но не нажимать «Передать»">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start" disabled>📦 Передать</button>`;
    updateAll();
  }

  const notesHtml = () => scanNotes.length
    ? `<div class="promo-alert">${scanNotes.map(n => `<div>⚠ ${escapeHtml(n)}</div>`).join('')}</div>` : '';

  const currentPlans = () => (serverId ? planTransfer(selectedChars(), rosters, { shardId: serverId, picks: picksOf() }) : []);

  function summaryHtml(plans) {
    if (!selected.size) return '<div class="promo-muted">Отметьте браузеры (аккаунты сайта), с которых нужно передать предметы.</div>';
    if (!serverId) return '<div class="promo-warn">⚠ Выберите сервер назначения: без него передача не запускается.</div>';
    const lines = plans.map(p => {
      if (!p.run) {
        const info = statusInfo(p.status);
        return `<div class="tr-line">${info.icon} <b>${escapeHtml(p.char.nick)}</b> — ${escapeHtml(info.label)}${p.detail ? ` (${escapeHtml(p.detail)})` : ''}</div>`;
      }
      const pend = rosters[p.char.id]?.pending;
      const known = pend && !pend.stale;
      return `<div class="tr-line">➡️ <b>${escapeHtml(p.char.nick)}</b> → ${escapeHtml(p.serverName)} → <b>${escapeHtml(charLine(p.recipient))}</b>${p.auto ? ' <span class="promo-muted">(единственный на сервере)</span>' : ''}
        ${known ? `<details class="promo-reward"><summary>📦 К передаче: ${pend.items.length}${pend.chests ? ` · сундуков: ${pend.chests} (на сайте)` : ''}</summary>${pend.items.length ? `<div class="promo-muted">${escapeHtml(totalsText(pend.items, 12))}</div>` : '<div class="promo-muted">Сейчас нет предметов.</div>'}</details>` : '<span class="promo-muted"> · что ждёт — выяснится на странице</span>'}</div>`;
    });
    const run = plans.filter(p => p.run).length;
    return `${lines.join('')}
      <div class="promo-count">Будет передано с аккаунтов: ${run} из ${plans.length}.</div>
      <div class="promo-muted tr-notes">• Передача необратима. • Среднее время передачи в игру — около 30 минут. • Уровень персонажей на сайте обновляется раз в сутки. • Лимит сайта «не более 6 предметов за раз» снят: отмечаются все предметы. • Предметы могут иметь срок действия и привязку.</div>`;
  }

  function updateAll() {
    const count = dlg.body.querySelector('#tr-count');
    if (count) count.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    const plans = currentPlans();
    const box = dlg.body.querySelector('#tr-summary');
    if (box) box.innerHTML = summaryHtml(plans);
    const ack = dlg.body.querySelector('#tr-ack')?.checked;
    const canRun = plans.some(p => p.run);
    const start = dlg.foot.querySelector('[data-act="start"]');
    const dry = dlg.foot.querySelector('[data-act="dry"]');
    if (start) start.disabled = !(canRun && ack);
    if (dry) dry.disabled = !canRun;
  }

  function quickSelect(kind) {
    if (kind === 'none') selected.clear();
    if (kind === 'all') state.characters.forEach(c => selected.add(c.id));
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#tr-list').innerHTML = listHtml();
    updateAll();
  }

  /* ----------------------- чтение серверов ----------------------- */

  async function scan(chars) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const task = startTask(`📦 Серверы и персонажи (${chars.length} браузеров)`, { total: chars.length, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...chars.map(c => `char:${c.id}`));
    task.setStep(`${chars.length} браузеров, по ${browserSlots.max} одновременно, повторов до ${retries}`);
    renderScanning(chars, signal);

    const { invoke } = await import('@tauri-apps/api/core');
    let rows;
    try {
      rows = await scanRosters({
        chars, signal, invokeFn: invoke, retries, retryDelayMs, task,
        onRow: (row, done, all) => {
          if (row.status === 'ok' && row.roster) setRoster(row.charId, row.roster);
          if (alive()) updateScanning(row, done, all);
        }
      });
    } finally { running = null; }

    scanNotes = rows.filter(r => r.status !== 'ok' && r.status !== 'cancelled')
      .map(r => `${r.nick}: ${r.status === 'not_logged_in' ? 'нет входа на сайт' : r.status === 'challenge' ? 'сайт показал проверку безопасности' : errorText(r.error)}`);
    const ok = rows.filter(r => r.status === 'ok').length;
    task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}Прочитано ${ok} из ${rows.length}`, ok === rows.length ? 'done' : 'warn');
    rows.filter(r => r.status !== 'ok' && r.status !== 'cancelled').forEach(r => task.log(`${r.nick}: ${r.status}${r.error ? ` — ${errorText(r.error)}` : ''}`, 'error'));
    rosters = loadRosters();
    if (!servers().some(s => s.id === serverId)) serverId = '';
    if (alive()) renderForm();
  }

  function renderScanning(chars, signal) {
    dlg.sub.textContent = 'Читаю со страницы сайта, какие у аккаунтов серверы и персонажи и что ждёт передачи. Ничего не отправляется.';
    dlg.body.innerHTML = `<div class="promo-progress" id="tr-progress">0 из ${chars.length}</div>
      <div class="promo-scroll"><table class="promo-table"><tbody>${chars.map(c =>
        `<tr><td><b>${escapeHtml(c.nick)}</b></td><td data-scan="${escapeHtml(c.id)}"><span class="promo-muted">⏳ в очереди</span></td></tr>`).join('')}</tbody></table></div>`;
    dlg.foot.innerHTML = `<span class="promo-muted" style="flex:1">«Стоп» не начинает новых чтений; начатые завершатся.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    bindStop(signal);
  }

  function updateScanning(row, done, total) {
    const td = [...dlg.body.querySelectorAll('[data-scan]')].find(el => el.dataset.scan === row.charId);
    if (td) {
      const r = rosters[row.charId] || loadRosters()[row.charId];
      td.innerHTML = row.status === 'ok'
        ? `✅ ${escapeHtml(r?.shards.length ? r.shards.map(s => s.name).join(', ') : 'персонажей нет')}${r?.pending ? ` · к передаче: ${r.pending.items.length}` : ''}`
        : `❌ ${escapeHtml(row.status === 'not_logged_in' ? 'нет входа' : row.status === 'challenge' ? 'проверка безопасности' : errorText(row.error))}`;
    }
    const p = dlg.body.querySelector('#tr-progress');
    if (p) p.textContent = `${done} из ${total}`;
  }

  function bindStop(signal) {
    dlg.foot.querySelector('[data-act="stop"]').onclick = (e) => { signal.cancelled = true; e.currentTarget.disabled = true; e.currentTarget.textContent = '⏳ Останавливаю…'; };
  }

  /* ----------------------------- запуск ----------------------------- */

  async function start(plans, dry) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const todo = plans.filter(p => p.run);
    const task = startTask(`📦 ${dry ? 'Пробная п' : 'П'}ередача предметов → ${todo[0]?.serverName || ''}`, { total: plans.length, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...plans.map(p => `char:${p.char.id}`));
    task.setStep(`${todo.length} аккаунтов, по ${browserSlots.max} одновременно${dry ? ', без нажатия «Передать»' : ''}`);
    renderRunning(plans, signal, dry);

    const { invoke } = await import('@tauri-apps/api/core');
    let rows;
    try {
      rows = await runTransferBatch({
        plans, dryRun: dry, signal, task, invokeFn: invoke, retries, retryDelayMs,
        onRow: (row, done, all) => {
          // В журнал и список «что ждёт» — сразу: «Стоп» или закрытие окна ничего не теряют
          if (!dry && row.clicked) {
            recordTransfer(row);
            if (row.status === 'success' || row.status === 'partial') clearPending(row.charId);
          }
          if (alive()) updateRunning(row, done, all);
        }
      });
    } finally { running = null; }

    rosters = loadRosters();
    const s = summarize(rows);
    task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}${dry ? `Пробный запуск: готово к передаче ${s.dry}` : `Передано ${s.ok}${s.partial ? `, не всё ${s.partial}` : ''}`}, не распознано ${s.unknown}, ошибок ${s.failed}, пропущено ${s.skipped}`,
      s.failed || s.unknown || s.partial ? 'warn' : 'done');
    rows.filter(r => !['same_site', 'no_recipient', 'no_server', 'no_roster'].includes(r.status)).forEach(r =>
      task.log(`${r.nick} → ${r.server} → ${r.recipient}: ${rowLabel(r)}${r.status === 'error' ? ` — ${errorText(r.error)}` : ''}`, statusInfo(r.status).level === 'error' ? 'error' : 'info'));

    lastRows = rows; lastPlans = plans; lastDry = dry;
    if (alive()) renderResults(signal.cancelled);
  }

  const tableHtml = (plans, byId) => `
    <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Браузер</th><th>Сервер → получатель</th><th>Предметов</th><th>Результат</th></tr></thead>
      <tbody>${plans.map(p => {
        const row = byId.get(p.char.id);
        return `<tr data-row="${escapeHtml(p.char.id)}"><td><b>${escapeHtml(p.char.nick)}</b></td>
          <td>${p.recipient ? `${escapeHtml(p.serverName)} → ${escapeHtml(p.recipient.name)}` : '—'}</td>
          <td data-count="${escapeHtml(p.char.id)}">${row?.count || ''}</td>
          <td data-cell="${escapeHtml(p.char.id)}">${cellHtml(row)}</td></tr>`;
      }).join('')}</tbody></table></div>`;

  function renderRunning(plans, signal, dry) {
    dlg.sub.textContent = dry
      ? 'Пробный запуск: выбираю сервер, персонажа и предметы, но «Передать» не нажимаю.'
      : 'Идёт передача: аккаунты обрабатываются несколько одновременно. После «Передать» сайт открывает историю передач — по ней я проверяю результат.';
    dlg.body.innerHTML = `<div class="promo-progress" id="tr-progress">0 из ${plans.length}</div>${tableHtml(plans, new Map())}`;
    dlg.foot.innerHTML = `<span class="promo-muted" style="flex:1">«Стоп» не начинает новых передач; уже нажатые завершатся и будут записаны в журнал.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    bindStop(signal);
  }

  function updateRunning(row, done, total) {
    const q = (attr) => [...dlg.body.querySelectorAll(`[${attr}]`)].find(el => el.getAttribute(attr) === row.charId);
    const cell = q('data-cell'); if (cell) cell.innerHTML = cellHtml(row);
    const cnt = q('data-count'); if (cnt) cnt.textContent = row.count || '';
    const p = dlg.body.querySelector('#tr-progress');
    if (p) p.textContent = `${done} из ${total}`;
  }

  function renderResults(stopped) {
    const s = summarize(lastRows);
    dlg.sub.textContent = `${stopped ? '⏹ Остановлено. ' : ''}${lastDry ? `Пробный запуск: готово к передаче ${s.dry} из ${s.total}.` : `Передано: ${s.ok} из ${s.total}${s.items ? ` (предметов: ${s.items})` : ''}.`}`
      + `${s.partial ? ` Не всё: ${s.partial}.` : ''}${s.unknown ? ` Не распознано: ${s.unknown}.` : ''}${s.failed ? ` Ошибок: ${s.failed}.` : ''}${s.skipped ? ` Пропущено: ${s.skipped}.` : ''}`;
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    const sent = lastRows.filter(r => isOk(r.status) && r.items.length);
    dlg.body.innerHTML = `${tableHtml(lastPlans, byId)}
      ${sent.map(r => `<details class="promo-reward"><summary>📦 ${escapeHtml(r.nick)} → ${escapeHtml(r.recipient)}: ${r.count} предм.</summary><div class="promo-muted">${escapeHtml(totalsText(r.items, 30))}</div></details>`).join('')}
      ${s.unknown || s.partial ? '<p class="promo-warn">❓ «Не распознано» и «Передано не всё»: сверьте результат с «Историей передачи» на сайте. Автоматически эти аккаунты не повторяются, чтобы не отправить предметы дважды.</p>' : ''}
      ${!lastDry && s.ok ? '<p class="promo-muted">Предметы дойдут до персонажа примерно через 30 минут. Строки со статусом «В обработке» на сайте — это нормально.</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <span style="flex:1"></span>
      <button class="btn secondary" data-act="retry" ${s.rerun ? '' : 'disabled'}>🔁 Повторить неудачные${s.rerun ? ` (${s.rerun})` : ''}</button>
      <button class="btn primary" data-act="close">Закрыть</button>`;
  }

  /* ----------------------------- события ----------------------------- */

  dlg.body.addEventListener('input', (e) => {
    if (e.target.id === 'tr-search') { search = e.target.value; dlg.body.querySelector('#tr-list').innerHTML = listHtml(); }
  });
  dlg.body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'tr-server') {
      serverId = t.value;
      prefs.server = serverId; savePrefs(prefs);
      dlg.body.querySelector('#tr-list').innerHTML = listHtml();
      updateAll();
    } else if (t.id === 'tr-ack') {
      updateAll();
    } else if (t.matches('[data-id]')) {
      if (t.checked) selected.add(t.dataset.id); else selected.delete(t.dataset.id);
      updateAll();
    } else if (t.matches('[data-pick]')) {
      const id = t.dataset.pick;
      prefs.picks[id] = { ...(prefs.picks[id] || {}) };
      if (t.value) prefs.picks[id][serverId] = t.value; else delete prefs.picks[id][serverId];
      savePrefs(prefs);
      updateAll();
    }
  });
  dlg.body.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) quickSelect(q.dataset.q);
  });

  /** Запуск по плану; возвращает после результата. */
  async function run(dry) {
    if (!serverId) { toast('Выберите сервер назначения', 'warning'); return; }
    const plans = currentPlans();
    if (!plans.some(p => p.run)) { toast('Некому передавать: проверьте браузеры и получателей', 'warning'); return; }
    if (!dry) {
      if (!dlg.body.querySelector('#tr-ack')?.checked) { toast('Поставьте галочку: передача необратима', 'warning'); return; }
      if (!(await ensureBackup())) return;
    }
    await start(plans, dry);
  }

  dlg.foot.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'back') { renderForm(); return; }
    if (act === 'log') { openTransferLog(); return; }
    if (act === 'dry') { await run(true); return; }
    if (act === 'start') { await run(false); return; }
    if (act === 'retry') {
      const byId = new Map(lastRows.map(r => [r.charId, r]));
      const plans = lastPlans.filter(p => p.run && isRerunnable(byId.get(p.char.id)));
      if (!plans.length) return;
      if (!lastDry && !(await ensureBackup())) return;
      await start(plans, lastDry);
    }
  });
  // «Подтянуть» стоит в теле формы, а не внизу: обрабатываем здесь
  dlg.body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="scan"]')) await scanSelected();
  });

  async function scanSelected() {
    const chars = selectedChars();
    if (!chars.length) { toast('Отметьте браузеры, у которых нужно прочитать серверы и персонажей', 'warning'); return; }
    await scan(chars);
  }

  renderForm();
  // Браузеры, выбранные заранее и ещё без списка серверов, читаются сразу (только чтение страницы)
  const fresh = selectedChars().filter(c => !rosters[c.id]);
  if (fresh.length) scan(fresh);
  return dlg;
}
