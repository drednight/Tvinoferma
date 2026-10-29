// demo/tools-modals.js
// Лаборатория модальных окон для скриптов раздела «Инструменты».
//
// Всё настоящее: openOverlay (окно), scriptUi.js (sd-* блоки), promoCore.js (коды, статусы,
// итоги), confirmModal и toast из core/ui.js, стили promo.css/marathons.css/modal.css.
// Данные фейковые: персонажи вымышлены, «запуск» имитируется simulate(), ничего не уходит
// на сайт игры и не пишется в хранилище приложения.
//
// По решению автора в лаборатории оставлен один стиль окон — вариант B (split):
// настройка слева, сканирование и живой ход работы справа. «Передачу», «Подарки»
// и «Сундук караванщика» рисует demo/scenarios.js — окна со сканированием сайта;
// «Промокод» — openSplit() ниже. Рукописные окна прошлых вариантов (копия текущего
// диалога openCurrent, мастер openWizard, быстрый запуск openQuick, консоль
// openConsole) со страницы убраны, но код сохранён — на случай возвращения к сравнению.

import { openOverlay } from '../js/modules/marathons/overlay.js';
import { toast, confirmModal } from '../js/core/ui.js';
import { escapeHtml } from '../js/core/utils.js';
import { noteHtml, sectionHtml, progressHtml, setProgress, chipsHtml } from '../js/modules/automation/scriptUi.js';
import {
  parseCodes,
  statusInfo,
  rowLabel,
  isOk,
  isRerunnable,
  summarize,
  summarizeByCode,
  plainRow,
  rewardText,
  MAX_CODES,
  codeKey
} from '../js/modules/automation/promoCore.js';
import {
  CHARS,
  PARTIES,
  sleep,
  rand,
  pick,
  byNick,
  dot,
  hhmmss,
  el,
  classIconHtml,
  stripeCls,
  statusTitle,
  defaultTarget,
  targetChars as selectedTargetChars,
  targetHtml,
  bindTarget,
  closeTargetPicker
} from './lab-data.js';
import { openScenario } from './scenarios.js';
import { demoReport, openDemoReport } from './script-report.js';

/* ==================== фейковые данные сценария «Промокод» ==================== */
// Персонажи, пати и мелкие помощники общие для всех сценариев — живут в lab-data.js.

const CODES_DEFAULT = 'PWZNANIYA26, PWMIZAR2026HB';

/** «Журнал промокодов» демо: какие коды уже вводились и на ком — их строки станут «пропущено». */
const FAKE_LOG = new Map([['pwznaniya26', { when: '12.10.2026 18:42', chars: new Set(['c2', 'c6']) }]]);

const REWARDS = [
  [{ name: 'Древние монеты', qty: 500 }],
  [{ name: 'Метеорит', qty: 100 }],
  [{ name: 'Свиток опыта', qty: 3 }],
  [{ name: 'Подарок гильдии', qty: 1, bound: true }],
  null
];

/* ============================== имитация запуска ============================== */

/** План: кто будет пропущен по «журналу» (skipped), а кто реально пойдёт в работу (jobs). */
function planRows(codes, chars) {
  const skipped = [];
  const jobs = [];
  for (const ch of [...chars].sort(byNick)) {
    for (const code of codes) {
      const rec = FAKE_LOG.get(codeKey(code));
      if (rec && rec.chars.has(ch.id)) {
        skipped.push(plainRow(ch, code, 'already_used', `Введён ранее: ${rec.when}`, { skipped: true }));
      } else {
        jobs.push({ ch, code });
      }
    }
  }
  return { skipped, jobs, total: skipped.length + jobs.length };
}

/** Одна фейковая строка результата. Код PWOLD* всегда «просрочен» — для демонстрации предупреждений. */
function makeFakeRow(ch, code, { dry = false } = {}) {
  if (dry) {
    if (Math.random() < 0.12) {
      return plainRow(ch, code, 'error', 'Кнопка «Активировать» не найдена', {
        error: 'button_not_found',
        dryRun: true
      });
    }
    return plainRow(ch, code, 'dry_run', 'Кнопка найдена, не нажата', { dryRun: true });
  }
  if (codeKey(code).startsWith('pwold'))
    return plainRow(ch, code, 'expired', 'Срок действия истёк 01.01.2025', { clicked: true });
  const r = Math.random();
  if (ch.isLoggedIn === false) {
    if (r < 0.5) return plainRow(ch, code, 'not_logged_in', 'Персонаж не авторизован на сайте');
    if (r < 0.7) return plainRow(ch, code, 'challenge', 'Сайт показал проверку безопасности');
    return plainRow(ch, code, 'error', null, { error: 'timeout' });
  }
  if (r < 0.66)
    return { ...plainRow(ch, code, 'success', 'Код активирован', { clicked: true }), rewards: pick(REWARDS) };
  if (r < 0.78) return plainRow(ch, code, 'already_used', 'Сайт сообщил: код уже вводился', { clicked: true });
  if (r < 0.84) return plainRow(ch, code, 'invalid_code', 'Сайт: код недействителен', { clicked: true });
  if (r < 0.9) return plainRow(ch, code, 'unknown', 'Ответ сайта не распознан', { clicked: true });
  if (r < 0.95) return plainRow(ch, code, 'challenge', 'Сайт показал проверку безопасности', { clicked: true });
  return plainRow(ch, code, 'error', null, { error: 'timeout' });
}

/**
 * «Запуск»: строки появляются по одной с паузами; skipped уже лежат в плане.
 * signal.cancelled обрывает поток — остаток получает статус «cancelled», как в приложении.
 */
async function simulate(plan, { dry = false, signal = null, onRow = null, speed = 1 } = {}) {
  const rows = [...plan.skipped];
  for (let i = 0; i < plan.jobs.length; i++) {
    if (signal?.cancelled) {
      for (let j = i; j < plan.jobs.length; j++) rows.push(plainRow(plan.jobs[j].ch, plan.jobs[j].code, 'cancelled'));
      break;
    }
    await sleep(rand(160, 420) / speed);
    if (signal?.cancelled) {
      for (let j = i; j < plan.jobs.length; j++) rows.push(plainRow(plan.jobs[j].ch, plan.jobs[j].code, 'cancelled'));
      break;
    }
    const job = plan.jobs[i];
    const row = makeFakeRow(job.ch, job.code, { dry });
    rows.push(row);
    onRow?.(row, rows.length, plan.total);
  }
  return rows;
}

/* ============================== общие куски разметки ============================== */

/** Ячейка таблицы результатов — как cellHtml в promo.js. planned — строка ещё не запуска, а план. */
function cellHtml(row) {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  if (row.planned) return '<span class="promo-muted">· в плане</span>';
  const info = statusInfo(row.status);
  const detail = row.detail || (row.status === 'error' ? 'Таймаут: сайт не ответил' : '');
  const label = row.skipped && isOk(row.status) ? 'ранее' : rowLabel(row);
  const tip = [label, detail].filter(Boolean).join(' — ');
  return `<span title="${escapeHtml(tip)}">${info.icon} ${escapeHtml(label)}</span>`;
}

