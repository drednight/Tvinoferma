// Чистая логика раздела «Учёт» (js/modules/finance/model.js).
// Здесь нет DOM и нет state — только деньги, комиссия и начисление процентов,
// поэтому проверяется без запуска приложения.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fullMonthsBetween,
  goldDeal,
  commissionLossPct,
  loanAccrual,
  loanForecast,
  loanStatus,
  paymentSplit,
  normalizeFinance,
  ledgerTotals,
  ledgerTotalsByCurrency,
  runningBalance,
  shopTotals,
  shopItemTotal,
  findShopItem,
  money,
  todayIso
} from '../js/modules/finance/model.js';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

/** Долг под 5% на полгода: 01.01 → 01.07. */
const LOAN = { principal: 10000, percent: 5, start: '2026-01-01', end: '2026-07-01', payments: [] };

describe('полные месяцы между датами', () => {
  it('считает только целые месяцы, неполный месяц — ноль', () => {
    expect(fullMonthsBetween('2026-01-01', '2026-02-01')).toBe(1);
    expect(fullMonthsBetween('2026-01-15', '2026-02-14')).toBe(0);
    expect(fullMonthsBetween('2026-01-15', '2026-02-15')).toBe(1);
    expect(fullMonthsBetween('2026-01-01', '2026-07-01')).toBe(6);
  });

  it('31.01 → 28.02 целым месяцем не считается, и обратный порядок даёт ноль', () => {
    expect(fullMonthsBetween('2026-01-31', '2026-02-28')).toBe(0);
    expect(fullMonthsBetween('2026-07-01', '2026-01-01')).toBe(0);
    expect(fullMonthsBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('битые даты не превращаются в месяцы', () => {
    expect(fullMonthsBetween('', '2026-07-01')).toBe(0);
    expect(fullMonthsBetween('2026-01-01', 'ерунда')).toBe(0);
  });
});

describe('голд и комиссия 8%', () => {
  it('продажа 1000 голда по миллиону: комиссия берётся голдом, золото целиком', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 8 });
    expect(deal.commissionCoins).toBe(80);
    expect(deal.coinsTotal).toBe(1080);          // «потратил 1020» из его примера — это случай с 2%
    expect(deal.gold).toBe(1000000000);
    expect(deal.commissionGold).toBe(0);
    expect(deal.effectiveRate).toBe(925925.93);  // 1 000 000 000 / 1080
  });

  it('потеря курса при комиссии 8% равна 7.41%, а не 8%', () => {
    // Ключевая проверка: комиссию считают от номинала, а убыток измеряют от курса,
    // поэтому 8% превращаются в 8/108. Проверено вручную: 1 − 1000/1080 = 7.407%.
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 8 });
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(7.41);
  });

  it('его пример с 20 голдами комиссии даёт потерю 1.96%', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 1000000, commissionPct: 2 });
    expect(deal.commissionCoins).toBe(20);
    expect(deal.coinsTotal).toBe(1020);
    expect(deal.effectiveRate).toBe(980392.16);
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(1.96);
  });

  it('покупка: комиссия добавкой к золоту, 1 голд обходится в 108% курса', () => {
    const deal = goldDeal({ side: 'buy', coins: 1000, rate: 1000000, commissionPct: 8 });
    expect(deal.commissionCoins).toBe(80);
    expect(deal.commissionGold).toBe(80000000);
    expect(deal.gold).toBe(1080000000);
    expect(deal.effectiveRate).toBe(1080000);
    expect(commissionLossPct(deal.effectiveRate, 1000000)).toBe(-8);
  });

  it('нулевой курс не делит на ноль', () => {
    const deal = goldDeal({ side: 'sell', coins: 1000, rate: 0, commissionPct: 8 });
    expect(deal.effectiveRate).toBe(0);
    expect(deal.gold).toBe(0);
    expect(goldDeal({ side: 'sell', coins: 0, rate: 1000000 }).effectiveRate).toBe(0);
  });
});

