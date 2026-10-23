// Чистая логика раздела «Банк» (js/modules/finance/model.js).
// Здесь нет DOM и нет state — только деньги, комиссия и начисление процентов,
// поэтому проверяется без запуска приложения.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  goldDeal,
  commissionLossPct,
  loanAccrual,
  loanForecast,
  loanStatus,
  paymentSplit,
  normalizeFinance,
  ledgerTotals,
  ledgerTotalsByCurrency,
  shopTotals,
  shopItemTotal,
  findShopItem,
  money,
  todayIso,
  daysBetween,
  daysInMonth,
  roundFor,
  formatAmount,
  formatInputNumber,
  spanLabel,
  balances,
  currentBalances,
  groupByMonth,
  shopDealOperation,
  loanOperation,
  goldDealOperations
} from '../js/modules/finance/model.js';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

/** Долг под 5% на полгода: 01.01 → 01.07. */
/**
 * Долг с процентами, где нужны копейки. Основной долг золотой и на нём считается
 * ровно; для проверки дробных процентов есть отдельные тесты ниже.
 */
const LOAN = {
  principal: 10000,
  percent: 5,
  start: '2026-01-01',
  end: '2026-07-01',
  currency: 'coins',
  payments: []
};

describe('дни между датами', () => {
  it('считает целые дни', () => {
    expect(daysBetween('2026-01-01', '2026-02-01')).toBe(31);
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(28);
    expect(daysBetween('2024-02-01', '2024-03-01')).toBe(29); // високосный год
    expect(daysBetween('2026-01-01', '2026-01-15')).toBe(14);
  });

  it('обратный порядок, совпадение дат и битые даты дают ноль', () => {
    expect(daysBetween('2026-07-01', '2026-01-01')).toBe(0);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
    expect(daysBetween('', '2026-07-01')).toBe(0);
    expect(daysBetween('2026-01-01', 'ерунда')).toBe(0);
  });

  it('число дней в месяце знает про високосный февраль', () => {
    expect(daysInMonth('2026-02-01')).toBe(28);
    expect(daysInMonth('2024-02-01')).toBe(29);
    expect(daysInMonth('2026-04-01')).toBe(30);
    expect(daysInMonth('2026-12-01')).toBe(31);
  });

  it('срок подписывается месяцами и днями', () => {
    expect(spanLabel(0)).toBe('0 дн.');
    expect(spanLabel(14)).toBe('14 дн.');
    expect(spanLabel(30)).toBe('1 мес.');
    expect(spanLabel(45)).toBe('1 мес. 15 дн.');
  });
});

describe('децималы зависят от валюты', () => {
  it('золото округляется до целых, голд сохраняет копейки', () => {
    expect(roundFor('gold', 10.4)).toBe(10);
    expect(roundFor('gold', 10.5)).toBe(11);
    expect(roundFor('coins', 10.44)).toBe(10.44);
    expect(roundFor('coins', 10.445)).toBe(10.45);
  });

  it('мусор и не-числа дают ноль, а не NaN', () => {
    expect(roundFor('gold', 'ерунда')).toBe(0);
    expect(roundFor('coins', undefined)).toBe(0);
    expect(roundFor('gold', Infinity)).toBe(0);
  });

  it('запись золота с хвостом обрезается, голд — нет', () => {
    const [gold] = normalizeFinance({ operations: [{ amount: 100.7, currency: 'gold' }] }).operations;
    const [coins] = normalizeFinance({ operations: [{ amount: 100.7, currency: 'coins' }] }).operations;
    expect(gold.amount).toBe(101);
    expect(coins.amount).toBe(100.7);
  });

  it('остаток золота остаётся целым, даже если строк было много', () => {
    const ops = Array.from({ length: 37 }, () => ({ amount: 10.5, currency: 'gold', kind: 'in', date: '2026-06-01' }));
    const totals = ledgerTotals(ops, 'gold');
    expect(Number.isInteger(totals.income)).toBe(true);
    expect(Number.isInteger(totals.balance)).toBe(true);
  });

  it('у голда децималы живут, и сумма строк совпадает с итогом', () => {
    const ops = Array.from({ length: 37 }, () => ({ amount: 10.5, currency: 'coins', kind: 'in', date: '2026-06-01' }));
    const totals = ledgerTotals(ops, 'coins');
    expect(totals.income).toBe(388.5); // 37 × 10,5 — ровно
  });

  it('сумма золота в реестре всегда целая — иначе остаток не сошёлся бы', () => {
    const ops = normalizeFinance({
      operations: [
        { amount: 10.5, currency: 'gold', kind: 'in' },
        { amount: 0.4, currency: 'gold', kind: 'in' }
      ]
    }).operations;
    expect(ops.every(o => Number.isInteger(o.amount))).toBe(true);
  });

  it('проценты округляются под валюту долга', () => {
    // 1000 под 5% за один день января = 1000 × 0,05 / 31 = 1,6129.
    // В золоте это 2 целых, в голде остаётся 1,61. Проверено вручную.
    const base = { principal: 1000, percent: 5, start: '2026-01-01', end: '2026-01-02', payments: [] };
    expect(loanAccrual({ ...base, currency: 'gold' }, '2026-01-02').interest).toBe(2);
    expect(loanAccrual({ ...base, currency: 'coins' }, '2026-01-02').interest).toBe(1.61);
  });

  it('мелкий золотой долг не дорисовывает золото из воздуха', () => {
    // 1 золото под 5% за 5 месяцев = 0,25 золота: меньше целого, поэтому ноль,
    // а в голде те же 0,25 остаются дробью
    const base = { principal: 1, percent: 5, start: '2026-01-01', end: '2026-06-01', payments: [] };
    const inGold = loanAccrual({ ...base, currency: 'gold' }, '2026-06-01');
    const inCoins = loanAccrual({ ...base, currency: 'coins' }, '2026-06-01');
    expect(inGold.interest).toBe(0);
    expect(inCoins.interest).toBe(0.25);
  });

  it('проценты золотого долга всегда целые', () => {
    const acc = loanAccrual(
      { principal: 999, percent: 5, start: '2026-01-01', end: '2026-03-01', currency: 'gold', payments: [] },
      '2026-03-01'
    );
    for (const key of ['interest', 'interestDue', 'total', 'outstanding']) {
      expect(Number.isInteger(acc[key])).toBe(true);
    }
  });

  it('формат вывода золота без дробной части, голд с ней', () => {
    expect(formatAmount('gold', 1234.7)).toBe(new Intl.NumberFormat('ru-RU').format(1235));
    expect(formatAmount('coins', 1234.55)).toBe(
      new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(1234.55)
    );
  });
});