/** Таблица «персонажи × коды» — как tableHtml в promo.js. byKey: Map «charId|codekey» → row. */
function promoTableHtml(codes, chars, byKey) {
  return `<div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th>${codes
    .map(c => `<th><code>${escapeHtml(c)}</code></th>`)
    .join('')}</tr></thead><tbody>${[...chars]
    .sort(byNick)
    .map(
      ch =>
        `<tr class="${stripeCls(ch)}" title="${escapeHtml(statusTitle(ch))}"><td><b>${classIconHtml(ch)} ${escapeHtml(ch.nick)}</b></td>${codes
          .map(code => {
            const row = byKey.get(`${ch.id}|${codeKey(code)}`);
            return `<td data-cell="${escapeHtml(ch.id)}|${escapeHtml(codeKey(code))}">${cellHtml(row)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('')}</tbody></table></div>`;
}

const byKeyOf = rows => new Map(rows.map(r => [`${r.charId}|${codeKey(r.code)}`, r]));

/** Итоговые чипы — как resultChips в promo.js. */
function resultChips(s, dry) {
  return chipsHtml(
    dry
      ? [
          { icon: '👁', label: 'кнопка найдена', value: s.dry, tone: 'ok' },
          { icon: '⏭', label: 'уже введены', value: s.skipped },
          { icon: '❌', label: 'проблем', value: s.failed, tone: 'err' }
        ]
      : [
          { icon: '✅', label: 'введено', value: s.entered, tone: 'ok' },
          { icon: '⏭', label: 'уже были раньше', value: s.skipped + s.alreadyUsed },
          { icon: '⛔', label: 'отклонено сайтом', value: s.invalid, tone: 'warn' },
          { icon: '❓', label: 'не распознано', value: s.unknown, tone: 'warn' },
          { icon: '❌', label: 'ошибок', value: s.failed, tone: 'err' },
          { icon: '⏭', label: 'не выполнено', value: s.notRun }
        ]
  );
}

/** Разбор поля кодов + строки «что с каждым кодом» (новые / уже введённые) — как updateCodesInfo. */
function codesInfoHtml(codesRaw, chars) {
  const p = parseCodes(codesRaw);
  const lines = [];
  if (p.invalid.length) {
    lines.push(
      `<div class="promo-warn">⚠ Не похоже на промокод: ${p.invalid
        .map(t => `<code>${escapeHtml(t.slice(0, 40))}</code>`)
        .join(', ')} (латинские буквы, цифры, «-», «_»; 4–40 символов)</div>`
    );
  }
  if (p.extra) lines.push(`<div class="promo-warn">⚠ Больше ${MAX_CODES} кодов: лишних (${p.extra}) не будет.</div>`);
  if (p.duplicates) lines.push(`<div class="promo-muted">Повторяющиеся коды убраны: ${p.duplicates}</div>`);
  for (const code of p.codes) {
    const rec = FAKE_LOG.get(codeKey(code));
    if (!rec) {
      lines.push(`<div class="promo-muted">🆕 <code>${escapeHtml(code)}</code> — новый код</div>`);
      continue;
    }
    const done = chars.filter(c => rec.chars.has(c.id)).length;
    lines.push(
      `<div class="promo-known">♻️ <code>${escapeHtml(code)}</code> — уже был введён (${escapeHtml(rec.when)}): ${
        chars.length ? `у ${done} из ${chars.length} выбранных, их пропущу; запущу у ${chars.length - done}` : ''
      }</div>`
    );
  }
  return lines.join('');
}

/** Баннеры «код не принят» — как в renderResults promo.js. */
function rejectedBannersHtml(perCode) {
  return perCode
    .filter(c => c.rejected)
    .map(
      c =>
        `<div class="promo-alert">⚠ Код <code>${escapeHtml(c.code)}</code> не принят: ${escapeHtml(
          c.rejected.status === 'expired' ? 'срок действия истёк' : 'недействителен или ещё не настроен на сайте'
        )}. Такие коды в историю не сохраняются.</div>`
    )
    .join('');
}

/** Персонажи, которых «Повторить» запустит снова: строки, подходящие isRerunnable. */
function rerunCharsOf(rows, chars) {
  const ids = new Set(rows.filter(isRerunnable).map(r => r.charId));
  return chars.filter(c => ids.has(c.id));
}

/* ============================================================================ */
/* Вариант 0 · Как сейчас — копия текущего диалога promo.js на фейковых данных   */
/* ============================================================================ */

function openCurrent() {
  const selected = new Set(CHARS.filter(c => c.isLoggedIn === true).map(c => c.id));
  let search = '';
  let codesRaw = CODES_DEFAULT;
  let running = null; // { cancelled } пока идёт запуск
  let last = null; // { rows, codes, chars, dry, stopped }

  const dlg = openOverlay({
    title: '🎁 Активация промокодов',
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
    }
  });
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;
  const selectedChars = () => CHARS.filter(c => selected.has(c.id)).sort(byNick);

  function visibleChars() {
    const q = search.trim().toLowerCase();
    return [...CHARS].sort(byNick).filter(c => !q || [c.nick, c.cls, c.party].join(' ').toLowerCase().includes(q));
  }

  function listHtml() {
    const list = visibleChars();
    if (!list.length) return '<div class="promo-empty empty-state">Никого не найдено</div>';
    return list
      .map(
        c =>
          `<label class="promo-item"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
        <span class="promo-dot">${dot(c)}</span><b>${escapeHtml(c.nick)}</b><span class="promo-muted promo-item-tags">${escapeHtml(c.party)} · ${escapeHtml(c.cls)}</span></label>`
      )
      .join('');
  }

  function updateCount() {
    const cnt = dlg.body.querySelector('#cur-count');
    if (cnt) cnt.textContent = `Выбрано: ${selected.size} из ${CHARS.length}`;
    const meta = dlg.body.querySelector('#cur-count-meta');
    if (meta) meta.textContent = `🟢 с входом: ${selectedChars().filter(c => c.isLoggedIn === true).length}`;
    const info = dlg.body.querySelector('#cur-codes-info');
    if (info) info.innerHTML = codesInfoHtml(codesRaw, selectedChars());
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
        labelFor: 'cur-code',
        body: `
        <div class="field">
          <textarea class="input" id="cur-code" rows="2" autocomplete="off" spellcheck="false" placeholder="Например: PWZNANIYA26, PWMIZAR2026HB">${escapeHtml(codesRaw)}</textarea>
          <p class="promo-muted promo-hint">До ${MAX_CODES} промокодов за раз. Разделяйте запятой, пробелом или переносом строки.</p>
          <div class="promo-codes-info" id="cur-codes-info"></div>
        </div>`
      })}
      ${sectionHtml('Персонажи', {
        step: '2',
        aside: `<span class="sd-count" id="cur-count"></span><span class="sd-count-meta" id="cur-count-meta"></span>`,
        body: `
        <div class="promo-quick">
          <input class="input" id="cur-search" aria-label="Поиск персонажа" placeholder="Поиск: ник, пати, класс" value="${escapeHtml(search)}">
          <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
          <button class="btn ghost small" data-q="logged" title="Отметить всех, у кого по данным приложения есть вход">🟢 Все с входом</button>
          <button class="btn ghost small" data-q="none">Снять выбор</button>
        </div>
        <div class="promo-list" id="cur-list">${listHtml()}</div>`
      })}`;
    dlg.foot.innerHTML = `
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn secondary" data-act="dry" title="Откроет страницу кода и найдёт кнопку «Активировать», но не нажмёт её">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start">▶ Запустить</button>`;
    updateCount();
  }

  function renderRunning(codes, chars, plan, dry) {
    dlg.sub.textContent = dry
      ? '👁 Пробный запуск: страницы открываются, кнопка ищется, но не нажимается.'
      : 'Идёт ввод: персонажи обрабатываются несколько одновременно, коды у каждого — по очереди.';
    dlg.body.innerHTML = `${progressHtml('cur-progress', plan.skipped.length, plan.total)}${promoTableHtml(
      codes,
      chars,
      byKeyOf(plan.skipped)
    )}`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">«Стоп» не начинает новых вводов; уже начатые завершатся, введённое сохранится.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
  }

  function updateRunning(row, done, total) {
    const td = dlg.body.querySelector(`[data-cell="${CSS.escape(`${row.charId}|${codeKey(row.code)}`)}"]`);
    if (td) td.innerHTML = cellHtml(row);
    setProgress(dlg.body, 'cur-progress', done, total);
  }

  function renderResults() {
    const { rows, codes, chars, dry, stopped } = last;
    const s = summarize(rows);
    const byKey = byKeyOf(rows);
    if (dry) {
      dlg.sub.textContent = `${stopped ? '⏹ Остановлено. ' : ''}👁 Пробный запуск: кнопка найдена ${s.dry} из ${s.total}.`;
      dlg.body.innerHTML = `${resultChips(s, true)}
        ${sectionHtml('Результат по персонажам', { body: promoTableHtml(codes, chars, byKey) })}
        <p class="promo-muted">Ничего не нажато, не введено и не записано в журнал. Если везде «кнопка найдена» — можно запускать по-настоящему.</p>`;
      dlg.foot.innerHTML = `
        <button class="btn ghost" data-act="back">← К списку</button>
        <span class="sd-foot-spacer"></span>
        <button class="btn secondary" data-act="dry-again">👁 Ещё раз</button>
        <button class="btn primary" data-act="real">▶ Запустить по-настоящему</button>`;
      return;
    }
    const perCode = summarizeByCode(rows, codes);
    const rerun = rerunCharsOf(rows, chars).length;
    dlg.sub.textContent =
      `${stopped ? '⏹ Остановлено. ' : ''}Введено: ${s.ok} из ${s.total}.` +
      `${s.invalid ? ` Отклонено сайтом: ${s.invalid}.` : ''}${s.failed ? ` Ошибок: ${s.failed}.` : ''}`;
    const codeLines = perCode.map(c => {
      const reward = rows.find(r => codeKey(r.code) === codeKey(c.code) && r.rewards?.length)?.rewards;
      return `<div class="promo-code-sum"><code>${escapeHtml(c.code)}</code> — введено ${c.entered}, уже было ${c.alreadyUsed}${
        c.invalid ? `, отклонено ${c.invalid}` : ''
      }${c.other ? `, не введено ${c.other}` : ''}${
        reward ? `<div class="promo-muted">🎁 Награда: ${escapeHtml(rewardText(reward))}</div>` : ''
      }</div>`;
    });
    dlg.body.innerHTML = `${rejectedBannersHtml(perCode)}${resultChips(s, false)}
      ${sectionHtml('Результат по персонажам', { body: promoTableHtml(codes, chars, byKey) })}
      ${sectionHtml('Итог по кодам', { body: `<div class="promo-sums">${codeLines.join('')}</div>` })}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="back">← К списку</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn secondary" data-act="retry" ${rerun ? '' : 'disabled'}>🔁 Повторить ввод${rerun ? ` (${rerun})` : ''}</button>
      <button class="btn primary" data-act="close">Закрыть</button>`;
  }

  async function start(codes, chars, { dry = false } = {}) {
    const plan = planRows(codes, chars);
    const signal = { cancelled: false };
    running = signal;
    renderRunning(codes, chars, plan, dry);
    const rows = await simulate(plan, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (alive()) updateRunning(row, done, total);
      }
    });
    running = null;
    last = { rows, codes, chars, dry, stopped: signal.cancelled };
    if (alive()) renderResults();
  }

  /** Подтверждение как в приложении: отдельное окно confirmModal с числом вводов. */
  async function confirmRun(codes, chars) {
    const plan = planRows(codes, chars);
    if (!plan.jobs.length) {
      toast('Все выбранные персонажи уже получили эти коды', 'info');
      return false;
    }
    const head = codes.length === 1 ? `Код ${codes[0]}` : `Коды (${codes.length}): ${codes.join(', ')}`;
    return confirmModal({
      title: 'Активировать промокоды?',
      text: `${head} — персонажей: ${chars.length}. ${
        plan.skipped.length ? `Уже введены, будут пропущены: ${plan.skipped.length}. ` : ''
      }Будет выполнено вводов: ${plan.jobs.length}. Действие необратимо.`,
      okText: `Активировать (${plan.jobs.length})`,
      danger: true
    });
  }

  /** Валидация формы перед запуском; возвращает { codes, chars } или null. */
  function collect() {
    const p = parseCodes(codesRaw);
    if (p.invalid.length) {
      toast(`Не похоже на промокод: ${p.invalid.slice(0, 3).join(', ')}`, 'warning');
      return null;
    }
    if (!p.codes.length) {
      toast('Введите хотя бы один промокод', 'warning');
      return null;
    }
    const chars = selectedChars();
    if (!chars.length) {
      toast('Выберите хотя бы одного персонажа', 'warning');
      return null;
    }
    return { codes: p.codes, chars };
  }

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'cur-search') {
      search = e.target.value;
      dlg.body.querySelector('#cur-list').innerHTML = listHtml();
    }
    if (e.target.id === 'cur-code') {
      codesRaw = e.target.value;
      updateCount();
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
    if (!q) return;
    if (q.dataset.q === 'none') selected.clear();
    if (q.dataset.q === 'all') CHARS.forEach(c => selected.add(c.id));
    if (q.dataset.q === 'logged') CHARS.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
    dlg.body.querySelector('#cur-list').innerHTML = listHtml();
    updateCount();
  });

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'back') return renderForm();
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'dry' || act === 'dry-again') {
      const c = collect();
      if (c) await start(c.codes, c.chars, { dry: true });
      return;
    }
    if (act === 'start' || act === 'real') {
      const c = collect();
      if (!c) return;
      if (await confirmRun(c.codes, c.chars)) await start(c.codes, c.chars);
      return;
    }
    if (act === 'retry') {
      const chars = rerunCharsOf(last.rows, last.chars);
      if (!chars.length) return toast('Повторять нечего', 'info');
      if (await confirmRun(last.codes, chars)) await start(last.codes, chars);
    }
  });

  renderForm();
  return dlg;
}

/* ============================================================================ */
/* Вариант A · Мастер шагов                                                      */
/* ============================================================================ */

function openWizard() {
  const selected = new Set(CHARS.filter(c => c.isLoggedIn === true).map(c => c.id));
  let codesRaw = CODES_DEFAULT;
  let search = '';
  let step = 1; // 1 коды | 2 персонажи | 3 проверка
  let phase = 'form'; // form | run | result
  let running = null;
  let last = null;

  const dlg = openOverlay({
    title: '🎁 Активация промокодов',
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
    }
  });
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;
  const selectedChars = () => CHARS.filter(c => selected.has(c.id)).sort(byNick);
  const STEPS = ['Коды', 'Персонажи', 'Проверка', 'Выполнение'];

  function currentPlan() {
    const p = parseCodes(codesRaw);
    const chars = selectedChars();
    return { codes: p.codes, chars, plan: planRows(p.codes, chars) };
  }

  function stepperHtml() {
    const active = phase === 'form' ? step : 4;
    const n = phase === 'result' ? 5 : active; // в результате все шаги «✓»
    const visible = phase === 'form' ? 3 : 4;
    return `<ol class="wz-steps">${STEPS.slice(0, visible)
      .map((label, i) => {
        const idx = i + 1;
        const done = idx < n;
        const cls = done ? 'is-done' : idx === n ? 'is-active' : '';
        const clickable = phase === 'form' && idx <= 3 ? `data-goto="${idx}"` : '';
        return `<li class="wz-step ${cls}" ${clickable}><span class="wz-step-n">${done ? '✓' : idx}</span><span>${label}</span></li>`;
      })
      .join('')}</ol>`;
  }

  function codeChipsHtml() {
    const p = parseCodes(codesRaw);
    const chips = p.codes.map(code => {
      const rec = FAKE_LOG.get(codeKey(code));
      return `<span class="wz-code-chip ${rec ? 'is-known' : ''}" title="${
        rec ? `Уже вводился ${rec.when}` : 'Новый код'
      }"><code>${escapeHtml(code)}</code>${rec ? ' ♻️' : ' 🆕'}</span>`;
    });
    if (p.invalid.length)
      chips.push(
        `<span class="wz-code-chip is-bad" title="Не похоже на промокод"><code>${escapeHtml(p.invalid.join(', '))}</code> ⚠</span>`
      );
    return chips.join('') || '<span class="muted">Пока пусто — введите хотя бы один код</span>';
  }

  function listHtml() {
    const q = search.trim().toLowerCase();
    const list = [...CHARS]
      .sort(byNick)
      .filter(c => !q || [c.nick, c.cls, c.party].join(' ').toLowerCase().includes(q));
    if (!list.length) return '<div class="promo-empty empty-state">Никого не найдено</div>';
    return list
      .map(
        c =>
          `<label class="promo-item"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>
        <span class="promo-dot">${dot(c)}</span><b>${escapeHtml(c.nick)}</b><span class="promo-muted promo-item-tags">${escapeHtml(c.party)} · ${escapeHtml(c.cls)}</span></label>`
      )
      .join('');
  }

  function stepBodyHtml() {
    if (step === 1) {
      return `<div class="wz-pane">
        ${sectionHtml('Какие коды активируем', {
          hint: `до ${MAX_CODES} за раз`,
          labelFor: 'wz-code',
          body: `
          <div class="field">
            <textarea class="input" id="wz-code" rows="3" autocomplete="off" spellcheck="false" placeholder="PWZNANIYA26, PWMIZAR2026HB">${escapeHtml(codesRaw)}</textarea>
            <div class="promo-codes-info" id="wz-codes-info">${codesInfoHtml(codesRaw, selectedChars())}</div>
          </div>`
        })}
        <div class="wz-code-chips" id="wz-code-chips">${codeChipsHtml()}</div>
      </div>`;
    }
    if (step === 2) {
      return `<div class="wz-pane">
        ${sectionHtml('На каких персонажах', {
          aside: `<span class="sd-count" id="wz-count">Выбрано: ${selected.size} из ${CHARS.length}</span>`,
          body: `
          <div class="promo-quick">
            <input class="input" id="wz-search" aria-label="Поиск персонажа" placeholder="Поиск: ник, пати, класс" value="${escapeHtml(search)}">
            <button class="btn ghost small" data-q="all">☑ Всех</button>
            <button class="btn ghost small" data-q="logged">🟢 С входом</button>
            <button class="btn ghost small" data-q="none">Снять</button>
          </div>
          <div class="promo-list wz-list" id="wz-list">${listHtml()}</div>`
        })}
      </div>`;
    }
    const { codes, chars, plan } = currentPlan();
    return `<div class="wz-pane">
      ${noteHtml({
        icon: '⚠️',
        tone: 'warn',
        title: 'Проверьте — и можно запускать',
        text: 'Коды будут активированы на сайте игры, действие необратимо. Этот шаг заменяет отдельное окно подтверждения.'
      })}
      <div class="wz-review">
        <div class="wz-review-row"><span>Коды</span><span class="wz-code-chips">${codeChipsHtml()}</span></div>
        <div class="wz-review-row"><span>Персонажей</span><b>${chars.length}</b></div>
        <div class="wz-review-row wz-review-big"><span>Выполним вводов</span><b>${plan.jobs.length}</b></div>
        <div class="wz-review-row"><span>Пропустим (уже введены раньше)</span><b>${plan.skipped.length}</b></div>
      </div>
      <div class="wz-nicks">${chars.map(c => `<span class="wz-nick">${dot(c)} ${escapeHtml(c.nick)}</span>`).join('')}</div>
      ${
        plan.jobs.length
          ? ''
          : noteHtml({
              icon: 'ℹ️',
              text: 'Все выбранные уже получили эти коды — запускать нечего. Вернитесь на шаг 1 или 2.'
            })
      }
    </div>`;
  }

  function render() {
    if (phase === 'run') return renderRun();
    if (phase === 'result') return renderResult();
    dlg.sub.textContent = 'Шаг ' + step + ' из 3 — мастер проведёт от кодов до запуска.';
    dlg.body.innerHTML = stepperHtml() + stepBodyHtml();
    if (step === 1) {
      dlg.foot.innerHTML = `
        <span class="sd-foot-spacer"></span>
        <button class="btn ghost" data-act="close">✕ Закрыть</button>
        <button class="btn primary" data-act="next">Далее →</button>`;
    } else if (step === 2) {
      dlg.foot.innerHTML = `
        <button class="btn ghost" data-act="prev">← Назад</button>
        <span class="sd-foot-spacer"></span>
        <button class="btn primary" data-act="next">Далее →</button>`;
    } else {
      const { plan } = currentPlan();
      dlg.foot.innerHTML = `
        <button class="btn ghost" data-act="prev">← Назад</button>
        <span class="sd-foot-spacer"></span>
        <button class="btn secondary" data-act="dry">👁 Пробный</button>
        <button class="btn primary" data-act="start" ${plan.jobs.length ? '' : 'disabled'}>▶ Запустить (${plan.jobs.length})</button>`;
    }
  }

  function renderRun() {
    const { rows, codes, chars, plan, dry } = last;
    dlg.sub.textContent = dry ? '👁 Пробный запуск: ищем кнопку, ничего не нажимаем.' : 'Идёт ввод кодов на сайте…';
    dlg.body.innerHTML =
      stepperHtml() +
      `<div class="wz-pane">${progressHtml('wz-progress', rows.length, plan.total)}${promoTableHtml(codes, chars, byKeyOf(rows))}</div>`;
    dlg.foot.innerHTML = `<span class="promo-muted sd-foot-spacer">Можно закрыть окно — работа продолжится в журнале задач.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
  }

  function renderResult() {
    const { rows, codes, chars, dry, stopped } = last;
    const s = summarize(rows);
    dlg.sub.textContent = `${stopped ? '⏹ Остановлено. ' : ''}${
      dry ? `Пробный: кнопка найдена ${s.dry} из ${s.total}.` : `Введено ${s.ok} из ${s.total}.`
    }`;
    const rerun = rerunCharsOf(rows, chars).length;
    dlg.body.innerHTML =
      stepperHtml() +
      `<div class="wz-pane">
        ${rejectedBannersHtml(summarizeByCode(rows, codes))}
        ${resultChips(s, dry)}
        ${sectionHtml('Результат по персонажам', { body: promoTableHtml(codes, chars, byKeyOf(rows)) })}
      </div>`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="restart">← Начать заново</button>
      <span class="sd-foot-spacer"></span>
      ${dry || rerun ? `<button class="btn secondary" data-act="retry" ${rerun || dry ? '' : 'disabled'}>🔁 Повторить${rerun ? ` (${rerun})` : ''}</button>` : ''}
      <button class="btn primary" data-act="close">✓ Готово</button>`;
  }

  async function start(dry) {
    const { codes, chars } = currentPlan();
    const plan = planRows(codes, chars);
    const signal = { cancelled: false };
    running = signal;
    phase = 'run';
    last = { rows: [...plan.skipped], codes, chars, plan, dry, stopped: false };
    renderRun();
    const rows = await simulate(plan, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (!alive()) return;
        last.rows = [...last.rows, row];
        const td = dlg.body.querySelector(`[data-cell="${CSS.escape(`${row.charId}|${codeKey(row.code)}`)}"]`);
        if (td) td.innerHTML = cellHtml(row);
        setProgress(dlg.body, 'wz-progress', done, total);
      }
    });
    running = null;
    last = { rows, codes, chars, plan, dry, stopped: signal.cancelled };
    phase = 'result';
    if (alive()) renderResult();
  }

  function validateStep1() {
    const p = parseCodes(codesRaw);
    if (p.invalid.length) {
      toast(`Не похоже на промокод: ${p.invalid.slice(0, 3).join(', ')}`, 'warning');
      return false;
    }
    if (!p.codes.length) {
      toast('Введите хотя бы один промокод', 'warning');
      return false;
    }
    return true;
  }

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'wz-search') {
      search = e.target.value;
      dlg.body.querySelector('#wz-list').innerHTML = listHtml();
    }
    if (e.target.id === 'wz-code') {
      codesRaw = e.target.value;
      dlg.body.querySelector('#wz-codes-info').innerHTML = codesInfoHtml(codesRaw, selectedChars());
      dlg.body.querySelector('#wz-code-chips').innerHTML = codeChipsHtml();
    }
  });
  dlg.body.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-id]')) {
      if (t.checked) selected.add(t.dataset.id);
      else selected.delete(t.dataset.id);
      const cnt = dlg.body.querySelector('#wz-count');
      if (cnt) cnt.textContent = `Выбрано: ${selected.size} из ${CHARS.length}`;
    }
  });
  dlg.body.addEventListener('click', e => {
    const q = e.target.closest('[data-q]');
    if (q) {
      if (q.dataset.q === 'none') selected.clear();
      if (q.dataset.q === 'all') CHARS.forEach(c => selected.add(c.id));
      if (q.dataset.q === 'logged') CHARS.filter(c => c.isLoggedIn === true).forEach(c => selected.add(c.id));
      dlg.body.querySelector('#wz-list').innerHTML = listHtml();
      const cnt = dlg.body.querySelector('#wz-count');
      if (cnt) cnt.textContent = `Выбрано: ${selected.size} из ${CHARS.length}`;
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto && phase === 'form') {
      step = Number(goto.dataset.goto);
      render();
    }
  });

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'restart') {
      phase = 'form';
      step = 1;
      last = null;
      return render();
    }
    if (act === 'prev') {
      step = Math.max(1, step - 1);
      return render();
    }
    if (act === 'next') {
      if (step === 1 && !validateStep1()) return;
      if (step === 2 && !selected.size) return toast('Выберите хотя бы одного персонажа', 'warning');
      step = Math.min(3, step + 1);
      return render();
    }
    if (act === 'dry') return start(true);
    if (act === 'start') return start(false);
    if (act === 'retry') {
      if (last?.dry) return start(true);
      const chars = rerunCharsOf(last.rows, last.chars);
      if (!chars.length) return toast('Повторять нечего', 'info');
      codesRaw = last.codes.join(', ');
      chars.forEach(c => selected.add(c.id));
      return start(false);
    }
  });

  render();
  return dlg;
}

