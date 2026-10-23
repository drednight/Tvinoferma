// js/modules/automation/promo.js
// 🎁 Промокоды (Issue #25): диалог «коды → персонажи → предпросмотр → запуск → итоговая таблица».
// Rust-команда: activate_promo (src-tauri/src/automation/promo.rs). Журнал: promoLog.js. Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import { partiesOf } from '../parties/membership.js';
import {
  parseCodes,
  statusInfo,
  rowLabel,
  isOk,
  summarize,
  summarizeByCode,
  rewardLine,
  MAX_CODES,
  codeKey
} from './promoCore.js';
import { loadLog, planRun, recordRun, recentRecords, findRecord, RECENT_N } from './promoLog.js';
import { runPromoBatch } from './promoRunner.js';
import { chipsHtml, noteHtml, progressHtml, sectionHtml, setProgress } from './scriptUi.js';

// Служебная фраза скрытой панели клана: вводится в поле вместо промокода.
// Принимаем обе формы: `pw-guild` появился при переименовании раздела и успел уйти
// в заметки тех, кто уже открыл панель. Замёрзшая на одном слове фраза закрыла бы им путь.
const SECRET_PHRASES = new Set(['pw-eternals', 'pw-guild']);
const isSecretPhrase = value =>
  SECRET_PHRASES.has(
    String(value || '')
      .trim()
      .toLowerCase()
  );
const dot = c => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const when = iso => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

const rowDetail = r => {
  if (r.status === 'unknown') return r.detail ? `Ответ сайта: «${r.detail}»` : errorText(r.error);
  if (r.status === 'error') return errorText(r.error);
  return r.detail || '';
};

const cellHtml = row => {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  const info = statusInfo(row.status);
  const tip = [rowLabel(row), rowDetail(row)].filter(Boolean).join(' — ');
  return `<span title="${escapeHtml(tip)}">${info.icon} ${escapeHtml(row.skipped && isOk(row.status) ? 'ранее' : rowLabel(row))}</span>`;
};

const rewardsHtml = rewards =>
  !rewards?.length
    ? ''
    : `
  <details class="promo-reward"><summary>🎁 Награда: ${rewards.length} шт.</summary>
    <ul>${rewards.map(r => `<li>${escapeHtml(rewardLine(r))}${r.bound ? ' <span class="promo-muted">(привязанный)</span>' : ''}</li>`).join('')}</ul>
  </details>`;

/**
 * Открывает диалог активации промокодов.
 * @param {{ ids?: string[] }} [opts] ids — персонажи, выбранные заранее (например, из режима «Выбрать»)
 */
