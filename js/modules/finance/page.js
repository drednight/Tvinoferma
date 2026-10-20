// js/modules/finance/page.js
// Раздел «Банк»: приход и расход, комиссионка и голд.
//
// Один экран без вкладок: сверху KPI (что есть сейчас), ниже журнал выбранного
// месяца (месяцы списком слева), внизу — комиссионка и долги двумя колонками.
// Комиссионка, голд и долги не хранят деньги отдельно: каждый пишет в общий
// реестр, иначе «остаток» перестанет сходиться с суммой строк.
//
// Считает всё модель (finance/model.js) — здесь только разметка и обработчики.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml, uid } from '../../core/utils.js';
import { showModal, toast, confirmModal } from '../../core/ui.js';
import {
  CURRENCIES, CURRENCY_IDS, DEFAULT_CURRENCY, DEFAULT_COMMISSION_PCT,
  money, roundFor, formatAmount, todayIso, normalizeFinance, currentBalances,
  groupByMonth, shopTotals, shopItemTotal, findShopItem, shopDealOperation,
  goldDeal, goldDealOperations, commissionLossPct,
  loanStatus, loanOperation, paymentSplit, spanLabel
} from './model.js';

const root = () => document.getElementById('finance-root');

const SOURCE_LABEL = { manual: 'Ручные', shop: 'Комиссионка', gold: 'Голд', debt: 'Долг' };
const KIND_LABEL = { in: 'Получил', out: 'Потратил' };

// Выбранный месяц и фильтры журнала. Живут в модуле: перерисовка их сохраняет.
let selected = null;
let query = '';
let sourceFilter = null;
let currencyFilter = null;
let showBalance = true;
/** id записи → нарастающий остаток по валюте (считается снизу вверх). */
let balMap = {};

/** Раздел всегда приведён к схеме: иначе битый state.json уронил бы отрисовку. */
function fin() {
  if (!state.finance) state.finance = normalizeFinance(undefined);
  return state.finance;
}

/** Сохранить и перерисовать. Нормализация перед записью — state.json не должен копить мусор. */
function save() {
  state.finance = normalizeFinance(state.finance);
  persist().catch(e => console.error('[FINANCE] save failed', e));
  renderFinance();
}

/**
 * Число для показа. Золото округляется до целых, Голд оставляет копейки — иначе в
 * интерфейсе и в реестре были бы разные числа. Валюту по умолчанию берём Золото,
 * потому что почти все суммы в разделе — золотые.
 */
function fmt(value, currency = DEFAULT_CURRENCY) {
  return formatAmount(currency, value);
}

function cur(id) {
  return CURRENCIES[id] || CURRENCIES[DEFAULT_CURRENCY];
}

/** Поле формы → число. `\s` в JS покрывает и неразрывный пробел, поэтому «1 000» и «1,5»
 *  читаются одинаково. Пустая строка даёт 0, а не NaN: иначе в итог уехал бы NaN. */
