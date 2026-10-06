import { describe, it, expect } from 'vitest';
import {
  SHOP_ITEMS, itemByKey, wantedNames, normalizeScan, normalizeScanItem, siteKeyOf, groupAccounts, pickRepresentative,
  planQty, planAccount, canAffordAny, sortByAffordability, addMonthMsk, siteStampToIso, reconcileTrack, trackAfterPurchase,
  needsHistory, historyPurchaseAt, countHistoryPurchases, limitView, resultInfo, resultLabel, interpretBuy, afterPurchase, summarizeRows, cleanDesc
} from '../js/modules/automation/shopCore.js';
import { runPageScript, fixture } from './helpers/pageScript.js';

const scanPayload = () => {
  window.__TF_SHOP = { mode: 'scan', wanted: wantedNames() };
  const r = runPageScript('shop.js', fixture('site-shop.html'), 'TF_SHOP_V1_');
  return { status: 'ok', ...r.data };
};
const historyRows = () => {
  window.__TF_SHOP = { mode: 'history', wanted: [] };
  return runPageScript('shop.js', fixture('site-shop-history.html'), 'TF_SHOP_V1_').data.rows;
};
const NOW = new Date('2026-10-08T09:00:00Z');

describe('список предметов', () => {
  it('8 закреплённых в заданном порядке; ивентовые помечены', () => {
    expect(SHOP_ITEMS.map(i => i.name)).toEqual([
      'Камень светлого духа', 'Камень асуров', 'Камень лагеря', 'Камень государя',
      'Знак доблести (25 штук)', 'Знак единства (25 штук)', 'Сундук средоточия', 'Ключ от Книги наставлений'
    ]);
    expect(SHOP_ITEMS.filter(i => i.event).map(i => [i.key, i.oldPrice])).toEqual([['focus', 30], ['guide', 50]]);
    expect(itemByKey('asura').name).toBe('Камень асуров');
    expect(itemByKey('nope')).toBeNull();
    expect(wantedNames()).toHaveLength(8);
  });
});

describe('разбор страницы магазина (на настоящей странице)', () => {
  it('аккаунт, баланс, найденные и ненайденные предметы', () => {
    const scan = normalizeScan(scanPayload(), NOW);
    expect(scan).toMatchObject({ account: 'u_1000000001', balance: 54 });
    expect(scan.items.light).toMatchObject({ found: true, price: 40, available: 4, buyable: true, blocked: false, kind: 'item' });
    expect(scan.items.asura).toMatchObject({ found: true, available: 0, blocked: true, buyable: false });
    expect(scan.items.valor).toMatchObject({ found: true, price: 10, available: null, kind: 'chest', buyable: true });
    expect(scan.items.focus.found).toBe(false);
    expect(scan.items.guide.found).toBe(false);
  });

  it('описание без «Описание:», картинка только https', () => {
    expect(cleanDesc('Описание:Первая строка\n  Вторая  ')).toBe('Первая строка\nВторая');
    const def = itemByKey('light');
    expect(normalizeScanItem({ found: true, price: 40, image: 'javascript:alert(1)' }, def).image).toBe('');
    expect(normalizeScanItem({ found: true, price: 40, image: 'https://cdn.example/x.png' }, def).image).toBe('https://cdn.example/x.png');
  });

  it('плохой ответ не годится: нет баланса, не ok', () => {
    expect(normalizeScan(null)).toBeNull();
    expect(normalizeScan({ status: 'not_logged_in' })).toBeNull();
    expect(normalizeScan({ status: 'ok', balance: null, items: [] })).toBeNull();
  });

  it('предмет без цены нельзя купить', () => {
    expect(normalizeScanItem({ found: true, price: null, hasLink: true }, itemByKey('light')).buyable).toBe(false);
    expect(normalizeScanItem({ found: true, price: 40, hasLink: false }, itemByKey('light')).buyable).toBe(false);
  });
});

