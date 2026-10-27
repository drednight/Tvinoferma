// demo/lab-data.js
// Общие данные и помощники лаборатории окон: персонажи, пати, статусы строк,
// имитация запуска и выбор целей «кого запускать» — одинаковые для всех сценариев.
//
// Данные фейковые: персонажи вымышлены, ничего не уходит на сайт игры.

import { escapeHtml } from '../js/core/utils.js';
import { getClassIconSrc } from '../js/core/constants.js';

// account — вымышленный аккаунт сайта: у нескольких персонажей может быть общий
// инвентарь и баланс. checking — идёт проверка входа на сайт (не статус окна игры).
export const CHARS = [
  { id: 'c1', nick: 'Звеномир', cls: 'Воин', party: 'Альфа', account: 'site-1', isLoggedIn: true },
  { id: 'c2', nick: 'Тихомир', cls: 'Маг', party: 'Альфа', account: 'site-1', isLoggedIn: true },
  { id: 'c3', nick: 'Радовика', cls: 'Лучник', party: 'Браво', account: 'site-2', isLoggedIn: false },
  { id: 'c4', nick: 'Светолика', cls: 'Жрец', party: 'Альфа', account: 'site-3', isLoggedIn: true },
  { id: 'c5', nick: 'Братислав', cls: 'Воин', party: 'Браво', account: 'site-4', isLoggedIn: true, checking: true },
  { id: 'c6', nick: 'Милослава', cls: 'Маг', party: 'Браво', account: 'site-3', isLoggedIn: true },
  { id: 'c7', nick: 'Горыня', cls: 'Оборотень', party: 'Альфа', account: 'site-5', isLoggedIn: false },
  { id: 'c8', nick: 'Ярополк', cls: 'Паладин', party: 'Браво', account: 'site-5', isLoggedIn: true }
];

/** Визуальные состояния как у карточек: это вход на сайт, не статус игры. */
export const stripeCls = c => `st-${c.checking ? 'checking' : c.isLoggedIn === true ? 'online' : 'offline'}`;
export const statusTitle = c =>
  c.checking ? 'Проверка входа на сайт' : c.isLoggedIn === true ? 'Есть вход на сайт' : 'Нет входа на сайт';
export function classIconHtml(c) {
  const src = getClassIconSrc(c.cls);
  return src
    ? `<img class="char-class-ico" src="../${escapeHtml(src)}" alt="${escapeHtml(c.cls)}" title="${escapeHtml(c.cls)}">`
    : `<span class="char-class-ico char-class-letter" title="${escapeHtml(c.cls)}">${escapeHtml(c.cls?.[0] || '?')}</span>`;
}

export const PARTIES = [...new Set(CHARS.map(c => c.party))];

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];
export const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
export const dot = c => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
export const hhmmss = (d = new Date()) => d.toLocaleTimeString('ru-RU', { hour12: false });
export const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/* ============================== строки и статусы ============================== */

/** Статусы строк всех сценариев: иконка, тон и короткая подпись. */
export const STATUS = {
  ok: { icon: '✅', level: 'ok', label: 'Готово' },
  dry_run: { icon: '👁', level: 'info', label: 'Найдено, не нажато' },
  rare: { icon: '💎', level: 'ok', label: 'Редкая находка' },
  partial: { icon: '⚠️', level: 'warn', label: 'Частично' },
  poor: { icon: '🪙', level: 'warn', label: 'Не хватает монет' },
  already: { icon: '♻️', level: 'muted', label: 'Уже есть' },
  empty: { icon: '📭', level: 'muted', label: 'Пусто' },
  skip: { icon: '⏭', level: 'muted', label: 'Пропуск' },
  not_logged_in: { icon: '🔴', level: 'warn', label: 'Нет входа' },
  challenge: { icon: '🛡', level: 'warn', label: 'Проверка безопасности' },
  error: { icon: '❌', level: 'error', label: 'Ошибка' },
  cancelled: { icon: '⏹', level: 'muted', label: 'Не выполнено' }
};

export const statusMeta = s => STATUS[s] || { icon: '❔', level: 'muted', label: s || '—' };

/** Строки, которые «Повторить ошибки» запустит снова. */
export const isRerunnableRow = r => ['error', 'challenge', 'not_logged_in', 'partial', 'poor'].includes(r.status);

export function rowOf(ch, unitKey, status, detail = '', extra = {}) {
  return { charId: ch.id, nick: ch.nick, unitKey, status, detail, ...extra };
}