export function openPromoDialog({ ids = [] } = {}) {
  if (!state.characters.length) {
    toast('Сначала добавьте персонажей', 'info');
    return;
  }
  const selected = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  let search = '';
  let codesRaw = '';
  let running = null; // { cancelled } пока идёт запуск
  let lastRows = []; // результаты последнего запуска
  let lastCodes = [];
  let lastChars = [];
  let lastDry = false; // последний запуск был пробным

  const dlg = openOverlay({
    title: '🎁 Активация промокодов',
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
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
        return `<label class="promo-item"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
        <span class="promo-dot">${dot(c)}</span><b>${escapeHtml(c.nick)}</b><span class="promo-muted promo-item-tags">${escapeHtml(parties)}</span></label>`;
      })
      .join('');
  }

  function renderForm() {
    dlg.sub.textContent =
      'Коды активируются на сайте: приложение откроет страницу активации у каждого выбранного персонажа, активирует коды и покажет награды.';
    dlg.body.innerHTML = `
      ${noteHtml({
        icon: '🎯',
        title: 'Что сделает это окно',
        text:
          'Каждый отмеченный персонаж по очереди открывает страницу активации промокодов на сайте, и там активируются указанные коды. ' +
          'Коды, которые персонаж уже получал раньше, пропускаются. Пробный запуск только ищет кнопку «Активировать» и ничего не нажимает.'
      })}
      ${sectionHtml('Промокоды', {
        step: '1',
        hint: `до ${MAX_CODES} за раз`,
        labelFor: 'promo-code',
        body: `
        <div class="field">
          <textarea class="input" id="promo-code" rows="2" autocomplete="off" spellcheck="false" placeholder="Например: PWZNANIYA26, PWMIZAR2026HB">${escapeHtml(codesRaw)}</textarea>
          <p class="promo-muted promo-hint">До ${MAX_CODES} промокодов за раз. Разделяйте запятой, пробелом или переносом строки; каждый код вводится отдельно.</p>
          <div class="promo-codes-info" id="promo-codes-info"></div>
        </div>`
      })}
      ${sectionHtml('Персонажи', {
        step: '2',
        aside: `<span class="sd-count" id="promo-count"></span><span class="sd-count-meta" id="promo-count-meta"></span>`,
        body: `
        <div class="promo-quick">
          <input class="input" id="promo-search" aria-label="Поиск персонажа" placeholder="Поиск: ник, пати, тег" value="${escapeHtml(search)}">
          <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
          <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
          <button class="btn ghost small" data-q="none">Снять выбор</button>
        </div>
        <div class="promo-list" id="promo-list">${listHtml()}</div>`
      })}`;
    dlg.foot.innerHTML = `
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn secondary" data-act="dry" title="Откроет страницу кода и найдёт кнопку «Активировать», но не нажмёт её: ничего не вводится и не сохраняется">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start">▶ Запустить</button>`;
    updateCount();
    updateCodesInfo();
  }

  const selectedChars = () => state.characters.filter(c => selected.has(c.id)).sort(byNick);

  function updateCount() {
    const el = dlg.body.querySelector('#promo-count');
    if (el) el.textContent = `Выбрано: ${selected.size} из ${state.characters.length}`;
    const meta = dlg.body.querySelector('#promo-count-meta');
    if (meta) meta.textContent = `🟢 с входом: ${selectedChars().filter(c => c.isLoggedIn === true).length}`;
    updateCodesInfo();
  }

  /** Сразу под полем: что с каждым кодом — новый, или уже был введён и у скольких выбранных пропущу. */
  function updateCodesInfo() {
    const box = dlg.body.querySelector('#promo-codes-info');
    if (!box) return;
    const p = parseCodes(codesRaw);
    const lines = [];
    if (p.invalid.length)
      lines.push(
        `<div class="promo-warn">⚠ Не похоже на промокод: ${p.invalid.map(t => `<code>${escapeHtml(t.slice(0, 40))}</code>`).join(', ')} (латинские буквы, цифры, «-», «_»; 4–40 символов)</div>`
      );
    if (p.extra)
      lines.push(
        `<div class="promo-warn">⚠ Больше ${MAX_CODES} кодов: лишних (${p.extra}) не будет — запустите их отдельно.</div>`
      );
    if (p.duplicates) lines.push(`<div class="promo-muted">Повторяющиеся коды убраны: ${p.duplicates}</div>`);
    const chars = selectedChars();
    planRun(loadLog(), p.codes, chars).forEach(plan => {
      if (!plan.record) {
        lines.push(`<div class="promo-muted">🆕 <code>${escapeHtml(plan.code)}</code> — новый код</div>`);
        return;
      }
      const all = chars.length;
      lines.push(
        `<div class="promo-known">♻️ <code>${escapeHtml(plan.code)}</code> — код уже был введён (первый раз ${escapeHtml(when(plan.record.firstAt))}): ${
          all
            ? `у ${plan.done.length} из ${all} выбранных, их пропущу; запущу у ${plan.todo.length}`
            : `у ${Object.keys(plan.record.entered).length} перс.`
        }</div>`
      );
    });
    box.innerHTML = lines.join('');
  }

  function quickSelect(kind) {
    if (kind === 'none') selected.clear();
    if (kind === 'all') state.characters.forEach(c => selected.add(c.id));
    if (kind === 'logged') state.characters.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#promo-list').innerHTML = listHtml();
    updateCount();
  }

  /* --------------------------- запуск ---------------------------- */

  /** Кому код из последних 10 уже введён → строка «пропущено», и результаты прошлого запуска без ответа. */
  function makeSkip(carry = []) {
    const recent = recentRecords(loadLog(), RECENT_N);
    const unclear = new Map(
      carry.filter(r => r.clicked && r.status === 'unknown').map(r => [`${r.charId}|${codeKey(r.code)}`, r])
    );
    return (code, char) => {
      const e = findRecord(recent, code)?.entered[char.id];
      if (e) return { status: 'already_used', detail: `Введён ранее: ${when(e.at)}` };
      const u = unclear.get(`${char.id}|${codeKey(code)}`);
      return u ? { status: 'unknown', detail: u.detail } : null;
    };
  }

  async function start(codes, chars, { carry = [], dry = false } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');

    const total = codes.length * chars.length;
    const task = startTask(`🎁 Промокод${dry ? ' (пробный)' : ''}: ${codes.join(', ').slice(0, 60)}`, {
      total,
      cancelable: true
    });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => {
      signal.cancelled = true;
    });
    // Ждём своей очереди: пока идёт другой скрипт, работу не начинаем
    await task.waitTurn();
    task.watch(...chars.map(c => `char:${c.id}`));
    task.setStep(
      `${chars.length} перс. × ${codes.length} код., по ${browserSlots.max} одновременно, повторов до ${retries}`
    );
    renderRunning(codes, chars, signal, dry);

    const { invoke } = await import('@tauri-apps/api/core');
    const known = state.characters.map(c => ({ id: c.id, nick: c.nick }));
    let rows = [];
    try {
      rows = await runPromoBatch({
        codes,
        chars,
        dryRun: dry,
        signal,
        task,
        invokeFn: invoke,
        retries,
        retryDelayMs,
        skip: makeSkip(carry),
        onRow: (row, done, all) => {
          // Введённое сохраняем сразу: «Стоп» или закрытие окна ничего не теряют
          if (isOk(row.status) && !row.skipped) recordRun(row.code, [row], { known });
          if (alive()) updateRunning(row, done, all);
        }
      });
    } finally {
      running = null;
    }
    // Итог по каждому коду: кому введён и кому нет (и почему); недействительные коды в журнал не попадают
    if (!dry)
      codes.forEach(code =>
        recordRun(
          code,
          rows.filter(r => codeKey(r.code) === codeKey(code)),
          { known }
        )
      );

    const s = summarize(rows);
    if (dry)
      task.finish(
        `${signal.cancelled ? 'Остановлено. ' : ''}Пробный запуск: кнопка найдена у ${s.dry} из ${s.total}, ничего не нажато и не сохранено`,
        s.dry === s.total ? 'done' : 'warn'
      );
    else
      task.finish(
        `${signal.cancelled ? 'Остановлено. ' : ''}Введено ${s.ok} из ${s.total}, пропущено (уже введены) ${s.skipped}, отклонено ${s.invalid}, ошибок ${s.failed}`,
        s.ok === s.total ? 'done' : 'warn'
      );
    rows
      .filter(r => !r.skipped)
      .forEach(r =>
        task.log(
          `${r.nick} · ${r.code}: ${rowLabel(r)}${rowDetail(r) ? ` — ${rowDetail(r)}` : ''}`,
          statusInfo(r.status).level === 'error' ? 'error' : 'info'
        )
      );

    lastRows = rows;
    lastCodes = codes;
    lastChars = chars;
    lastDry = dry;
    if (alive()) renderResults(signal.cancelled);
  }

  const tableHtml = (codes, chars, byKey) => `
    <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th>${codes.map(c => `<th><code>${escapeHtml(c)}</code></th>`).join('')}</tr></thead>
      <tbody>${chars
        .map(
          ch =>
            `<tr data-row="${escapeHtml(ch.id)}"><td><b>${escapeHtml(ch.nick)}</b></td>${codes
              .map(
                code =>
                  `<td data-cell="${escapeHtml(ch.id)}|${escapeHtml(codeKey(code))}">${cellHtml(byKey.get(`${ch.id}|${codeKey(code)}`))}</td>`
              )
              .join('')}</tr>`
        )
        .join('')}</tbody></table></div>`;

  function renderRunning(codes, chars, signal, dry = false) {
    dlg.sub.textContent = dry
      ? '👁 Пробный запуск: страницы открываются, кнопка ищется, но не нажимается.'
      : 'Идёт ввод: персонажи обрабатываются несколько одновременно, коды у каждого — по очереди.';
    dlg.body.innerHTML = `${progressHtml('promo-progress', 0, codes.length * chars.length)}${tableHtml(codes, chars, new Map())}`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">«Стоп» не начинает новых вводов; уже начатые завершатся, введённое сохранится.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    dlg.foot.querySelector('[data-act="stop"]').onclick = e => {
      signal.cancelled = true;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ Останавливаю…';
    };
  }

  function updateRunning(row, done, total) {
    const cellKey = `${row.charId}|${codeKey(row.code)}`;
    const td = [...dlg.body.querySelectorAll('[data-cell]')].find(el => el.dataset.cell === cellKey);
    if (td) td.innerHTML = cellHtml(row);
    setProgress(dlg.body, 'promo-progress', done, total);
  }

  /** Итог запуска чистыми чипами — только то, что действительно было. */
  const resultChips = (s, dry) =>
    chipsHtml(
      dry
        ? [
            { icon: '👁', label: 'кнопка найдена', value: s.dry, tone: 'ok' },
            { icon: '⏭', label: 'уже введены', value: s.skipped },
            { icon: '⛔', label: 'отклонено сайтом', value: s.invalid, tone: 'warn' },
            { icon: '❌', label: 'проблем', value: s.failed, tone: 'err' }
          ]
        : [
            { icon: '✅', label: 'введено', value: s.entered, tone: 'ok' },
            { icon: '⏭', label: 'уже были раньше', value: s.skipped },
            { icon: '⛔', label: 'отклонено сайтом', value: s.invalid, tone: 'warn' },
            { icon: '❓', label: 'не распознано', value: s.unknown, tone: 'warn' },
            { icon: '❌', label: 'ошибок', value: s.failed, tone: 'err' },
            { icon: '⏭', label: 'не выполнено', value: s.notRun }
          ]
    );

  /* ------------------------- результаты -------------------------- */

  function renderResults(stopped) {
    if (lastDry) {
      renderDryResults(stopped);
      return;
    }
    const s = summarize(lastRows);
    const perCode = summarizeByCode(lastRows, lastCodes);
    const log = loadLog();
    dlg.sub.textContent =
      `${stopped ? '⏹ Остановлено. ' : ''}Введено: ${s.ok} из ${s.total}${s.skipped ? ` (из них уже были введены раньше: ${s.skipped})` : ''}.` +
      `${s.invalid ? ` Отклонено сайтом: ${s.invalid}.` : ''}${s.failed ? ` Ошибок: ${s.failed}.` : ''}${s.notRun ? ` Не выполнено: ${s.notRun}.` : ''}`;
    const byKey = new Map(lastRows.map(r => [`${r.charId}|${codeKey(r.code)}`, r]));
    const banners = perCode
      .filter(c => c.rejected)
      .map(
        c =>
          `<div class="promo-alert">⚠ Код <code>${escapeHtml(c.code)}</code> не принят: ${escapeHtml(c.rejected.status === 'expired' ? 'срок действия истёк' : 'недействителен или ещё не настроен на сайте')}` +
          `${c.rejected.detail ? ` («${escapeHtml(c.rejected.detail)}»)` : ''}. Проверьте, что код написан верно. Такие коды в историю не сохраняются.</div>`
      );
    const codeLines = perCode.map(c => {
      const rewards = c.rewards || findRecord(log, c.code)?.reward;
      return `<div class="promo-code-sum"><code>${escapeHtml(c.code)}</code> — введено ${c.entered}, уже было ${c.alreadyUsed}${c.invalid ? `, отклонено ${c.invalid}` : ''}${c.other ? `, не введено ${c.other}` : ''}${rewardsHtml(rewards)}</div>`;
    });
    dlg.body.innerHTML = `${banners.join('')}${resultChips(s, false)}
      ${sectionHtml('Результат по персонажам', { body: tableHtml(lastCodes, lastChars, byKey) })}
      ${sectionHtml('Итог по кодам', { body: `<div class="promo-sums">${codeLines.join('')}</div>` })}
      ${s.unknown ? '<p class="promo-warn">❓ «Результат не распознан» — кнопка нажата, но ответ сайта не удалось понять. Проверьте этих персонажей вручную; автоматически они не повторяются.</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn secondary" data-act="retry">🔁 Повторить ввод${s.rerun ? ` (${s.rerun})` : ''}</button>
      <button class="btn primary" data-act="close">Закрыть</button>`;
  }

  /** Итог пробного запуска: где кнопка найдена, а где нет; в журнал ничего не пишется. */
  function renderDryResults(stopped) {
    const s = summarize(lastRows);
    const byKey = new Map(lastRows.map(r => [`${r.charId}|${codeKey(r.code)}`, r]));
    dlg.sub.textContent =
      `${stopped ? '⏹ Остановлено. ' : ''}👁 Пробный запуск: кнопка найдена ${s.dry} из ${s.total}.` +
      `${s.skipped ? ` Уже введены раньше: ${s.skipped}.` : ''}${s.failed ? ` Проблем: ${s.failed}.` : ''}${s.invalid ? ` Отклонено сайтом: ${s.invalid}.` : ''}`;
    dlg.body.innerHTML = `${resultChips(s, true)}
      ${sectionHtml('Результат по персонажам', { body: tableHtml(lastCodes, lastChars, byKey) })}
      <p class="promo-muted">Ничего не нажато, не введено и не записано в журнал промокодов. Если везде «кнопка найдена» — можно запускать по-настоящему.</p>`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn secondary" data-act="dry-again">👁 Ещё раз</button>
      <button class="btn primary" data-act="real">▶ Запустить по-настоящему</button>`;
  }

  /* ------------------------- события ------------------------------ */

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'promo-search') {
      search = e.target.value;
      dlg.body.querySelector('#promo-list').innerHTML = listHtml();
    }
    if (e.target.id === 'promo-code') {
      codesRaw = e.target.value;
      updateCodesInfo();
    }
  });
  dlg.body.addEventListener('change', e => {
    const t = e.target;
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

  /** Предпросмотр и подтверждение; возвращает false, если запускать нечего или пользователь отказался. */
  async function confirmRun(codes, chars, carry = [], { dry = false } = {}) {
    const plans = planRun(loadLog(), codes, chars);
    const unclear = new Set(
      carry.filter(r => r.clicked && r.status === 'unknown').map(r => `${r.charId}|${codeKey(r.code)}`)
    );
    const todo = plans.reduce((n, p) => n + p.todo.filter(c => !unclear.has(`${c.id}|${codeKey(p.code)}`)).length, 0);
    const skipped = plans.reduce((n, p) => n + p.done.length, 0);
    if (!todo) {
      toast('Все выбранные персонажи уже получили эти коды', 'info');
      return false;
    }
    if (dry) return true; // пробный запуск ничего не нажимает: подтверждение не нужно
    const head = codes.length === 1 ? `Код ${codes[0]}` : `Коды (${codes.length}): ${codes.join(', ')}`;
    return confirmModal({
      title: 'Активировать промокоды?',
      text:
        `${head} — персонажей: ${chars.length}. ` +
        `${skipped ? `Уже введены, будут пропущены: ${skipped}. ` : ''}` +
        `Будет выполнено вводов: ${todo}. Действие необратимо.`,
      okText: `Активировать (${todo})`,
      danger: true
    });
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
    if (act === 'dry-again') {
      if (await confirmRun(lastCodes, lastChars, [], { dry: true })) await start(lastCodes, lastChars, { dry: true });
      return;
    }
    if (act === 'real') {
      if (await confirmRun(lastCodes, lastChars)) await start(lastCodes, lastChars);
      return;
    }
    if (act === 'retry') {
      const carry = lastRows;
      if (await confirmRun(lastCodes, lastChars, carry)) await start(lastCodes, lastChars, { carry });
      return;
    }
    if (act === 'start' || act === 'dry') {
      const dry = act === 'dry';
      codesRaw = dlg.body.querySelector('#promo-code')?.value ?? codesRaw;
      // Скрытая настройка: служебная фраза вместо кода переключает страницу клана и ничего не запускает
      if (isSecretPhrase(codesRaw)) {
        const { toggleGuild } = await import('../guild/state.js');
        const { applyGuildVisibility } = await import('../guild/page.js');
        await toggleGuild();
        applyGuildVisibility();
        dlg.close();
        return;
      }
      const p = parseCodes(codesRaw);
      if (p.invalid.length) {
        toast(`Не похоже на промокод: ${p.invalid.slice(0, 3).join(', ')}`, 'warning');
        return;
      }
      if (!p.codes.length) {
        toast('Введите хотя бы один промокод', 'warning');
        return;
      }
      const chars = selectedChars();
      if (!chars.length) {
        toast('Выберите хотя бы одного персонажа', 'warning');
        return;
      }
      if (await confirmRun(p.codes, chars, [], { dry })) await start(p.codes, chars, { dry });
    }
  });

  renderForm();
  return dlg;
}
