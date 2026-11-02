import { classIconHtml, stripeCls } from './characterPicker.js';
import { groupAccounts } from './shopCore.js';
import { layoutScriptWorkspace } from './scriptWorkspace.js';
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
  statusInfo,
  rowLabel,
  rowNotes,
  chestLine,
  summarize,
  summaryText,
  taskLevel,
  isRerunnable,
  plainRow
} from './caravanCore.js';
import { runCaravanBatch } from './caravanRunner.js';
import { chipsHtml, noteHtml, progressHtml, sectionHtml, setProgress } from './scriptUi.js';
import { makeScriptReport } from './scriptReport.js';
import { openScriptStatistics } from './scriptReportView.js';

const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');

const cellHtml = row => {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  const info = statusInfo(row.status);
  const notes = rowNotes(row);
  const chests = row.chests?.length
    ? `<details class="promo-reward"><summary>Сундуки: ${row.chests.length}</summary><ul>${row.chests.map(c => `<li>${escapeHtml(chestLine(c))}</li>`).join('')}</ul></details>`
    : '';
  return `<span class="caravan-res-${info.level}">${info.icon} ${escapeHtml(rowLabel(row))}</span>${notes
    .map(n => `<div class="promo-muted">${escapeHtml(n)}</div>`)
    .join('')}${chests}`;
};

/**
 * Открывает диалог «Сундук караванщика».
 * @param {{ ids?: string[] }} [opts] ids — персонажи, выбранные заранее (например, из режима «Выбрать»)
 */
