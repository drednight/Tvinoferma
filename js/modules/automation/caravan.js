// js/modules/automation/caravan.js
// 🧰 Сундук караванщика: диалог «персонажи → проверка инвентарей → итоги».
// Что делает кнопка «Проверить инвентари» для каждого выбранного персонажа: заходит на сайт Perfect World, открывает
// инвентарь (promo_items.php), находит «Сундуки караванщика», в каждом отмечает все предметы и нажимает «Перевести».
// Rust-команда: open_caravan_chests (src-tauri/src/automation/caravan.rs). Раннер: caravanRunner.js, логика: caravanCore.js.
// Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { openOverlay } from '../marathons/overlay.js';
import { partiesOf } from '../parties/membership.js';
import {
  statusInfo, rowLabel, rowNotes, chestLine, summarize, summaryText, taskLevel, isRerunnable, plainRow
} from './caravanCore.js';
import { runCaravanBatch } from './caravanRunner.js';

const dot = (c) => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');

const cellHtml = (row) => {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  const info = statusInfo(row.status);
  const notes = rowNotes(row);
  const chests = row.chests?.length
    ? `<details class="promo-reward"><summary>Сундуки: ${row.chests.length}</summary><ul>${row.chests.map(c => `<li>${escapeHtml(chestLine(c))}</li>`).join('')}</ul></details>`
    : '';
  return `<span class="caravan-res-${info.level}">${info.icon} ${escapeHtml(rowLabel(row))}</span>${
    notes.map(n => `<div class="promo-muted">${escapeHtml(n)}</div>`).join('')}${chests}`;
};

/**
 * Открывает диалог «Сундук караванщика».
 * @param {{ ids?: string[] }} [opts] ids — персонажи, выбранные заранее (например, из режима «Выбрать»)
 */