/* ============================================================================ */
/* Вариант B · Два столбца: настройка слева, живой ход справа                    */
/* ============================================================================ */

export function openSplit() {
  let codesRaw = CODES_DEFAULT;
  const target = defaultTarget();
  let running = null;
  let last = null;
  let reports = [];

  const dlg = openOverlay({
    title: '🎁 Промокоды — настройка и ход работы в одном окне',
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
      closeTargetPicker(dlg.body);
    }
  });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('sp-container');
  const alive = () => dlg.el.isConnected;

  const targetChars = () => selectedTargetChars(target);

  dlg.sub.textContent =
    'Слева — настройка, справа — план и ход. Демо: данные вымышлены, запуск и проверка имитируются, запросов к сайту нет.';
  dlg.body.innerHTML = `
    <div class="sp-body">
      <aside class="sp-side" id="sp-side">
        <div class="sp-field">
          <label for="sp-codes">Промокоды</label>
          <textarea class="input" id="sp-codes" rows="2" autocomplete="off" spellcheck="false">${escapeHtml(codesRaw)}</textarea>
          <div class="promo-codes-info" id="sp-codes-info"></div>
        </div>
        <div class="sp-field">
          <label>Кого запускать</label>
          ${targetHtml(target, 'sp')}
        </div>
        <label class="sp-check"><input type="checkbox" checked disabled> Пропускать уже введённые (по журналу)</label>
        <div class="sp-summary">
          <b id="sp-jobs">0</b>
          <span>вводов у <b id="sp-chars">0</b> персонажей</span>
          <small class="muted" id="sp-skip"></small>
        </div>
      </aside>
      <div class="sp-main">
        <div class="sp-progress">
          <div class="sp-progress-top">
            <span class="sp-status" id="sp-status">Готов к запуску</span>
            <b id="sp-count">0 из 0</b>
          </div>
          <div class="sd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="sp-bar" style="width:0%"></span></div>
        </div>
        <div id="sp-table"></div>
        <div id="sp-chips"></div>
      </div>
    </div>`;
  dlg.foot.innerHTML = `
    <span class="promo-muted" id="sp-foot-hint">Изменения слева сразу пересчитывают план справа.</span>
    <span class="sd-foot-spacer"></span>
    <button class="btn secondary" data-act="dry">👁 Пробный</button>
    <button class="btn primary" data-act="start">▶ Запустить</button>`;

  const $ = id => dlg.body.querySelector('#' + id);

  /** Пересчёт плана: числа слева, таблица справа (в состоянии «план»), подпись кнопки запуска. */
  function updatePlan() {
    if (running) return;
    // Правка параметров обнуляет прошлый итог: старый результат к новому плану не относится
    last = null;
    const p = parseCodes(codesRaw);
    const chars = targetChars();
    const plan = planRows(p.codes, chars);
    $('sp-codes-info').innerHTML = codesInfoHtml(codesRaw, chars);
    $('sp-jobs').textContent = String(plan.jobs.length);
    $('sp-chars').textContent = String(chars.length);
    $('sp-skip').textContent = plan.skipped.length ? `ещё ${plan.skipped.length} пропустим (уже введены)` : '';
    $('sp-status').textContent = 'Готов к запуску';
    $('sp-status').classList.remove('is-running');
    $('sp-count').textContent = `план: ${plan.total}`;
    setBar(0, plan.total);
    $('sp-chips').innerHTML = '';
    $('sp-table').innerHTML = p.codes.length
      ? promoTableHtml(
          p.codes,
          chars,
          byKeyOf([...plan.skipped, ...plan.jobs.map(j => ({ charId: j.ch.id, code: j.code, planned: true }))])
        )
      : '<p class="muted">Введите коды слева — здесь появится план: кто получит каждый код.</p>';
    resetFooter(plan);
  }

  function resetFooter(plan) {
    dlg.foot.innerHTML = `
      <button class="btn secondary" data-act="refresh">🔄 Обновить статусы</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      <button class="btn secondary" data-act="dry">👁 Пробный</button>
      <button class="btn primary" data-act="start">▶ Запустить${plan ? ` (${plan.jobs.length})` : ''}</button>`;
  }

  // В демо проверка только показывает процесс; реального обращения к сайту нет.
  async function refresh() {
    const chars = targetChars();
    if (!chars.length) return toast('Выберите персонажей', 'warning');
    const signal = { cancelled: false };
    running = signal;
    $('sp-side').classList.add('is-locked');
    $('sp-side').inert = true;
    $('sp-status').classList.add('is-running');
    dlg.foot.innerHTML =
      '<span class="promo-muted">Демо: проверка имитируется.</span><span class="sd-foot-spacer"></span><button class="btn danger" data-act="stop">⏹ Стоп</button>';
    let done = 0;
    for (const char of chars) {
      if (!alive() || signal.cancelled) break;
      $('sp-status').textContent = `🔄 Демо-проверка: ${char.nick}`;
      await sleep(110);
      if (!alive() || signal.cancelled) break;
      done++;
      setBar(done, chars.length);
      $('sp-count').textContent = `${done} из ${chars.length}`;
    }
    running = null;
    if (!alive()) return;
    $('sp-side').classList.remove('is-locked');
    $('sp-side').inert = false;
    updatePlan();
    $('sp-status').textContent = signal.cancelled ? '⏹ Проверка остановлена' : '✅ Демо-проверка статусов завершена';
  }

  async function start(dry, retryRows = null) {
    const p = parseCodes(codesRaw);
    if (!p.codes.length) return toast('Введите хотя бы один промокод', 'warning');
    const chars = targetChars();
    if (!chars.length) return toast('Выберите персонажей', 'warning');
    const plan = planRows(p.codes, chars);
    if (retryRows) {
      const allowed = new Set(retryRows.filter(isRerunnable).map(r => `${r.charId}|${codeKey(r.code)}`));
      plan.jobs = plan.jobs.filter(job => allowed.has(`${job.ch.id}|${codeKey(job.code)}`));
      plan.skipped = [];
      plan.total = plan.jobs.length;
    }
    if (!plan.jobs.length && !dry) return toast('Повторять нечего', 'info');
    if (
      !dry &&
      !(await confirmModal({
        title: 'Активировать промокоды?',
        text: `Коды (${p.codes.length}) — персонажей: ${chars.length}. Будет выполнено вводов: ${plan.jobs.length}. Действие необратимо.`,
        okText: `Активировать (${plan.jobs.length})`,
        danger: true
      }))
    )
      return;

    const signal = { cancelled: false };
    running = signal;
    last = null;
    $('sp-side').classList.add('is-locked');
    $('sp-side').inert = true;
    $('sp-status').textContent = dry ? '👁 Пробный запуск' : 'Идёт ввод…';
    $('sp-status').classList.add('is-running');
    $('sp-chips').innerHTML = '';
    $('sp-table').innerHTML = promoTableHtml(p.codes, chars, byKeyOf(plan.skipped));
    setBar(plan.skipped.length, plan.total);
    dlg.foot.innerHTML = `
      <span class="promo-muted">«Стоп» не начинает новых вводов; уже начатые завершатся.</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;

    const rows = await simulate(plan, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (!alive()) return;
        const td = $('sp-table').querySelector(`[data-cell="${CSS.escape(`${row.charId}|${codeKey(row.code)}`)}"]`);
        if (td) td.innerHTML = cellHtml(row);
        setBar(done, total);
        $('sp-count').textContent = `${done} из ${total}`;
      }
    });
    running = null;
    last = { rows, codes: p.codes, chars, dry, stopped: signal.cancelled };
    if (!retryRows) reports = [];
    reports.push(demoReport('promo', rows, dry));
    if (!alive()) return;
    const s = summarize(rows);
    $('sp-side').classList.remove('is-locked');
    $('sp-side').inert = false;
    $('sp-status').classList.remove('is-running');
    $('sp-status').textContent = signal.cancelled ? '⏹ Остановлено' : dry ? '👁 Пробный завершён' : '✅ Завершено';
    $('sp-chips').innerHTML = resultChips(s, dry);
    const rerun = dry ? 0 : rerunCharsOf(rows, chars).length;
    dlg.foot.innerHTML = `
      <span class="promo-muted">${
        dry
          ? 'Ничего не нажато и не сохранено.'
          : `Введено ${s.ok} из ${s.total}${s.failed ? `, ошибок ${s.failed}` : ''}.`
      }</span>
      <button class="btn secondary" data-act="refresh">🔄 Обновить статусы</button>
      <button class="btn secondary" data-act="report">📋 Таблица действий</button>
      <span class="sd-foot-spacer"></span>
      ${rerun ? `<button class="btn secondary" data-act="retry">🔁 Повторить ошибки (${rerun})</button>` : ''}
      <button class="btn ghost" data-act="close">Закрыть</button>`;
  }

  function setBar(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar = $('sp-bar');
    if (bar) bar.style.width = `${pct}%`;
    bar?.parentElement?.setAttribute('aria-valuenow', String(pct));
  }

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'sp-codes') {
      codesRaw = e.target.value;
      updatePlan();
    }
  });
  bindTarget(dlg.body, target, 'sp', updatePlan);

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'refresh') return refresh();
    if (act === 'report') return openDemoReport(reports);
    if (act === 'dry') return start(true);
    if (act === 'start') return start(false);
    if (act === 'retry') {
      if (!last) return;
      if (!last.rows.some(isRerunnable)) return toast('Повторять нечего', 'info');
      return start(false, last.rows);
    }
  });

  updatePlan();
  return dlg;
}

/* ============================================================================ */
/* Вариант C · Быстрый запуск + фоновый док                                      */
/* ============================================================================ */

function openQuick() {
  let codesRaw = CODES_DEFAULT;
  let target = 'logged'; // all | logged | party | manual
  const parties = new Set([PARTIES[0]]);
  const manual = new Set(CHARS.filter(c => c.isLoggedIn === true).map(c => c.id));

  const dlg = openOverlay({ title: '🎁 Промокоды' });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('ql-container');

  function targetChars() {
    if (target === 'all') return [...CHARS].sort(byNick);
    if (target === 'logged') return CHARS.filter(c => c.isLoggedIn === true).sort(byNick);
    if (target === 'party') return CHARS.filter(c => parties.has(c.party)).sort(byNick);
    return CHARS.filter(c => manual.has(c.id)).sort(byNick);
  }

  dlg.sub.textContent =
    'Короткое окно: только параметры. Запуск уйдёт в док справа внизу — страницу можно закрыть и заниматься другим.';
  dlg.body.innerHTML = `
    <div class="ql-field">
      <label for="ql-codes">Коды</label>
      <textarea class="input" id="ql-codes" rows="2" autocomplete="off" spellcheck="false">${escapeHtml(codesRaw)}</textarea>
      <div class="ql-code-chips" id="ql-chips"></div>
    </div>
    <div class="ql-field">
      <label>Кому</label>
      <div class="ql-seg" id="ql-seg" role="radiogroup" aria-label="Кому активировать коды">
        <button type="button" data-t="all">Все <b>${CHARS.length}</b></button>
        <button type="button" data-t="logged" class="is-on">С входом <b>${CHARS.filter(c => c.isLoggedIn === true).length}</b></button>
        <button type="button" data-t="party">Пати <b>${PARTIES.length}</b></button>
        <button type="button" data-t="manual">Вручную <b id="ql-manual-n">${manual.size}</b></button>
      </div>
      <div class="promo-list ql-manual" id="ql-parties" hidden></div>
      <div class="promo-list ql-manual" id="ql-manual" hidden></div>
    </div>
    <p class="ql-summary" id="ql-summary"></p>`;
  dlg.foot.innerHTML = `
    <button class="btn ghost" data-act="tune" title="В демо недоступно">⚙ Тонкая настройка</button>
    <button class="btn primary ql-go" data-act="go">▶ Запустить</button>`;

  const $ = id => dlg.body.querySelector('#' + id);

  function updateSummary() {
    const p = parseCodes(codesRaw);
    const chars = targetChars();
    const plan = planRows(p.codes, chars);
    $('ql-chips').innerHTML =
      p.codes
        .map(code => {
          const rec = FAKE_LOG.get(codeKey(code));
          return `<span class="ql-chip ${rec ? 'is-known' : ''}"><code>${escapeHtml(code)}</code>${rec ? ' ♻️' : ''}</span>`;
        })
        .join('') || '<span class="muted">кодов пока нет</span>';
    const eta = plan.jobs.length ? ` · ~${Math.max(1, Math.ceil((plan.jobs.length * 0.3) / 60))} мин` : '';
    $('ql-summary').innerHTML = p.codes.length
      ? `Запустим <b>${plan.jobs.length}</b> вводов у <b>${chars.length}</b> персонажей${plan.skipped.length ? ` · <b>${plan.skipped.length}</b> пропустим` : ''}${eta}`
      : 'Введите хотя бы один код';
    const go = dlg.foot.querySelector('[data-act="go"]');
    if (go) go.textContent = `▶ Запустить${plan.jobs.length ? ` · ${plan.jobs.length}` : ''}`;
    $('ql-manual-n').textContent = String(manual.size);
  }

  $('ql-parties').innerHTML = PARTIES.map(
    p =>
      `<label class="promo-item"><input type="checkbox" data-party="${escapeHtml(p)}" ${parties.has(p) ? 'checked' : ''}>
      <b>🛡 ${escapeHtml(p)}</b><span class="promo-muted promo-item-tags">${CHARS.filter(c => c.party === p).length} персонажей</span></label>`
  ).join('');
  $('ql-manual').innerHTML = [...CHARS]
    .sort(byNick)
    .map(
      c =>
        `<label class="promo-item"><input type="checkbox" data-mid="${escapeHtml(c.id)}" ${manual.has(c.id) ? 'checked' : ''}>
      <span class="promo-dot">${dot(c)}</span><b>${escapeHtml(c.nick)}</b></label>`
    )
    .join('');

  dlg.body.addEventListener('input', e => {
    if (e.target.id === 'ql-codes') {
      codesRaw = e.target.value;
      updateSummary();
    }
  });
  dlg.body.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-party]')) {
      if (t.checked) parties.add(t.dataset.party);
      else parties.delete(t.dataset.party);
      updateSummary();
    }
    if (t.matches('[data-mid]')) {
      if (t.checked) manual.add(t.dataset.mid);
      else manual.delete(t.dataset.mid);
      updateSummary();
    }
  });
  dlg.body.addEventListener('click', e => {
    const seg = e.target.closest('[data-t]');
    if (!seg) return;
    target = seg.dataset.t;
    $('ql-seg')
      .querySelectorAll('button')
      .forEach(b => b.classList.toggle('is-on', b === seg));
    $('ql-parties').hidden = target !== 'party';
    $('ql-manual').hidden = target !== 'manual';
    updateSummary();
  });

  dlg.foot.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'tune') return toast('Здесь открылась бы полная форма — как варианты 0 или B', 'info');
    if (act !== 'go') return;
    const p = parseCodes(codesRaw);
    if (!p.codes.length) return toast('Введите хотя бы один промокод', 'warning');
    const chars = targetChars();
    if (!chars.length) return toast('Выберите персонажей', 'warning');
    const plan = planRows(p.codes, chars);
    if (!plan.jobs.length) return toast('Все выбранные уже получили эти коды', 'info');
    dlg.close();
    openDock(p.codes, chars, plan);
  });

  updateSummary();
  return dlg;
}

/** Плавающий док: пилюля с прогрессом + раскрывающаяся панель хода работы. */
function openDock(codes, chars, plan) {
  document.querySelector('.ql-dock')?.remove(); // один док на демо
  const dock = el('div', 'ql-dock');
  dock.innerHTML = `
    <div class="ql-panel">
      <header>
        <b>🎁 Промокоды · <span id="ql-dock-state">в очереди</span></b>
        <span class="ql-panel-acts">
          <button type="button" class="btn ghost tiny" id="ql-stop" hidden>⏹ Стоп</button>
          <button type="button" class="icon-btn" id="ql-toggle" title="Свернуть">▾</button>
        </span>
      </header>
      <div class="ql-events" id="ql-events"></div>
      <div class="ql-panel-foot" id="ql-dock-foot"></div>
    </div>
    <button type="button" class="ql-pill" id="ql-pill" title="Промокоды — нажмите, чтобы развернуть/свернуть">
      <span class="ql-pill-ico" id="ql-pill-ico"><span class="ql-spin"></span></span>
      <span class="ql-pill-copy"><b>Промокоды</b><small id="ql-pill-sub">0 из ${plan.total}</small></span>
      <span class="ql-pill-bar"><i id="ql-pill-bar" style="width:0%"></i></span>
    </button>`;
  document.body.appendChild(dock);

  const $ = id => dock.querySelector('#' + id);
  const panel = dock.querySelector('.ql-panel');
  const signal = { cancelled: false };

  $('ql-toggle').onclick = () => {
    panel.hidden = !panel.hidden;
    $('ql-toggle').textContent = panel.hidden ? '▴' : '▾';
  };
  $('ql-pill').onclick = () => $('ql-toggle').click();
  $('ql-stop').onclick = e => {
    signal.cancelled = true;
    e.currentTarget.hidden = true;
  };

  function eventLine(row) {
    const info = statusInfo(row.status);
    const reward = row.rewards?.length ? ` · 🎁 ${rewardText(row.rewards)}` : '';
    const detail = row.detail ? ` — ${row.detail}` : row.status === 'error' ? ' — таймаут' : '';
    return `<div class="ql-event ql-${info.level}"><time>${hhmmss()}</time><span>${info.icon} <b>${escapeHtml(row.nick)}</b> ← <code>${escapeHtml(row.code)}</code>: ${escapeHtml(rowLabel(row))}${escapeHtml(detail)}${escapeHtml(reward)}</span></div>`;
  }

  function addEvents(rows) {
    const box = $('ql-events');
    rows.forEach(r => box.insertAdjacentHTML('beforeend', eventLine(r)));
    box.scrollTop = box.scrollHeight;
  }

  // Сразу показываем пропущенных по журналу
  $('ql-dock-state').textContent = 'идёт запуск';
  $('ql-stop').hidden = false;
  addEvents(plan.skipped);
  setPill(plan.skipped.length, plan.total);

  function setPill(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    $('ql-pill-sub').textContent = `${done} из ${total} · ${pct}%`;
    $('ql-pill-bar').style.width = `${pct}%`;
  }

  simulate(plan, {
    signal,
    onRow: (row, done, total) => {
      addEvents([row]);
      setPill(done, total);
    }
  }).then(rows => {
    const s = summarize(rows);
    const stopped = signal.cancelled;
    $('ql-dock-state').textContent = stopped ? 'остановлено' : 'готово';
    $('ql-stop').hidden = true;
    const pill = $('ql-pill');
    pill.classList.toggle('is-done', !stopped);
    pill.classList.toggle('is-stopped', stopped);
    $('ql-pill-ico').innerHTML = stopped ? '⏹' : s.failed ? '⚠️' : '✅';
    $('ql-pill-sub').textContent = stopped
      ? `Остановлено · введено ${s.entered}`
      : `Введено ${s.ok} из ${s.total}${s.failed ? ` · ошибок ${s.failed}` : ''}`;
    $('ql-pill-bar').style.width = '100%';
    $('ql-dock-foot').innerHTML = `
      ${resultChips(s, false)}
      <div class="ql-dock-btns">
        <button type="button" class="btn ghost small" id="ql-log">📜 Открыть журнал</button>
        ${
          rerunCharsOf(rows, chars).length
            ? `<button type="button" class="btn secondary small" id="ql-rerun">🔁 Повторить ошибки (${rerunCharsOf(rows, chars).length})</button>`
            : ''
        }
        <button type="button" class="btn ghost small" id="ql-dismiss">Скрыть</button>
      </div>`;
    $('ql-log').onclick = () => toast('В приложении здесь откроется журнал промокодов', 'info');
    const rerunBtn = $('ql-rerun');
    if (rerunBtn) {
      rerunBtn.onclick = () => {
        const again = rerunCharsOf(rows, chars);
        dock.remove();
        toast('Повторяем для тех, у кого не получилось…', 'info');
        openDock(codes, again, planRows(codes, again));
      };
    }
    $('ql-dismiss').onclick = () => dock.remove();
    toast(
      stopped
        ? `Промокоды остановлены: введено ${s.entered}`
        : `Промокоды: введено ${s.ok} из ${s.total}${s.failed ? `, ошибок ${s.failed}` : ''}`,
      stopped ? 'warning' : s.failed ? 'warning' : 'success',
      4200
    );
  });
}

/* ============================================================================ */
/* Вариант D · Консоль скриптов                                                  */
/* ============================================================================ */

function openConsole() {
  const dlg = openOverlay({ title: '⌨️ Консоль скриптов' });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('cn-container');
  const alive = () => dlg.el.isConnected;
  let running = null; // { signal, text, done, total }
  let lastCmd = '';

  dlg.sub.textContent =
    'Демо-консоль: команды выполняются локально на фейковых данных. Enter — выполнить, ↑ — прошлая команда.';
  dlg.body.innerHTML = `
    <div class="cn-log" id="cn-log" role="log" aria-live="polite"></div>
    <form class="cn-input-row" id="cn-form">
      <span class="cn-prompt">promo❯</span>
      <input class="cn-input" id="cn-in" autocomplete="off" spellcheck="false" aria-label="Команда консоли" placeholder="activate PWZNANIYA26 --target=logged">
    </form>`;
  dlg.foot.innerHTML = `
    <div class="cn-hints">
      <button type="button" class="btn ghost small" data-cmd="help">help</button>
      <button type="button" class="btn ghost small" data-cmd="activate PWZNANIYA26,PWMIZAR2026HB --target=logged">activate … (пример)</button>
      <button type="button" class="btn ghost small" data-cmd="status">status</button>
      <button type="button" class="btn ghost small" data-cmd="stop">stop</button>
      <button type="button" class="btn ghost small" data-cmd="clear">clear</button>
    </div>
    <span class="sd-foot-spacer"></span>
    <button type="button" class="btn ghost" data-act="close">✕ Закрыть</button>`;

  const log = dlg.body.querySelector('#cn-log');
  const input = dlg.body.querySelector('#cn-in');

  function print(text, cls = '') {
    const line = el('div', `cn-line ${cls}`.trim());
    line.innerHTML = `<time>${hhmmss()}</time><span>${text}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line.querySelector('span');
  }

  function welcome() {
    log.innerHTML = '';
    print('Твиноферма · консоль скриптов (демо)', 'cn-acc');
    print('help — список команд. Пример: <b>activate PWZNANIYA26,PWMIZAR2026HB --target=logged</b>', 'cn-dim');
  }

  function resolveTarget(value) {
    if (!value || value === 'all') return [...CHARS].sort(byNick);
    if (value === 'logged') return CHARS.filter(c => c.isLoggedIn === true).sort(byNick);
    if (value === 'none') return [];
    if (value.startsWith('party:')) {
      const name = value.slice(6);
      return CHARS.filter(c => c.party.toLowerCase() === name.toLowerCase()).sort(byNick);
    }
    // перечисление ников через «+»
    const nicks = value.split('+').map(s => s.trim().toLowerCase());
    return CHARS.filter(c => nicks.includes(String(c.nick).toLowerCase())).sort(byNick);
  }

  async function cmdActivate(args) {
    if (running) {
      print('Уже идёт запуск — дождитесь окончания или введите stop.', 'cn-warn');
      return;
    }
    const flags = args.filter(a => a.startsWith('--'));
    const codesRaw = args
      .filter(a => !a.startsWith('--'))
      .join(' ')
      .replace(/--codes=/, '');
    const p = parseCodes(codesRaw);
    const dry = flags.some(f => f === '--dry');
    const targetFlag = flags.find(f => f.startsWith('--target='))?.slice(9) || 'all';
    if (p.invalid.length) {
      print(`⚠ Не похоже на промокод: ${escapeHtml(p.invalid.join(', '))}`, 'cn-warn');
      return;
    }
    if (!p.codes.length) {
      print('Укажите коды: activate КОД1,КОД2 [--target=…] [--dry]', 'cn-warn');
      return;
    }
    const chars = resolveTarget(targetFlag);
    if (!chars.length) {
      print('Под фильтр --target никто не подошёл.', 'cn-warn');
      return;
    }
    const plan = planRows(p.codes, chars);
    print(
      `▶ ${dry ? 'Пробный запуск' : 'Запуск'}: коды [${p.codes.map(escapeHtml).join(', ')}] · персонажей ${chars.length} · вводов ${plan.jobs.length} · пропустим ${plan.skipped.length}`,
      'cn-acc'
    );
    plan.skipped.forEach(r =>
      print(
        `${statusInfo(r.status).icon} ${escapeHtml(r.nick)} ← ${escapeHtml(r.code)}: уже введён ранее — пропуск`,
        'cn-dim'
      )
    );

    const signal = { cancelled: false };
    const progressLine = print('', 'cn-progress');
    running = { signal, text: `activate ${p.codes.join(',')}`, done: plan.skipped.length, total: plan.total };
    const barText = (done, total) => {
      const pct = total > 0 ? done / total : 0;
      const filled = Math.round(pct * 24);
      return `[${'█'.repeat(filled)}${'░'.repeat(24 - filled)}] ${done}/${total}`;
    };
    progressLine.textContent = barText(plan.skipped.length, plan.total);

    const rows = await simulate(plan, {
      dry,
      signal,
      speed: 1.4,
      onRow: (row, done, total) => {
        if (!alive()) return;
        running.done = done;
        progressLine.textContent = `${barText(done, total)} · ${row.nick}`;
        const info = statusInfo(row.status);
        const cls =
          info.level === 'ok'
            ? 'cn-ok'
            : info.level === 'error'
              ? 'cn-err'
              : info.level === 'warn'
                ? 'cn-warn'
                : 'cn-dim';
        const reward = row.rewards?.length ? ` · 🎁 ${rewardText(row.rewards)}` : '';
        const detail = row.detail ? ` — ${row.detail}` : row.status === 'error' ? ' — таймаут' : '';
        print(
          `${info.icon} ${escapeHtml(row.nick)} ← ${escapeHtml(row.code)}: ${escapeHtml(rowLabel(row))}${escapeHtml(detail)}${escapeHtml(reward)}`,
          cls
        );
      }
    });
    running = null;
    if (!alive()) return;
    const s = summarize(rows);
    progressLine.textContent = `${barText(plan.total, plan.total)} ${signal.cancelled ? '— остановлено' : '— готово'}`;
    print('─'.repeat(46), 'cn-dim');
    print(
      dry
        ? `ИТОГ (пробный): кнопка найдена ${s.dry} из ${s.total}, проблем ${s.failed}`
        : `ИТОГ: введено ${s.entered}, уже были ${s.skipped + s.alreadyUsed}, отклонено ${s.invalid}, не распознано ${s.unknown}, ошибок ${s.failed}, не выполнено ${s.notRun}`,
      s.failed ? 'cn-warn' : 'cn-ok'
    );
    const rewards = rows.filter(r => r.rewards?.length);
    if (rewards.length) {
      const uniq = [...new Set(rewards.map(r => rewardText(r.rewards)))];
      print(`🎁 Награды: ${escapeHtml(uniq.join('; '))}`, 'cn-acc');
    }
    if (signal.cancelled) print('Введённое до остановки сохранено в журнал.', 'cn-dim');
  }

  function handle(line) {
    const trimmed = line.trim();
    print(`<span class="cn-cmdline">promo❯ ${escapeHtml(trimmed)}</span>`);
    if (!trimmed) return;
    lastCmd = trimmed;
    const [cmd, ...args] = trimmed.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'help':
        print('Команды:', 'cn-acc');
        print('  activate КОДЫ [--target=all|logged|none|party:ИМЯ|ник1+ник2] [--dry] — активировать промокоды', '');
        print('  status  — что выполняется сейчас', '');
        print('  stop    — остановить текущий запуск', '');
        print('  clear   — очистить экран', '');
        print(
          'Коды разделяйте запятой или пробелом. Пример: activate PWZNANIYA26,PWMIZAR2026HB --target=logged',
          'cn-dim'
        );
        break;
      case 'activate':
        void cmdActivate(args);
        break;
      case 'status':
        if (running) print(`Выполняется: ${escapeHtml(running.text)} · ${running.done}/${running.total}`, 'cn-acc');
        else print('Ничего не выполняется.', 'cn-dim');
        break;
      case 'stop':
        if (running) {
          running.signal.cancelled = true;
          print('Останавливаю: новые вводы не начинаются…', 'cn-warn');
        } else print('Нечего останавливать.', 'cn-dim');
        break;
      case 'clear':
        welcome();
        break;
      default:
        print(`Неизвестная команда: ${escapeHtml(cmd)}. Введите help.`, 'cn-err');
    }
  }

  dlg.body.querySelector('#cn-form').addEventListener('submit', e => {
    e.preventDefault();
    handle(input.value);
    input.value = '';
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && !input.value) {
      e.preventDefault();
      input.value = lastCmd;
    }
  });
  dlg.foot.addEventListener('click', e => {
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      handle(cmdBtn.dataset.cmd);
      input.focus();
      return;
    }
    if (e.target.closest('[data-act="close"]')) dlg.close();
  });

  welcome();
  input.focus();
  return dlg;
}

