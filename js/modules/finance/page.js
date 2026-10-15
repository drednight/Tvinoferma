// js/modules/finance/page.js
// Раздел «Учёт»: приход и расход, комиссионный магазин, голд и долги.
//
// Четыре блока под общей вкладкой, потому что это четыре взгляда на одни и те же деньги,
// а не четыре независимых раздела. Все три из них (магазин, голд, возврат долга) пишут
// в общий реестр: если у каждого будут свои деньги, «Сумма в банке» перестанет сходиться.
//
// Считает всё модель (finance/model.js) — здесь только разметка и обработчики.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml, uid } from '../../core/utils.js';
import { showModal, toast, confirmModal } from '../../core/ui.js';
import {
  CURRENCIES, CURRENCY_IDS, DEFAULT_CURRENCY,
  money, todayIso, normalizeFinance, ledgerTotalsByCurrency,
  groupByMonth, runningBalance, shopTotals, shopItemTotal,
  findShopItem, goldDeal, commissionLossPct, loanStatus, paymentSplit
} from './model.js';

const BLOCKS = [
  { id: 'ledger', label: 'Приход и расход', icon: '📒' },
  { id: 'shop', label: 'Магазин', icon: '🏪' },
  { id: 'gold', label: 'Голд', icon: '🪙' },
  { id: 'loans', label: 'Долги', icon: '🤝' }
];

let activeBlock = 'ledger';

const root = () => document.getElementById('finance-root');

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