describe('пробелы в полях сумм', () => {
  it('разделяет разряды пробелами по три цифры', () => {
    expect(formatInputNumber('242982166')).toBe('242 982 166');
    expect(formatInputNumber(1000)).toBe('1 000');
    expect(formatInputNumber('1234567890123')).toBe('1 234 567 890 123');
  });

  it('сохраняет дробную часть и разделитель, который ввели', () => {
    expect(formatInputNumber('1234,5')).toBe('1 234,5');
    expect(formatInputNumber('1234567.89')).toBe('1 234 567.89');
  });

  it('снимает уже расставленные пробелы и мусор, ничего не накапливая', () => {
    expect(formatInputNumber('1 000')).toBe('1 000');
    expect(formatInputNumber(' 242 982 166 ')).toBe('242 982 166');
    expect(formatInputNumber('1 000 abc')).toBe('1 000');
  });

  it('пустое и нечисловое дают пустое, а не NaN', () => {
    expect(formatInputNumber('')).toBe('');
    expect(formatInputNumber(null)).toBe('');
    expect(formatInputNumber(undefined)).toBe('');
  });
});

describe('голд и комиссия 2%', () => {
  it('по умолчанию комиссия 2%, и она берётся голдом', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000 });
    expect(deal.commissionCoins).toBe(20); // ровно его пример: «20 голды»
    expect(deal.coinsTotal).toBe(1020);
    expect(deal.gold).toBe(1000000000);
    expect(deal.effectiveRate).toBe(980392.16); // 1 000 000 000 / 1020
  });

  it('потеря курса от комиссии 2% равна 1.96%, а не 2%', () => {
    // Ключевая проверка: комиссию считают от номинала, а убыток измеряют от курса,
    // поэтому 2% превращаются в 2/102. Проверено вручную: 1 − 1000/1020 = 1.9608%
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 2 });
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(1.96);
  });

  it('при комиссии 8% потеря была бы 7.41% — пересчёт для сравнения', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 8 });
    expect(deal.commissionCoins).toBe(80);
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(7.41);
  });

  it('покупка: комиссия добавкой к золоту, 1 голд обходится в 102% курса', () => {
    const deal = goldDeal({ side: 'buy', coins: 1000, rate: 1000000, commissionPct: 2 });
    expect(deal.commissionCoins).toBe(20);
    expect(deal.commissionGold).toBe(20000000);
    expect(deal.gold).toBe(1020000000);
    expect(deal.effectiveRate).toBe(1020000);
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(-2);
  });

  it('нулевой курс не делит на ноль', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 0, commissionPct: 2 });
    expect(deal.effectiveRate).toBe(0);
    expect(deal.gold).toBe(0);
    expect(goldDeal({ side: 'sell', coins: 0, rate: 1000000 }).effectiveRate).toBe(0);
  });
});

describe('сделка с голдом пишет обе валюты', () => {
  it('продажа: голд уходит, золото приходит', () => {
    const { operations } = goldDealOperations({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 2 });
    expect(operations).toHaveLength(2);
    const coins = operations.find(o => o.currency === 'coins');
    const gold = operations.find(o => o.currency === 'gold');
    expect(coins.kind).toBe('out');
    expect(coins.amount).toBe(1020); // 1000 + комиссия 20
    expect(gold.kind).toBe('in');
    expect(gold.amount).toBe(1000000000);
  });

  it('покупка: голд приходит в остаток, золото уходит', () => {
    // Регрессия: раньше записывался только расход золота, и купленный голд нигде
    // не появлялся — наличные расходились с остатком
    const { operations } = goldDealOperations({ side: 'buy', coins: 1000, rate: 1000000, commissionPct: 2 });
    const coins = operations.find(o => o.currency === 'coins');
    const gold = operations.find(o => o.currency === 'gold');
    expect(coins.kind).toBe('in');
    expect(coins.amount).toBe(1000);
    expect(gold.kind).toBe('out');
    expect(gold.amount).toBe(1020000000);
  });

  it('обе записи пополняют остаток так, что он сходится с деньгами', () => {
    const { operations } = goldDealOperations({ side: 'buy', coins: 1000, rate: 1000000, commissionPct: 2 });
    const now = balances(operations);
    expect(now.coins).toBe(1000);
    expect(now.gold).toBe(-1020000000);
  });
});

describe('деньги долга и комиссионки попадают в «Банк»', () => {
  it('дал в долг — расход из остатка', () => {
    const op = loanOperation({
      id: 'l1',
      direction: 'lent',
      who: 'Шкила',
      principal: 10000,
      percent: 5,
      start: '2026-01-01',
      end: '2026-07-01'
    });
    expect(op.kind).toBe('out');
    expect(op.amount).toBe(10000);
    expect(op.currency).toBe('gold');
    expect(op.counterparty).toContain('Шкила');
    expect(balances([op]).gold).toBe(-10000);
  });

  it('взял в долг — приход в остаток', () => {
    const op = loanOperation({
      id: 'l2',
      direction: 'borrowed',
      who: 'Ракохаме',
      principal: 2000,
      percent: 3,
      start: '2026-01-01',
      end: '2026-07-01'
    });
    expect(op.kind).toBe('in');
    expect(balances([op]).gold).toBe(2000);
  });

  it('продажа позиции комиссионки — приход золота', () => {
    const item = { id: 'i1', side: 'sell', name: 'Зелье', price: 120000, qty: 5 };
    const op = shopDealOperation({ item, qty: 2 });
    expect(op.kind).toBe('in');
    expect(op.amount).toBe(240000); // 120000 × 2
    expect(op.counterparty).toContain('Банк');
    expect(op.source).toBe('shop');
    expect(op.ref).toBe('i1');
  });

  it('покупка позиции комиссионки — расход золота', () => {
    const item = { id: 'i2', side: 'buy', name: 'Меч', price: 250000, qty: 4 };
    const op = shopDealOperation({ item, qty: 1 });
    expect(op.kind).toBe('out');
    expect(op.amount).toBe(250000);
  });
});

