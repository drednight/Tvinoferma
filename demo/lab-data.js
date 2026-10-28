// demo/lab-data.js
// Общие данные и помощники лаборатории окон: персонажи, пати, статусы строк,
// имитация запуска и выбор целей «кого запускать» — одинаковые для всех сценариев.
//
// Данные фейковые: персонажи вымышлены, ничего не уходит на сайт игры.

import { escapeHtml } from '../js/core/utils.js';
import { openCharacterPicker, classIconHtml, stripeCls, statusTitle } from './character-picker.js';

export { classIconHtml, stripeCls, statusTitle };

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

export const PARTIES = [...new Set(CHARS.map(c => c.party))];

/** Когда окна открываются из полной копии, используют текущий вымышленный состав демо. */
export function setLabRoster(characters, parties) {
  const names = new Map(parties.map(party => [party.id, party.name]));
  CHARS.splice(
    0,
    CHARS.length,
    ...characters.map((character, index) => ({
      id: character.id,
      nick: character.nick,
      cls: character.class || '',
      party: names.get(character.mainPartyId) || '',
      account: `site-${(index % 5) + 1}`,
      isLoggedIn: character.isLoggedIn === true,
      checking: character.checking === true
    }))
  );
  PARTIES.splice(0, PARTIES.length, ...new Set(parties.map(party => party.name)));
}

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
// «По пати» показывает список пати, а ручной выбор открывает отдельное окно.
// Пока окно не сохранено, режим и выбранные персонажи родительского плана не меняются.

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
    <label class="sp-radio"><input type="radio" name="tg-${idp}" value="manual" ${on('manual')}><span>🖐 Выбрать вручную</span><small>открыть выбор персонажей</small></label>
  </div>`;
}

/** Список пати остаётся в родительском окне; для ручного выбора видна только сводка. */
export function targetListsHtml(t, idp) {
  const parties = PARTIES.map(
    p =>
      `<label class="promo-item"><input type="checkbox" data-party="${escapeHtml(p)}" ${t.parties.has(p) ? 'checked' : ''}>
      <b>🛡 ${escapeHtml(p)}</b><span class="promo-muted promo-item-tags">${CHARS.filter(c => c.party === p).length} персонажей</span></label>`
  ).join('');
  return `
    <div class="promo-list sp-manual" data-tg-parties="${idp}" hidden>${parties}</div>
    <div class="sp-manual-summary" data-tg-manual="${idp}" hidden>
      <span>Выбрано: <b data-tg-count>${t.chars.size}</b></span>
      <button type="button" class="btn small ghost" data-tg-edit="${idp}">Изменить</button>
    </div>`;
}

export const targetHtml = (t, idp) => targetRadiosHtml(t, idp) + targetListsHtml(t, idp);

// Если родительское окно закрыто программно, вложенный выбор не должен остаться поверх страницы.
const activePickers = new WeakMap();
export function closeTargetPicker(root) {
  activePickers.get(root)?.close();
}

/** Привязать режимы и атомарный ручной выбор; слушатели сохраняются при перерисовке панели. */
export function bindTarget(root, t, idp, onChange) {
  const sync = () => {
    const partiesBox = root.querySelector(`[data-tg-parties="${idp}"]`);
    const manualBox = root.querySelector(`[data-tg-manual="${idp}"]`);
    if (partiesBox) partiesBox.hidden = t.mode !== 'party';
    if (manualBox) {
      manualBox.hidden = t.mode !== 'manual';
      manualBox.querySelector('[data-tg-count]').textContent = String(t.chars.size);
    }
    root.querySelectorAll(`input[name="tg-${idp}"]`).forEach(radio => {
      radio.checked = radio.value === t.mode;
    });
  };
  sync();
  const boundKey = `tgBound${idp}`;
  if (root.dataset[boundKey]) return sync;
  root.dataset[boundKey] = 'true';

  const chooseCharacters = origin => {
    if (activePickers.get(root)?.el.isConnected) return;
    const picker = openCharacterPicker({
      characters: CHARS,
      selected: t.chars,
      parent: root.closest('.modal-overlay'),
      returnFocus: origin,
      onClose: selection => {
        activePickers.delete(root);
        if (!root.isConnected) return;
        if (selection !== null) {
          t.mode = 'manual';
          t.chars.clear();
          selection.forEach(id => t.chars.add(id));
          sync();
          onChange?.();
        } else sync();
      }
    });
    activePickers.set(root, picker);
  };

  root.addEventListener('click', e => {
    const edit = e.target.closest?.(`[data-tg-edit="${idp}"]`);
    const manual = e.target.closest?.(`input[name="tg-${idp}"][value="manual"]`);
    // Повторное нажатие на уже выбранное радио тоже открывает выбор.
    if (edit || (manual && t.mode === 'manual')) chooseCharacters(edit || manual);
  });
  root.addEventListener('change', e => {
    const radio = e.target.closest?.(`input[name="tg-${idp}"]`);
    if (radio) {
      if (radio.value === 'manual') {
        // До сохранения оставляем прежний режим и план нетронутыми.
        sync();
        chooseCharacters(radio);
      } else {
        t.mode = radio.value;
        sync();
        onChange?.();
      }
      return;
    }
    if (e.target.matches?.('[data-party]')) {
      if (e.target.checked) t.parties.add(e.target.dataset.party);
      else t.parties.delete(e.target.dataset.party);
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