describe('аккаунты', () => {
  const chars = [{ id: 'a', nick: 'А' }, { id: 'b', nick: 'Б' }, { id: 'c', nick: 'В' }];
  it('ключ аккаунта; пока неизвестен — сам персонаж', () => {
    expect(siteKeyOf('u_1', 'a')).toBe('acc:u_1');
    expect(siteKeyOf('', 'a')).toBe('char:a');
  });
  it('персонажи одного аккаунта показываются один раз', () => {
    const g = groupAccounts(chars, { a: 'acc:u_1', b: 'acc:u_1' });
    expect(g.map(x => [x.siteKey, x.members.map(m => m.id)])).toEqual([['acc:u_1', ['a', 'b']], ['char:c', ['c']]]);
  });
  it('представитель: с известным входом и из выбранных; без входа — никто', () => {
    const m = [{ id: 'a', isLoggedIn: false }, { id: 'b' }, { id: 'c', isLoggedIn: true }];
    expect(pickRepresentative(m).id).toBe('c');
    expect(pickRepresentative(m, new Set(['b'])).id).toBe('b');
    expect(pickRepresentative([{ id: 'a', isLoggedIn: false }])).toBeNull();
  });
});

describe('расчёт количества и остатка', () => {
  it('хватает: цена × количество, остаток', () => {
    expect(planQty({ requested: 3, price: 10, balance: 54 })).toMatchObject({ qty: 3, cost: 30, left: 24, cap: null });
  });
  it('лимит меньше желаемого: 6 при доступных 4 → 4', () => {
    expect(planQty({ requested: 6, price: 10, balance: 100, available: 4 })).toMatchObject({ qty: 4, cost: 40, left: 60, cap: 'limit', fullCost: 60 });
  });
  it('монет меньше: 54 монеты, камень 40 → 1', () => {
    expect(planQty({ requested: 4, price: 40, balance: 54, available: 4 })).toMatchObject({ qty: 1, left: 14, cap: 'funds' });
  });
  it('дробные монеты и пустой ввод', () => {
    expect(planQty({ requested: 3, price: 0.1, balance: 0.3 }).qty).toBe(3);
    expect(planQty({ requested: 0, price: 10, balance: 50 })).toMatchObject({ qty: 0, left: 50 });
    expect(planQty({ requested: 2, price: null, balance: 50 }).qty).toBe(0);
  });
  it('предметы по порядку делят один баланс', () => {
    const p = planAccount({ balance: 54, orders: [
      { key: 'light', requested: 1, price: 40, available: 4 },
      { key: 'valor', requested: 3, price: 10, available: null }
    ] });
    expect(p.rows.map(r => r.qty)).toEqual([1, 1]);
    expect(p).toMatchObject({ spent: 50, left: 4, qty: 2, requested: 4 });
    expect(p.rows[1].cap).toBe('funds');
  });
  it('хватит ли монет хотя бы на один предмет (учитываются только доступные)', () => {
    const items = [{ buyable: false, price: 5 }, { buyable: true, price: 40 }, { buyable: true, price: 10 }];
    expect(canAffordAny(10, items)).toBe(true);
    expect(canAffordAny(9.9, items)).toBe(false);
    expect(canAffordAny(100, [{ buyable: false, price: 5 }])).toBe(false);
  });
  it('сначала способные купить, потом остальные; внутри — по нику', () => {
    const list = [{ n: 'Яна', b: 100 }, { n: 'Аня', b: 1 }, { n: 'Боря', b: 50 }, { n: 'Вера', b: 2 }];
    const out = sortByAffordability(list, { can: x => x.b >= 10, nick: x => x.n });
    expect(out.map(x => x.n)).toEqual(['Боря', 'Яна', 'Аня', 'Вера']);
  });
});