describe('долг: проценты на остаток, ежедневно по календарю', () => {
  it('без выплат за 6 полных месяцев под 5% начисляет 3000', () => {
    // 6 отрезков «с 1-го по 1-е», каждый = ровно месячная ставка. Проверено вручную:
    // 01.01→01.02 (31 день) и 01.02→01.03 (28 дней) стоят одинаково — это один месяц
    const acc = loanAccrual(LOAN, '2026-07-01');
    expect(acc.interest).toBe(3000);
    expect(acc.outstanding).toBe(10000);
    expect(acc.total).toBe(13000);
    expect(acc.days).toBe(181);
  });

  it('полный месяц стоит месячную ставку независимо от числа дней в нём', () => {
    const rate = (start, end) => loanAccrual({ ...LOAN, start, end }, end).interest;
    expect(rate('2026-01-01', '2026-02-01')).toBe(500); // 31 день
    expect(rate('2026-02-01', '2026-03-01')).toBe(500); // 28 дней
    expect(rate('2024-02-01', '2024-03-01')).toBe(500); // високосный, 29 дней
    expect(rate('2026-01-15', '2026-02-15')).toBe(500); // выдача 15-го
  });

  it('выдача 31-го обрывается в последний день месяца и всё равно стоит месяц', () => {
    expect(loanAccrual({ ...LOAN, start: '2026-01-31', end: '2026-02-28' }, '2026-02-28').interest).toBe(500);
  });

  it('неполный отрезок стоит ровно свою долю месяца', () => {
    // 14 дней из 31 → 500 × 14/31 = 225,81
    expect(loanAccrual({ ...LOAN, end: '2026-01-15' }, '2026-01-15').interest).toBe(225.81);
    // один день января: 500 / 31
    expect(loanAccrual({ ...LOAN, end: '2026-01-02' }, '2026-01-02').interest).toBe(16.13);
  });

  it('смена месяца меняет цену дня: в феврале день дороже, чем в марте', () => {
    const perDayJan = loanAccrual({ ...LOAN, end: '2026-01-02' }, '2026-01-02').interest;
    const perDayFeb = loanAccrual({ ...LOAN, start: '2026-02-01', end: '2026-02-02' }, '2026-02-02').interest;
    expect(perDayFeb).toBeGreaterThan(perDayJan); // 500/28 > 500/31
  });

  it('выплата 5000 на 4-й месяц гасит проценты, а остаток уменьшает базу', () => {
    // 3 месяца на базе 10 000 → 1500 процентов, из выплаты 1500 гасят проценты
    // и 3500 — тело долга. Дальше 3 месяца проценты капают уже на 6500.
    const loan = { ...LOAN, payments: [{ id: 'p1', date: '2026-04-01', amount: 5000 }] };
    const acc = loanAccrual(loan, '2026-07-01');
    expect(acc.interestPaid).toBe(1500);
    expect(acc.paid).toBe(3500);
    expect(acc.outstanding).toBe(6500);
    expect(acc.interest).toBe(2475); // 1500 + 3 × 6500 × 0.05
    expect(acc.interestDue).toBe(975); // не погашенные проценты после выплаты
    expect(acc.total).toBe(7475); // 6500 тела + 975 процентов
  });

  it('выплата разбивается: сначала проценты, потом тело долга', () => {
    const split = paymentSplit(LOAN, { id: 'p1', date: '2026-04-01', amount: 5000 });
    expect(split.interest).toBe(1500);
    expect(split.principal).toBe(3500);
  });

  it('выплата меньше начисленных процентов целиком уходит в проценты', () => {
    const split = paymentSplit(LOAN, { id: 'p1', date: '2026-03-01', amount: 400 });
    expect(split.interest).toBe(400);
    expect(split.principal).toBe(0);
  });

  it('в первый день процентов ещё нет, на второй уже есть', () => {
    expect(loanAccrual(LOAN, '2026-01-01').interest).toBe(0);
    expect(loanAccrual(LOAN, '2026-01-02').interest).toBe(16.13);
  });

  it('после крайнего срока проценты не идут', () => {
    expect(loanAccrual(LOAN, '2027-07-01').interest).toBe(3000);
    expect(loanAccrual(LOAN, '2027-07-01').days).toBe(181);
  });

  it('выплата ПОСЛЕ срока засчитывается, а проценты сверх срока не капают', () => {
    // Регрессия: выплаты фильтровались по дате срока, и «Выплатить всё» не работало:
    // долг, закрытый после срока, навсегда оставался с остатком. Проверено вручную.
    const loan = { ...LOAN, payments: [{ id: 'p1', date: '2026-04-01', amount: 5000 }] };
    const st = loanStatus(loan, '2026-10-15');
    expect(st.outstanding).toBe(6500);
    expect(st.interestDue).toBe(975); // проценты застыли на дату срока
    expect(st.total).toBe(7475);

    const paid = loanAccrual(
      { ...loan, payments: [...loan.payments, { id: 'p2', date: '2026-10-15', amount: 7475 }] },
      '2026-10-15'
    );
    expect(paid.total).toBe(0);
    expect(paid.outstanding).toBe(0);
    expect(
      loanStatus(
        { ...loan, payments: [...loan.payments, { id: 'p2', date: '2026-10-15', amount: 7475 }] },
        '2026-10-15'
      ).settled
    ).toBe(true);

    // Частичная выплата после срока уменьшает остаток ровно на тело
    const part = loanAccrual(
      { ...loan, payments: [...loan.payments, { id: 'p2', date: '2026-10-15', amount: 3000 }] },
      '2026-10-15'
    );
    expect(part.total).toBe(4475); // 7 475 − 3 000
  });

  it('выплата, оформленная на будущее, сегодняшний долг не уменьшает', () => {
    // Отсекается только выплата БУДУЩЕЕ, а не все, что позже даты расчёта:
    // выплата раньше сегодняшнего дня засчитывается всегда, даже за пределами срока
    const loan = { ...LOAN, payments: [{ id: 'p1', date: '2026-06-01', amount: 5000 }] };
    expect(loanAccrual(loan, '2026-03-01').outstanding).toBe(10000);
    // А вот будущая выплата (после даты расчёта) ещё не засчитана
    expect(
      loanAccrual({ ...LOAN, payments: [{ id: 'p2', date: '2027-01-01', amount: 5000 }] }, '2026-03-01').outstanding
    ).toBe(10000);
    // К июню набегает 5 полных месяцев по 500, поэтому из 5000 на проценты уходит 2500
    // и только 2500 гасят тело долга
    const acc = loanAccrual(loan, '2026-07-01');
    expect(acc.outstanding).toBe(7500);
    expect(acc.interestPaid).toBe(2500);
    expect(acc.paid).toBe(2500);
  });

  it('много выплат подряд не ломают расчёт', () => {
    // Регрессия: расчёт обязан быть одним проходом, рекурсия выплат уронила бы стек
    const payments = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
      amount: 100
    }));
    const acc = loanAccrual({ ...LOAN, payments }, '2026-07-01');
    expect(acc.paid + acc.outstanding).toBeLessThanOrEqual(10000);
    expect(acc.outstanding).toBeGreaterThanOrEqual(0);
  });

  it('прогноз по сроку совпадает с начислением без выплат', () => {
    expect(loanForecast(LOAN)).toEqual({ days: 181, principal: 10000, interest: 3000, total: 13000 });
  });

  it('долг без срока не начисляет ничего', () => {
    const acc = loanAccrual({ principal: 5000, percent: 10, start: '2026-01-01', end: '', payments: [] }, '2026-12-01');
    expect(acc.interest).toBe(0);
    expect(loanForecast({ principal: 5000, percent: 10, start: '2026-01-01', end: '' }).total).toBe(5000);
  });

  it('просрочка видна только после срока', () => {
    expect(loanStatus(LOAN, '2026-07-01').overdue).toBe(false);
    expect(loanStatus(LOAN, '2026-08-01').overdue).toBe(true);
  });
});

