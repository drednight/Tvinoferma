// @ts-check
// js/modules/finance/model.js
// Раздел «Банк»: реестр движений денег, комиссионный магазин и голд.
// Здесь только чистые функции — без DOM и без state. Их проверяет tests/finance.test.js.
//
// Три идеи, на которых держится всё остальное:
//
// 1. ЕДИНЫЙ РЕЕСТР. Комиссионка, голд и долги не хранят деньги отдельно, а порождают
//    запись в `operations` с пометкой `source`. Иначе появятся три правды о деньгах,
//    которые рано или поздно разойдутся, и остаток перестанет сходиться с суммой строк.
//
// 2. СУММА ВСЕГДА ПОЛОЖИТЕЛЬНАЯ. Получил или потратил — это `kind`, а не знак.
//    Отрицательная сумма в реестре ломает все итоги сразу, поэтому нормализация её отсекает.
//
// 3. ДЕНЬГИ ОКРУГЛЯЮТСЯ ЗДЕСЬ. Сумма, которую видит человек, уже округлена; накопление
//    ошибки от float за год записей незаметно, но итог перестаёт сходиться с суммой строк —
//    а это как раз тот список, который человек пересчитывает глазами.
//
// НЕ СДЕЛАНО (из заготовки js/modules/bank, которая была мёртвой и удалена — сам раздел
// «Банк» живёт здесь):
//   - графики по банку на chart.js — Issue #57;
//   - сводный журнал доходов/расходов отдельным экраном — Issue #56.
// chart.js уже прописан в зависимостях package.json, но кода на нём нет.

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

/** Комиссия комиссионки по умолчанию (процент). */
export const DEFAULT_COMMISSION_PCT = 2;

/**
 * Дней в «месяце» для показа сроков («1 мес. 30 дн.»). Только подпись: сама ставка
 * так не делится, см. INTEREST_DAYS_IN_MONTH.
 */
export const SPAN_DAYS_PER_MONTH = 30;

export function defaultFinance() {
  return {
    operations: [],
    shopItems: [],
    loans: [],
    settings: {
      goldRate: 0,
      commissionPct: DEFAULT_COMMISSION_PCT,
      goldRateAt: null,
      opening: { gold: 0, coins: 0 }
    }
  };
}

// ── Числа и даты ───────────────────────────────────────────────────────────

/**
 * Деньги округляются до копеек: сумма в реестре, показанная глазом, обязана сходиться.
 * Это округление по умолчанию — для валют, где копейки бывают (сейчас это Голд).
 */
export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Округление под конкретную валюту. Золото в игре ходит ЦЕЛЫМИ числами, а Голд бывает
 * дробным (цены, комиссия, проценты), поэтому валюта решает, что показывать.
 * Разные валюты в одном расчёте смешивать нельзя: одна и та же сумма золота,
 * посчитанная по-разному, дала бы разные остатки.
 */
export function roundFor(currency, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return currency === CURRENCIES.gold.id ? Math.round(n) : money(n);
}