/* ============================================================================ */
/* Страница лаборатории                                                          */
/* ============================================================================ */

/** Копия сетки карточек «Инструменты» (данные — из js/modules/tools/index.js). */
function renderToolsReplica() {
  const box = document.getElementById('lab-tools-replica');
  if (!box) return;
  const checks = [
    { id: 'check-auth', ico: '🔐', label: 'Проверка входа', hint: 'Проверить вход у всех персонажей на сайте игры' },
    {
      id: 'update-balance',
      ico: '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg>',
      label: 'Балансы',
      hint: 'Обновить баланс Древних монет'
    },
    { id: 'update-marathons', ico: '🏃', label: 'Марафоны', hint: 'Сверить задания и прогресс на сайте' }
  ];
  const actions = [
    { id: 'promo', ico: '🎁', label: 'Промокод', hint: 'Активировать промокод на аккаунтах' },
    { id: 'transfer', ico: '📦', label: 'Передача', hint: 'Передать все предметы с сайта' },
    {
      id: 'shop',
      ico: '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg>',
      label: 'Подарки',
      hint: 'Купить подарки за Древние монеты'
    },
    { id: 'caravan', ico: '🧰', label: 'Сундук караванщика', hint: 'Открыть сундуки в инвентаре' }
  ];
  const card = s => `
    <button type="button" class="tools-card" data-replica="${escapeHtml(s.id)}" title="${escapeHtml(s.hint)}">
      <span class="tools-card-ico" aria-hidden="true">${s.ico}</span>
      <span class="tools-card-body"><b>${escapeHtml(s.label)}</b><small>${escapeHtml(s.hint)}</small></span>
    </button>`;
  box.innerHTML = `
    <div class="tools-block lab-replica">
      <div class="tools-group">
        <header class="tools-group-head"><h4>Проверки</h4><p class="muted">Окон не имеют: тост «запускаю…», работа, тост «завершено».</p></header>
        <div class="tools-grid tools-grid--check">${checks.map(card).join('')}</div>
      </div>
      <div class="tools-group">
        <header class="tools-group-head"><h4>Операции</h4><p class="muted">В демо каждая операция открывается в окне варианта B: слева настройка, справа сканирование и ход работы.</p></header>
        <div class="tools-grid tools-grid--action">${actions.map(card).join('')}</div>
      </div>
    </div>`;
  box.addEventListener('click', e => {
    const btn = e.target.closest('[data-replica]');
    if (!btn) return;
    const id = btn.dataset.replica;
    // По решению автора все операции открываются в варианте B (split)
    if (id === 'promo') return openSplit();
    if (id === 'transfer' || id === 'shop' || id === 'caravan') return openScenario(id);
    if (id === 'check-auth' || id === 'update-balance' || id === 'update-marathons') {
      return toast('У этих проверок отдельного окна пока нет: ход работы показывается в журнале задач.', 'info', 4200);
    }
  });
}

/** Сценарий, выбранный переключателем над карточкой: promo нарисован здесь, остальные — в scenarios.js. */
let currentScript = 'promo';

document.addEventListener('click', e => {
  const scriptBtn = e.target.closest('[data-script-pick]');
  if (scriptBtn) {
    currentScript = scriptBtn.dataset.scriptPick;
    document.querySelectorAll('[data-script-pick]').forEach(b => b.classList.toggle('is-on', b === scriptBtn));
    return;
  }
  const btn = e.target.closest('[data-open-variant]');
  if (!btn) return;
  if (btn.dataset.openVariant !== 'split') return;
  if (currentScript === 'promo') return openSplit();
  return openScenario(currentScript);
});

renderToolsReplica();