describe('реестр: нормализация', () => {
  it('отбрасывает записи без суммы и приводит дату к сегодняшней', () => {
    const f = normalizeFinance({
      operations: [{ amount: 0 }, { amount: -50 }, { amount: '100', date: 'ерунда' }]
    });
    expect(f.operations).toHaveLength(1);
    expect(f.operations[0].amount).toBe(100);
    expect(f.operations[0].date).toBe(todayIso());
  });

  it('чужая валюта и чужой kind не ломают запись', () => {
    const [op] = normalizeFinance({
      operations: [{ amount: 10, currency: 'биткоин', kind: 'maybe' }]
    }).operations;
    expect(op.currency).toBe('gold');
    expect(op.kind).toBe('out');
  });

  it('операции сортируются свежими сверху', () => {
    const f = normalizeFinance({
      operations: [
        { amount: 1, date: '2026-01-01' },
        { amount: 2, date: '2026-06-01' },
        { amount: 3, date: '2026-03-01' }
      ]
    });
    expect(f.operations.map(o => o.date)).toEqual(['2026-06-01', '2026-03-01', '2026-01-01']);
  });

  it('долг без имени и позиция без названия не сохраняются', () => {
    const f = normalizeFinance({
      loans: [{ principal: 100 }, { principal: 100, who: 'Шкила' }],
      shopItems: [
        { price: 10, qty: 1 },
        { price: 10, qty: 1, name: 'Зелье' }
      ]
    });
    expect(f.loans).toHaveLength(1);
    expect(f.shopItems).toHaveLength(1);
  });

  it('пустой раздел превращается в пустые списки с настройками по умолчанию', () => {
    const f = normalizeFinance(undefined);
    expect(f.operations).toEqual([]);
    expect(f.loans).toEqual([]);
    expect(f.settings.commissionPct).toBe(2);
    expect(f.settings.goldRate).toBe(0);
  });

  it('комиссию можно выключить нулём, а мусор возвращает умолчание', () => {
    expect(normalizeFinance({ settings: { commissionPct: 0 } }).settings.commissionPct).toBe(0);
    expect(normalizeFinance({ settings: { commissionPct: 'ерунда' } }).settings.commissionPct).toBe(2);
    expect(normalizeFinance({ settings: { commissionPct: -5 } }).settings.commissionPct).toBe(2);
  });

  it('позиция без остатка убирается: проданное подчистую живёт в реестре', () => {
    const f = normalizeFinance({ shopItems: [{ name: 'Зелье', price: 10, qty: 0 }] });
    expect(f.shopItems).toEqual([]);
  });

  it('выплаты внутри долга сортируются по дате', () => {
    const [loan] = normalizeFinance({
      loans: [
        {
          who: 'Ежа',
          principal: 100,
          start: '2026-01-01',
          payments: [
            { amount: 2, date: '2026-05-01' },
            { amount: 1, date: '2026-02-01' }
          ]
        }
      ]
    }).loans;
    expect(loan.payments.map(p => p.date)).toEqual(['2026-02-01', '2026-05-01']);
  });
});

describe('реестр: итоги', () => {
  const OPS = [
    { kind: 'in', amount: 1000, currency: 'gold', date: '2026-06-01' },
    { kind: 'out', amount: 300, currency: 'gold', date: '2026-06-02' },
    { kind: 'in', amount: 50, currency: 'coins', date: '2026-06-03' }
  ];

  it('считает приход, расход и остаток по валюте', () => {
    expect(ledgerTotals(OPS, 'gold')).toEqual({ income: 1000, expense: 300, balance: 700 });
  });

  it('не смешивает золото и голд', () => {
    const byCurrency = ledgerTotalsByCurrency(OPS);
    expect(byCurrency.gold.balance).toBe(700);
    expect(byCurrency.coins).toEqual({ income: 50, expense: 0, balance: 50 });
  });

  it('остаток в наличии по обеим валютам', () => {
    expect(balances(OPS)).toEqual({ gold: 700, coins: 50 });
  });

  it('пустой реестр даёт нули, а не NaN', () => {
    expect(ledgerTotals([])).toEqual({ income: 0, expense: 0, balance: 0 });
    expect(money('ерунда')).toBe(0);
  });
});