describe('срок обновления лимита', () => {
  it('через месяц: 31 января → конец февраля, 15 сентября → 15 октября', () => {
    expect(addMonthMsk('2026-01-31T10:00:00Z')).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonthMsk('2028-01-31T10:00:00Z')).toBe('2028-02-29T10:00:00.000Z');
    expect(addMonthMsk('2026-09-15T17:07:00Z')).toBe('2026-10-15T17:07:00.000Z');
    expect(addMonthMsk('мусор')).toBeNull();
  });
  it('время сайта московское', () => {
    expect(siteStampToIso('2026-10-07 01:11')).toBe('2026-10-06T22:11:00.000Z');
    expect(siteStampToIso('вчера')).toBeNull();
  });
  it('последняя покупка по «Истории монет» (на настоящей странице)', () => {
    const rows = historyRows();
    expect(historyPurchaseAt(rows, itemByKey('asura'))).toBe(siteStampToIso('2026-09-15 20:07'));
    expect(historyPurchaseAt(rows, itemByKey('light'))).toBe(siteStampToIso('2026-10-07 01:11'));
    expect(historyPurchaseAt(rows, itemByKey('camp'))).toBeNull();
  });
  it('асуров: куплено 15.09, лимит 0 → дата сброса 15.10', () => {
    const item = normalizeScan(scanPayload(), NOW).items.asura;
    expect(needsHistory(item, null)).toBe(true);
    const at = historyPurchaseAt(historyRows(), itemByKey('asura'));
    const t = reconcileTrack({ lastBuyAt: at }, item, NOW);
    expect(t.resetAt).toBe(addMonthMsk(at));
    const v = limitView(item, t, NOW);
    expect(v).toMatchObject({ exhausted: true, available: 0 });
    expect(v.text).toContain('лимит исчерпан');
    expect(v.text).toContain('обновится 15.10.2026 (через 8 дн.)');
  });
  it('лимит обновился: срок прошёл или «Доступно» выросло', () => {
    const item = { found: true, available: 4, max: 4 };
    const old = { lastBuyAt: '2026-08-01T00:00:00Z', resetAt: '2026-09-01T00:00:00Z', available: 0 };
    expect(reconcileTrack(old, item, NOW)).toMatchObject({ lastBuyAt: null, resetAt: null, available: 4 });
    const fresh = { lastBuyAt: '2026-10-01T00:00:00Z', resetAt: '2026-11-01T00:00:00Z', available: 1 };
    expect(reconcileTrack(fresh, { found: true, available: 4 }, NOW).resetAt).toBeNull();
    expect(reconcileTrack(fresh, { found: true, available: 1 }, NOW).resetAt).toBe('2026-11-01T00:00:00Z');
  });
  it('у предмета без лимита записи нет', () => {
    expect(reconcileTrack(null, { found: true, available: null }, NOW)).toBeNull();
    expect(limitView({ found: true, available: null }, null)).toBeNull();
  });
  it('после покупки срок считается от неё, даже если куплено не всё', () => {
    const t = trackAfterPurchase(null, { at: '2026-10-08T09:00:00Z', availableBefore: 4, availableAfter: 2 });
    expect(t).toMatchObject({ lastBuyAt: '2026-10-08T09:00:00Z', resetAt: '2026-11-08T09:00:00.000Z', max: 4, available: 2 });
    const t2 = trackAfterPurchase(t, { at: '2026-10-20T09:00:00Z', availableAfter: 1 });
    expect(t2.resetAt).toBe('2026-11-20T09:00:00.000Z');
  });
  it('история нужна, только когда лимит тронут, а дата неизвестна', () => {
    expect(needsHistory({ found: true, available: 4, max: 4 }, null)).toBe(false);
    expect(needsHistory({ found: true, available: 2, max: 4 }, null)).toBe(true);
    expect(needsHistory({ found: true, available: 2, max: 4 }, { lastBuyAt: '2026-10-01T00:00:00Z' })).toBe(false);
    expect(needsHistory({ found: true, available: null }, null)).toBe(false);
  });
  it('сколько записей покупки появилось с момента старта', () => {
    const rows = [
      { at: '2026-10-08 12:01', delta: -10, action: 'Покупка предмета Знак доблести' },
      { at: '2026-10-08 12:02', delta: -10, action: 'Покупка предмета Знак доблести' },
      { at: '2026-10-01 12:02', delta: -10, action: 'Покупка предмета Знак доблести' },
      { at: '2026-10-08 12:02', delta: -40, action: 'Покупка предмета Камень асуров' }
    ];
    expect(countHistoryPurchases(rows, itemByKey('valor'), 10, '2026-10-08T09:00:30Z')).toBe(2);
  });
});