function num(value) {
  const n = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function str(value) {
  return String(value ?? '').trim();
}

/** «+1 000» / «−250» — для итогов и нарастающего остатка. */
function signed(value, currency = DEFAULT_CURRENCY) {
  return `${value >= 0 ? '+' : '−'}${fmt(Math.abs(value), currency)}`;
}

/** Сумма списка по валюте: без валюты складываем только золото (основную). */
function sumFor(list, ccy) {
  return list
    .filter(o => !ccy || o.currency === ccy)
    .reduce((a, o) => a + (o.kind === 'in' ? o.amount : -o.amount), 0);
}

/** Цвет плитки из названия: одинаковые предметы всегда одного цвета. */
function hueOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Виджет «поле + подпись» для модальных форм. */
function field(label, name, value, opts = {}) {
  const { type = 'text', step, min, placeholder = '', required = false } = opts;
  return `
    <label class="fin-field">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" name="${name}" value="${escapeHtml(value)}"
             ${step ? `step="${step}"` : ''} ${min !== undefined ? `min="${min}"` : ''}
             placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''} />
    </label>`;
}

function selectField(label, name, value, options) {
  return `
    <label class="fin-field">
      <span>${escapeHtml(label)}</span>
      <select name="${name}">
        ${options.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
    </label>`;
}

function textField(label, name, value, placeholder = '') {
  return `
    <label class="fin-field fin-field-wide">
      <span>${escapeHtml(label)}</span>
      <input type="text" name="${name}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
    </label>`;
}

/** Сколько сейчас должны тебе и сколько должен ты — по каждой валюте. */
function loanExposure() {
  /** @type {Record<string, number>} */
  const out = {};
  for (const loan of fin().loans) {
    const id = loan.currency || DEFAULT_CURRENCY;
    const st = loanStatus(loan);
    if (st.settled) continue;
    out[id] = roundFor(id, (out[id] || 0) + (loan.direction !== 'borrowed' ? st.total : -st.total));
  }
  return out;
}

/**
 * Полоса «сколько сейчас в наличии» — ответ на вопрос «сколько у меня денег».
 * Показывается в форме сделки с голдом.
 */
function balancesRow() {
  const now = currentBalances(fin());
  const debt = loanExposure();
  return `
    <div class="fin-holdings">
      ${CURRENCY_IDS.map(id => `
        <span class="fin-holding ${now[id] < 0 ? 'fin-out' : ''}">
          ${cur(id).icon} ${escapeHtml(cur(id).title)}: <b>${fmt(now[id], id)}</b>
          ${debt[id] ? `<small class="fin-holding-debt">из них в долгах ${fmt(debt[id], id)}</small>` : ''}
        </span>`).join('')}
    </div>`;
}

// ── KPI-панели ─────────────────────────────────────────────────────────────

/**
 * Итог месяца без переноса: сколько заработали/потратили ЗА этот месяц.
 * `totals` уже включает перенос прошлого месяца (колонка «Банк»), а он не
 * заработан в этом месяце — поэтому вычитаем.
 */
function netOf(month, currency = DEFAULT_CURRENCY) {
  if (!month) return 0;
  const carry = Number(fin().settings.monthCarry?.[month.month]?.[currency]) || 0;
  return month.totals[currency].balance - carry;
}

/** Верх страницы: сколько есть сейчас, сколько должны, что на складе. */
function panels() {
  const { operations, loans, shopItems, settings } = fin();
  const now = currentBalances(fin());
  const months = groupByMonth(operations, settings.monthAdjust);
  const first = months[0];
  const totals = shopTotals(shopItems);
  const lent = loans.filter(l => l.direction !== 'borrowed');
  const borrowed = loans.filter(l => l.direction === 'borrowed');
  const sum = (list) => list.reduce((s, l) => s + loanStatus(l).total, 0);
  return `
    <div class="pans">
      ${CURRENCY_IDS.map(id => `
        <div class="pan">
          <span class="pan-label">${cur(id).icon} ${escapeHtml(cur(id).title)}</span>
          <span class="pan-value ${now[id] < 0 ? 'fin-out' : ''}">${fmt(now[id], id)}</span>
          <span class="pan-sub">за ${escapeHtml(first ? first.label : '—')} ${signed(netOf(first, id), id)}</span>
        </div>`).join('')}
      <div class="pan">
        <span class="pan-label">🤝 Долги</span>
        ${loans.length
          ? `<span class="pan-row"><span>должны вернуть</span><b class="fin-in">${fmt(sum(lent))}</b></span>
             <span class="pan-row"><span>я должен</span><b class="fin-out">${fmt(sum(borrowed))}</b></span>`
          : '<span class="pan-value fin-in">нет</span>'}
      </div>
      <div class="pan">
        <span class="pan-label">🏪 Комиссионка</span>
        <span class="pan-row"><span>продаю</span><b>${fmt(totals.sell.sum)}</b></span>
        <span class="pan-row"><span>покупаю</span><b>${fmt(totals.buy.sum)}</b></span>
      </div>
    </div>`;
}

// ── Месяцы ─────────────────────────────────────────────────────────────────

/** Список месяцев слева: клик выбирает месяц, активный подсвечен. */
function monthsList() {
  const months = groupByMonth(fin().operations, fin().settings.monthAdjust);
  // В списке — итог ЗА месяц (без переноса прошлого): по нему видно, в плюсе месяц или нет.
  return `
    <div class="months-list">
      ${months.map(m => `
        <button type="button" class="month-item ${m.month === selected ? 'active' : ''}" data-month="${m.month}">
          <b>${escapeHtml(m.label)}</b>
          <span class="mi-sum">
            ${CURRENCY_IDS.map(id => `<span class="${netOf(m, id) < 0 ? 'fin-out' : 'fin-in'}">${signed(netOf(m, id), id)}</span>`).join('<br>')}
          </span>
          <small>${m.operations.length} записей</small>
        </button>`).join('')}
    </div>`;
}

function operationRow(op) {
  const isIn = op.kind === 'in';
  // Голд-сделка — обмен валюты, а не расход: отдельная метка, чтобы не путать
  // «покупку голда за золото» с обычными тратами.
  const chip = op.source === 'gold'
    ? '<span class="fin-chip is-conv">Конвертация</span>'
    : `<span class="fin-chip ${isIn ? 'is-in' : 'is-out'}">${KIND_LABEL[op.kind]}</span>`;
  return `
    <tr class="fin-row">
      <td class="fin-date">${escapeHtml(op.date.slice(8))}.${escapeHtml(op.date.slice(5, 7))}</td>
      <td class="fin-kind">
        ${chip}
        ${SOURCE_LABEL[op.source] ? `<span class="fin-source">${escapeHtml(SOURCE_LABEL[op.source])}</span>` : ''}
      </td>
      <td class="fin-what">
        <b>${escapeHtml(op.counterparty || '—')}</b>
        ${op.note ? `<small class="muted">${escapeHtml(op.note)}</small>` : ''}
      </td>
      <td class="fin-amount ${isIn ? 'fin-in' : 'fin-out'}">${isIn ? '+' : '−'}${fmt(op.amount, op.currency)} <small class="muted">${escapeHtml(cur(op.currency).short)}</small></td>
      ${showBalance ? `<td class="fin-num ${balMap[op.id] < 0 ? 'fin-out' : 'fin-in'}">${signed(balMap[op.id], op.currency)}</td>` : ''}
      <td class="fin-actions">
        <button type="button" class="btn ghost small fin-icon" data-fin-act="edit-op" data-id="${escapeHtml(op.id)}" title="Изменить">✏️</button>
        <button type="button" class="btn ghost small fin-icon" data-fin-act="del-op" data-id="${escapeHtml(op.id)}" title="Удалить">🗑️</button>
      </td>
    </tr>`;
}

/** Правая колонка: инструменты фильтра и журнал выбранного месяца в рамке. */
function monthOpen() {
  const months = groupByMonth(fin().operations);
  const sel = months.find(m => m.month === selected);
  if (!sel) return '<div class="month-right"><p class="fin-empty">Записей пока нет. Нажмите «Записать движение».</p></div>';

  const q = query.trim().toLowerCase();
  let list = sel.operations;
  if (sourceFilter) list = list.filter(o => o.source === sourceFilter);
  if (currencyFilter) list = list.filter(o => o.currency === currencyFilter);
  if (q) list = list.filter(o =>
    (o.counterparty || '').toLowerCase().includes(q) || (o.note || '').toLowerCase().includes(q));

  // «Итог» считаем снизу вверх по порядку строк: нижняя строка — первое действие,
  // каждая следующая сверху добавляет к ней. Так видно, как копился остаток.
  const acc = {};
  for (let i = list.length - 1; i >= 0; i--) {
    const op = list[i];
    acc[op.currency] = (acc[op.currency] || 0) + (op.kind === 'in' ? op.amount : -op.amount);
    balMap[op.id] = acc[op.currency];
  }

  const anyFilter = sourceFilter || currencyFilter || q;
  const sumCcy = currencyFilter || DEFAULT_CURRENCY;
  const head = showBalance ? '<th class="fin-num">Итог</th>' : '';
  const empty = list.length
    ? ''
    : `<tr><td colspan="${showBalance ? 5 : 4}"><p class="fin-empty">Ничего не найдено по текущим фильтрам.</p></td></tr>`;

  return `
    <div class="month-right">
      <div class="month-tools">
        <div class="chips">
          <span class="chips-label">Источник:</span>
          <button type="button" class="chip-btn ${sourceFilter === null ? 'active' : ''}" data-source="">Все</button>
          ${Object.keys(SOURCE_LABEL).map(k => `<button type="button" class="chip-btn ${sourceFilter === k ? 'active' : ''}" data-source="${k}">${escapeHtml(SOURCE_LABEL[k])}</button>`).join('')}
        </div>
        <div class="chips">
          <span class="chips-label">Валюта:</span>
          <button type="button" class="chip-btn ${currencyFilter === null ? 'active' : ''}" data-currency="">Обе</button>
          ${CURRENCY_IDS.map(id => `<button type="button" class="chip-btn ${currencyFilter === id ? 'active' : ''}" data-currency="${id}">${escapeHtml(cur(id).short)}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <label class="check"><input type="checkbox" data-balance ${showBalance ? 'checked' : ''} /> Итог</label>
      </div>
      ${anyFilter ? `
        <div class="filter-bar">
          <span class="muted">Показано:</span>
          ${sourceFilter ? `<span class="filter-chip">${escapeHtml(SOURCE_LABEL[sourceFilter])}<button type="button" data-clear-source>×</button></span>` : ''}
          ${currencyFilter ? `<span class="filter-chip">${escapeHtml(cur(currencyFilter).title)}<button type="button" data-clear-currency>×</button></span>` : ''}
          ${q ? `<span class="filter-chip">«${escapeHtml(query)}»<button type="button" data-clear-query>×</button></span>` : ''}
          <span class="muted">${list.length} записей · ${signed(sumFor(list, currencyFilter), sumCcy)}</span>
        </div>` : ''}
      <h3 class="block-h">${escapeHtml(sel.label)} · ${list.length} записей</h3>
      <div class="month-body">
        <div class="fin-table-wrap">
          <table class="fin-table">
            <thead><tr><th>Дата</th><th>Вид</th><th>Откуда / на что</th><th class="fin-num">Сумма</th>${head}</tr></thead>
            <tbody>${list.map(operationRow).join('')}${empty}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ── Комиссионка ────────────────────────────────────────────────────────────

function shopSide(side) {
  const isSell = side === 'sell';
  const items = fin().shopItems.filter(i => (i.side === 'buy') === !isSell);
  const totals = shopTotals(fin().shopItems);
  const sum = isSell ? totals.sell : totals.buy;
  const qty = items.reduce((a, i) => a + i.qty, 0);
  const cells = items.slice(0, 20).map(i => `
    <div class="slot is-filled" style="--hue: ${hueOf(i.name)}"
         title="${escapeHtml(i.name)} — ${fmt(i.qty)} шт. по ${fmt(i.price)}"
         data-fin-act="deal-item" data-id="${escapeHtml(i.id)}">
      <span class="slot-name">${escapeHtml(i.name)}</span>
      <span class="slot-qty">×${fmt(i.qty)}</span>
      <span class="slot-acts">
        <button type="button" class="slot-btn" data-fin-act="edit-item" data-id="${escapeHtml(i.id)}" title="Изменить">✏️</button>
        <button type="button" class="slot-btn" data-fin-act="del-item" data-id="${escapeHtml(i.id)}" title="Убрать">🗑️</button>
      </span>
    </div>`).join('')
    + `<button type="button" class="slot is-empty" data-fin-act="add-item" data-side="${side}" title="Добавить предмет">+</button>`.repeat(Math.max(0, 20 - items.length));
  return `
    <div class="shop-side">
      <div class="shop-side-head"><h4>${isSell ? 'Продажа' : 'Покупка'}</h4></div>
      <div class="slots">${cells}</div>
      <div class="shop-side-foot">
        <span class="muted">${items.length} предм. · ${fmt(qty)} шт.</span>
        <b class="${isSell ? 'fin-in' : 'fin-out'}">${isSell ? '+' : '−'}${fmt(sum.sum)} ${escapeHtml(cur(DEFAULT_CURRENCY).short)}</b>
      </div>
    </div>`;
}

function shopBlock() {
  return `<div class="shop-grid">${shopSide('sell')}${shopSide('buy')}</div>`;
}

// ── Долги ──────────────────────────────────────────────────────────────────

function loanCard(loan) {
  const st = loanStatus(loan);
  const lent = loan.direction !== 'borrowed';
  // Долг живёт в своей валюте, поэтому и суммы в карточке округляются под неё
  const ccy = loan.currency || DEFAULT_CURRENCY;
  const n = (v) => fmt(v, ccy);
  const pct = st.principal > 0 ? Math.min(100, Math.round(st.paid / st.principal * 100)) : 0;
  return `
    <div class="fin-loan ${lent ? 'is-lent' : 'is-borrowed'}">
      <div class="fin-loan-main">
        <div class="fin-loan-title">
          <span class="fin-chip ${lent ? 'is-in' : 'is-out'}">${lent ? 'Дано' : 'Взято'}</span>
          <b>${escapeHtml(loan.who)}</b>
          ${st.overdue ? '<span class="fin-chip is-warn">Просрочен</span>' : ''}
          ${st.settled ? '<span class="fin-chip is-done">Закрыт</span>' : ''}
          <span class="fin-loan-meta">${n(loan.principal)} · ${fmt(loan.percent, ccy)}%/мес · прошло ${escapeHtml(spanLabel(st.days))}</span>
        </div>
        <div class="fin-loan-prog">
          <div class="fin-bar ${lent ? '' : 'is-neg'}"><i style="width:${pct}%"></i></div>
          <span class="fin-loan-meta">погашено ${n(st.paid)} из ${n(st.principal)}</span>
        </div>
        ${loan.payments.length ? `
          <details class="fin-payments" ${st.settled ? 'open' : ''}>
            <summary>История выплат: ${loan.payments.length} на ${fmt(st.paid + st.interestPaid, ccy)}</summary>
            <div class="fin-table-wrap">
              <table class="fin-table fin-table-compact">
                <tbody>
                  ${loan.payments.map(p => {
                    const split = paymentSplit(loan, p);
                    return `<tr class="fin-row">
                      <td class="fin-date">${escapeHtml(p.date)}</td>
                      <td class="fin-amount fin-in">+${n(p.amount)}</td>
                      <td class="muted fin-split">проценты ${n(split.interest)} · тело ${n(split.principal)}</td>
                      <td class="fin-actions"><button type="button" class="btn ghost small fin-icon" data-fin-act="del-payment"
                        data-loan="${escapeHtml(loan.id)}" data-id="${escapeHtml(p.id)}" title="Убрать выплату">🗑️</button></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </details>` : ''}
        <div class="fin-loan-actions">
          ${st.settled
            ? `<button type="button" class="btn ghost small" data-fin-act="edit-loan" data-id="${escapeHtml(loan.id)}">✏️ Изменить</button>
               <button type="button" class="btn ghost small" data-fin-act="del-loan" data-id="${escapeHtml(loan.id)}">🗑️ Удалить</button>`
            : `<button type="button" class="btn primary small" data-fin-act="pay-all" data-id="${escapeHtml(loan.id)}" title="Выплатить всю сумму долга сразу">💵 Выплатить всё</button>
               <button type="button" class="btn small" data-fin-act="add-payment" data-id="${escapeHtml(loan.id)}">💸 Частично</button>
               <button type="button" class="btn ghost small" data-fin-act="close-loan" data-id="${escapeHtml(loan.id)}"
                       title="Списать остаток долга — деньги больше не вернутся">✅ Закрыть</button>
               <button type="button" class="btn ghost small" data-fin-act="edit-loan" data-id="${escapeHtml(loan.id)}">✏️</button>
               <button type="button" class="btn ghost small" data-fin-act="del-loan" data-id="${escapeHtml(loan.id)}">🗑️</button>`}
        </div>
      </div>
      <div class="fin-loan-due">
        <small>должен вернуть</small>
        <b>${n(st.total)}</b>
      </div>
    </div>`;
}

function loansBlock() {
  const { loans } = fin();
  if (!loans.length) {
    return `<div class="fin-loan is-lent">
      <div class="fin-loan-main"><b>Долгов нет</b>
        <span class="fin-loan-meta">Никто не должен и ты ничего не должен.</span></div>
      <button type="button" class="btn small" data-fin-act="add-loan" data-dir="lent">🤝 Дать в долг</button>
    </div>`;
  }
  return `<div class="stack">${loans.map(loanCard).join('')}</div>`;
}

// ── Отрисовка ─────────────────────────────────────────────────────────────

export function renderFinance() {
  const el = root();
  if (!el) return;
  const { operations, loans } = fin();
  const months = groupByMonth(operations);
  // Выбранный месяц должен существовать: иначе после удаления записей журнал был бы пуст
  if (!selected || !months.some(m => m.month === selected)) selected = months[0]?.month || null;

  el.innerHTML = `
    <div class="desk-bar">
      <div class="grp">
        <button type="button" class="btn primary" data-fin-act="add-op">➕ Записать движение</button>
      </div>
      <div class="grp">
        <button type="button" class="btn" data-fin-act="gold">💰 Голд</button>
        <button type="button" class="btn ghost" data-fin-act="add-loan">🤝 Долг</button>
      </div>
      <div class="desk-search">
        <input type="search" placeholder="Поиск по источнику или примечанию…" value="${escapeHtml(query)}" data-query />
      </div>
    </div>
    <section class="desk-section">${panels()}</section>
    <section class="desk-section">
      <h3 class="block-h">Месяцы</h3>
      <div class="month-open">${monthsList()}${monthOpen()}</div>
    </section>
    <section class="desk-section">
      <div class="bottom-grid">
        <div class="bottom-col">
          <h3 class="block-h">Комиссионка</h3>
          ${shopBlock()}
        </div>
        <div class="bottom-col">
          <h3 class="block-h">Долги${loans.length ? ` (${loans.length})` : ''}</h3>
          ${loansBlock()}
        </div>
      </div>
    </section>`;
}

// ── Формы ─────────────────────────────────────────────────────────────────

function operationForm(existing = null) {
  const op = existing || {
    date: todayIso(), kind: 'in', amount: '', currency: DEFAULT_CURRENCY,
    counterparty: '', note: '', status: ''
  };
  showModal({
    title: existing ? 'Изменить запись' : 'Новая запись',
    submitText: 'Сохранить',
    content: `<form class="fin-form">
      ${selectField('Вид', 'kind', op.kind, [
        { value: 'in', label: 'Получил' },
        { value: 'out', label: 'Потратил' }
      ])}
      ${selectField('Валюта', 'currency', op.currency,
        CURRENCY_IDS.map(id => ({ value: id, label: `${cur(id).icon} ${cur(id).title}` })))}
      ${field('Сумма', 'amount', op.amount, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Дата', 'date', op.date, { type: 'date', required: true })}
      ${textField('Откуда / на что', 'counterparty', op.counterparty, 'источник или статья расхода')}
      ${textField('Примечание', 'note', op.note, 'детали операции')}
      ${textField('Статус', 'status', op.status, 'необязательно')}
    </form>`,
    onSubmit: (form) => {
      const amount = num(form.get('amount'));
      if (amount <= 0) { alert('Сумма должна быть больше нуля.'); return false; }
      const entry = {
        id: existing?.id || uid(),
        date: str(form.get('date')) || todayIso(),
        kind: form.get('kind') === 'in' ? 'in' : 'out',
        currency: CURRENCY_IDS.includes(str(form.get('currency'))) ? str(form.get('currency')) : DEFAULT_CURRENCY,
        amount,
        counterparty: str(form.get('counterparty')),
        note: str(form.get('note')),
        status: str(form.get('status')),
        // Правка записи, порождённой комиссионкой, голдом или долгом, не должна терять
        // её происхождение: по source считаются пометки, а по ref — связанные записи
        source: existing?.source || 'manual',
        ref: existing?.ref || null
      };
      const ops = fin().operations;
      const at = ops.findIndex(o => o.id === entry.id);
      if (at >= 0) ops[at] = entry; else ops.unshift(entry);
      save();
    }
  });
}

function shopItemForm(existing = null, side = 'sell') {
  const item = existing || { side, name: '', price: '', qty: '', date: todayIso(), note: '' };
  showModal({
    title: existing ? 'Изменить позицию' : `Новая позиция: ${item.side === 'buy' ? 'Покупка' : 'Продажа'}`,
    submitText: 'Сохранить',
    content: `<form class="fin-form">
      ${selectField('Сторона', 'side', item.side, [
        { value: 'sell', label: 'Продажа — золото ко мне' },
        { value: 'buy', label: 'Покупка — золото от меня' }
      ])}
      ${textField('Предмет', 'name', item.name, 'название предмета')}
      ${field('Цена за штуку (золото)', 'price', item.price, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Количество на складе', 'qty', item.qty, { type: 'number', step: '1', min: 0, required: true })}
      ${field('Дата', 'date', item.date, { type: 'date' })}
      ${textField('Примечание', 'note', item.note)}
      <p class="muted fin-form-hint">
        Такой же предмет с той же ценой долится в ту же позицию: ввёл 3 «Зелья», потом ещё 2 —
        получится одна строка на 5 штук. Количество уменьшается, когда отмечаешь, сколько
        реально продал или купил.
      </p>
    </form>`,
    onSubmit: (form) => {
      const qty = num(form.get('qty'));
      const price = num(form.get('price'));
      if (!str(form.get('name'))) { alert('Впишите название предмета.'); return false; }
      if (qty <= 0 || price <= 0) { alert('Цена и количество должны быть больше нуля.'); return false; }

      const side = form.get('side') === 'buy' ? 'buy' : 'sell';
      const draft = { side, name: str(form.get('name')), price, qty, date: str(form.get('date')) || todayIso(), note: str(form.get('note')) };
      const items = fin().shopItems;

      // Доливаем в существующую позицию вместо дубли — это и просил «те же самые предметы»
      const target = existing ? null : findShopItem(items, draft);
      if (target) {
        target.qty = money(target.qty + qty);
        if (draft.date > target.date) target.date = draft.date;
        save();
        toast(`Добавлено к позиции «${target.name}»: стало ${fmt(target.qty)} шт.`, 'success');
        return;
      }
      const record = { id: existing?.id || uid(), ...draft };
      const at = items.findIndex(i => i.id === record.id);
      if (at >= 0) items[at] = record; else items.unshift(record);
      save();
    }
  });
}

/** Продажа/покупка части позиции: вычитает количество и пишет движение денег в «Банк». */
function shopDealForm(item) {
  const sold = item.side !== 'buy';
  showModal({
    title: `${sold ? 'Продано' : 'Куплено'}: ${item.name}`,
    submitText: sold ? 'Продано' : 'Куплено',
    content: `<form class="fin-form">
      ${field('Сколько', 'qty', item.qty, { type: 'number', step: '1', min: 0, required: true })}
      ${field('Дата', 'date', todayIso(), { type: 'date', required: true })}
      <div class="fin-preview" data-fin-preview>—</div>
      <p class="muted fin-form-hint">
        На складе осталось <b>${fmt(item.qty)}</b> шт. по ${fmt(item.price)} золота.
        Деньги запишутся в «Банк»: ${sold ? 'приход' : 'расход'} Золота.
      </p>
    </form>`,
    onSubmit: (form) => {
      let qty = num(form.get('qty'));
      if (qty <= 0) { alert('Количество должно быть больше нуля.'); return false; }
      if (qty > item.qty) qty = item.qty;   // больше, чем на складе, продать нельзя
      const date = str(form.get('date')) || todayIso();
      const op = shopDealOperation({ item, qty, date });
      item.qty = money(Math.max(0, item.qty - qty));
      state.finance.operations.unshift(op);
      save();
      toast(`${sold ? 'Продано' : 'Куплено'} ${fmt(qty)} шт. · ${fmt(op.amount)} золота`, 'success');
    }
  });

  const form = document.querySelector('#modal-root form');
  if (!form) return;
  const preview = form.querySelector('[data-fin-preview]');
  const update = () => {
    const qty = Math.min(num(form.elements.qty?.value), item.qty);
    if (qty <= 0) { preview.textContent = 'Впиши количество.'; return; }
    const rest = money(item.qty - qty);
    preview.innerHTML = `${sold ? 'Приход' : 'Расход'} <b>${fmt(shopItemTotal({ price: item.price, qty }))} золота</b>
      (${fmt(item.price)} × ${fmt(qty)}).<br>На складе останется: <b>${fmt(rest)}</b> шт.`;
  };
  form.addEventListener('input', update);
  update();
}

function goldForm() {
  const settings = fin().settings;
  const now = currentBalances(fin());
  showModal({
    title: 'Голд',
    submitText: 'Провести',
    wide: true,
    content: `<form class="fin-form">
      ${balancesRow()}
      ${selectField('Действие', 'side', 'sell', [
        { value: 'sell', label: 'Продать голд — получить золото' },
        { value: 'buy', label: 'Купить голд — заплатить золотом' }
      ])}
      ${field('Количество голда', 'coins', 1000, { type: 'number', step: '1', min: 0, required: true })}
      ${field('Курс: 1 голд = ? золота', 'rate', settings.goldRate, { type: 'number', step: '0.000001', min: 0, required: true })}
      <details class="fin-details">
        <summary>Комиссия аукциона (по умолчанию 2%)</summary>
        ${field('Комиссия, %', 'commissionPct', settings.commissionPct || DEFAULT_COMMISSION_PCT, { type: 'number', step: '0.01', min: 0 })}
      </details>
      <div class="fin-preview" data-fin-preview>—</div>
      <p class="muted fin-form-hint">
        Сделка запишется в «Банк» двумя строками: движение Голда и движение Золота.
        Курс и комиссию из этой формы можно сохранить как текущие.
      </p>
    </form>`,
    onSubmit: (form) => {
      const side = form.get('side') === 'buy' ? 'buy' : 'sell';
      const coins = num(form.get('coins'));
      const rate = num(form.get('rate'));
      if (coins <= 0 || rate <= 0) { alert('Нужны количество голда и курс.'); return false; }
      const commissionPct = num(form.get('commissionPct'));
      const { deal, operations } = goldDealOperations({ side, coins, rate, commissionPct });

      state.finance.settings.goldRate = rate;
      state.finance.settings.commissionPct = commissionPct;
      state.finance.settings.goldRateAt = todayIso();
      state.finance.operations.unshift(...operations);
      save();
      toast(`${side === 'sell' ? 'Продано' : 'Куплено'} ${fmt(deal.coins, 'coins')} голд · ${fmt(deal.gold, 'gold')} золота`, 'success');
    }
  });

  // Живой пересчёт: без него человек видит итог только после нажатия «Провести»
  const form = document.querySelector('#modal-root form');
  if (!form) return;
  const preview = form.querySelector('[data-fin-preview]');
  const update = () => {
    const isSell = form.elements.side?.value !== 'buy';
    const coins = num(form.elements.coins?.value);
    const course = num(form.elements.rate?.value);
    const pct = num(form.elements.commissionPct?.value);
    if (!coins || !course) { preview.textContent = 'Впишите количество и курс.'; return; }
    const d = goldDeal({ side: isSell ? 'sell' : 'buy', coins, rate: course, commissionPct: pct });
    // Курс показываем с копейками: это цена за 1 голд, округлять её до целых нельзя
    const rateText = (v) => formatAmount('coins', v);
    const loss = commissionLossPct(d.effectiveRate, course);
    preview.innerHTML = isSell
      ? `Голд: уйдёт <b>${fmt(d.coinsTotal, 'coins')}</b> (${fmt(coins, 'coins')} + комиссия ${fmt(d.commissionCoins, 'coins')}) · остаток станет ${fmt(now.coins - d.coinsTotal, 'coins')}<br>
         Золото: получите <b>${fmt(d.gold, 'gold')}</b> · фактический курс ${rateText(d.effectiveRate)} <span class="fin-out">−${rateText(loss)}%</span> · остаток станет ${fmt(now.gold + d.gold, 'gold')}`
      : `Голд: придёт <b>${fmt(coins, 'coins')}</b> · остаток станет ${fmt(now.coins + coins, 'coins')}<br>
         Золото: заплатите <b>${fmt(d.gold, 'gold')}</b> (из них комиссия ${fmt(d.commissionGold, 'gold')}) · за 1 голд ${rateText(d.effectiveRate)} <span class="fin-out">+${rateText(Math.abs(loss))}%</span> · остаток станет ${fmt(now.gold - d.gold, 'gold')}`;
  };
  // Направление выбирается списком, а списки сообщают о смене через change
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

function loanForm(existing = null, direction = 'lent') {
  const loan = existing || { direction, who: '', principal: '', percent: 5, start: todayIso(), end: '', currency: DEFAULT_CURRENCY, note: '' };
  showModal({
    title: existing ? 'Изменить долг' : (loan.direction === 'borrowed' ? 'Взять в долг' : 'Дать в долг'),
    submitText: 'Сохранить',
    content: `<form class="fin-form">
      ${existing ? '' : selectField('Направление', 'direction', loan.direction, [
        { value: 'lent', label: 'Я даю в долг' },
        { value: 'borrowed', label: 'Я беру в долг' }
      ])}
      ${textField('Кто', 'who', loan.who, 'ник или имя в игре')}
      ${field('Сумма долга', 'principal', loan.principal, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Процент в месяц', 'percent', loan.percent, { type: 'number', step: '0.01', min: 0 })}
      ${selectField('Валюта', 'currency', loan.currency,
        CURRENCY_IDS.map(id => ({ value: id, label: `${cur(id).icon} ${cur(id).title}` })))}
      ${field('Начало', 'start', loan.start, { type: 'date', required: true })}
      ${field('Конец (срок)', 'end', loan.end, { type: 'date' })}
      ${textField('Примечание', 'note', loan.note)}
      <p class="muted fin-form-hint">
        Проценты линейные, начисляются ежедневно: ставка делится на 30 и падает на остаток
        каждый день. Выплата сначала гасит проценты, потом тело долга — база уменьшается.
        Без даты конца проценты не идут вовсе.
      </p>
    </form>`,
    onSubmit: (form) => {
      if (!str(form.get('who'))) { alert('Впишите, кому долг.'); return false; }
      if (num(form.get('principal')) <= 0) { alert('Сумма долга должна быть больше нуля.'); return false; }
      const start = str(form.get('start')) || todayIso();
      const end = str(form.get('end'));
      const draft = {
        direction: form.get('direction') === 'borrowed' ? 'borrowed' : 'lent',
        who: str(form.get('who')),
        principal: num(form.get('principal')),
        percent: num(form.get('percent')),
        start,
        // Конец раньше начала — опечатка, а не «долг назад в прошлом»
        end: end && end > start ? end : '',
        currency: CURRENCY_IDS.includes(str(form.get('currency'))) ? str(form.get('currency')) : DEFAULT_CURRENCY,
        note: str(form.get('note'))
      };
      const loans = fin().loans;
      let target;
      if (existing) {
        const at = loans.findIndex(l => l.id === existing.id);
        if (at < 0) return;
        loans[at] = { ...existing, ...draft };
        target = loans[at];
      } else {
        target = { id: uid(), payments: [], opId: null, ...draft };
        loans.unshift(target);
      }
      syncLoanOperation(target);
      save();
    }
  });
}

/**
 * Долг — это движение денег, и запись в «Банке» должна совпадать с долгом.
 * Правка суммы обновляет ту же запись по `opId`, а не ищет её угадыванием по дате.
 */
function syncLoanOperation(loan) {
  const op = loanOperation(loan);
  const ops = state.finance.operations;
  const at = loan.opId ? ops.findIndex(o => o.id === loan.opId) : -1;
  if (at >= 0) ops[at] = op; else ops.unshift(op);
  loan.opId = op.id;
}

function paymentForm(loan) {
  const lent = loan.direction !== 'borrowed';
  const ccy = loan.currency || DEFAULT_CURRENCY;
  const st = loanStatus(loan);
  showModal({
    title: lent ? `Выплата от «${loan.who}»` : `Я возвращаю «${loan.who}»`,
    submitText: 'Записать выплату',
    content: `<form class="fin-form">
      ${field('Сумма выплаты', 'amount', '', { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Дата', 'date', todayIso(), { type: 'date', required: true })}
      <div class="fin-pay-actions">
        <button type="button" class="btn ghost small" data-pay-all>💵 Вся сумма долга (${fmt(st.total, ccy)})</button>
      </div>
      <div class="fin-preview" data-fin-preview>—</div>
    </form>`,
    onSubmit: (form) => {
      const amount = num(form.get('amount'));
      if (amount <= 0) { alert('Сумма выплаты должна быть больше нуля.'); return false; }
      if (!addPayment(loan, amount, str(form.get('date')) || todayIso())) return false;
    }
  });

  const form = document.querySelector('#modal-root form');
  if (!form) return;
  const preview = form.querySelector('[data-fin-preview]');
  // Кнопка «вся сумма»: долг считается на сегодня, поэтому сумма может быть больше
  // той, что была при открытии окна — подставляем актуальную при каждом нажатии
  form.querySelector('[data-pay-all]')?.addEventListener('click', () => {
    const current = loanStatus(loan);
    form.elements.amount.value = String(current.total);
    update();
  });
  const update = () => {
    const amount = num(form.elements.amount?.value);
    if (amount <= 0) { preview.textContent = 'Впишите сумму выплаты.'; return; }
    const split = paymentSplit(loan, { id: '__preview__', date: todayIso(), amount });
    // Остаток считаем на дату СЕГОДНЯ, а не на дату выплаты: иначе предпросмотр
    // врал бы в обе стороны — показывал проценты, которых ещё не будет, или
    // скрывал те, что уже набежали
    const after = loanStatus(loanWithPayment(loan, { date: todayIso(), amount }), todayIso());
    preview.innerHTML = `Из ${fmt(amount, ccy)}: <b>${fmt(split.interest, ccy)}</b> в проценты
      и <b>${fmt(split.principal, ccy)}</b> в тело долга.<br>
      ${after.total > 0 ? `После выплаты останется <b>${fmt(after.total, ccy)}</b>.` : 'Долг будет закрыт полностью.'}
      <br><small>Проценты дальше считаются только на остаток.</small>`;
  };
  form.addEventListener('input', update);
  update();
}

/**
 * Долг, как если бы выплата уже была записана: предпросмотр обязан прогнать
 * начисление с новым остатком, иначе показывал бы проценты по старой базе.
 * Возвращаем именно долг, а не посчитанный статус: статус в себе выплат не держит,
 * и повторный расчёт по нему терял бы их.
 */
function loanWithPayment(loan, payment) {
  return { ...loan, payments: [...loan.payments, { ...payment, id: '__preview__' }] };
}

/**
 * Записать выплату: сумма уходит и в сам долг, и в «Банк» одной записью. Общая часть
 * для кнопок «Выплата», «Выплатить всё» и предпросмотра — иначе они разошлись бы
 * при правке любой из них.
 */
function addPayment(loan, amount, date = null) {
  const value = roundFor(loan.currency || DEFAULT_CURRENCY, amount);
  if (value <= 0) return false;
  const target = fin().loans.find(l => l.id === loan.id);
  if (!target) return false;
  const when = date || todayIso();
  target.payments = [...target.payments, { id: uid(), date: when, amount: value }];

  const lent = target.direction !== 'borrowed';
  state.finance.operations.unshift({
    id: uid(),
    date: when,
    kind: lent ? 'in' : 'out',
    currency: target.currency,
    amount: value,
    counterparty: lent ? `Возврат долга — ${target.who}` : `Отдаю долг — ${target.who}`,
    note: str(target.note) || `Выплата по долгу ${fmt(target.percent)}%`,
    status: '',
    source: 'debt',
    ref: target.id
  });
  save();
  return true;
}

// ── Обработчики ───────────────────────────────────────────────────────────

export function bindFinance() {
  const el = root();
  if (!el || el.dataset.financeBound) return;
  el.dataset.financeBound = 'true';

  el.addEventListener('click', async (event) => {
    const month = /** @type {HTMLElement} */ (event.target).closest('[data-month]');
    if (month) {
      selected = month.dataset.month || null;
      renderFinance();
      return;
    }

    const clear = /** @type {HTMLElement} */ (event.target).closest('[data-clear-source],[data-clear-currency],[data-clear-query]');
    if (clear) {
      if (clear.hasAttribute('data-clear-source')) sourceFilter = null;
      if (clear.hasAttribute('data-clear-currency')) currencyFilter = null;
      if (clear.hasAttribute('data-clear-query')) query = '';
      renderFinance();
      return;
    }

    const chip = /** @type {HTMLElement} */ (event.target).closest('[data-source],[data-currency]');
    if (chip) {
      if (chip.hasAttribute('data-source')) sourceFilter = chip.dataset.source || null;
      if (chip.hasAttribute('data-currency')) currencyFilter = chip.dataset.currency || null;
      renderFinance();
      return;
    }

    const btn = /** @type {HTMLElement} */ (event.target).closest('[data-fin-act]');
    if (!btn) return;
    const act = btn.dataset.finAct;
    const { operations, shopItems, loans } = fin();

    if (act === 'add-op') return operationForm();
    if (act === 'edit-op') {
      return operationForm(operations.find(o => o.id === btn.dataset.id));
    }
    if (act === 'del-op') {
      const op = operations.find(o => o.id === btn.dataset.id);
      if (!op) return;
      if (await confirmModal({ title: 'Удалить запись?', text: op.counterparty || 'Запись без названия', okText: 'Удалить', danger: true })) {
        state.finance.operations = operations.filter(o => o.id !== btn.dataset.id);
        save();
      }
      return;
    }

    if (act === 'add-item') return shopItemForm(null, btn.dataset.side === 'buy' ? 'buy' : 'sell');
    if (act === 'edit-item') {
      const item = shopItems.find(i => i.id === btn.dataset.id);
      if (item) shopItemForm(item);
      return;
    }
    if (act === 'deal-item') {
      const item = shopItems.find(i => i.id === btn.dataset.id);
      if (item) shopDealForm(item);
      return;
    }
    if (act === 'del-item') {
      const item = shopItems.find(i => i.id === btn.dataset.id);
      if (!item) return;
      if (await confirmModal({ title: 'Убрать позицию?', text: `${item.name} — ${fmt(item.qty)} шт.`, okText: 'Убрать', danger: true })) {
        state.finance.shopItems = shopItems.filter(i => i.id !== btn.dataset.id);
        save();
      }
      return;
    }

    if (act === 'gold') return goldForm();
    if (act === 'add-loan') return loanForm();
    if (act === 'edit-loan') {
      const loan = loans.find(l => l.id === btn.dataset.id);
      if (loan) loanForm(loan);
      return;
    }
    if (act === 'del-loan') {
      const loan = loans.find(l => l.id === btn.dataset.id);
      if (!loan) return;
      const ok = await confirmModal({
        title: `Удалить долг: ${loan.who}?`,
        text: loan.payments.length
          ? `Вместе с долгом пропадут ${loan.payments.length} выплат и их записи в «Банке».`
          : 'Запись в «Банке» об открытии долга тоже пропадёт.',
        okText: 'Удалить', danger: true
      });
      if (!ok) return;
      const loanId = loan.id;
      state.finance.loans = loans.filter(l => l.id !== loanId);
      state.finance.operations = operations.filter(op => op.ref !== loanId);
      save();
      return;
    }
    if (act === 'add-payment') {
      const loan = loans.find(l => l.id === btn.dataset.id);
      if (loan) paymentForm(loan);
      return;
    }
    if (act === 'pay-all') {
      const loan = loans.find(l => l.id === btn.dataset.id);
      if (!loan) return;
      const ccy = loan.currency || DEFAULT_CURRENCY;
      const st = loanStatus(loan);
      const lent = loan.direction !== 'borrowed';
      const ok = await confirmModal({
        title: lent ? `Записать выплату от «${loan.who}»?` : `Записать возврат «${loan.who}»?`,
        text: `Вся сумма долга: ${fmt(st.total, ccy)} `
          + `(тело ${fmt(st.outstanding, ccy)}, проценты ${fmt(st.interestDue, ccy)}). Долг будет закрыт.`,
        okText: 'Записать выплату'
      });
      if (!ok) return;
      addPayment(loan, st.total);
      return;
    }
    if (act === 'close-loan') {
      const loan = loans.find(l => l.id === btn.dataset.id);
      if (!loan) return;
      const ccy = loan.currency || DEFAULT_CURRENCY;
      const st = loanStatus(loan);
      const ok = await confirmModal({
        title: `Закрыть долг «${loan.who}», не выплачивая?`,
        text: `Остаток ${fmt(st.total, ccy)} списывается: деньги уже не придут, но долг перестанет`
          + ' начислять проценты. История выплат сохранится.',
        okText: 'Закрыть долг',
        danger: true
      });
      if (!ok) return;
      loan.closedAt = todayIso();
      loan.closeReason = 'Списан без выплаты';
      save();
      toast('Долг закрыт', 'success');
      return;
    }
    if (act === 'del-payment') {
      const ok = await confirmModal({ title: 'Убрать выплату?', text: 'Долг вернётся к состоянию без неё.', okText: 'Убрать', danger: true });
      if (!ok) return;
      const loan = loans.find(l => l.id === btn.dataset.loan);
      if (!loan) return;
      loan.payments = loan.payments.filter(p => p.id !== btn.dataset.id);
      save();
    }
  });

  // Поиск и чекбокс «Итог» — не кнопки, поэтому слушаются отдельно.
  el.addEventListener('input', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target).closest('[data-query]');
    if (!input) return;
    query = input.value;
    const focused = document.activeElement === input;
    renderFinance();
    if (focused) {
      const fresh = el.querySelector('[data-query]');
      fresh?.focus();
      const n = fresh ? fresh.value.length : 0;
      try { fresh?.setSelectionRange(n, n); } catch { /* type=search не всегда ставит каретку */ }
    }
  });
  el.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target).closest('[data-balance]');
    if (!input) return;
    showBalance = input.checked;
    renderFinance();
  });
}
