import { confirmTransfer } from './transferConfirm.js';
import { groupTransferItems, chooseTransferPackets, transferExpiry } from './transferItemGroups.js';
import { classIconHtml, stripeCls } from './characterPicker.js';
import { layoutScriptWorkspace } from './scriptWorkspace.js';
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
  serverList,
  charsOnServer,
  planTransfer,
  statusInfo,
  rowLabel,
  isOk,
  isRerunnable,
  summarize,
  itemTotals,
  charTitle
} from './transferCore.js';
import {
  loadRosters,
  loadPrefs,
  savePrefs,
  setRoster,
  clearPending,
  pruneRosters,
  recordTransfer,
  limitsMap,
  saveLimits
} from './transferStore.js';
import { scanRosters, runTransferBatch } from './transferRunner.js';
import { getServerStatus, refreshServerStatus, onServerStatus } from '../servers/serverStatus.js';
import { serverStatusHtml } from '../servers/serverStatusView.js';
import { openTransferLog } from './transferLogView.js';
import { chipsHtml, noteHtml, progressHtml, sectionHtml, setProgress } from './scriptUi.js';
import { makeScriptReport } from './scriptReport.js';
import { openScriptStatistics } from './scriptReportView.js';

const setsLabel = n =>
  `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'наборов' : n % 10 === 1 ? 'набор' : n % 10 >= 2 && n % 10 <= 4 ? 'набора' : 'наборов'}`;
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const when = iso => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const charLine = c => `${charTitle(c)} (${c.cls || '?'}, ур. ${c.level})`;

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

const rowDetail = r => {
  if (r.status === 'error') return errorText(r.error);
  if (r.status === 'unknown' && r.error) return errorText(r.error);
  return r.detail || '';
};