describe('поправки по месяцам (переносы из таблицы)', () => {
  const mon = date => ({ date, currency: 'gold', kind: 'in', amount: 0 });

  it('monthAdjust правит итог месяца, не трогая записи', () => {
    const ops = [
      { ...mon('2026-09-01'), kind: 'in', amount: 100 },
      { ...mon('2026-09-02'), kind: 'out', amount: 40 }
    ];
    const [m] = groupByMonth(ops, { '2026-09': { gold: 500 } });
    expect(m.totals.gold.balance).toBe(560);
    expect(m.operations).toHaveLength(2);
  });

  it('без поправок итог месяца считается из движений', () => {
    const ops = [{ ...mon('2025-03-01'), kind: 'in', amount: 100 }];
    expect(groupByMonth(ops)[0].totals.gold.balance).toBe(100);
  });

  it('у каждого месяца своя правда листа, и «сейчас» — итог свежего месяца', () => {
    const finance = normalizeFinance({
      operations: [
        { ...mon('2025-03-01'), kind: 'in', amount: 1000 },
        { ...mon('2026-09-01'), kind: 'in', amount: 100 },
        { ...mon('2026-09-02'), kind: 'out', amount: 40 }
      ],
      settings: { monthAdjust: { '2025-03': { gold: 9999 }, '2026-09': { gold: 500 } } }
    });
    // Поправка есть у обоих месяцев: итог свежего (60 + 500) и есть «сейчас»
    expect(currentBalances(finance).gold).toBe(560);
  });

  it('без monthAdjust «сейчас» = движения + начальный остаток', () => {
    const finance = normalizeFinance({
      operations: [{ ...mon('2026-09-01'), kind: 'in', amount: 100 }],
      settings: { opening: { gold: 25 } }
    });
    expect(currentBalances(finance).gold).toBe(125);
  });

  it('normalizeFinance выбрасывает битые поправки', () => {
    const finance = normalizeFinance({
      settings: { monthAdjust: { сломано: { gold: 5 }, '2026-09': { gold: 'ерунда' } } }
    });
    expect(finance.settings.monthAdjust).toEqual({});
  });

  it('monthCarry хранит перенос месяца, не меняя ни итог, ни записи', () => {
    const finance = normalizeFinance({
      operations: [{ ...mon('2026-09-01'), kind: 'in', amount: 100 }],
      settings: {
        monthAdjust: { '2026-09': { gold: 500 } },
        monthCarry: { '2026-09': { gold: 400 }, мусор: { gold: 7 } }
      }
    });
    expect(finance.settings.monthCarry).toEqual({ '2026-09': { gold: 400 } });
    // «за месяц» = итог − перенос: приложение показывает накопленное за месяц
    const [m] = groupByMonth(finance.operations, finance.settings.monthAdjust);
    expect(m.totals.gold.balance - finance.settings.monthCarry[m.month].gold).toBe(200);
    expect(currentBalances(finance).gold).toBe(600);
  });

  it('свежий месяц без поправки листа получает остаток прошлого', () => {
    // Сентябрь закрыт листом (поправка 500), октябрь — руками, листа ещё нет.
    // Без переноса октябрь показывал бы 50 вместо 650, и история сентября пропадала.
    const finance = normalizeFinance({
      operations: [
        { ...mon('2026-09-01'), kind: 'in', amount: 100 },
        { ...mon('2026-10-01'), kind: 'in', amount: 50 }
      ],
      settings: { monthAdjust: { '2026-09': { gold: 500 } } }
    });
    expect(currentBalances(finance).gold).toBe(650);
  });

  it('перенос работает и по обеим валютам сразу', () => {
    const finance = normalizeFinance({
      operations: [
        { date: '2026-09-01', kind: 'in', currency: 'coins', amount: 10 },
        { date: '2026-10-01', kind: 'in', currency: 'coins', amount: 5 }
      ],
      settings: { monthAdjust: { '2026-09': { gold: 100, coins: 10 } } }
    });
    // Сентябрь закрыт листом: Золото 100, Голд 20 (нетто 10 + поправка 10).
    // Октябрь без поправки: Золото 100 + 0, Голд 20 + 5.
    expect(currentBalances(finance)).toEqual({ gold: 100, coins: 25 });
  });
});

describe('комиссионный магазин', () => {
  const ITEMS = [
    { side: 'sell', name: 'Зелье', price: 100, qty: 3 },
    { side: 'sell', name: 'Щит', price: 50, qty: 2 },
    { side: 'buy', name: 'Меч', price: 200, qty: 1 }
  ];

  it('перемножает цену на количество', () => {
    expect(shopItemTotal(ITEMS[0])).toBe(300);
  });

  it('сводит продажи и покупки раздельно', () => {
    const totals = shopTotals(ITEMS);
    expect(totals.sell).toEqual({ count: 2, qty: 5, sum: 400 });
    expect(totals.buy).toEqual({ count: 1, qty: 1, sum: 200 });
    expect(totals.net).toBe(200);
  });

  it('одинаковый предмет находит свою позицию независимо от регистра и пробелов', () => {
    const found = findShopItem(ITEMS, { side: 'sell', name: '  зелье ', price: 100 });
    expect(found?.name).toBe('Зелье');
  });

  it('другая цена или другая сторона — это новая позиция', () => {
    expect(findShopItem(ITEMS, { side: 'sell', name: 'Зелье', price: 150 })).toBeNull();
    expect(findShopItem(ITEMS, { side: 'buy', name: 'Зелье', price: 100 })).toBeNull();
    expect(findShopItem(ITEMS, { side: 'sell', name: 'Меч', price: 200 })).toBeNull();
  });
});

// ── Раздел: разметка ──────────────────────────────────────────────────────
// Модель уже проверена выше. Здесь важно другое: человек должен увидеть остаток
// на экране, а комиссию и разбивку выплаты — до того, как он нажмёт «Провести».

const FINANCE = {
  operations: [
    {
      id: 'o1',
      date: '2026-06-09',
      kind: 'in',
      currency: 'gold',
      amount: 500000000,
      counterparty: 'Ежа',
      note: 'сундуки',
      source: 'manual'
    },
    {
      id: 'o2',
      date: '2026-06-10',
      kind: 'out',
      currency: 'gold',
      amount: 50000000,
      counterparty: 'голд',
      note: 'на релики',
      source: 'manual'
    },
    {
      id: 'o3',
      date: '2026-06-11',
      kind: 'in',
      currency: 'coins',
      amount: 1000,
      counterparty: 'Шкила',
      note: '',
      source: 'debt'
    }
  ],
  shopItems: [
    { id: 'i1', side: 'sell', name: 'Зелье', price: 100, qty: 3, date: '2026-06-09', note: '' },
    { id: 'i2', side: 'buy', name: 'Меч', price: 200, qty: 1, date: '2026-06-10', note: '' }
  ],
  loans: [
    {
      id: 'l1',
      direction: 'lent',
      who: 'Шкила',
      principal: 10000,
      percent: 5,
      start: '2026-01-01',
      end: '2026-07-01',
      currency: 'gold',
      note: '',
      payments: [{ id: 'p1', date: '2026-04-01', amount: 5000 }]
    },
    // Второй долг без выплат: на нём проверяем отсутствие истории и подписи форм
    {
      id: 'l2',
      direction: 'borrowed',
      who: 'Ракохаме',
      principal: 2000000,
      percent: 3,
      start: '2026-06-01',
      end: '2026-12-01',
      currency: 'gold',
      note: '',
      payments: []
    }
  ],
  settings: { goldRate: 1000000, commissionPct: 2, goldRateAt: '2026-06-09' }
};

// Проценты и остаток в долге зависят от сегодняшней даты, а тесты должны быть
// одинаковыми в любой день запуска. Фиксируем время на дату до срока долга.
const FROZEN_NOW = new Date('2026-06-01T12:00:00');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  vi.resetModules();
  // modal-root нужен формам: они ищут его в документе, и без него тест падал бы
  // не на своей проверке, а на отсутствии элемента
  document.body.innerHTML = '<div id="modal-root"></div><div id="finance-root"></div>';
  const { state } = await import('../js/core/state.js');
  state.finance = normalizeFinance(structuredClone(FINANCE));
});

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
  vi.useRealTimers();
});

async function render() {
  const page = await import('../js/modules/finance/page.js');
  page.bindFinance();
  page.renderFinance();
  return { el: document.getElementById('finance-root'), page };
}

/**
 * Текст с обычными пробелами. toLocaleString('ru-RU') разделяет разряды неразрывным
 * пробелом (U+00A0), и искать по нему обычным пробелом бессмысленно.
 */
const text = el => el.textContent.replace(/\u00a0/g, ' ');