export function openCaravanDialog({ ids = [] } = {}) {
  if (!state.characters.length) {
    toast('Сначала добавьте персонажей', 'info');
    return null;
  }
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let running = null; // { cancelled } пока идёт запуск
  let openAll = true;
  const limits = {};
  let lastRows = []; // результаты последнего запуска
  let lastChars = [];
  let lastDry = false;
  let lastReports = []; // включает прошлые попытки текущего повтора

  const dlg = openOverlay({
    title: '🧰 Сундук караванщика',
    wide: true,
    onClose: () => {
      if (running) {
        running.stop?.();
        running.cancelled = true;
      }
    }
  });
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;

  /* ---------------------------- форма ---------------------------- */

  function visibleChars() {
    const q = search.trim().toLowerCase();
    return [...state.characters].sort(byNick).filter(c => {
      if (!q) return true;
      const hay = [c.nick, c.className, ...(c.tags || []), ...partiesOf(c, state.parties).map(p => p.name)]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty empty-state">Никого не найдено</div>';
    return list
      .map(c => {
        const parties = partiesOf(c, state.parties)
          .map(p => p.name)
          .join(', ');
        return `<label class="promo-item ${stripeCls(c)}"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
        ${classIconHtml(c)}<b>${escapeHtml(c.nick)}</b><span class="promo-muted promo-item-tags">${escapeHtml(parties)}</span></label>`;
      })
      .join('');
  }

  const selectedChars = () => state.characters.filter(c => selected.has(c.id)).sort(byNick);

  function updateCount() {
    const el = dlg.body.querySelector('#caravan-count');
    if (el) el.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    dlg.foot.querySelectorAll('[data-act="start"],[data-act="dry"]').forEach(b => {
      b.disabled = b.dataset.act === 'start' || !selected.size;
    });
  }

  function renderForm() {
    dlg.sub.textContent =
      'Сначала «Проверить сайт» — только подсчёт сундуков. Затем выберите количество и отдельно подтвердите открытие.';
    dlg.body.innerHTML = `
      ${noteHtml({
        icon: '🧰',
        title: 'Что сделает это окно',
        text:
          'Для каждого выбранного персонажа приложение зайдёт на сайт, откроет инвентарь, найдёт «Сундуки караванщика», ' +
          'отметит в них все предметы и нажмёт «Перевести». Другие сундуки (например, «Подарочный мешок») не трогаются. ' +
          'Персонажи одного аккаунта делят один инвентарь — достаточно выбрать одного из них.'
      })}
      ${sectionHtml('Персонажи', {
        aside: `<span class="sd-count" id="caravan-count"></span>`,
        body: `
        <div class="promo-quick">
          <input class="input" id="caravan-search" aria-label="Поиск персонажа" placeholder="Поиск: ник, пати, тег" value="${escapeHtml(search)}">
          <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
          <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
          <button class="btn ghost small" data-q="none">Снять выбор</button>
        </div>
        <div class="promo-list" id="caravan-list">${listHtml()}</div>`
      })}
      `;
    dlg.foot.innerHTML = `
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn primary" data-act="dry" title="Откроет инвентарь и посчитает «Сундуки караванщика», но ничего не откроет и не нажмёт">🔍 Проверить сайт</button>
      <button class="btn secondary" data-act="start" title="Откроет инвентарь, найдёт «Сундуки караванщика», отметит все предметы и нажмёт «Перевести»">📦 Открыть сундуки</button>`;
    updateCount();
    dlg.foot.querySelector('[data-act=start]').disabled = true;

    layoutScriptWorkspace(dlg, {
      selected: selected,
      apply(ids) {
        selected.clear();
        ids.forEach(id => selected.add(id));
        renderForm();
      }
    });
  }

  function quickSelect(kind) {
    if (kind === 'none') selected.clear();
    if (kind === 'all') state.characters.forEach(c => selected.add(c.id));
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#caravan-list').innerHTML = listHtml();
    updateCount();
  }

  /* --------------------------- запуск ---------------------------- */

  async function start(chars, { dry = false, historyReports = [] } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const { invoke } = await import('@tauri-apps/api/core');

    const task = startTask(`🧰 Сундук караванщика${dry ? ' (только подсчёт)' : ''}: ${chars.length} перс.`, {
      total: chars.length,
      cancelable: true
    });
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
    task.setStep(`${chars.length} перс., по ${browserSlots.max} одновременно, повторов до ${retries}`);
    renderRunning(chars, signal, dry);

    let rows;
    const finishedRows = [];
    try {
      rows = await runCaravanBatch({
        chars,
        dryRun: dry,
        limits: openAll ? undefined : limits,
        accountKeys: Object.fromEntries(lastRows.filter(r => r.accountKey).map(r => [r.charId, r.accountKey])),
        signal,
        task,
        invokeFn: invoke,
        retries,
        retryDelayMs,
        onStart: char => {
          if (alive()) setCell(char.id, '<span class="promo-muted">🌐 работаю…</span>');
        },
        onRow: (row, done, all) => {
          finishedRows.push(row);
          task.setScriptReport(makeScriptReport('caravan', finishedRows, { dryRun: dry }));
          if (alive()) updateRunning(row, done, all);
        }
      });
    } finally {
      running = null;
    }

    task.setScriptReport(makeScriptReport('caravan', rows, { dryRun: dry }));
    task.finish(summaryText(rows, { dry, stopped: signal.cancelled }), taskLevel(rows));
    lastReports = [...historyReports, { ...makeScriptReport('caravan', rows, { dryRun: dry }), at: task.startedAt }];
    if (!dry && !openAll) {
      for (const row of rows) limits[row.charId] = Math.max(0, (limits[row.charId] || 0) - row.opened);
    }
    lastRows = dry
      ? rows
      : rows.map(row => ({
          ...row,
          ...(row.accountKey ? {} : { accountKey: lastRows.find(old => old.charId === row.charId)?.accountKey })
        }));
    lastChars = chars;
    lastDry = dry;
    if (dry) {
      openAll = true;
      for (const row of rows) limits[row.charId] = row.found || 0;
    }
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
    dlg.body.innerHTML = `${progressHtml('caravan-progress', 0, chars.length)}
      ${sectionHtml('Ход работы', {
        body: `<div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Итог</th></tr></thead><tbody>${chars
          .map(
            c =>
              `<tr class="${stripeCls(c)}"><td><b>${classIconHtml(c)} ${escapeHtml(c.nick)}</b></td><td data-cell="${escapeHtml(c.id)}">${cellHtml(null)}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      })}`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">«Стоп» прерывает текущую работу. Уже отправленный запрос мог выполниться; неизвестный результат не повторяется.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    dlg.foot.querySelector('[data-act="stop"]').onclick = e => {
      signal.stop?.();
      signal.cancelled = true;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ Останавливаю…';
    };

    layoutScriptWorkspace(dlg, undefined, { running: true });
  }

  function updateRunning(row, done, total) {
    setCell(row.charId, cellHtml(row));
    setProgress(dlg.body, 'caravan-progress', done, total);
  }

  /* ------------------------- результаты -------------------------- */

  /** Итог запуска чистыми чипами — только то, что действительно было. */
  const resultChips = (s, dry) =>
    chipsHtml(
      dry
        ? [
            { icon: '👁', label: 'сундуков найти', value: s.found, tone: 'ok' },
            { icon: '➖', label: 'без сундуков', value: s.nothing },
            { icon: '🔴', label: 'нет входа на сайт', value: s.noLogin, tone: 'err' },
            { icon: '❌', label: 'проблем', value: s.failed + s.challenge, tone: 'err' }
          ]
        : [
            { icon: '📦', label: 'открыто сундуков', value: s.opened, tone: 'ok' },
            { icon: '⚠️', label: 'открыто не всё', value: s.partial, tone: 'warn' },
            { icon: '➖', label: 'без сундуков', value: s.nothing },
            { icon: '🔴', label: 'нет входа на сайт', value: s.noLogin, tone: 'err' },
            { icon: '❓', label: 'не проверено', value: s.unknown, tone: 'warn' },
            { icon: '❌', label: 'ошибок', value: s.failed, tone: 'err' },
            { icon: '⏭', label: 'не выполнено', value: s.notRun }
          ]
    );

  function renderResults(stopped) {
    const s = summarize(lastRows);
    dlg.sub.textContent = summaryText(lastRows, { dry: lastDry, stopped });
    const byId = new Map(lastRows.map(r => [r.charId, r]));
    dlg.body.innerHTML = `
      ${resultChips(s, lastDry)}
      ${sectionHtml('Итог по персонажам', {
        body: `<div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Итог</th></tr></thead><tbody>${lastChars
          .map(
            c =>
              `<tr class="${stripeCls(c)}"><td><b>${classIconHtml(c)} ${escapeHtml(c.nick)}</b></td><td>${cellHtml(byId.get(c.id) || plainRow(c, 'not_run'))}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      })}
      ${
        lastDry
          ? `<section class="caravan-open-settings"><h4>Сколько сундуков открыть</h4><label><input type="radio" name="caravan-amount" value="all" ${openAll ? 'checked' : ''}> Открыть все найденные</label><label><input type="radio" name="caravan-amount" value="count" ${openAll ? '' : 'checked'}> Указать количество по аккаунтам</label>${accountRepresentatives(
              lastChars
            )
              .filter(c => (byId.get(c.id)?.found || 0) > 0)
              .map(
                c =>
                  `<label>${escapeHtml(c.nick)}: <input class="input" type="number" min="0" max="${byId.get(c.id).found}" step="1" data-caravan-limit="${escapeHtml(c.id)}" value="${limits[c.id] || 0}" ${openAll ? 'disabled' : ''}> из ${byId.get(c.id).found}</label>`
              )
              .join('')}</section>`
          : ''
      }
      ${lastDry ? '<p class="promo-muted">Ничего не открыто и не нажато. Если сундуки найдены — можно открывать по-настоящему.</p>' : ''}
      ${s.unknown ? '<p class="promo-warn">❓ Результат не подтверждён: кнопка могла быть нажата. Проверьте инвентарь на сайте; автоматически такие строки не повторяются.</p>' : ''}
      ${s.partial ? '<p class="promo-warn">⚠ Часть сундуков осталась в инвентаре: «Повторить» откроет только их.</p>' : ''}`;
    const found = lastDry && s.found > 0;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <button class="btn secondary" data-act="report">📋 Таблица действий</button>
      <span class="sd-foot-spacer"></span>
      ${found ? '<button class="btn primary" data-act="real">📦 Открыть найденные сундуки</button>' : ''}
      ${
        lastDry
          ? '<button class="btn secondary" data-act="dry-again">👁 Ещё раз</button>'
          : `<button class="btn secondary" data-act="retry" ${s.rerun ? '' : 'disabled'}>🔁 Повторить${s.rerun ? ` (${s.rerun})` : ''}</button>`
      }
      <button class="btn ${found ? 'ghost' : 'primary'}" data-act="close">Закрыть</button>`;

    layoutScriptWorkspace(dlg);
  }

  /* ------------------------- события ------------------------------ */

  function updateAmount(t) {
    if (t.name === 'caravan-amount') {
      openAll = t.value === 'all';
      dlg.body.querySelectorAll('[data-caravan-limit]').forEach(n => {
        n.disabled = openAll;
      });
      return true;
    }
    if (t.matches('[data-caravan-limit]')) {
      const n = Number(t.value),
        max = Number(t.max);
      if (Number.isSafeInteger(n) && n >= 0 && n <= max) {
        limits[t.dataset.caravanLimit] = n;
        t.setCustomValidity('');
      } else t.setCustomValidity('Введите целое число в пределах найденного количества');
      return true;
    }
    return false;
  }
  dlg.body.addEventListener('input', e => {
    if (updateAmount(e.target)) return;
    if (e.target.id === 'caravan-search') {
      search = e.target.value;
      dlg.body.querySelector('#caravan-list').innerHTML = listHtml();
    }
  });
  dlg.body.addEventListener('change', e => {
    const t = e.target;
    if (updateAmount(t)) return;
    if (t.matches('[data-id]')) {
      if (t.checked) selected.add(t.dataset.id);
      else selected.delete(t.dataset.id);
      updateCount();
    }
  });
  dlg.body.addEventListener('click', e => {
    const q = e.target.closest('[data-q]');
    if (q) quickSelect(q.dataset.q);
  });

  /** Подтверждение перед настоящим запуском: сундуки открываются необратимо. */
  let confirming = false;
  const confirmRun = async chars => {
    if (confirming || running) return false;
    confirming = true;
    try {
      return await confirmModal({
        title: 'Открыть сундуки караванщика?',
        text: `Персонажей: ${chars.length}. ${openAll ? 'Открыть все сундуки (до 500 за запуск).' : `Количество: ${chars.map(c => `${c.nick}: ${limits[c.id]}`).join(', ')}.`} В каждом «Сундуке караванщика» будут отмечены все предметы и нажато «Перевести». Действие необратимо. Другие сундуки не трогаются.`,
        okText: `Открыть сундуки (${chars.length})`,
        danger: true
      });
    } finally {
      confirming = false;
    }
  };

  /**
   * Выбирает одного представителя каждого известного аккаунта сайта.
   * Сохранённый статус не запрещает реальную проверку сайта.
   */
  function accountRepresentatives(chars) {
    // Saved status may be stale. The real website, not GameCenter or a dot, decides.
    const map = {};
    for (const row of lastRows) {
      if (row.accountKey) map[row.charId] = 'caravan:' + row.accountKey;
    }
    return groupAccounts(chars, map).map(g => g.members[0]);
  }

  dlg.foot.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') {
      dlg.close();
      return;
    }
    if (act === 'back') {
      renderForm();
      return;
    }
    if (act === 'report') {
      openScriptStatistics(lastReports, {
        title: '📋 Таблица действий: сундуки',
        note: 'Результаты запуска и его повторов: отдельно показано, какие сундуки открыты и какие остались непроверенными.'
      });
      return;
    }
    if (act === 'dry-again') {
      const again = lastChars;
      if (again?.length) await start(again, { dry: true });
      return;
    }
    if (act === 'real') {
      const found = accountRepresentatives(lastChars).filter(
        c => (lastRows.find(r => r.charId === c.id)?.found || 0) > 0
      );
      if ([...dlg.body.querySelectorAll('[data-caravan-limit]')].some(n => !n.checkValidity())) {
        toast('Проверьте количество сундуков', 'warning');
        return;
      }
      const chosen = found.filter(c => openAll || limits[c.id] > 0);
      const chars = chosen.length ? await accountRepresentatives(chosen) : null;
      if (!chars?.length) {
        toast('Укажите количество хотя бы для одного аккаунта', 'warning');
        return;
      }
      if (chars.some(c => !lastRows.find(row => row.charId === c.id)?.accountKey)) {
        toast('Сайт не сообщил аккаунт инвентаря. Открытие не запущено; проверьте сайт и вход заново.', 'warning');
        return;
      }
      if (!running && (await confirmRun(chars))) await start(chars);
      return;
    }
    if (act === 'retry') {
      const rerun = lastChars.filter(
        c => (openAll || limits[c.id] > 0) && isRerunnable(lastRows.find(r => r.charId === c.id))
      );
      const again = rerun.length ? await accountRepresentatives(rerun) : null;
      if (again?.length && (await confirmRun(again))) await start(again, { historyReports: lastReports });
      return;
    }
    if (act === 'start') return;
    if (act === 'dry') {
      const picked = selectedChars();
      if (!picked.length) {
        toast('Выберите хотя бы одного персонажа', 'warning');
        return;
      }
      const chars = picked;
      if (!chars?.length) return;
      if (act === 'dry') {
        await start(chars, { dry: true });
        return;
      }
      if (await confirmRun(chars)) await start(chars);
    }
  });

  renderForm();
  return dlg;
}
