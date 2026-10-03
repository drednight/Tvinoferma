// js/modules/automation/promo.js
// Промокоды (Issue #25): диалог «код → персонажи → предпросмотр → запуск → таблица результатов».
// Rust-команда: activate_promo (src-tauri/src/automation/promo.rs). Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmDialog } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import { partiesOf, charactersInParty } from '../parties/membership.js';
import {
  validateCode, maskCode, statusInfo, isRetryable, summarize, createSessionGuard,
  loadHistory, clearHistory, addHistory, keepCodeSetting, setKeepCodeSetting, resultsToCsv
} from './promoCore.js';
import { runPromoBatch } from './promoRunner.js';

/** Какие коды уже запускались на каких персонажах в этой сессии приложения (в памяти, не на диске). */
const sessionGuard = createSessionGuard();

const dot = (c) => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');

function downloadText(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const rowDetail = (r) => {
  if (r.status === 'unknown') return r.detail ? `Ответ сайта: «${r.detail}»` : errorText(r.error);
  if (r.status === 'dry_run') return r.detail ? `Кнопка «${r.detail}»` : '';
  if (r.status === 'error') return errorText(r.error);
  return r.detail || '';
};

/**
 * Открывает диалог активации промокода.
 * @param {{ ids?: string[] }} [opts] ids — персонажи, выбранные заранее (например, из режима «Выбрать»)
 */
export function openPromoDialog({ ids = [] } = {}) {
  if (!state.characters.length) { toast('Сначала добавьте персонажей', 'info'); return; }
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let code = '';
  let dryRun = false;
  let running = null;      // { cancelled } пока идёт запуск
  let lastRows = [];       // результаты текущего кода: charId → строка (последняя)
  let lastCode = '';

  const dlg = openOverlay({ title: '🎟 Активация промокода', wide: true, onClose: () => { if (running) running.cancelled = true; } });
  const alive = () => dlg.el.isConnected;

  /* ---------------------------- форма ---------------------------- */

  function visibleChars() {
    const q = search.trim().toLowerCase();
    return [...state.characters].sort(byNick).filter(c => {
      if (!q) return true;
      const hay = [c.nick, c.className, ...(c.tags || []), ...partiesOf(c, state.parties).map(p => p.name)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty">Никого не найдено</div>';
    return list.map(c => {
      const parties = partiesOf(c, state.parties).map(p => p.name).join(', ');
      return `<label class="promo-item"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
        <span>${dot(c)}</span><b>${escapeHtml(c.nick)}</b><span class="promo-muted">${escapeHtml(parties)}</span></label>`;
    }).join('');
  }

  function renderForm() {
    const partyOptions = state.parties.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    dlg.sub.textContent = 'Код откроется на странице pwonline.ru/pin/<код>, на ней будет нажата кнопка «Ввести».';
    dlg.body.innerHTML = `
      <div class="field"><label for="promo-code">Промокод</label>
        <input class="input" id="promo-code" maxlength="40" autocomplete="off" spellcheck="false" value="${escapeHtml(code)}" placeholder="Например, ABCD1234"></div>
      <div class="promo-quick">
        <input class="input" id="promo-search" placeholder="Поиск: ник, пати, тег" value="${escapeHtml(search)}">
        <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
        <select class="input" id="promo-party"><option value="">Вся пати…</option>${partyOptions}</select>
        <button class="btn ghost small" data-q="party">Выбрать пати</button>
        <button class="btn ghost small" data-q="none">Снять выбор</button>
      </div>
      <div class="promo-list" id="promo-list">${listHtml()}</div>
      <div class="promo-count" id="promo-count"></div>
      <label class="promo-opt"><input type="checkbox" id="promo-dry" ${dryRun ? 'checked' : ''}> Пробный запуск: открыть страницу и найти кнопку «Ввести», но <b>не нажимать</b></label>
      <label class="promo-opt"><input type="checkbox" id="promo-keep" ${keepCodeSetting() ? 'checked' : ''}> Хранить код в истории целиком (иначе он маскируется: AB••••••26)</label>`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="history">📜 История</button>
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      <button class="btn primary" data-act="start">▶ Запустить</button>`;
    updateCount();
  }

  function updateCount() {
    const el = dlg.body.querySelector('#promo-count');
    if (el) el.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
  }

  function quickSelect(kind) {
    if (kind === 'none') selected.clear();
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    if (kind === 'party') {
      const id = dlg.body.querySelector('#promo-party')?.value;
      if (!id) { toast('Выберите пати', 'info'); return; }
      charactersInParty(state.characters, id).forEach(c => selected.add(c.id));
    }
    dlg.body.querySelector('#promo-list').innerHTML = listHtml();
    updateCount();
  }

  /* --------------------------- запуск ---------------------------- */

  async function start(chars, { retry = false } = {}) {
    const mode = dryRun ? 'dry' : 'real';
    const ask = dryRun
      ? `Пробный запуск: страница промокода будет открыта у ${chars.length} перс., кнопка «Ввести» нажиматься НЕ будет. Продолжить?`
      : `Код ${code} будет применён к ${chars.length} перс. (${chars.slice(0, 5).map(c => c.nick).join(', ')}${chars.length > 5 ? '…' : ''}).\nДействие необратимо. Продолжить?`;
    if (!retry && !confirmDialog(ask)) return;

    const task = startTask(`🎟 Промокод ${maskCode(code)}${dryRun ? ' (пробный)' : ''}`, { total: chars.length, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...chars.map(c => `char:${c.id}`));
    renderRunning(chars, signal);

    const { invoke } = await import('@tauri-apps/api/core');
    let rows;
    try {
      rows = await runPromoBatch({
        code, chars, dryRun, signal, task, invokeFn: invoke,
        onRow: (row, done, total) => { if (alive()) updateRunning(row, done, total); }
      });
    } finally {
      running = null;
    }
    const s = summarize(rows);
    task.finish(`Промокод: успешно ${s.success}, уже использован ${s.alreadyUsed}, не распознано ${s.unknown}, неуспешно ${s.failed - s.unknown - s.dryRun}`,
      s.failed - s.dryRun > 0 ? 'warn' : 'done');
    rows.forEach(r => task.log(`${r.nick}: ${statusInfo(r.status).label}${rowDetail(r) ? ` — ${rowDetail(r)}` : ''}`, statusInfo(r.status).level === 'error' ? 'error' : 'info'));

    // Известные исходы, после которых запускать заново нельзя; история и защита от повторов
    sessionGuard.record(code, rows);
    addHistory(code, rows);
    lastCode = code;
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    rows.forEach(r => byId.set(r.charId, r));
    lastRows = chars.length && retry ? [...byId.values()] : rows;
    if (alive()) renderResults(mode);
  }

  function renderRunning(chars, signal) {
    dlg.sub.textContent = 'Идёт выполнение. Персонажи обрабатываются по одному, между ними пауза.';
    dlg.body.innerHTML = `
      <div class="promo-progress" id="promo-progress">0 из ${chars.length}</div>
      <table class="promo-table"><tbody id="promo-rows">${chars.map(c =>
        `<tr data-row="${escapeHtml(c.id)}"><td>⏳</td><td><b>${escapeHtml(c.nick)}</b></td><td class="promo-muted">в очереди</td></tr>`).join('')}</tbody></table>`;
    dlg.foot.innerHTML = `<span style="flex:1"></span><button class="btn danger" data-act="cancel">⏹ Отмена</button>`;
    dlg.foot.querySelector('[data-act="cancel"]').onclick = () => { signal.cancelled = true; dlg.foot.querySelector('[data-act="cancel"]').disabled = true; };
  }

  function updateRunning(row, done, total) {
    const tr = dlg.body.querySelector(`[data-row="${CSS.escape(row.charId)}"]`);
    const info = statusInfo(row.status);
    if (tr) tr.innerHTML = `<td>${info.icon}</td><td><b>${escapeHtml(row.nick)}</b></td><td>${escapeHtml(info.label)}</td>`;
    const p = dlg.body.querySelector('#promo-progress');
    if (p) p.textContent = `${done} из ${total}`;
  }

  /* ------------------------- результаты -------------------------- */

  function renderResults() {
    const s = summarize(lastRows);
    dlg.sub.textContent = `Итог: успешно ${s.success}, уже использован ${s.alreadyUsed}, не распознано ${s.unknown}, остальное ${Math.max(0, s.failed - s.unknown - s.dryRun)}${s.dryRun ? `, пробных ${s.dryRun}` : ''}.`;
    dlg.body.innerHTML = `
      <table class="promo-table"><thead><tr><th></th><th>Персонаж</th><th>Результат</th><th>Подробности</th></tr></thead><tbody>${lastRows.map(r => {
        const info = statusInfo(r.status);
        return `<tr><td>${info.icon}</td><td><b>${escapeHtml(r.nick)}</b></td><td>${escapeHtml(info.label)}</td><td class="promo-muted">${escapeHtml(rowDetail(r))}</td></tr>`;
      }).join('')}</tbody></table>
      ${s.unknown ? '<p class="promo-warn">❓ «Не распознано» значит, что кнопка была нажата, но ответ сайта не удалось понять. Проверьте этих персонажей вручную; автоматически они не повторяются.</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <button class="btn ghost" data-act="csv">⬇ Экспорт CSV</button>
      <span style="flex:1"></span>
      ${s.retryable ? `<button class="btn secondary" data-act="retry">🔁 Повторить для неуспешных (${s.retryable})</button>` : ''}
      <button class="btn primary" data-act="close">Закрыть</button>`;
  }

  function renderHistory() {
    const items = loadHistory().slice(0, 100);
    dlg.sub.textContent = 'Хранится только на этом компьютере. Коды маскируются, если не включено «Хранить код целиком».';
    dlg.body.innerHTML = items.length ? `
      <table class="promo-table"><thead><tr><th>Время</th><th>Код</th><th>Персонаж</th><th>Результат</th></tr></thead><tbody>${items.map(h =>
        `<tr><td class="promo-muted">${escapeHtml(new Date(h.at).toLocaleString('ru-RU'))}</td><td><code>${escapeHtml(h.code)}</code></td><td><b>${escapeHtml(h.nick)}</b></td><td>${statusInfo(h.status).icon} ${escapeHtml(statusInfo(h.status).label)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="promo-empty">История пуста</div>';
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <span style="flex:1"></span>
      ${items.length ? '<button class="btn danger" data-act="clear-history">🗑 Очистить</button>' : ''}
      <button class="btn primary" data-act="close">Закрыть</button>`;
  }

  /* ------------------------- события ------------------------------ */

  const readForm = () => {
    code = dlg.body.querySelector('#promo-code')?.value ?? code;
    dryRun = !!dlg.body.querySelector('#promo-dry')?.checked;
  };

  dlg.body.addEventListener('input', (e) => {
    if (e.target.id === 'promo-search') {
      search = e.target.value;
      dlg.body.querySelector('#promo-list').innerHTML = listHtml();
    }
  });
  dlg.body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-id]')) { if (t.checked) selected.add(t.dataset.id); else selected.delete(t.dataset.id); updateCount(); }
    if (t.id === 'promo-keep') setKeepCodeSetting(t.checked);
  });
  dlg.body.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) quickSelect(q.dataset.q);
  });

  dlg.foot.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'history') { readForm(); renderHistory(); return; }
    if (act === 'back') { renderForm(); return; }
    if (act === 'clear-history') { if (confirmDialog('Очистить историю промокодов?')) { clearHistory(); renderHistory(); } return; }
    if (act === 'csv') {
      downloadText(resultsToCsv(lastRows), `promo-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
      return;
    }
    if (act === 'retry') {
      const ids = new Set(lastRows.filter(isRetryable).map(r => r.charId));
      const chars = state.characters.filter(c => ids.has(c.id));
      if (chars.length) await start(chars, { retry: true });
      return;
    }
    if (act === 'start') {
      readForm();
      const v = validateCode(code);
      if (!v.ok) { toast(v.error, 'warning'); return; }
      code = v.code;
      let chars = state.characters.filter(c => selected.has(c.id)).sort(byNick);
      if (!chars.length) { toast('Выберите хотя бы одного персонажа', 'warning'); return; }
      if (!dryRun) {
        // Защита: один и тот же код на тех же персонажах дважды за сессию — только с подтверждением
        const repeated = new Set(sessionGuard.alreadySent(code, chars.map(c => c.id)));
        if (repeated.size) {
          const names = chars.filter(c => repeated.has(c.id)).map(c => c.nick).join(', ');
          const again = confirmDialog(`Этот код уже запускался в этой сессии для: ${names}.\n\nОК — применить к ним ещё раз.\nОтмена — пропустить их.`);
          if (!again) chars = chars.filter(c => !repeated.has(c.id));
          if (!chars.length) { toast('Все выбранные персонажи уже использовали этот код', 'info'); return; }
        }
      }
      if (lastCode !== code) lastRows = [];
      await start(chars);
    }
  });

  renderForm();
  return dlg;
}