/** Округлённое число с разделителями — для показа в интерфейсе. */
export function formatAmount(currency, value) {
  const n = roundFor(currency, value);
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
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

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/** Дата как UTC-полночь: разница в днях не должна зависеть от перехода на летнее время. */
function dateMs(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return Date.UTC(y || 0, (m || 1) - 1, d || 1);
}

/** Целых дней от `from` до `to`. Обратный порядок и битые даты дают 0. */
export function daysBetween(from, to) {
  if (!isDate(from) || !isDate(to) || to <= from) return 0;
  return Math.round((dateMs(to) - dateMs(from)) / 86400000);
}

/** Дней в календарном месяце — для подписей и отчёта, не для начисления ставки. */
export function daysInMonth(iso) {
  const [y, m] = String(iso || '').split('-').map(Number);
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function nextMonthIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const target = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const last = daysInMonth(`${target}-01`);
  // Выдача 31-го, а в следующем месяце 30 дней: отрезок обрывается в последний день
  return `${target}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Разбивка периода на месячные отрезки: от даты выдачи к такой же дате следующего месяца
 * («с 15-го по 15-е»). Каждый отрезок отдаёт `length` — свою полную длину в днях, и
 * `days` — сколько из них реально прошло.
 *
 * Делитель — длина САМОГО отрезка, а не число дней в каком-то месяце: полный отрезок
 * это ровно один месяц и стоит ровно месячную ставку, а неполный — её долю. Так 01.01→01.02
 * (31 день) и 01.02→01.03 (28 дней) стоят одинаково, потому что оба — один месяц.
 */
function monthChunks(from, to) {
  const chunks = [];
  let cursor = from;
  let guard = 0;   // страховка от зацикливания на битой дате
  while (cursor < to && guard++ < 1200) {
    const boundary = nextMonthIso(cursor);
    const length = daysBetween(cursor, boundary) || 1;
    const end = boundary < to ? boundary : to;
    const days = daysBetween(cursor, end);
    if (days > 0) chunks.push({ from: cursor, to: end, days, length });
    cursor = end;
  }
  return chunks;
}

/** Проценты за отрезок: полный отрезок = месячная ставка, неполный = его доля. */
function interestOver(principal, percentPerMonth, from, to) {
  return monthChunks(from, to)
    .reduce((sum, c) => sum + principal * percent(percentPerMonth) / 100 * c.days / c.length, 0);
}

/** «30 дней» → «1 мес.» — для карточки долга. */
export function spanLabel(days) {
  const d = Math.max(0, Math.round(Number(days) || 0));
  const months = Math.floor(d / SPAN_DAYS_PER_MONTH);
  const rest = d % SPAN_DAYS_PER_MONTH;
  if (!months) return `${d} дн.`;
  return rest ? `${months} мес. ${rest} дн.` : `${months} мес.`;
}

// ── Нормализация ───────────────────────────────────────────────────────────

function normalizeOperation(input = {}) {
  const currency = CURRENCY_IDS.includes(input.currency) ? input.currency : DEFAULT_CURRENCY;
  return {
    id: String(input.id || uid()),
    date: isDate(input.date) ? input.date : todayIso(),
    currency,
    // Чужое значение в kind не должно превращать расход в приход
    kind: input.kind === 'in' ? 'in' : 'out',
    // Валюта задана выше: округляем под неё, иначе сумма золота с хвостом проскочила бы
    // в реестр и остаток перестал бы сходиться
    amount: roundFor(currency, positive(input.amount)),
    counterparty: String(input.counterparty || '').slice(0, 200),
    note: String(input.note || '').slice(0, 500),
    status: String(input.status || '').slice(0, 100),
    source: ['manual', 'shop', 'gold', 'debt'].includes(input.source) ? input.source : 'manual',
    ref: input.ref ? String(input.ref) : null
  };
}

/**
 * Позиция комиссионки. Это остаток на складе, а не разовая операция: продал 3 «Зелья»,
 * потом ещё 2 — получится одна позиция на 5 штук, а списание уменьшает количество.
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
    // id записи в реестре, которой открыт этот долг: по нему правка суммы долга
    // обновляет и саму запись, а не ищет её угадыванием по дате
    opId: input.opId ? String(input.opId) : null,
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
    // Позиция без количества — проданная подчистую: держать её незачем, деньги уже в реестре
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
      commissionPct: commissionPctOf(settings.commissionPct),
      // Остаток на начало ведения реестра (строка «Перенос прошлого месяца» в таблицах).
      // Это НЕ операция: реестр хранит только движения, а сколько было «до» — отдельно.
      // Без этого баланс = сумма всех движений за все месяцы, что в разы больше реального остатка.
      opening: normalizeOpening(settings.opening),
      // Поправки по месяцам: `{ "2026-09": -260000000 }`. Переносы в таблице сходятся
      // не всегда (перенос ≠ перенос прошлого + движения), поэтому каждый месяц несёт
      // свою поправку — тогда итог месяца совпадает с колонкой «Банк» из таблицы.
      monthAdjust: normalizeMonthAdjust(settings.monthAdjust),
      // Перенос прошлого месяца внутри итога. Нужен панели: «за месяц» показывают
      // без него (накопленное за месяц), а не итог вместе с чужими деньгами.
      monthCarry: normalizeMonthAdjust(settings.monthCarry)
    }
  };
}

/** Поправки по месяцам: только числа по валютам, лишнее выбрасываем. */
function normalizeMonthAdjust(input) {
  const raw = input && typeof input === 'object' ? input : {};
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const [month, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const perCurrency = value && typeof value === 'object' ? value : {};
    /** @type {Record<string, number>} */
    const amounts = {};
    for (const id of CURRENCY_IDS) {
      const n = roundFor(id, Number(perCurrency[id]) || 0);
      if (n) amounts[id] = n;
    }
    if (Object.keys(amounts).length) out[month] = amounts;
  }
  return out;
}

/** Начальный остаток по валютам: `{ gold: 123, coins: 0 }`. */
function normalizeOpening(input) {
  const raw = input && typeof input === 'object' ? input : {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const id of CURRENCY_IDS) out[id] = roundFor(id, Number(raw[id]) || 0);
  return out;
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
  // Округляем под валюту: сумма целых строк золота и сама обязана остаться целой
  const id = currency || DEFAULT_CURRENCY;
  return {
    income: roundFor(id, income),
    expense: roundFor(id, expense),
    balance: roundFor(id, income - expense)
  };
}

/** Итоги по каждой валюте сразу: `{ gold: {...}, coins: {...} }`. */
export function ledgerTotalsByCurrency(operations) {
  /** @type {Record<string, {income: number, expense: number, balance: number}>} */
  const out = {};
  for (const id of CURRENCY_IDS) out[id] = ledgerTotals(operations, id);
  return out;
}

/**
 * Сколько сейчас в наличии по каждой валюте — для блока «Банк» и форм сделки.
 * `opening` — остаток на начало реестра: без него итог был бы суммой всех движений
 * за всю историю, то есть в разы больше того, что лежит на руках.
 */
export function balances(operations, opening = null) {
  const totals = ledgerTotalsByCurrency(operations);
  return CURRENCY_IDS.reduce((acc, id) => {
    acc[id] = roundFor(id, totals[id].balance + (Number(opening?.[id]) || 0));
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
}

/**
 * Сколько сейчас в наличии. Месяцы в таблице не сходятся между собой (перенос ≠
 * итог прошлого месяца), поэтому «сейчас» — это итог САМОГО СВЕЖЕГО месяца, а не
 * сумма движений за всю историю: поправки месяцев заданы как абсолютные итоги.
 * Если поправок нет, поведение прежнее: движения + начальный остаток.
 */
export function currentBalances(finance) {
  const { operations, settings } = finance;
  const adjust = settings?.monthAdjust;
  const hasAdjust = adjust && Object.keys(adjust).length > 0;
  const newest = groupByMonth(operations, adjust)[0];
  if (hasAdjust && newest) {
    return CURRENCY_IDS.reduce((acc, id) => {
      acc[id] = roundFor(id, newest.totals[id].balance);
      return acc;
    }, /** @type {Record<string, number>} */ ({}));
  }
  return balances(operations, settings?.opening);
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
export function groupByMonth(operations, monthAdjust = null) {
  /** @type {Map<string, any[]>} */
  const byMonth = new Map();
  for (const op of operations) {
    const key = monthOf(op.date);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(op);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, ops]) => {
      const totals = ledgerTotalsByCurrency(ops);
      // Поправка месяца (перенос из таблицы): правит итог, не трогая записи
      for (const id of CURRENCY_IDS) {
        const fix = Number(monthAdjust?.[month]?.[id]) || 0;
        if (fix) totals[id].balance = roundFor(id, totals[id].balance + fix);
      }
      return { month, label: monthLabel(month), operations: ops, totals };
    });
}

// ── Комиссионка ────────────────────────────────────────────────────────────

/** Итог по позиции: цена за штуку × сколько осталось на складе. */
export function shopItemTotal(item) {
  return roundFor(DEFAULT_CURRENCY, positive(item?.price) * positive(item?.qty));
}

/**
 * Сводка по тому, что сейчас на складе. Считается по позициям, а не по записям реестра:
 * проданная часть уже вычтена из количества и живёт в реестре отдельной записью.
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
    sell: { ...sell, qty: positive(sell.qty), sum: roundFor(DEFAULT_CURRENCY, sell.sum) },
    buy: { ...buy, qty: positive(buy.qty), sum: roundFor(DEFAULT_CURRENCY, buy.sum) },
    net: roundFor(DEFAULT_CURRENCY, sell.sum - buy.sum)
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

/**
 * Продажа или покупка части позиции. Возвращает запись в реестр: деньги двигаются
 * один раз, а количество на складе уменьшается на проданное.
 *
 * Продажа — приход Золота, покупка — расход. Комиссионка торгует именно за Золото.
 */
export function shopDealOperation({ item, qty, date = todayIso() }) {
  const sold = item.side !== 'buy';
  const count = money(positive(qty));
  return {
    id: uid(),
    date,
    kind: sold ? 'in' : 'out',
    currency: DEFAULT_CURRENCY,
    // Цена в комиссионке — целое золото, поэтому и произведение целое
    amount: roundFor(DEFAULT_CURRENCY, positive(item.price) * count),
    counterparty: `Банк · ${sold ? 'продажа' : 'покупка'} ${item.name} ×${count}`,
    note: '',
    status: '',
    source: 'shop',
    ref: item.id
  };
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
 * Из-за этого комиссия съедает не `pct%` курса, а `pct/100/(1 + pct/100)`:
 * комиссию считают от номинала, а убыток измеряют от курса. Поэтому здесь есть
 * и `effectiveRate`.
 */
export function goldDeal({ side, coins, rate, commissionPct = DEFAULT_COMMISSION_PCT }) {
  const c = positive(coins);
  const r = positive(rate);
  const pct = commissionPctOf(commissionPct);
  // Голд округляется копейками, золото — до целого: купленный/проданный голд с хвостом
  // в реестр не попадает, а сумма золота всегда та, что показана в интерфейсе
  const gold = (v) => roundFor(CURRENCIES.gold.id, v);
  // Курс — это цена за 1 голд, а не сумма золота: округлять его до целых нельзя,
  // иначе «980 392» вместо «980 392,16» выглядело бы как потеря в комиссии
  const perCoin = (v) => money(v);
  const commissionCoins = money(c * (pct / 100));
  const nominal = gold(c * r);
  if (side === 'buy') {
    const commissionGold = gold(commissionCoins * r);
    return {
      side, coins: money(c), coinsTotal: money(c), gold: gold(nominal + commissionGold),
      commissionCoins, commissionGold,
      // Покупка: золото делится на полученный голд — во сколько обошёлся 1 голд
      effectiveRate: c > 0 ? perCoin(gold(nominal + commissionGold) / c) : 0
    };
  }
  const coinsTotal = money(c + commissionCoins);   // продажа: столько голда уходит с руки
  return {
    side, coins: money(c), coinsTotal, gold: nominal,
    commissionCoins,
    commissionGold: 0,   // при продаже комиссия ушла голдом: золото получено целиком
    effectiveRate: coinsTotal > 0 ? perCoin(nominal / coinsTotal) : 0
  };
}

/**
 * Сделка с голдом — это ДВЕ записи в реестре, а не одна: голд всегда уходит в одну
 * сторону, золото — в другую. Записать только золото (как было) означалоло бы, что
 * купленный голд нигде не появился и наличные разошлись с остатком.
 */
export function goldDealOperations({ side, coins, rate, commissionPct, date = todayIso() }) {
  const deal = goldDeal({ side, coins, rate, commissionPct });
  const sold = side !== 'buy';
  const label = sold ? 'Продажа голда' : 'Покупка голда';
  const note = `${deal.coins} голд по курсу ${money(rate)}, комиссия ${deal.commissionCoins} голд`;
  return {
    deal,
    operations: [
      {
        id: uid(), date,
        kind: sold ? 'out' : 'in',
        currency: 'coins',
        // При продаже с рук уходит голд вместе с комиссией, при покупке — ровно купленное
        amount: sold ? deal.coinsTotal : deal.coins,
        counterparty: `Голд · ${sold ? 'продано' : 'куплено'}`,
        note, status: '', source: 'gold', ref: null
      },
      {
        id: uid(), date,
        kind: sold ? 'in' : 'out',
        currency: 'gold',
        amount: deal.gold,
        counterparty: label,
        note, status: '', source: 'gold', ref: null
      }
    ]
  };
}

/** Насколько фактический курс хуже номинального, в процентах. */
export function commissionLossPct(effectiveRate, nominalRate) {
  const r = positive(nominalRate);
  if (!r) return 0;
  return money(((r - positive(effectiveRate)) / r) * 100);
}

// ── Долги ──────────────────────────────────────────────────────────────────

/**
 * Начисление процентов и остаток долга на дату.
 *
 * Линейные проценты с ежедневной базой по календарю: месячная ставка делится на число
 * дней СВОЕГО месяца, а месячные отрезки идут от даты выдачи к такой же дате следующего
 * месяца. За полный отрезок начисляется ровно месячная ставка, за неполный — его доля
 * по календарю: в феврале на день приходится больше, чем в марте, и «деление на 30»
 * это размазывало. Выплата гасит сначала начисленные проценты, остаток идёт в тело
 * долга, поэтому база уменьшается и дальше проценты капают только на остаток.
 *
 * Считается одним проходом по выплатам в порядке дат: рекурсии между начислением и
 * разбиением выплаты нет, иначе долг с двумя десятками выплат уронил бы стек.
 *
 * @param {any} loan
 * @param {string} asOfIso
 */
export function loanAccrual(loan, asOfIso = todayIso()) {
  // Долг живёт в одной валюте, и округление процентов — тоже под неё: золото целое,
  // и набежавшие 0,4 процента не должны превращаться в лишнее золото у каждого
  // месячного отрезка и накапливаться за срок
  const round = (v) => roundFor(loan?.currency || DEFAULT_CURRENCY, v);
  const start = loan?.start;
  const end = loan?.end || null;
  // Проценты не идут дальше крайнего срока: иначе долг, который пережил срок, рос бы вечно
  const accrueUntil = end && asOfIso > end ? end : asOfIso;
  // Но ВЫПЛАТЫ после срока засчитываются: долг могли закрыть в octябре, и показывать
  // его как непогашенный было бы неверно. Просто отсекать их по дате срока нельзя —
  // именно это делало «Выплатить всё» бесполезным.
  // Без срока проценты не идут: начислять их «бесконечно» нельзя, иначе эта функция
  // показывала бы одно, а loanForecast — другое
  const accrues = !!end;

  // Отсекаются только выплаты БУДУЩЕЕ, то есть позже даты расчёта. Раньше стоял
  // отсев по дате срока — из-за него выплата после срока не засчитывалась вовсе.
  const payments = (loan?.payments || [])
    .filter(p => p.date <= asOfIso)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let outstanding = round(loan?.principal);
  let interest = 0;      // начислено всего
  let interestDue = 0;   // начислено, но ещё не погашено выплатами
  let paid = 0;          // погашено тела долга
  let interestPaid = 0;  // погашено процентов
  let cursor = start;

  const accrueTo = (to) => {
    if (!accrues || to <= cursor) { cursor = to; return; }
    for (const chunk of monthChunks(cursor, to)) {
      const due = outstanding * percent(loan?.percent) / 100 * chunk.days / chunk.length;
      interest += due;
      interestDue += due;
    }
    cursor = to;
  };

  for (const payment of payments) {
    // Начисляем только до даты выплаты и только пока идёт срок: выплата в октябре
    // по долгу, закончившемуся в июле, проценты сверх срока не тянет
    accrueTo(payment.date > accrueUntil ? accrueUntil : payment.date);
    const amount = round(payment.amount);
    const interestPart = round(Math.min(amount, interestDue));
    const principalPart = round(amount - interestPart);
    interestDue = round(interestDue - interestPart);
    outstanding = round(Math.max(0, outstanding - principalPart));
    paid = round(paid + principalPart);
    interestPaid = round(interestPaid + interestPart);
  }
  accrueTo(accrueUntil);

  outstanding = round(Math.max(0, outstanding));
  interest = round(Math.max(0, interest));
  return {
    principal: round(loan?.principal),
    paid,
    interestPaid,
    outstanding,
    interest,
    interestDue: round(Math.max(0, interestDue)),
    total: round(outstanding + Math.max(0, interestDue)),
    days: daysBetween(start, accrueUntil),
    rate: percent(loan?.percent)
  };
}

/**
 * На что распалось конкретное поступление: сначала гасятся начисленные проценты,
 * остаток идёт в тело долга. Так и человек понимает, почему долг уменьшился не на всю
 * сумму, — и это же объясняет, почему дальше проценты считаются с меньшей базы.
 */
export function paymentSplit(loan, payment) {
  const round = (v) => roundFor(loan?.currency || DEFAULT_CURRENCY, v);
  const amount = round(positive(payment?.amount));
  const others = {
    ...loan,
    payments: (loan?.payments || []).filter(p => p.id !== payment?.id && p.date < payment?.date)
  };
  const { interestDue } = loanAccrual(others, payment?.date || todayIso());
  const interest = round(Math.min(amount, interestDue));
  return { interest, principal: round(amount - interest) };
}

/** Сколько придётся отдать за весь срок, если выплат не было. */
export function loanForecast(loan) {
  const round = (v) => roundFor(loan?.currency || DEFAULT_CURRENCY, v);
  const days = loan?.end ? daysBetween(loan.start, loan.end) : 0;
  const principal = round(loan.principal);
  const interest = round(loan?.end ? interestOver(principal, loan.percent, loan.start, loan.end) : 0);
  return { days, principal, interest, total: round(principal + interest) };
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

/**
 * Долг — это тоже движение денег: отдал в долг = расход из остатка, взял в долг =
 * приход. Без этой записи остаток в «Банке» врал бы на всю сумму долга, хотя деньги
 * физически ушли или пришли.
 */
export function loanOperation(loan, date = null) {
  const lent = loan?.direction !== 'borrowed';
  const pct = percent(loan?.percent);
  const end = loan?.end || null;
  return {
    id: loan?.opId || uid(),
    date: date || loan?.start || todayIso(),
    kind: lent ? 'out' : 'in',
    currency: loan?.currency || DEFAULT_CURRENCY,
    amount: roundFor(loan?.currency || DEFAULT_CURRENCY, loan?.principal),
    counterparty: lent ? `Дал в долг — ${loan?.who || ''}` : `Взял в долг — ${loan?.who || ''}`,
    note: loan?.note || (pct ? `${pct}%${end ? ` до ${end}` : ', без срока'}` : ''),
    status: '',
    source: 'debt',
    ref: loan?.id || null
  };
}