const cellHtml = row => {
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
  if (!state.characters.length) {
    toast('Сначала добавьте персонажей', 'info');
    return null;
  }
  pruneRosters(state.characters.map(c => c.id));
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let loginFilter = 'all';
  const itemChoices = new Map();
  const invalidItemChoices = new Set();
  let rosters = loadRosters();
  const prefs = loadPrefs();
  let scanNotes = []; // что не удалось прочитать при последнем чтении
  let running = null; // { cancelled } пока идёт чтение или передача
  let lastRows = [];
  let lastPlans = [];
  let lastDry = false;
  let lastReports = []; // включает прошлые попытки текущего повтора
  let confirming = false;
  let confirmationAbort = null;
  let force = false; // «обойти ограничения приложения»: запомненные ограничения по серверам не применяются (не запоминается между открытиями)

  let offStatus = () => {};
  const dlg = openOverlay({
    title: '📦 Передача предметов в игру',
    wide: true,
    onClose: () => {
      offStatus();
      confirmationAbort?.abort();
      if (running) {
        running.stop?.();
        running.cancelled = true;
      }
    }
  });
  dlg.body.classList.add('tr-body'); // блоки не сжимаются, окно прокручивается (иначе список браузеров схлопывается)
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;
  // Названия всех серверов — со страницы «Статус серверов» (общие данные приложения: плашка в шапке, чтение при запуске и по расписанию)
  const servers = () => serverList(rosters, getServerStatus().status);
  const paintStatus = () => {
    const el = dlg.body.querySelector('#tr-server-status');
    if (el) el.innerHTML = serverStatusHtml(getServerStatus());
  };
  offStatus = onServerStatus(() => {
    if (alive()) paintStatus();
  });
  // Сервер выбирается в каждой строке (браузер → сервер → персонаж) и запоминается; пока не выбран — строка не передаётся.
  // Запомненный сервер действует, только если у аккаунта на нём по-прежнему есть персонажи.
  const rowServer = c => {
    const sid = prefs.servers?.[c.id] || '';
    return sid && charsOnServer(rosters[c.id], sid).length ? sid : '';
  };
  const serverMap = () => Object.fromEntries(state.characters.map(c => [c.id, rowServer(c)]));

  const selectedChars = () => state.characters.filter(c => selected.has(c.id)).sort(byNick);
  const picksOf = () => prefs.picks;

  /* ---------------------------- форма ---------------------------- */

  function visibleChars() {
    const q = search.trim().toLowerCase();
    return [...state.characters]
      .sort(byNick)
      .filter(
        c =>
          loginFilter === 'all' ||
          (loginFilter === 'selected'
            ? selected.has(c.id)
            : loginFilter === 'logged'
              ? c.isLoggedIn === true
              : c.isLoggedIn !== true)
      )
      .filter(c => !q || [c.nick, c.className, ...(c.tags || [])].join(' ').toLowerCase().includes(q));
  }

  function infoText(c) {
    const r = rosters[c.id];
    if (!r) return 'серверы не загружены';
    const n = r.shards.reduce((s, x) => s + x.chars.length, 0);
    const p =
      r.pending && !r.pending.stale
        ? `к передаче: ${r.pending.items.length}${r.pending.chests ? `, сундуков: ${r.pending.chests}` : ''}`
        : 'к передаче: обновите';
    return `${r.shards.length ? r.shards.map(s => s.name).join(', ') : 'нет персонажей'} · перс.: ${n} · ${p} · ${when(r.at)}`;
  }

  function serverCell(c) {
    const r = rosters[c.id];
    if (!r) return '<select class="input tr-server" disabled><option>не загружено</option></select>';
    if (!r.shards.some(sh => sh.chars.length))
      return '<select class="input tr-server" disabled><option>нет персонажей</option></select>';
    const cur = rowServer(c);
    return `<select class="input tr-server" data-srv="${escapeHtml(c.id)}">
      <option value="">— сервер не выбран —</option>
      ${servers()
        .filter(sv => sv.id)
        .map(sv => {
          const has = charsOnServer(r, sv.id).length > 0;
          return `<option value="${escapeHtml(sv.id)}" ${has ? '' : 'disabled'} ${sv.id === cur ? 'selected' : ''}>${escapeHtml(`${sv.online === true ? '🟢 ' : sv.online === false ? '🔴 ' : ''}${sv.name}${has ? '' : ' — нет персонажей'}`)}</option>`;
        })
        .join('')}
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
  const rowHtml = c => `
      <div class="promo-item tr-row ${stripeCls(c)}" data-row="${escapeHtml(c.id)}">
        <label class="tr-pick"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
          ${classIconHtml(c)}<b>${escapeHtml(c.nick)}</b></label>
        <button class="btn ghost small tr-refresh" data-act="refresh-one" data-char="${escapeHtml(c.id)}" title="Прочитать заново серверы, персонажей и то, что ждёт передачи — только у «${escapeHtml(c.nick)}»">🔄</button>
        <span class="promo-muted tr-info">${escapeHtml(infoText(c))}</span>
        ${serverCell(c)}
        ${recipientHtml(c)}
      </div>`;

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty empty-state">Никого не найдено</div>';
    return list.map(rowHtml).join('');
  }

  function renderForm() {
    dlg.sub.textContent = '';
    dlg.body.innerHTML = `
      ${noteHtml({
        icon: '📦',
        title: 'Что сделает это окно',
        text:
          'Всё, что ждёт передачи на аккаунте сайта, уходит персонажу, выбранному в строке, на выбранном там же сервере. ' +
          'Сервер в строке обязателен: без него браузер пропускается. Сундуки не открываются — награду выбирают на сайте. ' +
          'Передача необратима, поэтому перед запуском стоит прочитать блок «Что будет передано».'
      })}
        <div class="tr-top"><label>Сервер для всех <select class="input" data-bulk-server aria-label="Сервер для всех"><option value="">— выберите сервер —</option>${servers()
          .filter(sv => sv.id)
          .map(sv => `<option value="${escapeHtml(sv.id)}">${escapeHtml(sv.name)}</option>`)
          .join(
            ''
          )}</select></label><button type="button" class="btn secondary small" data-act="bulk-server">Применить всем</button></div>
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
      <div id="tr-notes">${notesHtml()}</div>
      ${sectionHtml('Браузеры и получатели', {
        hint: 'сервер и получатель выбираются в каждой строке',
        aside: `<span class="sd-count" id="tr-count"></span>`,
        body: `
        <div class="promo-quick">

          <input class="input" id="tr-search" aria-label="Поиск браузера" placeholder="Поиск: ник, класс, тег" value="${escapeHtml(search)}">
          <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
          <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
          <button class="btn ghost small" data-q="none">Снять выбор</button>
          <button class="btn secondary small" data-act="refresh-selected" id="tr-check-btn" title="Прочитать серверы, персонажей и то, что ждёт передачи — только у отмеченных (остальные не трогаем)"></button>
        </div>
        <div class="promo-list tr-list" id="tr-list">${listHtml()}</div>
        <div class="tr-summary" id="tr-summary"></div>
        `
      })}
      `;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log" title="Журнал передач">📜 Журнал</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn secondary" data-q="plan" id="tr-plan-btn">📋 Что будет передано</button>
      <button class="btn secondary" data-act="dry" title="Пройти все шаги, но не нажимать «Передать»">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start" disabled>📦 Передать</button>`;
    updateAll();

    layoutScriptWorkspace(dlg, {
      selected: selected,
      apply(ids, mode) {
        loginFilter = mode === 'all' ? 'all' : 'selected';
        selected.clear();
        ids.forEach(id => selected.add(id));
        renderForm();
      }
    });
  }

  const notesHtml = () =>
    scanNotes.length
      ? `<div class="promo-alert">${scanNotes.map(n => `<div>⚠ ${escapeHtml(n)}</div>`).join('')}</div>`
      : '';

  const currentPlans = ({ ignoreLimits = force } = {}) =>
    planTransfer(selectedChars(), rosters, {
      shards: serverMap(),
      picks: picksOf(),
      limits: ignoreLimits ? {} : limitsMap()
    }).map(p => {
      const pending = rosters[p.char.id]?.pending;
      if (!pending || pending.stale) return p;
      const excluded = new Set((p.skipped || []).map(i => i.id));
      const choices = itemChoices.get(p.char.id);
      const itemSelection = pending.items.filter(i => !excluded.has(i.id) && (!choices || choices.has(i.id)));
      return {
        ...p,
        itemSelection,
        ...(p.run && !itemSelection.length ? { run: false, status: 'nothing_to_transfer' } : {})
      };
    });

  const skipLine = p => {
    const info = statusInfo(p.status);
    return `<div class="tr-line">${info.icon} <b>${classIconHtml(p.char)} ${escapeHtml(p.char.nick)}</b> — ${escapeHtml(info.label)}${p.detail ? ` (${escapeHtml(p.detail)})` : ''}</div>${limitedHtml(p.skipped)}`;
  };

  function summaryHtml(plans) {
    if (!selected.size)
      return '<div class="promo-muted">Отметьте браузеры (аккаунты сайта), с которых нужно передать предметы.</div>';
    const run = plans.filter(p => p.run).length;
    const skipped = plans.length - run;
    return `${invalidItemChoices.size ? '<p class="promo-warn">Исправьте количество в «Что будет передано»: передача заблокирована.</p>' : ''}${force ? '<div class="promo-alert">⚠ Обход ограничений включён: приложение не пропускает акции, которые сайт ранее принимал только на другой сервер. Сайт может отклонить такие предметы предупреждением.</div>' : ''}
      <div class="sd-summary">
        <div class="sd-summary-line">Будет передано с аккаунтов: <b>${run}</b> из <b>${plans.length}</b>${skipped ? `. Пропущено: <b>${skipped}</b> — причины в блоке «Что будет передано».` : '.'}</div>
        <div class="promo-muted tr-notes">Передача необратима. Среднее время передачи в игру — около 30 минут. Передаются только выбранные наборы. Для выбора и свежей проверки откройте «Что будет передано».</div>
      </div>`;
  }

  /** Предметы, которые сайт принимает только на другой сервер: на этом они не отмечаются. */
  const limitedHtml = list =>
    list?.length
      ? `<div class="promo-warn tr-limited">🔒 Не передаём — сайт принимает их только на другой сервер:
        <ul class="tr-items">${list.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ''} <span class="promo-muted">— «${escapeHtml(i.source)}»: только на «${escapeHtml(i.server)}»</span></li>`).join('')}</ul></div>`
      : '';

  function updateAll() {
    const count = dlg.body.querySelector('#tr-count');
    if (count) count.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    const plans = currentPlans();
    const box = dlg.body.querySelector('#tr-summary');
    if (box) box.innerHTML = summaryHtml(plans);
    const checkBtn = dlg.body.querySelector('#tr-check-btn');
    if (checkBtn)
      checkBtn.textContent =
        selected.size > 1 ? `🔍 Проверить персонажей (${selected.size})` : '🔍 Проверить персонажа';
    const planBtn = dlg.foot.querySelector('#tr-plan-btn');
    if (planBtn) planBtn.textContent = '📋 Что будет передано';
    const canRun = plans.some(p => p.run);
    const potential = currentPlans({ ignoreLimits: true });
    const selectionKnown = potential.filter(p => p.run).every(p => Array.isArray(p.itemSelection));
    const start = dlg.foot.querySelector('[data-act="start"]');
    const dry = dlg.foot.querySelector('[data-act="dry"]');
    if (start) start.disabled = !(potential.some(p => p.run) && selectionKnown && !invalidItemChoices.size);
    if (dry) dry.disabled = !canRun;
  }

  function quickSelect(kind) {
    if (kind === 'plan') {
      if (running || !selected.size) return;
      const chars = selectedChars();
      let previewClosed = false;
      const preview = openOverlay({
        title: '📋 Что будет передано',
        wide: true,
        onClose: () => {
          previewClosed = true;
          if (running) running.stop?.();
        }
      });
      preview.el.querySelector('.modal-container').classList.add('tr-preview-dialog');
      preview.sub.textContent =
        'Проверяю предметы на сайте отмеченных персонажей (до 30 с на попытку). Ничего не передаётся.';
      preview.body.innerHTML = '<p>Читаю сайт…</p>';
      void (async () => {
        const checked = await scan(chars, { servers: false, isCancelled: () => previewClosed });
        const freshIds = new Set((checked || []).filter(row => row.status === 'ok').map(row => row.charId));
        if (!preview.el.isConnected || !alive()) return;
        preview.foot.querySelector('[data-preview-stop]').hidden = true;
        preview.sub.textContent =
          'Укажите количество наборов (0 — оставить на сайте). Сначала выбираются наборы с ближайшим известным сроком, затем с неизвестным. Категории объединены; набор неделим. Перед отправкой сайт проверяется заново.';
        for (const key of invalidItemChoices) {
          if (freshIds.has(JSON.parse(key)[0])) invalidItemChoices.delete(key);
        }
        updateAll();
        const plans = currentPlans();
        const groupsByChar = new Map();
        preview.body.innerHTML =
          '<div class="tr-preview-tools"><input class="input" type="search" data-item-search placeholder="Найти предмет" aria-label="Найти предмет"><button type="button" class="btn ghost small" data-items-clear>Снять всё</button><button type="button" class="btn ghost small" data-items-all>Поставить всё</button><span data-transfer-total role="status"></span></div><small class="promo-muted">Поиск только скрывает строки — выбор предметов не меняется. «Снять всё» оставит все предметы на сайте.</small>' +
            notesHtml() +
            plans
              .filter(
                p =>
                  freshIds.has(p.char.id) &&
                  rosters[p.char.id]?.pending?.items?.length &&
                  !rosters[p.char.id].pending.stale
              )
              .map(p => {
                const excluded = new Set((p.skipped || []).map(i => i.id));
                const items = rosters[p.char.id].pending.items.filter(i => !excluded.has(i.id));
                if (!items.length) return '';
                const choices = itemChoices.get(p.char.id);
                const groups = groupTransferItems(items);
                groupsByChar.set(p.char.id, groups);
                return `<section><h4>${classIconHtml(p.char)} ${escapeHtml(p.char.nick)}</h4>${p.run ? `<p>→ ${escapeHtml(p.serverName)} → ${escapeHtml(charLine(p.recipient))}${p.auto ? ' (единственный на сервере)' : ''}</p>` : skipLine(p)}
                  <div class="promo-scroll"><table class="promo-table tr-item-groups tr-item-grid ${groups.length >= 9 ? 'is-many' : groups.length >= 4 ? 'is-medium' : 'is-few'}"><thead><tr><th>Предмет</th><th>Доступно</th><th>Передать наборов</th></tr></thead><tbody>${groups
                    .map((group, index) => {
                      const count = group.items.filter(item => !choices || choices.has(item.id)).length;
                      const batches = new Map();
                      for (const item of group.items) {
                        const key = JSON.stringify([item.source || '', item.until || '']);
                        const batch = batches.get(key) || { ...item, count: 0 };
                        batch.count++;
                        batches.set(key, batch);
                      }
                      const first = group.items.find(item => Number.isFinite(transferExpiry(item.until)));
                      const expiry = first
                        ? `Ближайший срок: ${escapeHtml(first.until)}`
                        : 'Срок не указан / не распознан';
                      const details =
                        new Set(group.items.map(item => item.until || '')).size > 1
                          ? `<details class="tr-packet-details"><summary>${expiry}</summary><ul>${[...batches.values()].map(batch => `<li>${batch.count * group.qty} шт. · ${escapeHtml(batch.source || 'Без категории')} · ${escapeHtml(batch.until || 'Без срока')}</li>`).join('')}</ul></details>`
                          : `<small>${expiry}</small>`;
                      return `<tr data-transfer-group-row><td><b>${escapeHtml(group.name)}</b><small>В наборе ×${group.qty} штук</small>${details}</td><td>${setsLabel(group.items.length)}<small>${group.items.length * group.qty} шт. предмета</small></td><td><div class="tr-packet-count"><input class="input" type="number" min="0" max="${group.items.length}" step="1" value="${count}" data-transfer-char="${escapeHtml(p.char.id)}" data-item-group="${index}" aria-label="Передать наборов: ${escapeHtml(group.name)}"><button type="button" class="btn ghost small" data-group-max title="Выбрать все предметы этой позиции">Все</button></div><small data-selected-quantity>Выбрано: ${setsLabel(count)} (${count * group.qty} шт.)</small></td></tr>`;
                    })
                    .join('')}</tbody></table></div></section>`;
              })
              .join('') || '<p>Нет перечисленных предметов для передачи.</p>';
        const updateTotal = () => {
          let packets = 0,
            units = 0;
          for (const input of preview.body.querySelectorAll('[data-item-group]')) {
            const group = groupsByChar.get(input.dataset.transferChar)[Number(input.dataset.itemGroup)];
            const selected = itemChoices.get(input.dataset.transferChar);
            const n = group.items.filter(item => !selected || selected.has(item.id)).length;
            packets += n;
            units += n * group.qty;
          }
          preview.body.querySelector('[data-transfer-total]').textContent =
            `Выбрано: ${units} шт. (${setsLabel(packets)})`;
        };
        updateTotal();
        preview.body.onclick = event => {
          if (event.target.closest('[data-items-clear]')) {
            for (const id of groupsByChar.keys()) itemChoices.set(id, new Set());
            for (const key of invalidItemChoices) {
              if (groupsByChar.has(JSON.parse(key)[0])) invalidItemChoices.delete(key);
            }
            preview.body.querySelectorAll('[data-item-group]').forEach(input => {
              input.value = '0';
              input.setCustomValidity('');
              input.closest('td').querySelector('[data-selected-quantity]').textContent = 'Выбрано: 0 наборов (0 шт.)';
            });
            updateTotal();
            updateAll();
            return;
          }
          if (event.target.closest('[data-items-all]')) {
            preview.body.querySelectorAll('[data-item-group]').forEach(input => {
              input.value = input.max;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            return;
          }
          const max = event.target.closest('[data-group-max]');
          if (!max) return;
          const input = max.closest('tr').querySelector('[data-item-group]');
          input.value = input.max;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        preview.body.oninput = event => {
          if (!event.target.matches('[data-item-search]')) return;
          const query = event.target.value.trim().toLocaleLowerCase('ru-RU');
          preview.body.querySelectorAll('[data-transfer-group-row]').forEach(row => {
            row.hidden = !row.textContent.toLocaleLowerCase('ru-RU').includes(query);
          });
        };
        preview.body.onchange = event => {
          const input = event.target.closest('[data-transfer-char]');
          if (!input) return;
          const id = input.dataset.transferChar;
          const group = groupsByChar.get(id)?.[Number(input.dataset.itemGroup)];
          if (!group) return;
          const choices = itemChoices.get(id) || new Set(rosters[id].pending.items.map(i => i.id));
          const count = input.value.trim() ? Number(input.value) : NaN;
          const next = chooseTransferPackets(group, count, choices);
          input.setCustomValidity(next ? '' : `Укажите целое число наборов от 0 до ${group.items.length}`);
          const key = JSON.stringify([id, input.dataset.itemGroup]);
          if (!next) {
            invalidItemChoices.add(key);
            updateAll();
            input.reportValidity();
            return;
          }
          invalidItemChoices.delete(key);
          itemChoices.set(id, next);
          updateTotal();
          input.closest('td').querySelector('[data-selected-quantity]').textContent =
            `Выбрано: ${setsLabel(count)} (${count * group.qty} шт.)`;
          updateAll();
        };
      })().catch(() => {
        if (preview.el.isConnected)
          preview.body.textContent = 'Не удалось прочитать сайт. Прежний выбор сохранён; повторите проверку.';
      });
      preview.foot.innerHTML =
        '<button type="button" class="btn danger" data-preview-stop>Стоп проверки</button><button type="button" class="btn primary" data-preview-close>Закрыть</button>';
      preview.foot.querySelector('[data-preview-stop]').onclick = () => {
        running?.stop?.();
        preview.close();
      };
      preview.foot.querySelector('[data-preview-close]').onclick = () => preview.close();
      return;
    }
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
    dlg.body.querySelectorAll('[data-act^="refresh"]').forEach(b => {
      b.disabled = true;
    });
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await refreshServerStatus({ signal, invokeFn: invoke, retries, retryDelayMs });
    } finally {
      running = null;
    }
    if (alive()) renderForm();
  }

  /* ----------------------- чтение серверов ----------------------- */

  /** @param {{ servers?: boolean }} [opts] servers: false — не перечитывать «Статус серверов» (для проверки отдельных персонажей) */
  async function scan(chars, { servers: readServers = true, isCancelled = () => false } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    if (isCancelled() || !alive()) return [];
    const task = startTask(
      chars.length === 1
        ? `📦 Серверы и персонаж: ${chars[0].nick}`
        : `📦 Серверы и персонажи (${chars.length} браузеров)`,
      { total: chars.length, cancelable: true }
    );
    const signal = { cancelled: false };
    running = signal;
    signal.stop = () => task.stop();
    task.onCancel(() => {
      signal.cancelled = true;
    });
    // Ждём своей очереди: пока идёт другой скрипт, работу не начинаем
    await task.waitTurn();
    task.watch(...chars.map(c => `char:${c.id}`));
    await task.ready?.();
    task.setStep(`${chars.length} браузеров, по ${browserSlots.max} одновременно, повторов до ${retries}`);
    renderScanning(chars, signal);

    const { invoke } = await import('@tauri-apps/api/core');
    let rows;
    try {
      rows = await scanRosters({
        chars,
        signal,
        invokeFn: invoke,
        retries,
        retryDelayMs,
        task,
        onRow: (row, done, all) => {
          if (row.status === 'ok' && row.roster) {
            // Неполный ответ сайта не стирает прежние списки и выбор пользователя.
            setRoster(row.charId, row.roster, new Date(), { preserveLookup: true });
          }
          if (alive()) updateScanning(row, done, all);
        }
      });
    } finally {
      running = null;
    }

    // Названия всех серверов — со страницы «Статус серверов» (аккаунты не нужны). Без журнала и уведомлений: итог виден на плашке.
    if (!signal.cancelled && readServers) {
      const p = dlg.body.querySelector('#tr-progress');
      if (alive() && p) p.textContent = 'Читаю список серверов…';
      running = signal;
      signal.stop = () => task.stop();
      try {
        await refreshServerStatus({ signal, invokeFn: invoke, retries, retryDelayMs });
      } finally {
        running = null;
      }
    }

    scanNotes = rows
      .filter(r => r.status !== 'ok' && r.status !== 'cancelled')
      .map(
        r =>
          `${r.nick}: ${r.status === 'not_logged_in' ? 'нет входа на сайт' : r.status === 'challenge' ? 'сайт показал проверку безопасности' : errorText(r.error)}`
      );
    const ok = rows.filter(r => r.status === 'ok').length;
    task.finish(
      `${signal.cancelled ? 'Остановлено. ' : ''}Прочитано ${ok} из ${rows.length}`,
      ok === rows.length ? 'done' : 'warn'
    );
    rows
      .filter(r => r.status !== 'ok' && r.status !== 'cancelled')
      .forEach(r => task.log(`${r.nick}: ${r.status}${r.error ? ` — ${errorText(r.error)}` : ''}`, 'error'));
    rows
      .filter(r => r.status === 'ok' && r.roster?.empty)
      .forEach(r =>
        task.log(`${r.nick}: подарков нет, серверы и персонажи оставлены как есть — передавать нечего`, 'info')
      );
    rosters = loadRosters();
    if (alive()) renderForm();
    return rows;
  }

  function renderScanning(chars, signal) {
    dlg.sub.textContent =
      'Читаю со страницы сайта, какие у аккаунтов серверы и персонажи и что ждёт передачи. Ничего не отправляется.';
    dlg.body.innerHTML = `${progressHtml('tr-progress', 0, chars.length)}
      ${sectionHtml('Ход чтения', {
        body: `<div class="promo-scroll"><table class="promo-table"><tbody>${chars
          .map(
            c =>
              `<tr class="${stripeCls(c)}"><td><b>${classIconHtml(c)} ${escapeHtml(c.nick)}</b></td><td data-scan="${escapeHtml(c.id)}"><span class="promo-muted">⏳ в очереди</span></td></tr>`
          )
          .join('')}</tbody></table></div>`
      })}`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">«Стоп» прерывает текущую работу. Уже отправленный запрос мог выполниться; неизвестный результат не повторяется.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    bindStop(signal);

    layoutScriptWorkspace(dlg, undefined, { running: true });
  }

  function updateScanning(row, done, total) {
    const td = [...dlg.body.querySelectorAll('[data-scan]')].find(el => el.dataset.scan === row.charId);
    if (td) {
      const r = rosters[row.charId] || loadRosters()[row.charId];
      td.innerHTML =
        row.status === 'ok'
          ? row.roster?.empty
            ? // Пустая корзина: серверы и персонажи остаются прежними, но передавать нечего
              `🎁 <span class="promo-muted">передавать нечего</span>`
            : `✅ ${escapeHtml(r?.shards.length ? r.shards.map(s => s.name).join(', ') : 'персонажей нет')}${r?.pending ? ` · к передаче: ${r.pending.items.length}` : ''}`
          : `❌ ${escapeHtml(row.status === 'not_logged_in' ? 'нет входа' : row.status === 'challenge' ? 'проверка безопасности' : errorText(row.error))}`;
    }
    setProgress(dlg.body, 'tr-progress', done, total);
  }

  function bindStop(signal) {
    dlg.foot.querySelector('[data-act="stop"]').onclick = e => {
      signal.stop?.();
      signal.cancelled = true;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ Останавливаю…';
    };
  }

  /* ----------------------------- запуск ----------------------------- */

  async function start(plans, dry, { historyReports = [] } = {}) {
    if (invalidItemChoices.size) return;
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    if (!alive() || running) return;
    const todo = plans.filter(p => p.run);
    const task = startTask(
      `📦 ${dry ? 'Пробная п' : 'П'}ередача предметов → ${[...new Set(todo.map(p => p.serverName))].join(', ')}`,
      { total: plans.length, cancelable: true }
    );
    const signal = { cancelled: false };
    running = signal;
    signal.stop = () => task.stop();
    task.onCancel(() => {
      signal.cancelled = true;
    });
    // Ждём своей очереди: пока идёт другой скрипт, работу не начинаем
    await task.waitTurn();
    task.watch(...plans.map(p => `char:${p.char.id}`));
    await task.ready?.();
    task.setStep(
      `${todo.length} аккаунтов, по ${browserSlots.max} одновременно${dry ? ', без нажатия «Передать»' : ''}`
    );
    if (force)
      task.log('Включён «Обойти ограничения приложения»: запомненные ограничения по серверам не применялись', 'info');
    renderRunning(plans, signal, dry);

    const { invoke } = await import('@tauri-apps/api/core');
    let rows;
    const finishedRows = [];
    try {
      rows = await runTransferBatch({
        plans,
        dryRun: dry,
        signal,
        task,
        invokeFn: invoke,
        retries,
        retryDelayMs,
        onRow: (row, done, all) => {
          finishedRows.push(row);
          task.setScriptReport(makeScriptReport('transfer', finishedRows, { dryRun: dry }));
          // В журнал и список «что ждёт» — сразу: «Стоп» или закрытие окна ничего не теряют
          if (!dry && row.clicked) {
            recordTransfer(row);
            if (row.limit) saveLimits(row.limit); // сайт сказал, на какой сервер принимает эти акции — больше не отмечаем их на других
            if (row.status === 'success' || row.status === 'partial') clearPending(row.charId);
          }
          if (alive()) updateRunning(row, done, all);
        }
      });
    } finally {
      running = null;
    }

    rosters = loadRosters();
    const s = summarize(rows);
    task.finish(
      `${signal.cancelled ? 'Остановлено. ' : ''}${dry ? `Пробный запуск: готово к передаче ${s.dry}` : `Передано ${s.ok}${s.partial ? `, не всё ${s.partial}` : ''}${s.wrong ? `, не тот сервер ${s.wrong}` : ''}`}, не распознано ${s.unknown}, ошибок ${s.failed}, пропущено ${s.skipped}`,
      s.failed || s.unknown || s.partial || s.wrong ? 'warn' : 'done'
    );
    rows
      .filter(r => !['same_site', 'no_recipient', 'no_server', 'no_roster'].includes(r.status))
      .forEach(r =>
        task.log(
          `${r.nick} → ${r.server} → ${r.recipient}: ${rowLabel(r)}${r.status === 'error' ? ` — ${errorText(r.error)}` : ''}`,
          statusInfo(r.status).level === 'error' ? 'error' : 'info'
        )
      );

    task.setScriptReport(makeScriptReport('transfer', rows, { dryRun: dry }));
    lastReports = [...historyReports, { ...makeScriptReport('transfer', rows, { dryRun: dry }), at: task.startedAt }];
    lastRows = rows;
    lastPlans = plans;
    lastDry = dry;
    if (alive()) renderResults(signal.cancelled);
  }

  const tableHtml = (plans, byId) => `
    <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Браузер</th><th>Сервер → получатель</th><th>Предметов</th><th>Результат</th></tr></thead>
      <tbody>${plans
        .map(p => {
          const row = byId.get(p.char.id);
          return `<tr class="${stripeCls(p.char)}" data-row="${escapeHtml(p.char.id)}"><td><b>${classIconHtml(p.char)} ${escapeHtml(p.char.nick)}</b></td>
          <td>${p.recipient ? `${escapeHtml(p.serverName)} → ${escapeHtml(charTitle(p.recipient))}` : '—'}</td>
          <td data-count="${escapeHtml(p.char.id)}">${row?.count || ''}</td>
          <td data-cell="${escapeHtml(p.char.id)}">${cellHtml(row)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;

  function renderRunning(plans, signal, dry) {
    dlg.sub.textContent = dry
      ? 'Пробный запуск: выбираю сервер, персонажа и предметы, но «Передать» не нажимаю.'
      : 'Идёт передача: аккаунты обрабатываются несколько одновременно. После «Передать» сайт открывает историю передач — по ней я проверяю результат.';
    dlg.body.innerHTML = `${progressHtml('tr-progress', 0, plans.length)}
      ${sectionHtml('Ход передачи', { body: tableHtml(plans, new Map()) })}`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">«Стоп» прерывает текущую работу. Уже отправленный запрос мог выполниться; неизвестный результат не повторяется.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    bindStop(signal);

    layoutScriptWorkspace(dlg, undefined, { running: true });
  }

  function updateRunning(row, done, total) {
    const q = attr => [...dlg.body.querySelectorAll(`[${attr}]`)].find(el => el.getAttribute(attr) === row.charId);
    const cell = q('data-cell');
    if (cell) cell.innerHTML = cellHtml(row);
    const cnt = q('data-count');
    if (cnt) cnt.textContent = row.count || '';
    setProgress(dlg.body, 'tr-progress', done, total);
  }

  /** Итог запуска чистыми чипами — только то, что действительно было. */
  const resultChips = (s, dry) =>
    chipsHtml(
      dry
        ? [
            { icon: '👁', label: 'готово к передаче', value: s.dry, tone: 'ok' },
            { icon: '⏭', label: 'пропущено', value: s.skipped },
            { icon: '❓', label: 'не распознано', value: s.unknown, tone: 'warn' },
            { icon: '❌', label: 'ошибок', value: s.failed, tone: 'err' }
          ]
        : [
            { icon: '✅', label: 'передано', value: s.ok, tone: 'ok' },
            { icon: '⚠️', label: 'передано не всё', value: s.partial, tone: 'warn' },
            { icon: '🚫', label: 'не тот сервер', value: s.wrong, tone: 'warn' },
            { icon: '❓', label: 'не распознано', value: s.unknown, tone: 'warn' },
            { icon: '❌', label: 'ошибок', value: s.failed, tone: 'err' },
            { icon: '⏭', label: 'пропущено', value: s.skipped }
          ]
    );

  function renderResults(stopped) {
    const s = summarize(lastRows);
    dlg.sub.textContent =
      `${stopped ? '⏹ Остановлено. ' : ''}${lastDry ? `Пробный запуск: готово к передаче ${s.dry} из ${s.total}.` : `Передано: ${s.ok} из ${s.total}${s.items ? ` (предметов: ${s.items})` : ''}.`}` +
      `${s.partial ? ` Не всё: ${s.partial}.` : ''}${s.wrong ? ` Не тот сервер: ${s.wrong}.` : ''}${s.unknown ? ` Не распознано: ${s.unknown}.` : ''}${s.failed ? ` Ошибок: ${s.failed}.` : ''}${s.skipped ? ` Пропущено: ${s.skipped}.` : ''}`;
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    const list = items =>
      `<ul class="tr-items">${itemTotals(items)
        .map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ''}</li>`)
        .join('')}</ul>`;
    const sent = lastRows.filter(r => r.items.length && (isOk(r.status) || r.done?.length || r.missing?.length));
    const sentHtml =
      sent
        .map(r =>
          (r.done?.length || r.missing?.length) && !isOk(r.status)
            ? `<details class="promo-reward" open><summary>📦 ${classIconHtml(state.characters.find(c => c.id === r.charId) || {})} ${escapeHtml(r.nick)} → ${escapeHtml(r.recipient)}: передано ${r.done.length} из ${r.items.length}</summary>
            ${r.done.length ? `<div class="promo-muted">✅ Передано (есть в истории сайта):</div>${list(r.done)}` : ''}
            ${r.missing.length ? `<div class="promo-warn">⚠ Не передано${r.warning?.onlyServer ? ` — сайт принимает их только на сервер «${escapeHtml(r.warning.onlyServer)}»` : ''}:</div>${list(r.missing)}` : ''}
            ${limitedHtml(r.limited)}</details>`
            : `<details class="promo-reward"><summary>📦 ${classIconHtml(state.characters.find(c => c.id === r.charId) || {})} ${escapeHtml(r.nick)} → ${escapeHtml(r.recipient)}: ${r.count} предм.</summary>${list(r.items)}${limitedHtml(r.limited)}</details>`
        )
        .join('') +
      lastRows
        .filter(r => !sent.includes(r) && r.limited?.length)
        .map(
          r =>
            `<div class="tr-plan-item"><b>${classIconHtml(state.characters.find(c => c.id === r.charId) || {})} ${escapeHtml(r.nick)}</b>${limitedHtml(r.limited)}</div>`
        )
        .join('');
    dlg.body.innerHTML = `${resultChips(s, lastDry)}
      ${sectionHtml('Результат по браузерам', { body: tableHtml(lastPlans, byId) })}
      ${sentHtml ? sectionHtml('Что ушло в игру', { body: sentHtml }) : ''}
      ${s.wrong ? '<p class="promo-warn">🚫 «Не тот сервер»: эти предметы сайт передаёт только на другой сервер (указан в строке результата). Приложение запомнило это и в следующий раз не будет их отмечать на других серверах — выберите в строке нужный сервер и запустите заново.</p>' : ''}
      ${s.unknown || s.partial ? '<p class="promo-warn">❓ «Не распознано» и «Передано не всё»: сверьте результат с «Историей передачи» на сайте. Автоматически эти аккаунты не повторяются, чтобы не отправить предметы дважды.</p>' : ''}
      ${!lastDry && s.ok ? '<p class="promo-muted">Предметы дойдут до персонажа примерно через 30 минут. Строки со статусом «В обработке» на сайте — это нормально.</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <button class="btn secondary" data-act="report">📋 Таблица действий</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn secondary" data-act="retry" ${s.rerun ? '' : 'disabled'}>🔁 Повторить неудачные${s.rerun ? ` (${s.rerun})` : ''}</button>
      <button class="btn primary" data-act="close">Закрыть</button>`;

    layoutScriptWorkspace(dlg);
  }

  /* ----------------------------- события ----------------------------- */

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'tr-search') {
      search = e.target.value;
      dlg.body.querySelector('#tr-list').innerHTML = listHtml();
    }
  });
  dlg.body.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-srv]')) {
      const id = t.dataset.srv;
      prefs.servers = { ...(prefs.servers || {}) };
      if (t.value) prefs.servers[id] = t.value;
      else delete prefs.servers[id];
      savePrefs(prefs);
      rerenderRow(id);
      updateAll();
    } else if (t.matches('[data-id]')) {
      if (t.checked) selected.add(t.dataset.id);
      else selected.delete(t.dataset.id);
      updateAll();
    } else if (t.matches('[data-pick]')) {
      const id = t.dataset.pick;
      const sid = rowServer({ id });
      if (!sid) return;
      prefs.picks[id] = { ...(prefs.picks[id] || {}) };
      if (t.value) prefs.picks[id][sid] = t.value;
      else delete prefs.picks[id][sid];
      savePrefs(prefs);
      updateAll();
    }
  });
  dlg.body.addEventListener('click', e => {
    const q = e.target.closest('[data-q]');
    if (q) quickSelect(q.dataset.q);
  });

  /** Запуск по плану; возвращает после результата. */
  async function run(dry) {
    if (confirming || running) return;
    if (invalidItemChoices.size) {
      toast('Исправьте количество в «Что будет передано»', 'warning');
      return;
    }
    force = false;
    const potential = currentPlans({ ignoreLimits: !dry });
    if (!potential.some(p => p.run)) {
      toast('Некому передавать: отметьте браузеры и выберите в строках сервер и получателя', 'warning');
      return;
    }
    if (!dry && potential.filter(p => p.run).some(p => !Array.isArray(p.itemSelection))) {
      toast('Сначала проверьте предметы в «Что будет передано»', 'warning');
      return;
    }
    confirming = true;
    try {
      let plans = currentPlans();
      if (!dry) {
        confirmationAbort = new AbortController();
        const answer = await confirmTransfer({
          signal: confirmationAbort.signal,
          parent: dlg.el,
          plansFor: ignoreLimits => currentPlans({ ignoreLimits })
        });
        if (!answer || !alive()) return;
        force = answer.force;
        plans = answer.plans;
        dlg.el.inert = true;
        try {
          if (!(await ensureBackup()) || !alive()) return;
        } finally {
          dlg.el.inert = false;
        }
      }
      await start(plans, dry);
    } finally {
      confirming = false;
      confirmationAbort = null;
      force = false;
    }
  }

  dlg.foot.addEventListener('click', async e => {
    if (e.target.closest('[data-q=plan]')) {
      quickSelect('plan');
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'close') {
      dlg.close();
      return;
    }
    if (act === 'back') {
      renderForm();
      return;
    }
    if (act === 'log') {
      openTransferLog();
      return;
    }
    if (act === 'report') {
      openScriptStatistics(lastReports, {
        title: '📋 Таблица действий: передача',
        note: 'Записи истории подтверждают передачу на сайте, но не доказывают получение предметов в игре. Показаны также пробные и неясные результаты.'
      });
      return;
    }
    if (act === 'dry') {
      await run(true);
      return;
    }
    if (act === 'start') {
      await run(false);
      return;
    }
    if (act === 'retry') {
      const byId = new Map(lastRows.map(r => [r.charId, r]));
      const plans = lastPlans.filter(p => p.run && isRerunnable(byId.get(p.char.id)));
      if (!plans.length) return;
      if (!lastDry) {
        if (!(await ensureBackup())) return;
        const ok = await confirmModal({
          title: 'Повторить передачу?',
          text: `Будет повторено ${plans.length} неудачных передач, где команда сообщила, что кнопка не нажата. Выбранные серверы и получатели сохраняются. Передача необратима.`,
          okText: `Повторить (${plans.length})`,
          danger: true
        });
        if (!ok) return;
      }
      await start(plans, lastDry, { historyReports: lastReports });
    }
  });
  // Кнопки обновления стоят в теле формы, а не внизу: обрабатываем здесь
  dlg.body.addEventListener('click', async e => {
    if (e.target.closest('[data-q=plan]')) {
      quickSelect('plan');
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'bulk-server' && !running) {
      const server = dlg.body.querySelector('[data-bulk-server]').value;
      if (!server) return;
      for (const c of state.characters) prefs.servers[c.id] = server;
      savePrefs(prefs);
      state.characters.forEach(c => rerenderRow(c.id));
      updateAll();
      toast('Сервер задан всем. Без подтверждённого получателя передача будет пропущена.', 'info');
      return;
    }
    if (act === 'refresh-servers') await refreshServers();
    if (act === 'refresh-all' && !running) await scan([...state.characters].sort(byNick));
    if (act === 'refresh-one' && !running) {
      const c = state.characters.find(x => x.id === e.target.closest('[data-char]')?.dataset.char);
      if (c) await scan([c], { servers: false });
    }
    if (act === 'refresh-selected' && !running) {
      const chars = selectedChars();
      if (!chars.length) {
        toast('Отметьте персонажей, которых нужно проверить', 'warning');
        return;
      }
      await scan(chars, { servers: false });
    }
  });

  renderForm();
  // Браузеры, выбранные заранее и ещё без списка серверов, читаются сразу (только чтение страницы)
  const fresh = selectedChars().filter(c => !rosters[c.id]);
  if (fresh.length) scan(fresh);
  return dlg;
}
