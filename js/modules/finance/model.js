// @ts-check
// js/modules/finance/model.js
// Раздел «Учёт»: единый реестр движений денег, комиссионный магазин, голд и долги.
// Здесь только чистые функции — без DOM и без state. Их проверяет tests/finance.test.js.
//
// Три идеи, на которых держится всё остальное:
//
// 1. ЕДИНЫЙ РЕЕСТР. Магазин, голд и возврат долга не хранят деньги отдельно, а порождают
//    запись в `operations` с пометкой `source`. Иначе появятся три правды о деньгах,
//    которые рано или поздно разойдутся, и «Сумма в банке» перестанет сходиться.
//
// 2. СУММА ВСЕГДА ПОЛОЖИТЕЛЬНАЯ. Приход или расход — это `kind`, а не знак. Отрицательная
//    сумма в реестре ломает все итоги сразу, поэтому нормализация её отсекает.
//
// 3. ДЕНЬГИ ОКРУГЛЯЮТСЯ ЗДЕСЬ. Сумма, которую видит человек, уже округлена; накопление
//    ошибки от float за год записей незаметно, но итог перестаёт сходиться с суммой строк —
//    а это как раз тот список, который человек пересчитывает глазами.

import { uid } from '../../core/utils.js';

/**
 * Две валюты. Идентификаторы короткие, потому что лежат в state.json:
 * `gold` — Золото (курс зависит от рынка, пополняется за рубли вручную),
 * `coins` — Голд (игровая валюта, покупается за Золото).
 */
export const CURRENCIES = {
  gold: { id: 'gold', title: 'Золото', short: 'Зол.', icon: '💰' },
  coins: { id: 'coins', title: 'Голд', short: 'Голд', icon: '🪙' }
};

export const CURRENCY_IDS = Object.keys(CURRENCIES);
export const DEFAULT_CURRENCY = 'gold';

/** Комиссия комиссионного магазина по умолчанию (процент). В игре — 8%. */
export const DEFAULT_COMMISSION_PCT = 8;

export function defaultFinance() {
  return {
    operations: [],
    shopItems: [],
    loans: [],
    settings: { goldRate: 0, commissionPct: DEFAULT_COMMISSION_PCT, goldRateAt: null }
  };
}

// ── Числа и даты ───────────────────────────────────────────────────────────

/** Деньги округляются до копеек: сумма в реестре, показанная глазом, обязана сходиться. */
export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Процент комиссии. Ноль здесь осмыслен (комиссия выключена), поэтому «нет значения»
 * и «мусор» ведут к умолчанию, а ноль уважается.
 */
function commissionPctOf(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_COMMISSION_PCT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COMMISSION_PCT;
}

/** Локальная дата `YYYY-MM-DD`. Именно локальная: операция «сегодня» не должна
 *  переезжать на вчера из-за часового пояса. */