function fmt(value) {
  return money(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
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

// ── Блок «Приход и расход» ────────────────────────────────────────────────

function ledgerSummary() {
  const totals = ledgerTotalsByCurrency(fin().operations);
  return `
    <div class="fin-summary">
      ${CURRENCY_IDS.map(id => {
        const t = totals[id];
        return `
        <div class="fin-summary-cell">
          <span class="fin-summary-label">${cur(id).icon} ${escapeHtml(cur(id).title)}</span>
          <span class="fin-summary-row"><small>Приход</small><b class="fin-in">+${fmt(t.income)}</b></span>
          <span class="fin-summary-row"><small>Расход</small><b class="fin-out">−${fmt(t.expense)}</b></span>
          <span class="fin-summary-row fin-summary-total"><small>Остаток</small><b>${fmt(t.balance)}</b></span>
        </div>`;
      }).join('')}
    </div>`;
}

const SOURCE_LABEL = {
  manual: '', shop: 'магазин', gold: 'голд', debt: 'долг'
};

function operationRow(op, balanceAfter) {
  const isIn = op.kind === 'in';
  return `
    <tr class="fin-row">
      <td class="fin-date">${escapeHtml(op.date.slice(8))}.${escapeHtml(op.date.slice(5, 7))}</td>
      <td class="fin-kind">
        <span class="fin-chip ${isIn ? 'is-in' : 'is-out'}">${isIn ? 'Приход' : 'Расход'}</span>
        ${SOURCE_LABEL[op.source] ? `<span class="fin-source">${escapeHtml(SOURCE_LABEL[op.source])}</span>` : ''}
      </td>
      <td class="fin-what">
        <b>${escapeHtml(op.counterparty || '—')}</b>
        ${op.note ? `<small class="muted">${escapeHtml(op.note)}</small>` : ''}
      </td>
      <td class="fin-amount ${isIn ? 'fin-in' : 'fin-out'}">${isIn ? '+' : '−'}${fmt(op.amount)} <small class="muted">${escapeHtml(cur(op.currency).short)}</small></td>
      <td class="fin-balance muted">${fmt(balanceAfter)}</td>
      <td class="fin-actions">
        <button type="button" class="btn ghost small" data-fin-act="edit-op" data-id="${escapeHtml(op.id)}" title="Изменить">✏️</button>
        <button type="button" class="btn ghost small" data-fin-act="del-op" data-id="${escapeHtml(op.id)}" title="Удалить">🗑️</button>
      </td>
    </tr>`;
}

function ledgerBlock() {
  const { operations } = fin();
  if (!operations.length) {
    return `<p class="fin-empty">Записей пока нет. Нажмите «Записать» — и здесь появятся приход и расход.</p>`;
  }
  const months = groupByMonth(operations);
  return months.map(group => {
    const rows = runningBalance(group.operations);
    return `
      <details class="panel fold fin-month" ${group === months[0] ? 'open' : ''}>
        <summary>
          <h3>${escapeHtml(group.label)}</h3>
          <span class="fin-month-totals">
            ${CURRENCY_IDS.map(id => `<span class="${group.totals[id].balance < 0 ? 'fin-out' : 'fin-in'}">${escapeHtml(cur(id).short)} ${fmt(group.totals[id].balance)}</span>`).join('')}
          </span>
        </summary>
        <table class="fin-table">
          <thead><tr><th>Дата</th><th>Вид</th><th>Откуда / на что</th><th class="fin-num">Сумма</th><th class="fin-num">Итог</th><th></th></tr></thead>
          <tbody>${rows.map(r => operationRow(r, r.balanceAfter)).join('')}</tbody>
        </table>
      </details>`;
  }).join('');
}

// ── Блок «Магазин» ────────────────────────────────────────────────────────

function shopColumn(side, items, totals) {
  const isSell = side === 'sell';
  const title = isSell ? 'Продажа' : 'Покупка';
  const sign = isSell ? '+' : '−';
  return `
    <div class="fin-shop-col">
      <header class="fin-shop-head">
        <h3>${title}</h3>
        <span class="muted">${totals.count} поз. · ${fmt(totals.qty)} шт.</span>
      </header>
      ${items.length ? `
        <table class="fin-table fin-table-compact">
          <thead><tr><th>Предмет</th><th class="fin-num">Цена</th><th class="fin-num">Кол-во</th><th class="fin-num">Итого</th><th></th></tr></thead>
          <tbody>
            ${items.map(item => `
              <tr class="fin-row">
                <td class="fin-what">
                  <b>${escapeHtml(item.name)}</b>
                  <small class="muted">${escapeHtml(item.date.slice(8))}.${escapeHtml(item.date.slice(5, 7))}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small>
                </td>
                <td class="fin-num">${fmt(item.price)}</td>
                <td class="fin-num">${fmt(item.qty)}</td>
                <td class="fin-num"><b>${fmt(shopItemTotal(item))}</b></td>
                <td class="fin-actions">
                  <button type="button" class="btn ghost small" data-fin-act="bump-item" data-id="${escapeHtml(item.id)}" title="Долить такое же количество">➕</button>
                  <button type="button" class="btn ghost small" data-fin-act="del-item" data-id="${escapeHtml(item.id)}" title="Убрать позицию">🗑️</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<p class="fin-empty">Пусто</p>'}
      <footer class="fin-shop-foot">
        <span class="muted">Итого</span>
        <b class="${isSell ? 'fin-in' : 'fin-out'}">${sign}${fmt(totals.sum)} ${escapeHtml(cur(DEFAULT_CURRENCY).short)}</b>
      </footer>
    </div>`;
}

function shopBlock() {
  const items = fin().shopItems;
  const totals = shopTotals(items);
  return `
    <div class="fin-shop">
      ${shopColumn('sell', items.filter(i => i.side !== 'buy'), totals.sell)}
      ${shopColumn('buy', items.filter(i => i.side === 'buy'), totals.buy)}
    </div>
    <div class="fin-actions-row">
      <button type="button" class="btn primary" data-fin-act="add-item">➕ Добавить позицию</button>
      <span class="muted">Золото заработано за вычетом купленного: <b>${fmt(totals.net)}</b></span>
    </div>`;
}

// ── Блок «Голд» ───────────────────────────────────────────────────────────

function goldBlock() {
  const { goldRate, goldRateAt, commissionPct } = fin().settings;
  const sample = goldDeal({ side: 'sell', coins: 1000, rate: goldRate, commissionPct });
  const loss = commissionLossPct(sample.effectiveRate, goldRate);
  return `
    <div class="fin-gold-settings">
      ${field('Курс: 1 голд = ? золота', 'goldRate', goldRate, { type: 'number', step: '0.000001', min: 0, placeholder: '1000000' })}
      ${field('Комиссия, %', 'commissionPct', commissionPct, { type: 'number', step: '0.01', min: 0 })}
      <button type="button" class="btn primary" data-fin-act="save-gold">💾 Сохранить курс</button>
    </div>
    <p class="muted fin-gold-hint">
      ${goldRateAt ? `Курс от ${escapeHtml(goldRateAt)}. Он зависит от рынка, поэтому меняется со временем.` : 'Курс ещё не задан.'}
      Комиссия берётся голдом: при продаже 1000 голд уходит ${fmt(sample.coinsTotal ?? 0)} голда вместо 1000,
      фактический курс ${fmt(sample.effectiveRate)} вместо ${fmt(goldRate)}
      <b>(${loss > 0 ? `−${fmt(loss)}%` : '—'})</b>.
    </p>
    <div class="fin-actions-row">
      <button type="button" class="btn" data-fin-act="gold-sell">💰 Продать голд</button>
      <button type="button" class="btn" data-fin-act="gold-buy">🛒 Купить голд</button>
    </div>`;
}

// ── Блок «Долги」 ─────────────────────────────────────────────────────────

function loanCard(loan) {
  const st = loanStatus(loan);
  const lent = loan.direction !== 'borrowed';
  const paidTotal = st.paid + st.interestPaid;
  return `
    <article class="fin-loan ${lent ? 'is-lent' : 'is-borrowed'}">
      <header class="fin-loan-head">
        <span class="fin-chip ${lent ? 'is-in' : 'is-out'}">${lent ? 'Дано в долг' : 'Взято в долг'}</span>
        <b>${escapeHtml(loan.who)}</b>
        ${st.overdue ? '<span class="fin-chip is-warn">Просрочен</span>' : ''}
        ${st.settled ? '<span class="fin-chip is-done">Закрыт</span>' : ''}
      </header>
      <div class="fin-loan-grid">
        <span><small>Сумма</small><b>${fmt(loan.principal)}</b></span>
        <span><small>Ставка</small><b>${fmt(loan.percent)}% / мес</b></span>
        <span><small>Срок</small><b>${escapeHtml(loan.start)} → ${loan.end ? escapeHtml(loan.end) : '—'}</b></span>
        <span><small>Прошло</small><b>${st.months} мес.</b></span>
      </div>
      <div class="fin-loan-grid fin-loan-grid-sum">
        <span><small>Погашено тела</small><b>${fmt(st.paid)}</b></span>
        <span><small>Осталось тела</small><b>${fmt(st.outstanding)}</b></span>
        <span><small>Проценты набежали</small><b>${fmt(st.interestDue)}</b></span>
        <span class="fin-loan-due"><small>Должен вернуть</small><b>${fmt(st.total)}</b></span>
      </div>
      ${st.term.months ? `<p class="muted fin-loan-term">
        За весь срок без выплат вышло бы ${fmt(st.term.total)}
        (${st.term.months} мес., проценты ${fmt(st.term.interest)}). Выплачено ${fmt(paidTotal)}.
      </p>` : '<p class="muted fin-loan-term">Срок не задан — проценты не начисляются.</p>'}
      ${loan.payments.length ? `
        <details class="fin-payments">
          <summary>Выплаты: ${loan.payments.length}</summary>
          <table class="fin-table fin-table-compact">
            <tbody>
              ${loan.payments.map(p => {
                const split = paymentSplit(loan, p);
                return `<tr class="fin-row">
                  <td>${escapeHtml(p.date)}</td>
                  <td class="fin-amount fin-in">+${fmt(p.amount)}</td>
                  <td class="muted">проценты ${fmt(split.interest)} · тело ${fmt(split.principal)}</td>
                  <td class="fin-actions"><button type="button" class="btn ghost small" data-fin-act="del-payment"
                    data-loan="${escapeHtml(loan.id)}" data-id="${escapeHtml(p.id)}" title="Убрать выплату">🗑️</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </details>` : ''}
      <footer class="fin-loan-actions">
        <button type="button" class="btn primary small" data-fin-act="add-payment" data-id="${escapeHtml(loan.id)}">💸 Выплата</button>
        <button type="button" class="btn ghost small" data-fin-act="edit-loan" data-id="${escapeHtml(loan.id)}">✏️ Изменить</button>
        <button type="button" class="btn ghost small" data-fin-act="del-loan" data-id="${escapeHtml(loan.id)}">🗑️ Удалить</button>
      </footer>
    </article>`;
}

function loansBlock() {
  const { loans } = fin();
  const lent = loans.filter(l => l.direction !== 'borrowed');
  const borrowed = loans.filter(l => l.direction === 'borrowed');
  const total = (list) => list.reduce((sum, l) => sum + loanStatus(l).total, 0);
  return `
    <div class="fin-actions-row">
      <button type="button" class="btn primary" data-fin-act="add-loan" data-dir="lent">🤝 Дать в долг</button>
      <button type="button" class="btn" data-fin-act="add-loan" data-dir="borrowed">📥 Взять в долг</button>
      ${lent.length ? `<span class="muted">Должны вернуть: <b>${fmt(total(lent))}</b></span>` : ''}
      ${borrowed.length ? `<span class="muted">Я должен: <b>${fmt(total(borrowed))}</b></span>` : ''}
    </div>
    ${loans.length
      ? `<div class="fin-loans">${loans.map(loanCard).join('')}</div>`
      : '<p class="fin-empty">Долгов нет. Проценты считаются на остаток: после выплаты база уменьшается и дальше проценты капают только на остаток.</p>'}`;
}

// ── Отрисовка ─────────────────────────────────────────────────────────────

export function renderFinance() {
  const el = root();
  if (!el) return;
  el.innerHTML = `
    <nav class="fin-subnav" aria-label="Разделы учёта">
      ${BLOCKS.map(b => `
        <button type="button" class="fin-subnav-btn ${b.id === activeBlock ? 'active' : ''}"
                data-fin-block="${b.id}">${b.icon} ${escapeHtml(b.label)}</button>`).join('')}
    </nav>
    <div class="fin-body">
      ${activeBlock === 'ledger' ? `${ledgerSummary()}${ledgerBlock()}
        <div class="fin-actions-row"><button type="button" class="btn primary" data-fin-act="add-op">➕ Записать</button></div>` : ''}
      ${activeBlock === 'shop' ? shopBlock() : ''}
      ${activeBlock === 'gold' ? goldBlock() : ''}
      ${activeBlock === 'loans' ? loansBlock() : ''}
    </div>`;
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
        { value: 'in', label: 'Приход — получили' },
        { value: 'out', label: 'Расход — потратили' }
      ])}
      ${selectField('Валюта', 'currency', op.currency,
        CURRENCY_IDS.map(id => ({ value: id, label: `${cur(id).icon} ${cur(id).title}` })))}
      ${field('Сумма', 'amount', op.amount, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Дата', 'date', op.date, { type: 'date', required: true })}
      ${textField('Откуда / на что', 'counterparty', op.counterparty, 'Ежа, клановое ЗП, магазин…')}
      ${textField('Примечание', 'note', op.note, '25 сундуков + поджог')}
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
        // Правка записи, порождённой магазином или голдом, не должна терять её происхождение
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

function shopItemForm(existing = null) {
  const item = existing || { side: 'sell', name: '', price: '', qty: '', date: todayIso(), note: '' };
  showModal({
    title: existing ? 'Изменить позицию' : 'Новая позиция',
    submitText: 'Сохранить',
    content: `<form class="fin-form">
      ${selectField('Сторона', 'side', item.side, [
        { value: 'sell', label: 'Продажа — золото ко мне' },
        { value: 'buy', label: 'Покупка — золото от меня' }
      ])}
      ${textField('Предмет', 'name', item.name, 'Зелье восстановления')}
      ${field('Цена за штуку (золото)', 'price', item.price, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Количество', 'qty', item.qty, { type: 'number', step: '1', min: 0, required: true })}
      ${field('Дата', 'date', item.date, { type: 'date' })}
      ${textField('Примечание', 'note', item.note)}
      <p class="muted fin-form-hint">
        Такой же предмет с той же ценой долится в ту же позицию: продал 3 «Зелья», потом ещё 2 —
        получится одна строка на 5 штук, а не две.
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
      const item = { id: existing?.id || uid(), ...draft };
      const at = items.findIndex(i => i.id === item.id);
      if (at >= 0) items[at] = item; else items.unshift(item);
      save();
    }
  });
}

function goldForm(side) {
  const isSell = side === 'sell';
  const settings = fin().settings;
  showModal({
    title: isSell ? 'Продать голд' : 'Купить голд',
    submitText: 'Провести',
    wide: true,
    content: `<form class="fin-form">
      ${field('Количество голда', 'coins', 1000, { type: 'number', step: '1', min: 0, required: true })}
      ${field('Курс: 1 голд = ? золота', 'rate', settings.goldRate, { type: 'number', step: '0.000001', min: 0, required: true })}
      ${field('Комиссия, %', 'commissionPct', settings.commissionPct, { type: 'number', step: '0.01', min: 0 })}
      <div class="fin-preview" data-fin-preview>—</div>
      <p class="muted fin-form-hint">
        Сделка попадёт в «Приход и расход» с пометкой «голд». Курс и комиссию из этой формы
        можно сохранить как текущие.
      </p>
    </form>`,
    onSubmit: (form) => {
      const coins = num(form.get('coins'));
      const rate = num(form.get('rate'));
      if (coins <= 0 || rate <= 0) { alert('Нужны количество голда и курс.'); return false; }
      const commissionPct = num(form.get('commissionPct'));
      const deal = goldDeal({ side, coins, rate, commissionPct });

      state.finance.settings.goldRate = rate;
      state.finance.settings.commissionPct = commissionPct;
      state.finance.settings.goldRateAt = todayIso();

      // Голд уходит, золото приходит: в реестр пишем движение ЗОЛОТА, а не голда,
      // потому что реестр показывает деньги, а голд — это единицы, которыми их меняют
      state.finance.operations.unshift({
        id: uid(),
        date: todayIso(),
        kind: isSell ? 'in' : 'out',
        currency: 'gold',
        amount: deal.gold,
        counterparty: isSell ? 'Продажа голда' : 'Покупка голда',
        note: `${fmt(deal.coins)} голд по курсу ${fmt(rate)}, комиссия ${fmt(deal.commissionCoins)} голд`,
        status: '',
        source: 'gold',
        ref: null
      });
      save();
      toast(isSell ? `Продано ${fmt(deal.coins)} голд` : `Куплено ${fmt(deal.coins)} голд`, 'success');
    }
  });

  // Живой пересчёт: без него человек видит итог только после нажатия «Провести»
  const form = document.querySelector('#modal-root form');
  if (!form) return;
  const preview = form.querySelector('[data-fin-preview]');
  const update = () => {
    const coins = num(form.elements.coins?.value);
    const rate = num(form.elements.rate?.value);
    const pct = num(form.elements.commissionPct?.value);
    if (!coins || !rate) { preview.textContent = 'Впишите количество и курс.'; return; }
    const d = goldDeal({ side, coins, rate, commissionPct: pct });
    const loss = commissionLossPct(d.effectiveRate, rate);
    preview.innerHTML = isSell
      ? `Уйдёт <b>${fmt(d.coinsTotal ?? coins)} голда</b> (${fmt(coins)} + комиссия ${fmt(d.commissionCoins)})<br>
         Получите <b>${fmt(d.gold)} золота</b> · фактический курс ${fmt(d.effectiveRate)} <span class="fin-out">−${fmt(loss)}%</span>`
      : `Придёт <b>${fmt(coins)} голда</b><br>
         Заплатите <b>${fmt(d.gold)} золота</b> (из них комиссия ${fmt(d.commissionGold)}) · за 1 голд ${fmt(d.effectiveRate)} <span class="fin-out">+${fmt(Math.abs(loss))}%</span>`;
  };
  form.addEventListener('input', update);
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
      ${textField('Кто', 'who', loan.who, 'Шкила, Ежа…')}
      ${field('Сумма долга', 'principal', loan.principal, { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Процент в месяц', 'percent', loan.percent, { type: 'number', step: '0.01', min: 0 })}
      ${selectField('Валюта', 'currency', loan.currency,
        CURRENCY_IDS.map(id => ({ value: id, label: `${cur(id).icon} ${cur(id).title}` })))}
      ${field('Начало', 'start', loan.start, { type: 'date', required: true })}
      ${field('Конец (срок)', 'end', loan.end, { type: 'date' })}
      ${textField('Примечание', 'note', loan.note)}
      <p class="muted fin-form-hint">
        Проценты простые и считаются на остаток: полный месяц целиком, неполный — никак.
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
      if (existing) {
        const at = loans.findIndex(l => l.id === existing.id);
        if (at >= 0) loans[at] = { ...existing, ...draft };
      } else {
        loans.unshift({ id: uid(), payments: [], ...draft });
      }
      save();
    }
  });
}

function paymentForm(loan) {
  const lent = loan.direction !== 'borrowed';
  showModal({
    title: lent ? `Выплата от «${loan.who}»` : `Я возвращаю «${loan.who}»`,
    submitText: 'Записать выплату',
    content: `<form class="fin-form">
      ${field('Сумма выплаты', 'amount', '', { type: 'number', step: '0.01', min: 0, required: true })}
      ${field('Дата', 'date', todayIso(), { type: 'date', required: true })}
      <div class="fin-preview" data-fin-preview>—</div>
    </form>`,
    onSubmit: (form) => {
      const amount = num(form.get('amount'));
      if (amount <= 0) { alert('Сумма выплаты должна быть больше нуля.'); return false; }
      const payment = { id: uid(), date: str(form.get('date')) || todayIso(), amount };
      const target = fin().loans.find(l => l.id === loan.id);
      if (!target) return;
      target.payments = [...target.payments, payment];

      // Возврат долга — движение денег: мне вернули (приход) или я отдал (расход)
      state.finance.operations.unshift({
        id: uid(),
        date: payment.date,
        kind: lent ? 'in' : 'out',
        currency: target.currency,
        amount,
        counterparty: lent ? `Возврат долга — ${target.who}` : `Отдаю долг — ${target.who}`,
        note: str(target.note) || `Выплата по долгу ${fmt(target.percent)}%`,
        status: '',
        source: 'debt',
        ref: target.id
      });
      save();
    }
  });

  const form = document.querySelector('#modal-root form');
  if (!form) return;
  const preview = form.querySelector('[data-fin-preview]');
  const update = () => {
    const amount = num(form.elements.amount?.value);
    if (amount <= 0) { preview.textContent = 'Впишите сумму выплаты.'; return; }
    const split = paymentSplit(loan, { id: '__preview__', date: str(form.elements.date?.value) || todayIso(), amount });
    preview.innerHTML = `Из ${fmt(amount)}: <b>${fmt(split.interest)}</b> в проценты
      и <b>${fmt(split.principal)}</b> в тело долга.<br>
      Проценты дальше считаются только на остаток.`;
  };
  form.addEventListener('input', update);
  update();
}

// ── Обработчики ───────────────────────────────────────────────────────────

export function bindFinance() {
  const el = root();
  if (!el || el.dataset.financeBound) return;
  el.dataset.financeBound = 'true';

  el.addEventListener('click', async (event) => {
    const block = /** @type {HTMLElement} */ (event.target).closest('[data-fin-block]');
    if (block) {
      activeBlock = block.dataset.finBlock || 'ledger';
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

    if (act === 'add-item') return shopItemForm();
    if (act === 'bump-item') {
      // Кнопка «➕» открывает ту же форму, но с уже подставленными числами: так
      // «долить» и «завести новую позицию» — один и тот же код, а не две ветки
      const item = shopItems.find(i => i.id === btn.dataset.id);
      if (item) shopItemForm({ ...item, qty: '' });
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

    if (act === 'save-gold') {
      const rate = num(document.querySelector('[name="goldRate"]')?.value);
      const pct = num(document.querySelector('[name="commissionPct"]')?.value);
      state.finance.settings = { goldRate: rate, commissionPct: pct, goldRateAt: todayIso() };
      save();
      toast('Курс и комиссия сохранены', 'success');
      return;
    }
    if (act === 'gold-sell') return goldForm('sell');
    if (act === 'gold-buy') return goldForm('buy');

    if (act === 'add-loan') return loanForm(null, btn.dataset.dir || 'lent');
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
          ? `Вместе с долгом пропадут ${loan.payments.length} выплат и их записи в реестре.`
          : 'Записи в реестре останутся.',
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
    if (act === 'del-payment') {
      const ok = await confirmModal({ title: 'Убрать выплату?', text: 'Долг вернётся к состоянию без неё.', okText: 'Убрать', danger: true });
      if (!ok) return;
      const loan = loans.find(l => l.id === btn.dataset.loan);
      if (!loan) return;
      loan.payments = loan.payments.filter(p => p.id !== btn.dataset.id);
      save();
    }
  });
}