describe('долг: проценты на остаток', () => {
  it('без выплат за 6 месяцев под 5% начисляет 3000', () => {
    const acc = loanAccrual(LOAN, '2026-07-01');
    expect(acc.interest).toBe(3000);
    expect(acc.outstanding).toBe(10000);
    expect(acc.total).toBe(13000);
    expect(acc.months).toBe(6);
  });

  it('выплата 5000 на 4-й месяц гасит проценты, а остаток уменьшает базу', () => {
    // 3 месяца на базе 10 000 → 1500 процентов, из выплаты 1500 гасят проценты
    // и 3500 — тело долга. Дальше 3 месяца проценты капают уже на 6500.
    const loan = { ...LOAN, payments: [{ id: 'p1', date: '2026-04-01', amount: 5000 }] };
    const acc = loanAccrual(loan, '2026-07-01');
    expect(acc.interestPaid).toBe(1500);
    expect(acc.paid).toBe(3500);
    expect(acc.outstanding).toBe(6500);
    expect(acc.interest).toBe(2475);        // 1500 + 3 × 6500 × 0.05
    expect(acc.interestDue).toBe(975);      // не погашенные проценты после выплаты
    expect(acc.total).toBe(7475);           // 6500 тела + 975 процентов
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

  it('неполный месяц процентов не добавляет', () => {
    expect(loanAccrual(LOAN, '2026-01-20').interest).toBe(0);
    expect(loanAccrual(LOAN, '2026-02-01').interest).toBe(500);
  });

  it('после крайнего срока проценты не идут', () => {
    expect(loanAccrual(LOAN, '2027-07-01').interest).toBe(3000);
    expect(loanAccrual(LOAN, '2027-07-01').months).toBe(6);
  });

  it('выплата, оформленная на будущее, сегодняшний долг не уменьшает', () => {
    const loan = { ...LOAN, payments: [{ id: 'p1', date: '2026-06-01', amount: 5000 }] };
    expect(loanAccrual(loan, '2026-03-01').outstanding).toBe(10000);
    // К июню сначала набегает 5 × 500 процентов, поэтому из 5000 на проценты уходит 2500
    // и только 2500 гасят тело долга
    const acc = loanAccrual(loan, '2026-07-01');
    expect(acc.outstanding).toBe(7500);
    expect(acc.interestPaid).toBe(2500);
    expect(acc.paid).toBe(2500);
  });

  it('много выплат подряд не ломают расчёт', () => {
    // Регрессия: расчёт обязан быть одним проходом, рекурсия выплат уронила бы стек
    const payments = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, date: `2026-${String(i % 12 + 1).padStart(2, '0')}-01`, amount: 100
    }));
    const acc = loanAccrual({ ...LOAN, payments }, '2026-07-01');
    expect(acc.paid + acc.outstanding).toBeLessThanOrEqual(10000);
    expect(acc.outstanding).toBeGreaterThanOrEqual(0);
  });

  it('прогноз по сроку считается без выплат', () => {
    expect(loanForecast(LOAN)).toEqual({ months: 6, principal: 10000, interest: 3000, total: 13000 });
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
      shopItems: [{ price: 10, qty: 1 }, { price: 10, qty: 1, name: 'Зелье' }]
    });
    expect(f.loans).toHaveLength(1);
    expect(f.shopItems).toHaveLength(1);
  });

  it('пустой раздел превращается в пустые списки с настройками по умолчанию', () => {
    const f = normalizeFinance(undefined);
    expect(f.operations).toEqual([]);
    expect(f.loans).toEqual([]);
    expect(f.settings.commissionPct).toBe(8);
    expect(f.settings.goldRate).toBe(0);
  });

  it('выплаты внутри долга сортируются по дате', () => {
    const [loan] = normalizeFinance({
      loans: [{
        who: 'Ежа', principal: 100, start: '2026-01-01',
        payments: [{ amount: 2, date: '2026-05-01' }, { amount: 1, date: '2026-02-01' }]
      }]
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

  it('нарастающий итог внутри месяца', () => {
    const rows = runningBalance(OPS, 'gold');
    expect(rows.map(r => r.balanceAfter)).toEqual([1000, 700]);
  });

  it('пустой реестр даёт нули, а не NaN', () => {
    expect(ledgerTotals([])).toEqual({ income: 0, expense: 0, balance: 0 });
    expect(money('ерунда')).toBe(0);
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
// Модель уже проверена выше. Зде��ь важно другое: человек должен увидеть итог и
// нарастающий остаток на экране, а комиссия голда — до того, как он нажмёт «Провести».

const FINANCE = {
  operations: [
    { id: 'o1', date: '2026-06-09', kind: 'in', currency: 'gold', amount: 500000000, counterparty: 'Ежа', note: 'сундуки', source: 'manual' },
    { id: 'o2', date: '2026-06-10', kind: 'out', currency: 'gold', amount: 50000000, counterparty: 'голд', note: 'на релики', source: 'manual' },
    { id: 'o3', date: '2026-06-11', kind: 'in', currency: 'coins', amount: 1000, counterparty: 'Шкила', note: '', source: 'debt' }
  ],
  shopItems: [
    { id: 'i1', side: 'sell', name: 'Зелье', price: 100, qty: 3, date: '2026-06-09', note: '' },
    { id: 'i2', side: 'buy', name: 'Меч', price: 200, qty: 1, date: '2026-06-10', note: '' }
  ],
  loans: [{
    id: 'l1', direction: 'lent', who: 'Шкила', principal: 10000, percent: 5,
    start: '2026-01-01', end: '2026-07-01', currency: 'gold', note: '',
    payments: [{ id: 'p1', date: '2026-04-01', amount: 5000 }]
  }],
  settings: { goldRate: 1000000, commissionPct: 8, goldRateAt: '2026-06-09' }
};

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="finance-root"></div>';
  const { state } = await import('../js/core/state.js');
  state.finance = normalizeFinance(structuredClone(FINANCE));
});

async function openBlock(id) {
  const page = await import('../js/modules/finance/page.js');
  if (id) {
    const el = document.getElementById('finance-root');
    page.bindFinance();
    el.innerHTML = '';
    page.renderFinance();
    el.querySelector(`[data-fin-block="${id}"]`).click();
  } else {
    page.bindFinance();
    page.renderFinance();
  }
  return { el: document.getElementById('finance-root'), page };
}

/**
 * Текст с обычными пробелами. toLocaleString('ru-RU') разделяет разряды неразрывным
 * пробелом (U+00A0), и искать по нему обычным пробелом бессмысленно.
 */
const text = (el) => el.textContent.replace(/\u00a0/g, ' ');

describe('раздел «Учёт»: четыре блока', () => {
  it('в меню все четыре блока, и ни один не выбран по умолчанию дважды', async () => {
    const { el } = await openBlock();
    const tabs = [...el.querySelectorAll('[data-fin-block]')];
    expect(tabs.map(b => b.dataset.finBlock)).toEqual(['ledger', 'shop', 'gold', 'loans']);
    expect(el.querySelectorAll('[data-fin-block].active')).toHaveLength(1);
  });

  it('реестр показывает сводку по обеим валютам и нарастающий остаток', async () => {
    const { el } = await openBlock();
    const cells = [...el.querySelectorAll('.fin-summary-cell')];
    expect(cells).toHaveLength(2);
    // 500 000 000 − 50 000 000 = 450 000 000 золота, голд живёт отдельно
    expect(text(el.querySelector('.fin-summary'))).toContain('450 000 000');
    expect(text(el.querySelector('.fin-summary'))).toContain('1 000');
    // Баланс ведётся по валютам: у золота своя цепочка, у голда своя, обе в одной таблице
    const balances = [...el.querySelectorAll('.fin-balance')].map(b => text(b).trim());
    expect(balances).toEqual(['500 000 000', '450 000 000', '1 000']);
  });

  it('записи показываются по месяцам и помечены источником', async () => {
    const { el } = await openBlock();
    expect(el.querySelector('.fin-month summary h3').textContent).toContain('июнь 2026');
    // Все три записи месяца на месте, хотя золото и голд — разные валюты
    expect(el.querySelectorAll('.fin-row')).toHaveLength(3);
    expect(text(el)).toContain('долг');
  });

  it('магазин разносит продажу и покупку по двум колонкам с итогами', async () => {
    const { el } = await openBlock('shop');
    const cols = [...el.querySelectorAll('.fin-shop-col')];
    expect(cols).toHaveLength(2);
    expect(cols[0].querySelector('h3').textContent).toBe('Продажа');
    expect(text(cols[0].querySelector('.fin-shop-foot'))).toContain('300');
    expect(cols[1].querySelector('h3').textContent).toBe('Покупка');
    expect(text(cols[1].querySelector('.fin-shop-foot'))).toContain('200');
    expect(text(el)).toContain('Золото заработано');
  });

  it('голд показывает фактический курс и потерю от комиссии', async () => {
    const { el } = await openBlock('gold');
    const hint = text(el.querySelector('.fin-gold-hint'));
    expect(hint).toContain('925 925,93');   // 1 000 000 000 / 1080
    expect(hint).toContain('−7,41%');
  });

  it('долг показывает остаток, набежавшие проценты и разбивку выплаты', async () => {
    const { el } = await openBlock('loans');
    expect(el.querySelector('.fin-loan').textContent).toContain('Шкила');
    // 3 месяца по 10 000 → 1 500 процентов съедены выплатой, осталось 3 500 тела и 975 процентов
    expect(text(el.querySelector('.fin-loan-grid-sum'))).toContain('6 500');
    expect(text(el.querySelector('.fin-loan-due b'))).toContain('7 475');
    expect(text(el)).toContain('проценты 1 500');
  });

  it('пустой раздел не падает и объясняет, что делать', async () => {
    const { el, page } = await openBlock();
    const { state } = await import('../js/core/state.js');
    state.finance = normalizeFinance(undefined);
    page.renderFinance();
    for (const id of ['ledger', 'shop', 'loans']) {
      el.querySelector(`[data-fin-block="${id}"]`).click();
      expect(el.querySelector('.fin-empty')).toBeTruthy();
    }
  });
});