/**
 * «Запуск»: строки появляются по одной с паузами; skipped уже лежат в плане.
 * signal.cancelled обрывает поток — остаток получает статус «cancelled», как в приложении.
 * makeRow(job, { dry, ctx }) возвращает строку результата; job = { ch, unit, … },
 * ctx — общий контекст плана (plan.ctx), например балансы монет, которые тратятся по ходу.
 */
export async function runPlan(plan, makeRow, { dry = false, signal = null, onRow = null, speed = 1 } = {}) {
  const rows = [...plan.skipped];
  const cancelRest = (from, into) => {
    for (let j = from; j < plan.jobs.length; j++) {
      const job = plan.jobs[j];
      into.push({ ...rowOf(job.ch, job.unit.key, 'cancelled'), unit: job.unit });
    }
  };
  for (let i = 0; i < plan.jobs.length; i++) {
    if (signal?.cancelled) {
      cancelRest(i, rows);
      break;
    }
    await sleep(rand(140, 380) / speed);
    if (signal?.cancelled) {
      cancelRest(i, rows);
      break;
    }
    const job = plan.jobs[i];
    const row = makeRow(job, { dry, ctx: plan.ctx });
    row.unit = job.unit;
    rows.push(row);
    onRow?.(row, rows.length, plan.total);
  }
  return rows;
}

/* ============================== таблица хода работы ============================== */

