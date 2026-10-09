// js/modules/automation/transfer.js
// 📦 Передача предметов в игру (Issue #26): диалог «браузеры → сервер → получатель → сводка → передача → итог».
// Подарки лежат на аккаунте сайта; приложение управляет страницей /promo_items.php в окне каждого браузера.
// Rust-команды: read_transfer_page, transfer_items (src-tauri/src/automation/transfer.rs). Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import {
  serverList, charsOnServer, planTransfer, statusInfo, rowLabel, isOk, isRerunnable, summarize, itemTotals, charTitle
} from './transferCore.js';
import { loadRosters, loadPrefs, savePrefs, setRoster, clearPending, pruneRosters, recordTransfer, limitsMap, saveLimits, loadLimits, clearLimits } from './transferStore.js';
import { scanRosters, runTransferBatch } from './transferRunner.js';
import { getServerStatus, refreshServerStatus, onServerStatus } from '../servers/serverStatus.js';
import { serverStatusHtml } from '../servers/serverStatusView.js';
import { openTransferLog } from './transferLogView.js';

const dot = (c) => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const charLine = (c) => `${charTitle(c)} (${c.cls || '?'}, ур. ${c.level})`;

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
    return confirmModal({
      title: 'Продолжить без резервной копии?',
      text: `Не удалось создать резервную копию данных (${e?.message || e}). Передача предметов изменит данные, и откатить её без копии будет нечем.`,
      okText: 'Продолжить без копии',
      danger: true
    });
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
  let showPlan = false;        // развёрнут ли список «что будет передано»
  const prefs = loadPrefs();
  let scanNotes = [];        // что не удалось прочитать при последнем чтении
  let running = null;        // { cancelled } пока идёт чтение или передача
  let lastRows = [];
  let lastPlans = [];
  let lastDry = false;
  let force = false;         // «обойти ограничения приложения»: запомненные ограничения по серверам не применяются (не запоминается между открытиями)

  let offStatus = () => {};
  const dlg = openOverlay({ title: '📦 Передача предметов в игру', wide: true, onClose: () => { offStatus(); if (running) running.cancelled = true; } });
  dlg.body.classList.add('tr-body');   // блоки не сжимаются, окно прокручивается (иначе список браузеров схлопывается)
  const alive = () => dlg.el.isConnected;
  // Названия всех серверов — со страницы «Статус серверов» (общие данные приложения: плашка в шапке, чтение при запуске и по расписанию)
  const servers = () => serverList(rosters, getServerStatus().status);
  const paintStatus = () => { const el = dlg.body.querySelector('#tr-server-status'); if (el) el.innerHTML = serverStatusHtml(getServerStatus()); };
  offStatus = onServerStatus(() => { if (alive()) paintStatus(); });
  // Сервер выбирается в каждой строке (браузер → сервер → персонаж) и запоминается; пока не выбран — строка не передаётся.
  // Запомненный сервер действует, только если у аккаунта на нём по-прежнему есть персонажи.
  const rowServer = (c) => { const sid = prefs.servers?.[c.id] || ''; return sid && charsOnServer(rosters[c.id], sid).length ? sid : ''; };
  const serverMap = () => Object.fromEntries(state.characters.map(c => [c.id, rowServer(c)]));

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

  function serverCell(c) {
    const r = rosters[c.id];
    if (!r) return '<select class="input tr-server" disabled><option>не загружено</option></select>';
    if (!r.shards.some(sh => sh.chars.length)) return '<select class="input tr-server" disabled><option>нет персонажей</option></select>';
    const cur = rowServer(c);
    return `<select class="input tr-server" data-srv="${escapeHtml(c.id)}">
      <option value="">— сервер не выбран —</option>
      ${servers().filter(sv => sv.id).map(sv => {
        const has = charsOnServer(r, sv.id).length > 0;
        return `<option value="${escapeHtml(sv.id)}" ${has ? '' : 'disabled'} ${sv.id === cur ? 'selected' : ''}>${escapeHtml(`${sv.online === true ? '🟢 ' : sv.online === false ? '🔴 ' : ''}${sv.name}${has ? '' : ' — нет персонажей'}`)}</option>`;
      }).join('')}
    </select>`;
  }

  function recipientHtml(c) {
    const r = rosters[c.id];
    if (!r) return '<select class="input tr-recipient" disabled><option>не загружено</option></select>';
    const sid = rowServer(c);
    if (!sid) return '<select class="input tr-recipient" disabled><option>сначала выберите сервер</option></select>';
    const list = charsOnServer(r, sid);
    const pick = picksOf()[c.id]?.[sid] || '';
    const first = list.length === 1 ? `Авто: ${charLine(list[0])}` : '— не выбран: не передавать —';
    return `<select class="input tr-recipient" data-pick="${escapeHtml(c.id)}">
      <option value="">${escapeHtml(first)}</option>
      ${list.map(ch => `<option value="${escapeHtml(ch.key)}" ${pick === ch.key ? 'selected' : ''}>${escapeHtml(charLine(ch))}</option>`).join('')}
    </select>`;
  }

  /** Строка: галочка · персонаж приложения · что известно · сервер · получатель на этом сервере. */
  const rowHtml = (c) => `
      <div class="promo-item tr-row" data-row="${escapeHtml(c.id)}">
        <label class="tr-pick"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
          <span>${dot(c)}</span><b>${escapeHtml(c.nick)}</b></label>
        <button class="btn ghost small tr-refresh" data-act="refresh-one" data-char="${escapeHtml(c.id)}" title="Прочитать заново серверы, персонажей и то, что ждёт передачи — только у «${escapeHtml(c.nick)}»">🔄</button>
        <span class="promo-muted tr-info">${escapeHtml(infoText(c))}</span>
        ${serverCell(c)}
        ${recipientHtml(c)}
      </div>`;

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty">Никого не найдено</div>';
    return list.map(rowHtml).join('');
  }

  function renderForm() {
    dlg.sub.textContent = '';
    dlg.body.innerHTML = `
      <details class="tr-servers" id="tr-servers">
        <summary title="Серверы нужны не для перевода, а чтобы в списках рядом с ними были зелёные/красные точки. Открывать здесь нечего — обновление страницы серверов есть ниже.">🖥 Статус серверов</summary>
        <div class="tr-top">
          <div class="server-status" id="tr-server-status">${serverStatusHtml(getServerStatus())}</div>
          <button class="btn secondary small" data-act="refresh-servers" title="Прочитать заново страницу «Статус серверов» (аккаунты не нужны)">🔄 Обновить сервера</button>
        </div>
      </details>
      <div class="tr-top">
        <button class="btn secondary small" data-act="refresh-all" title="Прочитать у ВСЕХ браузеров приложения серверы, персонажей и то, что ждёт передачи (галочки не нужны)">🔄 Обновить информацию по всем персонажам</button>
      </div>
      <p class="promo-muted promo-hint">Предметы передаются <b>с сайта в игру</b>: всё, что ждёт передачи на аккаунте браузера, уходит персонажу, выбранному в строке, на выбранном там сервере.
        Сервер в строке обязателен: без него браузер пропускается. Получатель не выбран, а на сервере один персонаж — передаём ему; персонажей несколько и никто не выбран — не передаём. Сундуки не открываются (награду выбирают на сайте).</p>
      <div id="tr-notes">${notesHtml()}</div>
      <div class="promo-quick">
        <input class="input" id="tr-search" placeholder="Поиск: ник, класс, тег" value="${escapeHtml(search)}">
        <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
        <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
        <button class="btn ghost small" data-q="none">Снять выбор</button>
        <button class="btn secondary small" data-act="refresh-selected" id="tr-check-btn" title="Прочитать серверы, персонажей и то, что ждёт передачи — только у отмеченных (остальные не трогаем)"></button>
        <button class="btn secondary small" data-q="plan" id="tr-plan-btn" title="Расписать по каждому браузеру: куда и какие предметы будут переданы"></button>
      </div>
      <div class="promo-list tr-list" id="tr-list">${listHtml()}</div>
      <div class="promo-count" id="tr-count"></div>
      <div class="tr-summary" id="tr-summary"></div>
      <div class="tr-plan" id="tr-plan" hidden></div>
      <div class="tr-ack-box">
        <label class="tr-ack"><input type="checkbox" id="tr-ack"> <span>⚠ Понимаю, что передача необратима: предметы уйдут в игру и вернуть их нельзя.</span></label>
        <label class="tr-force"><input type="checkbox" id="tr-force" ${force ? 'checked' : ''}> <span><b>Обойти ограничения приложения</b> и попытаться передать всё на указанных персонажей: запомненные ограничения («только на другой сервер») не применяются, отмечаются все предметы. Ограничения самого сайта (например, «награды можно перевести после 20:00…») это не отменяет: сайт может отклонить передачу.</span></label>
        <button class="btn ghost small" data-act="forget-limits" id="tr-forget" title="Приложение запоминает, что сайт принимает акцию только на другой сервер, и не отмечает её там. Эта кнопка стирает запомненное: акции снова будут отмечаться везде."></button>
      </div>`;
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

  const currentPlans = () => planTransfer(selectedChars(), rosters, { shards: serverMap(), picks: picksOf(), limits: force ? {} : limitsMap() });

  const skipLine = (p) => {
    const info = statusInfo(p.status);
    return `<div class="tr-line">${info.icon} <b>${escapeHtml(p.char.nick)}</b> — ${escapeHtml(info.label)}${p.detail ? ` (${escapeHtml(p.detail)})` : ''}</div>${limitedHtml(p.skipped)}`;
  };

  function summaryHtml(plans) {
    if (!selected.size) return '<div class="promo-muted">Отметьте браузеры (аккаунты сайта), с которых нужно передать предметы.</div>';
    const run = plans.filter(p => p.run).length;
    const skipped = plans.length - run;
    return `${force ? '<div class="promo-alert">⚠ Обход ограничений включён: приложение не пропускает акции, которые сайт ранее принимал только на другой сервер. Сайт может отклонить такие предметы предупреждением.</div>' : ''}
      <div class="promo-count">Будет передано с аккаунтов: ${run} из ${plans.length}.${skipped ? ` Пропущено: ${skipped} (причины — в «Что будет передано»).` : ''}</div>
      <div class="promo-muted tr-notes">Передача необратима. Среднее время передачи в игру — около 30 минут. Лимит сайта «не более 6 предметов за раз» снят: отмечаются все предметы.</div>`;
  }

  /** Предметы, которые сайт принимает только на другой сервер: на этом они не отмечаются. */
  const limitedHtml = (list) => (list?.length
    ? `<div class="promo-warn tr-limited">🔒 Не передаём — сайт принимает их только на другой сервер:
        <ul class="tr-items">${list.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ''} <span class="promo-muted">— «${escapeHtml(i.source)}»: только на «${escapeHtml(i.server)}»</span></li>`).join('')}</ul></div>`
    : '');

  /** Подробный план: по каждому браузеру — куда уйдёт и ПОЛНЫЙ список предметов (без «ещё N»). */
  function planHtml(plans) {
    if (!selected.size) return '';
    return plans.map(p => {
      if (!p.run) return skipLine(p);
      const pend = rosters[p.char.id]?.pending;
      const known = pend && !pend.stale;
      const skippedIds = new Set((p.skipped || []).map(i => i.id));
      const items = known ? itemTotals(pend.items.filter(i => !skippedIds.has(i.id))) : [];
      const body = !known
        ? '<div class="promo-muted">Что ждёт передачи — выяснится на странице сайта. Нажмите «Обновить информацию по всем персонажам», чтобы увидеть заранее.</div>'
        : items.length
          ? `<ul class="tr-items">${items.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ''}</li>`).join('')}</ul>`
          : '<div class="promo-muted">Сейчас нет предметов.</div>';
      return `<div class="tr-plan-item">
        <div class="tr-line">➡️ <b>${escapeHtml(p.char.nick)}</b> → ${escapeHtml(p.serverName)} → <b>${escapeHtml(charLine(p.recipient))}</b>${p.auto ? ' <span class="promo-muted">(единственный на сервере)</span>' : ''}</div>
        ${known ? `<div class="promo-muted">📦 Предметов к передаче: ${items.length}${pend.chests ? ` · сундуков: ${pend.chests} (не передаются, награду выбирают на сайте)` : ''}</div>` : ''}
        ${body}${limitedHtml(p.skipped)}</div>`;
    }).join('');
  }

  function updateAll() {
    const count = dlg.body.querySelector('#tr-count');
    if (count) count.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    const plans = currentPlans();
    const box = dlg.body.querySelector('#tr-summary');
    if (box) box.innerHTML = summaryHtml(plans);
    const planBox = dlg.body.querySelector('#tr-plan');
    if (planBox) { planBox.hidden = !showPlan; planBox.innerHTML = showPlan ? planHtml(plans) : ''; }
    const checkBtn = dlg.body.querySelector('#tr-check-btn');
    if (checkBtn) checkBtn.textContent = selected.size > 1 ? `🔍 Проверить персонажей (${selected.size})` : '🔍 Проверить персонажа';
    const planBtn = dlg.body.querySelector('#tr-plan-btn');
    if (planBtn) planBtn.textContent = showPlan ? '🔼 Скрыть список' : '📋 Что будет передано';
    const forget = dlg.body.querySelector('#tr-forget');
    if (forget) {
      const n = Object.keys(loadLimits()).length;
      forget.textContent = n ? `🧹 Забыть запомненные ограничения (${n})` : '🧹 Запомненных ограничений нет';
      forget.disabled = !n;
    }
    const ack = dlg.body.querySelector('#tr-ack')?.checked;
    const canRun = plans.some(p => p.run);
    const start = dlg.foot.querySelector('[data-act="start"]');
    const dry = dlg.foot.querySelector('[data-act="dry"]');
    if (start) start.disabled = !(canRun && ack);
    if (dry) dry.disabled = !canRun;
  }

  function quickSelect(kind) {
    if (kind === 'plan') { showPlan = !showPlan; updateAll(); return; }
    if (kind === 'none') selected.clear();
    if (kind === 'all') state.characters.forEach(c => selected.add(c.id));
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#tr-list').innerHTML = listHtml();
    updateAll();
  }

  function rerenderRow(id) {
    const c = state.characters.find(x => x.id === id);
    const el = [...dlg.body.querySelectorAll('.tr-row')].find(x => x.dataset.row === id);
    if (c && el) el.outerHTML = rowHtml(c);
  }

  /** Только список серверов сайта (страница «Статус серверов»): галочки и аккаунты не нужны. Без журнала и уведомлений — итог виден на плашке. */
  async function refreshServers() {
    if (running) return;
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const signal = { cancelled: false };
    running = signal;
    dlg.body.querySelectorAll('[data-act^="refresh"]').forEach(b => { b.disabled = true; });
    const { invoke } = await import('@tauri-apps/api/core');
    try { await refreshServerStatus({ signal, invokeFn: invoke, retries, retryDelayMs }); } finally { running = null; }
    if (alive()) renderForm();
  }

  /* ----------------------- чтение серверов ----------------------- */

  /** @param {{ servers?: boolean }} [opts] servers: false — не перечитывать «Статус серверов» (для проверки отдельных персонажей) */
  async function scan(chars, { servers: readServers = true } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const task = startTask(chars.length === 1 ? `📦 Серверы и персонаж: ${chars[0].nick}` : `📦 Серверы и персонажи (${chars.length} браузеров)`, { total: chars.length, cancelable: true });
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

    // Названия всех серверов — со страницы «Статус серверов» (аккаунты не нужны). Без журнала и уведомлений: итог виден на плашке.
    if (!signal.cancelled && readServers) {
      const p = dlg.body.querySelector('#tr-progress');
      if (alive() && p) p.textContent = 'Читаю список серверов…';
      running = signal;
      try { await refreshServerStatus({ signal, invokeFn: invoke, retries, retryDelayMs }); } finally { running = null; }
    }

    scanNotes = rows.filter(r => r.status !== 'ok' && r.status !== 'cancelled')
      .map(r => `${r.nick}: ${r.status === 'not_logged_in' ? 'нет входа на сайт' : r.status === 'challenge' ? 'сайт показал проверку безопасности' : errorText(r.error)}`);
    const ok = rows.filter(r => r.status === 'ok').length;
    task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}Прочитано ${ok} из ${rows.length}`, ok === rows.length ? 'done' : 'warn');
    rows.filter(r => r.status !== 'ok' && r.status !== 'cancelled').forEach(r => task.log(`${r.nick}: ${r.status}${r.error ? ` — ${errorText(r.error)}` : ''}`, 'error'));
    rosters = loadRosters();
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
    const task = startTask(`📦 ${dry ? 'Пробная п' : 'П'}ередача предметов → ${[...new Set(todo.map(p => p.serverName))].join(', ')}`, { total: plans.length, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...plans.map(p => `char:${p.char.id}`));
    task.setStep(`${todo.length} аккаунтов, по ${browserSlots.max} одновременно${dry ? ', без нажатия «Передать»' : ''}`);
    if (force) task.log('Включён «Обойти ограничения приложения»: запомненные ограничения по серверам не применялись', 'info');
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
            if (row.limit) saveLimits(row.limit);   // сайт сказал, на какой сервер принимает эти акции — больше не отмечаем их на других
            if (row.status === 'success' || row.status === 'partial') clearPending(row.charId);
          }
          if (alive()) updateRunning(row, done, all);
        }
      });
    } finally { running = null; }

    rosters = loadRosters();
    const s = summarize(rows);
    task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}${dry ? `Пробный запуск: готово к передаче ${s.dry}` : `Передано ${s.ok}${s.partial ? `, не всё ${s.partial}` : ''}${s.wrong ? `, не тот сервер ${s.wrong}` : ''}`}, не распознано ${s.unknown}, ошибок ${s.failed}, пропущено ${s.skipped}`,
      s.failed || s.unknown || s.partial || s.wrong ? 'warn' : 'done');
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
          <td>${p.recipient ? `${escapeHtml(p.serverName)} → ${escapeHtml(charTitle(p.recipient))}` : '—'}</td>
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
      + `${s.partial ? ` Не всё: ${s.partial}.` : ''}${s.wrong ? ` Не тот сервер: ${s.wrong}.` : ''}${s.unknown ? ` Не распознано: ${s.unknown}.` : ''}${s.failed ? ` Ошибок: ${s.failed}.` : ''}${s.skipped ? ` Пропущено: ${s.skipped}.` : ''}`;
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    const list = (items) => `<ul class="tr-items">${itemTotals(items).map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ''}</li>`).join('')}</ul>`;
    const sent = lastRows.filter(r => r.items.length && (isOk(r.status) || r.done?.length || r.missing?.length));
    dlg.body.innerHTML = `${tableHtml(lastPlans, byId)}
      ${sent.map(r => (r.done?.length || r.missing?.length) && !isOk(r.status)
        ? `<details class="promo-reward" open><summary>📦 ${escapeHtml(r.nick)} → ${escapeHtml(r.recipient)}: передано ${r.done.length} из ${r.items.length}</summary>
            ${r.done.length ? `<div class="promo-muted">✅ Передано (есть в истории сайта):</div>${list(r.done)}` : ''}
            ${r.missing.length ? `<div class="promo-warn">⚠ Не передано${r.warning?.onlyServer ? ` — сайт принимает их только на сервер «${escapeHtml(r.warning.onlyServer)}»` : ''}:</div>${list(r.missing)}` : ''}
            ${limitedHtml(r.limited)}</details>`
        : `<details class="promo-reward"><summary>📦 ${escapeHtml(r.nick)} → ${escapeHtml(r.recipient)}: ${r.count} предм.</summary>${list(r.items)}${limitedHtml(r.limited)}</details>`).join('')}
      ${lastRows.filter(r => !sent.includes(r) && r.limited?.length).map(r => `<div class="tr-plan-item"><b>${escapeHtml(r.nick)}</b>${limitedHtml(r.limited)}</div>`).join('')}
      ${s.wrong ? '<p class="promo-warn">🚫 «Не тот сервер»: эти предметы сайт передаёт только на другой сервер (указан в строке результата). Приложение запомнило это и в следующий раз не будет их отмечать на других серверах — выберите в строке нужный сервер и запустите заново.</p>' : ''}
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
    if (t.matches('[data-srv]')) {
      const id = t.dataset.srv;
      prefs.servers = { ...(prefs.servers || {}) };
      if (t.value) prefs.servers[id] = t.value; else delete prefs.servers[id];
      savePrefs(prefs);
      rerenderRow(id);
      updateAll();
    } else if (t.id === 'tr-ack') {
      updateAll();
    } else if (t.id === 'tr-force') {
      force = t.checked;
      updateAll();
    } else if (t.matches('[data-id]')) {
      if (t.checked) selected.add(t.dataset.id); else selected.delete(t.dataset.id);
      updateAll();
    } else if (t.matches('[data-pick]')) {
      const id = t.dataset.pick;
      const sid = rowServer({ id });
      if (!sid) return;
      prefs.picks[id] = { ...(prefs.picks[id] || {}) };
      if (t.value) prefs.picks[id][sid] = t.value; else delete prefs.picks[id][sid];
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
    const plans = currentPlans();
    if (!plans.some(p => p.run)) { toast('Некому передавать: отметьте браузеры и выберите в строках сервер и получателя', 'warning'); return; }
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
  // Кнопки обновления стоят в теле формы, а не внизу: обрабатываем здесь
  dlg.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'refresh-servers') await refreshServers();
    if (act === 'refresh-all' && !running) await scan([...state.characters].sort(byNick));
    if (act === 'forget-limits' && !running) {
      const n = Object.keys(loadLimits()).length;
      if (n) {
        const ok = await confirmModal({
          title: `Забыть запомненные ограничения (${n})?`,
          text: 'Акции, которые сайт принимает только на определённый сервер, снова будут отмечаться на всех серверах; приложение запомнит их заново, если сайт откажет.',
          okText: 'Забыть',
          danger: true
        });
        if (ok) {
          clearLimits();
          updateAll();
          toast('Запомненные ограничения стёрты', 'info');
        }
      }
    }
    if (act === 'refresh-one' && !running) {
      const c = state.characters.find(x => x.id === e.target.closest('[data-char]')?.dataset.char);
      if (c) await scan([c], { servers: false });
    }
    if (act === 'refresh-selected' && !running) {
      const chars = selectedChars();
      if (!chars.length) { toast('Отметьте персонажей, которых нужно проверить', 'warning'); return; }
      await scan(chars, { servers: false });
    }
  });

  renderForm();
  // Браузеры, выбранные заранее и ещё без списка серверов, читаются сразу (только чтение страницы)
  const fresh = selectedChars().filter(c => !rosters[c.id]);
  if (fresh.length) scan(fresh);
  return dlg;
}