describe('итоги покупки', () => {
  it('статусы ответа → решение', () => {
    expect(interpretBuy({ status: 'success' })).toMatchObject({ kind: 'bought', status: 'done' });
    expect(interpretBuy({ status: 'dry_run' }).kind).toBe('dry');
    expect(interpretBuy({ status: 'limit_reached' })).toMatchObject({ kind: 'stop', status: 'limit' });
    expect(interpretBuy({ status: 'no_funds' })).toMatchObject({ kind: 'stop', status: 'no_funds' });
    expect(interpretBuy({ status: 'price_changed', info: { price: 50 } })).toMatchObject({ status: 'price_changed', price: 50 });
    expect(interpretBuy({ status: 'unknown', error: 'x' })).toMatchObject({ kind: 'block', status: 'unknown' });
    expect(interpretBuy({ status: 'not_logged_in' })).toMatchObject({ kind: 'block', status: 'not_logged_in' });
    expect(interpretBuy({ status: 'no_effect' })).toMatchObject({ kind: 'stop', status: 'no_effect' });
  });
  it('повтор только пока кнопка не нажата', () => {
    expect(interpretBuy({ status: 'error', error: 'timeout', clicked: false }).kind).toBe('retry');
    expect(interpretBuy({ status: 'error', error: 'timeout', clicked: true }).kind).toBe('stop');
    expect(interpretBuy({ status: 'error', error: 'modal_missing', clicked: false }).kind).toBe('retry');
    expect(interpretBuy({ status: 'error', error: 'window_open' }).kind).toBe('block');
    expect(interpretBuy(null, new Error('boom')).kind).toBe('retry');
  });
  it('подписи: куплено до лимита, «Лимит исчерпан — не куплено»', () => {
    expect(resultLabel({ status: 'limit', bought: 4, requested: 6 })).toBe('Куплено до лимита: 4 из 6');
    expect(resultLabel({ status: 'limit', bought: 0, requested: 6 })).toBe('Лимит исчерпан — не куплено');
    expect(resultLabel({ status: 'done', bought: 3, requested: 3 })).toBe('Куплено: 3 из 3');
    expect(resultLabel({ status: 'dry_run' })).toContain('не нажата');
    expect(resultInfo('что-то').level).toBe('error');
  });
  it('монеты и остаток лимита из ответа покупки', () => {
    const a = afterPurchase({ balanceAfter: 44, items: [{ want: 'Камень лагеря', found: true, price: 40, available: 3 }] }, itemByKey('camp'));
    expect(a.balance).toBe(44);
    expect(a.item.available).toBe(3);
    expect(afterPurchase({}, itemByKey('camp'))).toEqual({ balance: null, item: null });
  });
  it('сводка по строкам', () => {
    const s = summarizeRows([
      { status: 'done', bought: 3, spent: 30 }, { status: 'limit', bought: 4, spent: 160 }, { status: 'no_funds', bought: 0 },
      { status: 'unknown', bought: 0 }, { status: 'error' }, { status: 'dry_run' }, { status: 'cancelled' }
    ]);
    expect(s).toMatchObject({ total: 7, bought: 7, spent: 190, done: 1, limited: 1, noFunds: 1, unknown: 1, failed: 1, dry: 1, notRun: 1 });
  });
});