describe('раздел «Банк»: один экран', () => {
  it('рисует KPI, месяцы, комиссионку и долги на одном экране', async () => {
    const { el } = await render();
    expect(el.querySelector('.pans')).toBeTruthy();
    expect(el.querySelector('.months-list')).toBeTruthy();
    expect(el.querySelector('.shop-grid')).toBeTruthy();
    expect(el.querySelector('.fin-loan')).toBeTruthy();
  });

  it('KPI показывает наличные по валютам', async () => {
    const { el } = await render();
    const values = [...el.querySelectorAll('.pan-value')].map(v => text(v));
    expect(values).toContain('450 000 000');
    expect(values).toContain('1 000');
  });

  it('KPI показывает, сколько должны вернуть и сколько должен я', async () => {
    const { el } = await render();
    const debts = el.querySelector('.pans .pan:nth-child(3)');
    expect(text(debts)).toContain('должны вернуть');
    expect(text(debts)).toContain('7 150');
    expect(text(debts)).toContain('2 000 000');
  });

  it('месяцы показаны списком слева с итогом месяца', async () => {
    const { el } = await render();
    const items = [...el.querySelectorAll('.month-item')];
    expect(items).toHaveLength(1);
    expect(text(items[0])).toContain('июнь 2026');
    expect(text(items[0])).toContain('450 000 000');
  });

  it('перенос и поправка работают для «Голда» так же, как для золота', async () => {
    const { state } = await import('../js/core/state.js');
    // coins за месяц: 1 000 из фикстуры + 1 000 добавленная = 2 000.
    // Перенос (поправка) 400 — как в таблице, он входит в итог месяца.
    state.finance.operations = [
      ...state.finance.operations,
      {
        id: 'c1',
        date: '2026-06-12',
        kind: 'in',
        currency: 'coins',
        amount: 1000,
        counterparty: 'Голд',
        note: '',
        status: '',
        source: 'manual',
        ref: null
      }
    ];
    state.finance.settings.monthAdjust = { '2026-06': { coins: 400 } };
    state.finance.settings.monthCarry = { '2026-06': { coins: 400 } };
    const { el } = await render();
    const coins = el.querySelector('.pans .pan:nth-child(2)');
    expect(text(coins.querySelector('.pan-value'))).toContain('2 400'); // сейчас = итог месяца с переносом
    expect(text(coins.querySelector('.pan-sub'))).toContain('2 000'); // за месяц — без переноса
    expect(text(el.querySelector('.month-item .mi-sum'))).toContain('2 000');
  });

  it('в списке месяцев перенос прошлого месяца не считается заработком', async () => {
    const { state } = await import('../js/core/state.js');
    // Как в таблице: поправка месяца (monthAdjust) — это и есть перенос прошлого месяца,
    // поэтому итог месяца с ним 550 000 000, а заработано за месяц 450 000 000.
    state.finance.settings.monthAdjust = { '2026-06': { gold: 100000000 } };
    state.finance.settings.monthCarry = { '2026-06': { gold: 100000000 } };
    const { el } = await render();
    const gold = el.querySelector('.pans .pan:nth-child(1)');
    expect(text(gold.querySelector('.pan-sub'))).toContain('450 000 000');
    expect(text(el.querySelector('.month-item .mi-sum'))).toContain('450 000 000');
    expect(text(el.querySelector('.month-item .mi-sum'))).not.toContain('550 000 000');
  });

  it('панель показывает остаток с переносом прошлого месяца', async () => {
    const { state } = await import('../js/core/state.js');
    // Сентябрь закрыт листом (поправка 500), октябрь вбиту руками — листа ещё нет.
    state.finance = normalizeFinance({
      operations: [
        {
          id: 'a',
          date: '2026-09-01',
          kind: 'in',
          currency: 'gold',
          amount: 100,
          counterparty: 'Сент',
          note: '',
          status: '',
          source: 'manual',
          ref: null
        },
        {
          id: 'b',
          date: '2026-10-01',
          kind: 'in',
          currency: 'gold',
          amount: 50,
          counterparty: 'Окт',
          note: '',
          status: '',
          source: 'manual',
          ref: null
        }
      ],
      settings: { monthAdjust: { '2026-09': { gold: 500 } } }
    });
    const { el } = await render();
    const gold = el.querySelector('.pans .pan:nth-child(1)');
    // Сентябрь: 100 + 500 = 600, октябрь: 600 + 50 = 650. Без переноса было бы 50.
    expect(text(gold.querySelector('.pan-value'))).toContain('650');
    // «за месяц» остаётся ежемесячным: в панели видно и итог, и вклад месяца
    expect(text(gold.querySelector('.pan-sub'))).toContain('50');
  });

  it('журнал показывает записи выбранного месяца с источником', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('.month-body .fin-row')).toHaveLength(3);
    expect(text(el)).toContain('Долг');
  });

  it('«Получил» и «Потратил» вместо «Приход» и «Расход»', async () => {
    const { el } = await render();
    const chips = [...el.querySelectorAll('.fin-kind .fin-chip')].map(c => text(c).trim());
    expect(chips).toEqual(['Получил', 'Потратил', 'Получил']);
  });

  it('колонка «Итог» включена по умолчанию и считается снизу вверх', async () => {
    const { el } = await render();
    const heads = [...el.querySelectorAll('.fin-table th')].map(h => text(h).trim());
    expect(heads).toContain('Итог');
    // Нижняя строка — первое действие, верхняя — последнее: сложение идёт от низа
    const its = [...el.querySelectorAll('.month-body .fin-row')].map(r => text(r.querySelector('.fin-num')));
    expect(its[0]).toContain('1 000'); // верх: последнее (голд)
    expect(its[1]).toContain('450 000 000'); // середина
    expect(its[2]).toContain('500 000 000'); // низ: первое
  });

  it('чекбокс «Итог» убирает колонку', async () => {
    const { el } = await render();
    const cb = el.querySelector('[data-balance]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    const heads = [...el.querySelectorAll('.fin-table th')].map(h => text(h).trim());
    expect(heads).not.toContain('Итог');
  });

  it('фильтр по источнику оставляет только свои записи', async () => {
    const { el } = await render();
    el.querySelector('[data-source="debt"]').click();
    expect(el.querySelectorAll('.month-body .fin-row')).toHaveLength(1);
    expect(text(el.querySelector('.month-body .fin-row'))).toContain('Шкила');
  });

  it('фильтр по валюте оставляет только голд', async () => {
    const { el } = await render();
    el.querySelector('[data-currency="coins"]').click();
    expect(el.querySelectorAll('.month-body .fin-row')).toHaveLength(1);
    expect(text(el.querySelector('.month-body .fin-row'))).toContain('Шкила');
  });

  it('поиск ищет по источнику и примечанию', async () => {
    const { el } = await render();
    const input = el.querySelector('[data-query]');
    input.value = 'ежа';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.querySelectorAll('.month-body .fin-row')).toHaveLength(1);
    expect(text(el.querySelector('.month-body .fin-row'))).toContain('Ежа');
  });

  it('клик по месяцу выбирает его', async () => {
    const { el, page } = await render();
    const { state } = await import('../js/core/state.js');
    state.finance.operations.unshift({
      id: 'ox',
      date: '2026-05-05',
      kind: 'in',
      currency: 'gold',
      amount: 100,
      counterparty: 'Май',
      note: '',
      status: '',
      source: 'manual',
      ref: null
    });
    page.renderFinance();
    const may = [...el.querySelectorAll('.month-item')].find(m => text(m).includes('май 2026'));
    may.click();
    expect(text(el.querySelector('.month-right > .block-h'))).toContain('май 2026');
  });

  it('панель действий: запись, голд и долг одной кнопкой', async () => {
    const { el } = await render();
    const acts = [...el.querySelectorAll('.desk-bar [data-fin-act]')].map(b => b.dataset.finAct);
    expect(acts).toEqual(['add-op', 'gold', 'add-loan']);
    const html = el.innerHTML;
    expect(html.indexOf('data-fin-act="add-op"')).toBeLessThan(html.indexOf('<table'));
  });

  it('форма голда одна: сначала действие, комиссия скрыта', async () => {
    const { el } = await render();
    el.querySelector('[data-fin-act="gold"]').click();
    const form = document.querySelector('#modal-root form');
    expect(form.querySelector('select[name="side"]')).toBeTruthy();
    const details = form.querySelector('.fin-details');
    expect(details).toBeTruthy();
    expect(details.open).toBe(false); // по умолчанию комиссия не видна
    expect(details.querySelector('input[name="commissionPct"]').value).toBe('2');
  });

  it('суммы в формах показаны с пробелами по три цифры', async () => {
    const { el } = await render();
    el.querySelector('[data-fin-act="gold"]').click();
    const coins = document.querySelector('#modal-root form input[name="coins"]');
    expect(coins.value).toBe('1 000');
  });

  it('поле суммы разделяет разряды пробелами при вводе', async () => {
    const { el } = await render();
    el.querySelector('[data-fin-act="add-op"]').click();
    const input = document.querySelector('#modal-root form input[name="amount"]');
    expect(input.classList.contains('fin-money')).toBe(true);
    input.value = '242982166';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.value).toBe('242 982 166');
  });

  it('форма долга одна: внутри выбираешь дать или взять', async () => {
    const { el } = await render();
    el.querySelector('[data-fin-act="add-loan"]').click();
    const form = document.querySelector('#modal-root form');
    const dir = form.querySelector('select[name="direction"]');
    expect(dir).toBeTruthy();
    expect([...dir.options].map(o => o.value)).toEqual(['lent', 'borrowed']);
  });

  it('комиссионка разносит продажу и покупку по двум колонкам', async () => {
    const { el } = await render();
    const cols = [...el.querySelectorAll('.shop-side')];
    expect(cols).toHaveLength(2);
    expect(cols[0].querySelector('h4').textContent).toBe('Продажа');
    expect(text(cols[0].querySelector('.shop-side-foot'))).toContain('300');
    expect(cols[1].querySelector('h4').textContent).toBe('Покупка');
    expect(text(cols[1].querySelector('.shop-side-foot'))).toContain('200');
  });

  it('плитки комиссионки — ровно 5 колонок и ограничены по ширине', () => {
    // Регрессия: на широком экране плитки раздувались на всю колонку. Теперь сетка
    // ровно 5×4 и ограничена по ширине, чтобы слоты оставались размером с игру.
    const css = readFileSync('css/modules/finance.css', 'utf8');
    expect(css).toMatch(/\.slots\s*\{[^}]*grid-template-columns:\s*repeat\(5/);
    expect(css).toMatch(/\.slots\s*\{[^}]*max-width:\s*min\(620px/);
  });

  it('название предмета переносится по словам внутри плитки', () => {
    const css = readFileSync('css/modules/finance.css', 'utf8');
    expect(css).toMatch(/\.slot\.is-filled\s*\{[^}]*overflow-wrap:\s*anywhere/);
    // Строки не должны липнуть: межстрочный интервал задаётся, но без зазора между
    // строками название в две строки читается слитно (1.15 → 1.2)
    const lh = css.match(/\.slot\.is-filled\s*\{[^}]*line-height:\s*([\d.]+)/);
    expect(lh, 'у плитки должен быть задан межстрочный интервал').toBeTruthy();
    expect(Number(lh[1])).toBeGreaterThanOrEqual(1.2);
  });

  it('у каждой колонки комиссионки есть кнопка добавления позиции', async () => {
    const { el } = await render();
    const add = [...el.querySelectorAll('[data-fin-act="add-item"]')];
    expect(add.length).toBeGreaterThan(0);
    expect(add.map(b => b.dataset.side)).toContain('sell');
    expect(add.map(b => b.dataset.side)).toContain('buy');
  });

  it('у позиции комиссионки есть «продано», «изменить» и «убрать»', async () => {
    const { el } = await render();
    const acts = [...el.querySelectorAll('.shop-side [data-fin-act]')].map(b => b.dataset.finAct);
    expect(acts).toContain('deal-item'); // записать, сколько продано
    expect(acts).toContain('edit-item'); // изменить
    expect(acts).toContain('del-item');
    // Кнопки «долить» больше нет — просили заменить на «изменить»
    expect(acts).not.toContain('bump-item');
  });

  it('в плитке видно название и количество', async () => {
    const { el } = await render();
    const slots = [...el.querySelectorAll('.slot.is-filled')];
    expect(slots).toHaveLength(2);
    expect(text(slots[0])).toContain('Зелье');
    expect(text(slots[0])).toContain('×3');
  });

  it('голд-сделка помечена «Конвертация», а не «Потратил»', async () => {
    const { el, page } = await render();
    const { state } = await import('../js/core/state.js');
    state.finance.operations.unshift({
      id: 'g1',
      date: '2026-06-12',
      kind: 'out',
      currency: 'gold',
      amount: 1000,
      counterparty: 'Покупка голда',
      note: '',
      status: '',
      source: 'gold',
      ref: null
    });
    page.renderFinance();
    const row = [...el.querySelectorAll('.month-body .fin-row')].find(r => r.textContent.includes('Покупка голда'));
    expect(text(row.querySelector('.fin-chip'))).toBe('Конвертация');
  });

  it('в долге есть «Выплатить всё», «Частично», «Закрыть» и история', async () => {
    const { el } = await render();
    const card = [...el.querySelectorAll('.fin-loan')].find(c => c.textContent.includes('Шкила'));
    const acts = [...card.querySelector('.fin-loan-actions').querySelectorAll('[data-fin-act]')].map(
      b => b.dataset.finAct
    );
    expect(acts).toContain('pay-all');
    expect(acts).toContain('add-payment');
    expect(acts).toContain('close-loan');
    expect(text(card.querySelector('.fin-payments summary'))).toContain('История выплат');
    expect(text(card.querySelector('.fin-payments summary'))).toContain('5 000');
  });

  it('форма выплаты подставляет сумму из «должен вернуть»', async () => {
    const { el } = await render();
    const card = [...el.querySelectorAll('.fin-loan')].find(c => c.textContent.includes('Шкила'));
    const due = text(card.querySelector('.fin-loan-due b'));
    card.querySelector('[data-fin-act="add-payment"]').click();
    const form = document.querySelector('#modal-root form');
    // Пустой суммой предпросмотр просит ввести число, а не молчит
    expect(text(form.querySelector('[data-fin-preview]'))).toContain('Впишите сумму');
    // Кнопка подставляет всю сумму и обещает закрытие долга
    form.querySelector('[data-pay-all]').click();
    expect(form.elements.amount.value).toBe('7150');
    expect(due).toContain('7 150');
    expect(text(form.querySelector('[data-fin-preview]'))).toContain('закрыт полностью');
  });

  it('предпросмотр показывает, сколько останется после частичной выплаты', async () => {
    const { el } = await render();
    el.querySelector('[data-fin-act="add-payment"]').click();
    const form = document.querySelector('#modal-root form');
    form.elements.amount.value = '3000';
    form.dispatchEvent(new Event('input', { bubbles: true }));
    const preview = text(form.querySelector('[data-fin-preview]'));
    // На 2026-06-01 набежало 650 процентов, из выплаты 650 гасят проценты,
    // 2 350 — тело, и остаётся 4 150
    expect(preview).toContain('650');
    expect(preview).toContain('2 350');
    expect(preview).toContain('4 150');
    expect(preview).toContain('останется');
  });

  it('закрытый долг не предлагает выплату и не начисляет проценты', async () => {
    const { el, page } = await render();
    const { state } = await import('../js/core/state.js');
    const { loanStatus } = await import('../js/modules/finance/model.js');
    const loan = state.finance.loans.find(l => l.who === 'Шкила');
    // Выплата всей суммы на сегодня: тело 6 500 + проценты 650 = 7 150
    const due = loanStatus(loan).total;
    expect(due).toBe(7150);
    loan.payments = [...loan.payments, { id: 'p2', date: '2026-06-01', amount: due }];
    expect(loanStatus(loan).settled).toBe(true);
    page.renderFinance();
    const card = [...el.querySelectorAll('.fin-loan')].find(c => c.textContent.includes('Шкила'));
    const acts = [...card.querySelector('.fin-loan-actions').querySelectorAll('[data-fin-act]')].map(
      b => b.dataset.finAct
    );
    expect(acts).not.toContain('pay-all');
    expect(acts).not.toContain('close-loan');
    // История закрытого долга раскрыта сама — иначе её не увидеть без клика
    expect(card.querySelector('.fin-payments').open).toBe(true);
  });

  it('долг без выплат не показывает блок истории', async () => {
    const { el } = await render();
    const borrowed = [...el.querySelectorAll('.fin-loan')].find(c => c.textContent.includes('Ракохаме'));
    expect(borrowed.querySelector('.fin-payments')).toBeNull();
  });

  it('долг показывает остаток, набежавшие проценты и разбивку выплаты', async () => {
    const { el } = await render();
    const card = [...el.querySelectorAll('.fin-loan')].find(c => c.textContent.includes('Шкила'));
    expect(text(card.querySelector('.fin-loan-prog'))).toContain('3 500');
    expect(text(card.querySelector('.fin-loan-due b'))).toContain('7 150');
    expect(text(card.querySelector('.fin-payments'))).toContain('проценты 1 500');
  });

  it('срок показан днями, а не месяцами', async () => {
    const { el } = await render();
    expect(text(el.querySelector('.fin-loan'))).toContain('дн.');
  });

  it('пустой раздел не падает и объясняет, что делать', async () => {
    const { el, page } = await render();
    const { state } = await import('../js/core/state.js');
    state.finance = normalizeFinance(undefined);
    page.renderFinance();
    expect(el.querySelector('.fin-empty')).toBeTruthy();
  });

  it('сделка в комиссионке списывает количество и кладёт деньги в «Банк»', async () => {
    const { page } = await render();
    const { state } = await import('../js/core/state.js');
    const { shopDealOperation } = await import('../js/modules/finance/model.js');
    const item = state.finance.shopItems.find(i => i.side === 'sell');
    const goldBefore = balances(state.finance.operations).gold;

    item.qty = money(item.qty - 2);
    state.finance.operations.unshift(shopDealOperation({ item, qty: 2 }));

    expect(item.qty).toBe(1); // было 3
    expect(balances(state.finance.operations).gold).toBe(goldBefore + 200);
    expect(state.finance.operations[0].counterparty).toContain('Банк');
    expect(state.finance.operations[0].source).toBe('shop');
    page.renderFinance();
  });

  it('долг при создании уводит сумму из остатка, а взятый — добавляет', async () => {
    const { page } = await render();
    const { state } = await import('../js/core/state.js');
    const { loanOperation } = await import('../js/modules/finance/model.js');

    const lent = {
      id: 'lx',
      direction: 'lent',
      who: 'Новый',
      principal: 5000,
      percent: 5,
      start: '2026-06-01',
      end: '2026-12-01',
      currency: 'gold',
      opId: null,
      payments: []
    };
    const op = loanOperation(lent);
    lent.opId = op.id;
    state.finance.loans.unshift(lent);
    state.finance.operations.unshift(op);
    const afterLent = balances(state.finance.operations).gold;
    const goldBefore = ledgerTotals(FINANCE.operations, 'gold').balance;
    expect(afterLent).toBe(goldBefore - 5000);

    const borrowed = {
      id: 'ly',
      direction: 'borrowed',
      who: 'Другой',
      principal: 3000,
      percent: 3,
      start: '2026-06-01',
      end: '2026-12-01',
      currency: 'gold',
      opId: null,
      payments: []
    };
    const op2 = loanOperation(borrowed);
    borrowed.opId = op2.id;
    state.finance.loans.unshift(borrowed);
    state.finance.operations.unshift(op2);
    expect(balances(state.finance.operations).gold).toBe(afterLent + 3000);
    page.renderFinance();
  });
});