export function openCaravanDialog({ ids = [] } = {}) {
  if (!state.characters.length) { toast('Сначала добавьте персонажей', 'info'); return null; }
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let running = null;      // { cancelled } пока идёт запуск
  let lastRows = [];       // результаты последнего запуска
  let lastChars = [];
  let lastDry = false;

  const dlg = openOverlay({ title: '🧰 Сундук караванщика', wide: true, onClose: () => { if (running) running.cancelled = true; } });
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

  const selectedChars = () => state.characters.filter(c => selected.has(c.id)).sort(byNick);

  /**
   * Персонажи без входа на сайт — по данным приложения, то есть уже проверенные и найденные
   * без входа (`isLoggedIn === false`). Статус «ещё не проверялся» (undefined) не мешает:
   * проверка может пройти, а запрещать запуск на пустом месте нельзя.
   */
  const withoutLogin = (chars) => chars.filter(c => c.isLoggedIn === false);

  function updateCount() {
    const el = dlg.body.querySelector('#caravan-count');
    if (el) el.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    // Подсказка прямо в форме: вход нужен, чтобы инвентарь вообще открылся
    const warn = dlg.body.querySelector('#caravan-nologin');
    if (warn) {
      const skipped = withoutLogin(selectedChars());
      warn.innerHTML = skipped.length
        ? `⚠ Без входа на сайт: ${escapeHtml(skipped.map(c => c.nick).join(', '))}. Их инвентарь не откроется — при запуске они будут пропущены. Войдите в игру у этих персонажей: карточка персонажа → «🎮 Запуск игры» → «🔑 Запомнить текущий вход GameCenter».`
        : '';
      warn.hidden = !skipped.length;
    }
    dlg.foot.querySelectorAll('[data-act="start"],[data-act="dry"]').forEach(b => { b.disabled = !selected.size; });
  }

  function renderForm() {
    dlg.sub.textContent = 'Выберите персонажей и нажмите «Проверить инвентари»: у каждого будут открыты все «Сундуки караванщика».';
    dlg.body.innerHTML = `
      <p class="promo-muted promo-hint">Для каждого персонажа приложение зайдёт на сайт, откроет инвентарь, найдёт «Сундуки караванщика»,
        отметит в них все предметы и нажмёт «Перевести». Другие сундуки (например, «Подарочный мешок») не трогаются.
        Персонажи одного аккаунта делят один инвентарь — достаточно выбрать одного из них.</p>
      <div class="promo-quick">
        <input class="input" id="caravan-search" placeholder="Поиск: ник, пати, тег" value="${escapeHtml(search)}">
        <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
        <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
        <button class="btn ghost small" data-q="none">Снять выбор</button>
      </div>
      <div class="promo-list" id="caravan-list">${listHtml()}</div>
      <div class="promo-warn" id="caravan-nologin" hidden></div>
      <div class="promo-count" id="caravan-count"></div>`;
    dlg.foot.innerHTML = `
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      <button class="btn secondary" data-act="dry" title="Откроет инвентарь и посчитает «Сундуки караванщика», но ничего не откроет и не нажмёт">👁 Только посчитать сундуки</button>
      <button class="btn primary" data-act="start" title="Откроет инвентарь, найдёт «Сундуки караванщика», отметит все предметы и нажмёт «Перевести»">📦 Проверить инвентари</button>`;
    updateCount();
  }

  function quickSelect(kind) {
    if (kind === 'none') selected.clear();
    if (kind === 'all') state.characters.forEach(c => selected.add(c.id));
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#caravan-list').innerHTML = listHtml();
    updateCount();
  }

  /* --------------------------- запуск ---------------------------- */

  async function start(chars, { dry = false } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const { invoke } = await import('@tauri-apps/api/core');

    const task = startTask(`🧰 Сундук караванщика${dry ? ' (только подсчёт)' : ''}: ${chars.length} перс.`, { total: chars.length, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...chars.map(c => `char:${c.id}`));
    task.setStep(`${chars.length} перс., по ${browserSlots.max} одновременно, повторов до ${retries}`);
    renderRunning(chars, signal, dry);

    let rows;
    try {
      rows = await runCaravanBatch({
        chars, dryRun: dry, signal, task, invokeFn: invoke, retries, retryDelayMs,
        onStart: (char) => { if (alive()) setCell(char.id, '<span class="promo-muted">🌐 работаю…</span>'); },
        onRow: (row, done, all) => { if (alive()) updateRunning(row, done, all); }
      });
    } finally {
      running = null;
    }

    task.finish(summaryText(rows, { dry, stopped: signal.cancelled }), taskLevel(rows));
    lastRows = rows; lastChars = chars; lastDry = dry;
    if (alive()) renderResults(signal.cancelled);
  }

  const setCell = (charId, html) => {
    const td = [...dlg.body.querySelectorAll('[data-cell]')].find(el => el.dataset.cell === charId);
    if (td) td.innerHTML = html;
  };

  function renderRunning(chars, signal, dry) {
    dlg.sub.textContent = dry
      ? '👁 Только подсчёт: инвентарь открывается, сундуки считаются, ничего не нажимается.'
      : 'Идёт открытие: персонажи обрабатываются несколько одновременно, сундуки у каждого — по очереди.';
    dlg.body.innerHTML = `<div class="promo-progress" id="caravan-progress">0 из ${chars.length}</div>
      <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Итог</th></tr></thead><tbody>${
  chars.map(c => `<tr><td><b>${escapeHtml(c.nick)}</b></td><td data-cell="${escapeHtml(c.id)}">${cellHtml(null)}</td></tr>`).join('')}</tbody></table></div>`;
    dlg.foot.innerHTML = `<span class="promo-muted" style="flex:1">«Стоп» не начинает новых персонажей; уже начатый закончится, открытые сундуки учтутся.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    dlg.foot.querySelector('[data-act="stop"]').onclick = (e) => { signal.cancelled = true; e.currentTarget.disabled = true; e.currentTarget.textContent = '⏳ Останавливаю…'; };
  }

  function updateRunning(row, done, total) {
    setCell(row.charId, cellHtml(row));
    const p = dlg.body.querySelector('#caravan-progress');
    if (p) p.textContent = `${done} из ${total}`;
  }

  /* ------------------------- результаты -------------------------- */

  function renderResults(stopped) {
    const s = summarize(lastRows);
    dlg.sub.textContent = summaryText(lastRows, { dry: lastDry, stopped });
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    dlg.body.innerHTML = `
      <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Итог</th></tr></thead><tbody>${
  lastChars.map(c => `<tr><td><b>${escapeHtml(c.nick)}</b></td><td>${cellHtml(byId.get(c.id) || plainRow(c, 'not_run'))}</td></tr>`).join('')}</tbody></table></div>
      ${lastDry ? '<p class="promo-muted">Ничего не открыто и не нажато. Если сундуки найдены — можно открывать по-настоящему.</p>' : ''}
      ${s.unknown ? '<p class="promo-warn">❓ «Результат не проверен»: кнопка нажата, но инвентарь после этого прочитать не удалось. Проверьте инвентарь на сайте.</p>' : ''}
      ${s.partial ? '<p class="promo-warn">⚠ Часть сундуков осталась в инвентаре: «Повторить» откроет только их.</p>' : ''}`;
    const found = lastDry && s.found > 0;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <span style="flex:1"></span>
      ${found ? '<button class="btn primary" data-act="real">📦 Открыть найденные сундуки</button>' : ''}
      ${lastDry ? '<button class="btn secondary" data-act="dry-again">👁 Ещё раз</button>'
    : `<button class="btn secondary" data-act="retry" ${s.rerun ? '' : 'disabled'}>🔁 Повторить${s.rerun ? ` (${s.rerun})` : ''}</button>`}
      <button class="btn ${found ? 'ghost' : 'primary'}" data-act="close">Закрыть</button>`;
  }

  /* ------------------------- события ------------------------------ */

  dlg.body.addEventListener('input', (e) => {
    if (e.target.id === 'caravan-search') {
      search = e.target.value;
      dlg.body.querySelector('#caravan-list').innerHTML = listHtml();
    }
  });
  dlg.body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-id]')) { if (t.checked) selected.add(t.dataset.id); else selected.delete(t.dataset.id); updateCount(); }
  });
  dlg.body.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) quickSelect(q.dataset.q);
  });

  /** Подтверждение перед настоящим запуском: сундуки открываются необратимо. */
  const confirmRun = (chars) => confirmModal({
    title: 'Открыть сундуки караванщика?',
    text: `Персонажей: ${chars.length}. В каждом «Сундуке караванщика» будут отмечены все предметы и нажато «Перевести». Действие необратимо. Другие сундуки не трогаются.`,
    okText: `Проверить инвентари (${chars.length})`,
    danger: true
  });

  /**
   * Пропускает персонажей без подтверждённого входа: у них сайт не откроет инвентарь,
   * и в журнале осталась бы строка «нет входа» вместо результата.
   * `null` — запускать нечего (отказ или не осталось ни одного подходящего персонажа).
   */
  async function dropWithoutLogin(chars) {
    const skipped = withoutLogin(chars);
    if (!skipped.length) return chars;
    const left = chars.filter(c => c.isLoggedIn !== false);
    if (!left.length) {
      toast('У всех выбранных нет входа на сайт — инвентарь открыть не удастся. Войдите в игру у этих персонажей и повторите проверку.', 'warning');
      return null;
    }
    const ok = await confirmModal({
      title: 'У части персонажей нет входа',
      text: `Пропущу ${skipped.length} из ${chars.length}: ${skipped.map(c => c.nick).join(', ')}. Без входа на сайт инвентарь не открыть. Войдите в игру у этих персонажей: карточка персонажа → «🎮 Запуск игры» → «🔑 Запомнить текущий вход GameCenter».`,
      okText: `Продолжить без них (${left.length})`
    });
    return ok ? left : null;
  }

  dlg.foot.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'back') { renderForm(); return; }
    if (act === 'dry-again') {
      const again = await dropWithoutLogin(lastChars);
      if (again?.length) await start(again, { dry: true });
      return;
    }
    if (act === 'real') {
      const found = lastChars.filter(c => (lastRows.find(r => r.charId === c.id)?.found || 0) > 0);
      const chars = found.length ? await dropWithoutLogin(found) : null;
      if (chars?.length && await confirmRun(chars)) await start(chars);
      return;
    }
    if (act === 'retry') {
      const rerun = lastChars.filter(c => isRerunnable(lastRows.find(r => r.charId === c.id)));
      const again = rerun.length ? await dropWithoutLogin(rerun) : null;
      if (again?.length && await confirmRun(again)) await start(again);
      return;
    }
    if (act === 'start' || act === 'dry') {
      const picked = selectedChars();
      if (!picked.length) { toast('Выберите хотя бы одного персонажа', 'warning'); return; }
      const chars = await dropWithoutLogin(picked);
      if (!chars?.length) return;
      if (act === 'dry') { await start(chars, { dry: true }); return; }
      if (await confirmRun(chars)) await start(chars);
    }
  });

  renderForm();
  return dlg;
}