/** Таблица «персонажи × единицы сценария»: план, ход и итог живут в одних и тех же ячейках. */
export function gridTableHtml(units, chars, byKey, cellFn) {
  return `<div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th>${units
    .map(u => `<th title="${escapeHtml(u.label)}">${u.icon} ${escapeHtml(u.short || u.label)}</th>`)
    .join('')}</tr></thead><tbody>${[...chars]
    .sort(byNick)
    .map(
      ch =>
        `<tr class="${stripeCls(ch)}" title="${escapeHtml(statusTitle(ch))}"><td><b>${classIconHtml(ch)} ${escapeHtml(ch.nick)}</b></td>${units
          .map(u => {
            const row = byKey.get(`${ch.id}|${u.key}`);
            return `<td data-cell="${escapeHtml(ch.id)}|${escapeHtml(u.key)}">${cellFn(row, u)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('')}</tbody></table></div>`;
}

export const byKeyOfRows = rows => new Map(rows.filter(Boolean).map(r => [`${r.charId}|${r.unitKey}`, r]));

/** Ячейка таблицы сценария: «в очереди» → «в плане» → статус с подсказкой. */
export function gridCellHtml(row) {
  if (!row) return '<span class="promo-muted">⏳ в очереди</span>';
  if (row.planned) return '<span class="promo-muted">· в плане</span>';
  const meta = statusMeta(row.status);
  const label = row.short || meta.label;
  const tip = [label, row.detail].filter(Boolean).join(' — ');
  const cls = row.status === 'rare' ? ' class="sc-rare"' : '';
  return `<span${cls} title="${escapeHtml(tip)}">${meta.icon} ${escapeHtml(label)}</span>`;
}

/** Строка события для дока и консоли: время, персонаж, единица сценария и результат. */
export function eventLineHtml(row) {
  const meta = statusMeta(row.status);
  const unit = row.unit ? `${escapeHtml(row.unit.icon || '')} ${escapeHtml(row.unit.label)}: ` : '';
  const label = row.short && row.short !== meta.label ? `${meta.label} (${row.short})` : meta.label;
  const detail = row.detail
    ? ` — ${escapeHtml(row.detail)}`
    : row.status === 'error'
      ? ' — таймаут: сайт не ответил'
      : '';
  return `${meta.icon} <b>${escapeHtml(row.nick)}</b> · ${unit}${escapeHtml(label)}${detail}`;
}

/* ============================== кого запускать ============================== */
// Правило лаборатории (оно же правило приложения): список персонажей появляется,
// только когда выбран «Выбрать вручную», а «По пати» даёт список пати — так же,
// как список персонажей, отметками.

export function defaultTarget() {
  return {
    mode: 'logged', // logged | all | party | manual
    parties: new Set([PARTIES[0]]),
    chars: new Set(CHARS.filter(c => c.isLoggedIn === true).map(c => c.id))
  };
}

export function targetChars(t) {
  if (t.mode === 'all') return [...CHARS].sort(byNick);
  if (t.mode === 'party') return CHARS.filter(c => t.parties.has(c.party)).sort(byNick);
  if (t.mode === 'manual') return CHARS.filter(c => t.chars.has(c.id)).sort(byNick);
  return CHARS.filter(c => c.isLoggedIn === true).sort(byNick);
}

/** Радиогруппа «Кого запускать». */
export function targetRadiosHtml(t, idp) {
  const nLogged = CHARS.filter(c => c.isLoggedIn === true).length;
  const on = m => (t.mode === m ? 'checked' : '');
  return `<div class="sp-radios">
    <label class="sp-radio"><input type="radio" name="tg-${idp}" value="logged" ${on('logged')}><span>🟢 Только с входом</span><small>${nLogged} персонажей</small></label>
    <label class="sp-radio"><input type="radio" name="tg-${idp}" value="all" ${on('all')}><span>👥 Все</span><small>${CHARS.length} персонажей</small></label>
    <label class="sp-radio"><input type="radio" name="tg-${idp}" value="party" ${on('party')}><span>🛡 По пати…</span><small>${PARTIES.length} пати на выбор</small></label>
    <label class="sp-radio"><input type="radio" name="tg-${idp}" value="manual" ${on('manual')}><span>🖐 Выбрать вручную</span><small>отметить в списке</small></label>
  </div>`;
}

/** Списки пати и персонажей; виден только тот, что соответствует режиму. */
export function targetListsHtml(t, idp) {
  const parties = PARTIES.map(
    p =>
      `<label class="promo-item"><input type="checkbox" data-party="${escapeHtml(p)}" ${t.parties.has(p) ? 'checked' : ''}>
      <b>🛡 ${escapeHtml(p)}</b><span class="promo-muted promo-item-tags">${CHARS.filter(c => c.party === p).length} персонажей</span></label>`
  ).join('');
  const chars = [...CHARS]
    .sort(byNick)
    .map(
      c =>
        `<label class="promo-item ${stripeCls(c)}" title="${escapeHtml(statusTitle(c))}"><input type="checkbox" data-mid="${escapeHtml(c.id)}" ${t.chars.has(c.id) ? 'checked' : ''}>
      ${classIconHtml(c)}<b>${escapeHtml(c.nick)}</b><span class="promo-muted promo-item-tags">${escapeHtml(c.party)} · ${escapeHtml(c.cls)}</span></label>`
    )
    .join('');
  return `
    <div class="promo-list sp-manual" data-tg-parties="${idp}" hidden>${parties}</div>
    <div class="promo-list sp-manual" data-tg-manual="${idp}" hidden>${chars}</div>`;
}

export const targetHtml = (t, idp) => targetRadiosHtml(t, idp) + targetListsHtml(t, idp);

/**
 * Привязка выбора целей: радио переключают режим, отметки пати и персонажей
 * обновляют набор. Слушатель на root ставится один раз (перерисовка тела окна
 * не должна плодить копии), видимость списков синхронизируется при каждом вызове.
 * Возвращает функцию синхронизации видимости.
 */
export function bindTarget(root, t, idp, onChange) {
  const sync = () => {
    const partiesBox = root.querySelector(`[data-tg-parties="${idp}"]`);
    const manualBox = root.querySelector(`[data-tg-manual="${idp}"]`);
    if (partiesBox) partiesBox.hidden = t.mode !== 'party';
    if (manualBox) manualBox.hidden = t.mode !== 'manual';
  };
  sync();
  const boundKey = `tgBound${idp}`;
  if (root.dataset[boundKey]) return sync;
  root.dataset[boundKey] = 'true';
  root.addEventListener('change', e => {
    const radio = e.target.closest?.(`input[name="tg-${idp}"]`);
    if (radio) {
      t.mode = radio.value;
      sync();
      onChange?.();
      return;
    }
    if (e.target.matches?.('[data-party]')) {
      if (e.target.checked) t.parties.add(e.target.dataset.party);
      else t.parties.delete(e.target.dataset.party);
      onChange?.();
      return;
    }
    if (e.target.matches?.('[data-mid]')) {
      if (e.target.checked) t.chars.add(e.target.dataset.mid);
      else t.chars.delete(e.target.dataset.mid);
      onChange?.();
    }
  });
  return sync;
}

/** Персонажи, которых «Повторить ошибки» запустит снова. */
export function rerunCharsOfRows(rows) {
  const ids = new Set(rows.filter(isRerunnableRow).map(r => r.charId));
  return CHARS.filter(c => ids.has(c.id));
}