export function todayIso(now = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function parts(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return { y: y || 0, m: m || 1, d: d || 1 };
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/** Сколько ПОЛНЫХ месяцев прошло от `from` до `to`. Частичный месяц не считается:
 *  проценты начисляются помесячно, поэтому и месяц должен быть целым. */
export function fullMonthsBetween(from, to) {
  if (!isDate(from) || !isDate(to) || to <= from) return 0;
  const a = parts(from);
  const b = parts(to);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;   // 31.01 → 28.02 целым месяцем не считается
  return Math.max(0, months);
}

// ── Нормализация ───────────────────────────────────────────────────────────

function normalizeOperation(input = {}) {
  return {
    id: String(input.id || uid()),
    date: isDate(input.date) ? input.date : todayIso(),
    currency: CURRENCY_IDS.includes(input.currency) ? input.currency : DEFAULT_CURRENCY,
    // Чужое значение в kind не должно превращать расход в приход
    kind: input.kind === 'in' ? 'in' : 'out',
    amount: money(positive(input.amount)),
    counterparty: String(input.counterparty || '').slice(0, 200),
    note: String(input.note || '').slice(0, 500),
    status: String(input.status || '').slice(0, 100),
    source: ['manual', 'shop', 'gold', 'debt'].includes(input.source) ? input.source : 'manual',
    ref: input.ref ? String(input.ref) : null
  };
}

/**
 * Позиция комиссионного магазина. Это не разовая операция, а остаток на складе:
 * продал 3 «Зелья», потом ещё ещё 2 — получится одна позиция на 5 штук.
 */
function normalizeShopItem(input = {}) {
  return {
    id: String(input.id || uid()),
    side: input.side === 'buy' ? 'buy' : 'sell',
    name: String(input.name || '').slice(0, 200),
    price: money(positive(input.price)),
    qty: positive(input.qty),
    date: isDate(input.date) ? input.date : todayIso(),
    note: String(input.note || '').slice(0, 500)
  };
}

function normalizeLoanPayment(input = {}) {
  return {
    id: String(input.id || uid()),
    date: isDate(input.date) ? input.date : todayIso(),
    // На сколько ушло в проценты, а на сколько в тело долга, вычисляется само
    // (paymentSplit) и не хранится: оно выводится из суммы, поэтому не может разойтись с ней
    amount: money(positive(input.amount))
  };
}

function normalizeLoan(input = {}) {
  return {
    id: String(input.id || uid()),
    direction: input.direction === 'borrowed' ? 'borrowed' : 'lent',
    who: String(input.who || '').slice(0, 200),
    principal: money(positive(input.principal)),
    percent: percent(input.percent),
    start: isDate(input.start) ? input.start : todayIso(),
    end: isDate(input.end) ? input.end : '',
    currency: CURRENCY_IDS.includes(input.currency) ? input.currency : DEFAULT_CURRENCY,
    note: String(input.note || '').slice(0, 500),
    payments: (Array.isArray(input.payments) ? input.payments : [])
      .map(normalizeLoanPayment)
      .filter(p => p.amount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  };
}

export function normalizeFinance(input = {}) {
  const raw = input || {};
  const settings = raw.settings || {};
  return {
    operations: (Array.isArray(raw.operations) ? raw.operations : []).map(normalizeOperation)
      // Запись без суммы ничего не значит: нулевой «приход» только раздувает список
      .filter(op => op.amount > 0)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    shopItems: (Array.isArray(raw.shopItems) ? raw.shopItems : []).map(normalizeShopItem)
      .filter(item => item.name && item.qty > 0 && item.price > 0)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    loans: (Array.isArray(raw.loans) ? raw.loans : []).map(normalizeLoan)
      .filter(loan => loan.who && loan.principal > 0),
    settings: {
      // Курс 1 голда в золоте. Зависит от рынка, поэтому хранится вместе с датой
      // последнего изменения: старый курс без даты читался бы как актуальный.
      goldRate: money(positive(settings.goldRate)),
      goldRateAt: isDate(settings.goldRateAt) ? settings.goldRateAt : null,
      commissionPct: commissionPctOf(settings.commissionPct)
    }
  };
}

// ── Реестр ─────────────────────────────────────────────────────────────────

/**
 * Итоги по реестру. Без валюты суммируются обе валюты — это осмысленно только как
 * «сколько всего записей», поэтому для показа денег валюту передают явно.
 */
export function ledgerTotals(operations, currency = null) {
  let income = 0;
  let expense = 0;
  for (const op of operations) {
    if (currency && op.currency !== currency) continue;
    if (op.kind === 'in') income += op.amount;
    else expense += op.amount;
  }
  return { income: money(income), expense: money(expense), balance: money(income - expense) };
}

/** Итоги по каждой валюте сразу: `{ gold: {...}, coins: {...} }`. */
export function ledgerTotalsByCurrency(operations) {
  /** @type {Record<string, {income: number, expense: number, balance: number}>} */
  const out = {};
  for (const id of CURRENCY_IDS) out[id] = ledgerTotals(operations, id);
  return out;
}

export function monthOf(date) {
  return String(date || '').slice(0, 7);
}

const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** «2026-06» → «июнь 2026». Год нужен в подписи: без него «25 сундуков» не найти. */
export function monthLabel(month) {
  const [y, m] = String(month || '').split('-');
  const name = MONTH_NAMES[(Number(m) || 1) - 1];
  return name ? `${name} ${y}` : String(month || '');
}

/**
 * Группировка по месяцам, свежие сверху. Нужна для «Банковских расчетов»: в таблице
 * нарастающий итог считался вручную внутри каждого месяца, здесь он считается сам.
 */
export function groupByMonth(operations) {
  /** @type {Map<string, any[]>} */
  const byMonth = new Map();
  for (const op of operations) {
    const key = monthOf(op.date);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(op);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, ops]) => ({
      month,
      label: monthLabel(month),
      operations: ops,
      totals: ledgerTotalsByCurrency(ops)
    }));
}

/**
 * Нарастающий итог внутри месяца — то, что в таблице было в колонке «Банковские расчеты».
 *
 * Баланс ведётся ПО ВАЛЮТЕ: месяц содержит и золото, и голд, и общий счётчик сложил бы
 * несовместимые величины, а запись в чужой валюте ещё и выпала бы из списка.
 * Валюта в аргументе остаётся как фильтр для тех, кому нужен один счётчик.
 */
export function runningBalance(operations, currency = null) {
  const byDate = operations
    .filter(op => !currency || op.currency === currency)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  /** @type {Record<string, number>} */
  const balances = {};
  return byDate.map(op => {
    const next = (balances[op.currency] || 0) + (op.kind === 'in' ? op.amount : -op.amount);
    balances[op.currency] = money(next);
    return { ...op, balanceAfter: balances[op.currency] };
  });
}

// ── Магазин ────────────────────────────────────────────────────────────────

/** Итог по позиции: цена за штуку × количество. */
export function shopItemTotal(item) {
  return money(positive(item?.price) * positive(item?.qty));
}

/**
 * Сводка по магазину. `sell` — что я выставил (приход золота), `buy` — что я купил
 * (расход золота). Считается по позициям, а не по записям реестра: позицию можно
 * продать не полностью, и тогда она ещё числится на складе.
 */
export function shopTotals(items) {
  const sell = { count: 0, qty: 0, sum: 0 };
  const buy = { count: 0, qty: 0, sum: 0 };
  for (const item of items) {
    const bucket = item.side === 'buy' ? buy : sell;
    bucket.count += 1;
    bucket.qty += positive(item.qty);
    bucket.sum += shopItemTotal(item);
  }
  return {
    sell: { ...sell, qty: positive(sell.qty), sum: money(sell.sum) },
    buy: { ...buy, qty: positive(buy.qty), sum: money(buy.sum) },
    net: money(sell.sum - buy.sum)   // продажи минус покупки: сколько золота заработано
  };
}

/**
 * Найти позицию, в которую нужно долить количество: тот же предмет, та же сторона
 * и та же цена. Новой позицией считается и тот же предмет по другой цене — это другая
 * сделка, и смешивать их в одну строку нельзя, иначе пропадёт вид на реальные цены.
 */
export function findShopItem(items, { side, name, price }) {
  const key = String(name || '').trim().toLowerCase();
  const p = money(price);
  return (items || []).find(item =>
    item.side === side
    && item.name.trim().toLowerCase() === key
    && money(item.price) === p
  ) || null;
}

// ── Голд и комиссия ────────────────────────────────────────────────────────

/**
 * Сделка с голдом. Комиссия берётся ГОЛДОМ, а не золотом — как в игре, и это меняет
 * итоговые числа, поэтому оба значения показываются рядом.
 *
 *   продажа: отдал `coins` голда → получил `coins * rate` золота,
 *            потратив `coins * pct` голда сверху (всего `coins * (1 + pct/100)`).
 *   покупка:  получил `coins` голда → заплатил `coins * rate * (1 + pct/100)` золота.
 *
 * Из-за этого «8% при продаже» съедают не 8% курса, а 8/108 ≈ 7.41%: комиссию считают
 * от номинала, а убыток измеряют от курса. Поэтому здесь есть и `effectiveRate`.
 */
export function goldDeal({ side, coins, rate, commissionPct = DEFAULT_COMMISSION_PCT }) {
  const c = positive(coins);
  const r = positive(rate);
  const pct = commissionPctOf(commissionPct);
  const commissionCoins = money(c * (pct / 100));
  const nominal = money(c * r);
  if (side === 'buy') {
    const commissionGold = money(commissionCoins * r);
    const gold = money(nominal + commissionGold);
    return {
      side, coins: money(c), gold,
      commissionCoins, commissionGold,
      // Покупка: золото делится на полученный голд — во сколько обошёлся 1 голд
      effectiveRate: c > 0 ? money(gold / c) : 0
    };
  }
  const coinsTotal = money(c + commissionCoins);   // продажа: столько голда уходит с руки
  return {
    side, coins: money(c), coinsTotal, gold: nominal,
    commissionCoins,
    commissionGold: 0,   // при продаже комиссия ушла голдом: золото получено целиком
    effectiveRate: coinsTotal > 0 ? money(nominal / coinsTotal) : 0
  };
}

/** Насколько фактический курс хуже номинального, в процентах. Комиссия 8% → 7.41%. */
export function commissionLossPct(effectiveRate, nominalRate) {
  const r = positive(nominalRate);
  if (!r) return 0;
  return money(((r - positive(effectiveRate)) / r) * 100);
}

// ── Долги ──────────────────────────────────────────────────────────────────

/**
 * Начисление процентов и остаток долга на дату.
 *
 * Проценты простые, на остаток тела долга, помесячно: полный месяц считается целиком,
 * неполный — не считается вовсе. Выплата гасит сначала начисленные проценты, остаток
 * идёт в тело долга, поэтому база уменьшается и дальше проценты капают только на
 * остаток — ровно то, ради чего затевалась выплата частями.
 *
 * Считается одним проходом по выплатам в порядке дат: рекурсии между начислением и
 * разбиением выплаты нет, иначе долг с двумя десятками выплат уронил бы стек.
 *
 * @param {any} loan
 * @param {string} asOfIso
 */
export function loanAccrual(loan, asOfIso = todayIso()) {
  const start = loan?.start;
  const end = loan?.end || null;
  // Дальше крайнего срока проценты не идут: долг не должен расти бесконечно
  const cutoff = end && asOfIso > end ? end : asOfIso;
  const rate = percent(loan?.percent) / 100;
  // Без срока проценты не идут: начислять их «бесконечно» нельзя, а loanForecast для
  // такого долга отдаёт 0 месяцев и одну только сумму — иначе эти две функции
  // показывали бы разное и человек не понял бы, сколько отдавать
  const elapsed = end ? fullMonthsBetween(start, cutoff) : 0;

  const payments = (loan?.payments || [])
    .filter(p => p.date <= cutoff)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let outstanding = money(loan?.principal);
  let interest = 0;      // начислено всего
  let interestDue = 0;   // начислено, но ещё не погашено выплатами
  let paid = 0;          // погашено тела долга
  let interestPaid = 0;  // погашено процентов
  let accruedMonths = 0;

  for (const payment of payments) {
    const monthOfPayment = fullMonthsBetween(start, payment.date);
    // Проценты за все целые месяцы до месяца этой выплаты — на тот остаток, который был
    while (accruedMonths < monthOfPayment) {
      const due = outstanding * rate;
      interest += due;
      interestDue += due;
      accruedMonths += 1;
    }
    const amount = money(payment.amount);
    const interestPart = money(Math.min(amount, interestDue));
    const principalPart = money(amount - interestPart);
    interestDue = money(interestDue - interestPart);
    outstanding = money(Math.max(0, outstanding - principalPart));
    paid = money(paid + principalPart);
    interestPaid = money(interestPaid + interestPart);
  }

  // Добираем проценты до текущей даты по остатку, который к этому моменту и есть
  while (accruedMonths < elapsed) {
    const due = outstanding * rate;
    interest += due;
    interestDue += due;
    accruedMonths += 1;
  }

  outstanding = money(Math.max(0, outstanding));
  interest = money(Math.max(0, interest));
  return {
    principal: money(loan?.principal),
    paid,
    interestPaid,
    outstanding,
    interest,
    interestDue: money(Math.max(0, interestDue)),
    total: money(outstanding + interestDue),
    months: elapsed,
    rate: percent(loan?.percent)
  };
}

/**
 * На что распалось конкретное поступление: сначала гасятся начисленные проценты,
 * остаток идёт в тело долга. Так и человек понимает, почему долг уменьшился не на всю
 * сумму, — и это же объясняет, почему дальше проценты считаются с меньшей базы.
 */
export function paymentSplit(loan, payment) {
  const amount = money(positive(payment?.amount));
  const others = {
    ...loan,
    payments: (loan?.payments || []).filter(p => p.id !== payment?.id && p.date < payment?.date)
  };
  const { interestDue } = loanAccrual(others, payment?.date || todayIso());
  const interest = money(Math.min(amount, interestDue));
  return { interest, principal: money(amount - interest) };
}

/** Сколько придётся отдать за весь срок, если выплат не было. */
export function loanForecast(loan) {
  const months = loan.end ? fullMonthsBetween(loan.start, loan.end) : 0;
  const principal = money(loan.principal);
  const interest = money(principal * (percent(loan.percent) / 100) * months);
  return { months, principal, interest, total: money(principal + interest) };
}

/** Остаток, переплата по сроку и признак просрочки — для карточки долга. */
export function loanStatus(loan, asOfIso = todayIso()) {
  const acc = loanAccrual(loan, asOfIso);
  return {
    ...acc,
    term: loanForecast(loan),
    settled: acc.total <= 0,
    overdue: !!loan.end && asOfIso > loan.end && acc.total > 0
  };
}