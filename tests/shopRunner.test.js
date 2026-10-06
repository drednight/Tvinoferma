// Покупка за Древние монеты (shopRunner.js): штука за штукой, лимит, монеты, смена цены, неясный исход, стоп, пробный запуск.
import { describe, it, expect, vi } from 'vitest';
import { runShopBatch } from '../js/modules/automation/shopRunner.js';
import { createLimiter } from '../js/modules/sync/queue.js';

const NOW = new Date('2026-10-08T09:00:00Z');                 // 12:00 по Москве
const ok = (extra = {}) => ({ status: 'success', clicked: true, balanceAfter: undefined, ...extra });
const order = (key, qty, extra = {}) => ({ key, qty, requested: qty, price: key === 'valor' ? 10 : 40, available: null, cap: null, ...extra });
const acct = (id, orders, extra = {}) => ({ siteKey: `acc:${id}`, char: { id, nick: id.toUpperCase() }, members: [{ id, nick: id.toUpperCase() }], account: `u_${id}`, balance: 200, orders, ...extra });
const base = (over) => ({ limiter: createLimiter(3), sleepFn: async () => {}, random: () => 0, now: () => NOW, ...over });
const names = { light: 'Камень светлого духа', camp: 'Камень лагеря', valor: 'Знак доблести (25 штук)' };

describe('runShopBatch: покупка штука за штукой', () => {
  it('3 штуки = 3 вызова; в команду уходят предмет, ожидаемая цена, список предметов', async () => {
    const invokeFn = vi.fn(async () => ok());
    const onPurchase = vi.fn();
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('valor', 3)])], invokeFn, onPurchase }));
    expect(invokeFn).toHaveBeenCalledTimes(3);
    const [cmd, args] = invokeFn.mock.calls[0];
    expect(cmd).toBe('buy_shop_item');
    expect(args).toMatchObject({ charId: 'a', item: names.valor, expectPrice: 10, dryRun: false });
    expect(args.wanted).toHaveLength(8);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'done', bought: 3, spent: 30, requested: 3, balanceBefore: 200, balanceAfter: 170 });
    expect(onPurchase).toHaveBeenCalledTimes(3);
    expect(onPurchase.mock.calls[2][0]).toMatchObject({ balanceAfter: 170 });
  });

  it('баланс и лимит берутся из ответа сайта, если он их показал', async () => {
    const invokeFn = vi.fn(async () => ok({ balanceAfter: 150, items: [{ want: names.light, found: true, price: 40, available: 3 }] }));
    const onPurchase = vi.fn();
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 1, { available: 4 })])], invokeFn, onPurchase }));
    expect(rows[0].balanceAfter).toBe(150);
    expect(onPurchase.mock.calls[0][0]).toMatchObject({ availableBefore: 4, availableAfter: 3, balanceAfter: 150 });
  });

  it('предметы одного аккаунта идут по порядку списка', async () => {
    const calls = [];
    const invokeFn = async (_, a) => { calls.push(a.item); return ok(); };
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 1), order('valor', 2)])], invokeFn }));
    expect(calls).toEqual([names.light, names.valor, names.valor]);
    expect(rows.map(r => r.itemKey)).toEqual(['light', 'valor']);
  });

  it('запрошено 6, доступно 4: куплено 4, итог «куплено до лимита»', async () => {
    const invokeFn = vi.fn(async () => ok());
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('camp', 4, { requested: 6, available: 4, cap: 'limit' })])], invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(4);
    expect(rows[0]).toMatchObject({ status: 'limit', bought: 4, requested: 6 });
  });

  it('сайт сообщил о лимите посреди покупки — остановились, куплено засчитано', async () => {
    let n = 0;
    const invokeFn = async () => (++n < 3 ? ok() : { status: 'limit_reached', clicked: false });
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('camp', 4)])], invokeFn }));
    expect(rows[0]).toMatchObject({ status: 'limit', bought: 2 });
  });

  it('монет не хватает по расчёту: итог «не хватило монет»', async () => {
    const invokeFn = vi.fn(async () => ok());
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 1, { requested: 3, cap: 'funds' })], { balance: 54 })], invokeFn }));
    expect(rows[0]).toMatchObject({ status: 'no_funds', bought: 1 });
  });

  it('предмет с нулевым количеством пропускается без вызова', async () => {
    const invokeFn = vi.fn(async () => ok());
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 0, { requested: 2, cap: 'limit' })])], invokeFn }));
    expect(invokeFn).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'skipped', detail: 'Лимит исчерпан' });
  });

  it('цена изменилась: этот предмет остановлен, следующий покупается', async () => {
    const invokeFn = vi.fn(async (_, a) => (a.item === names.light ? { status: 'price_changed', clicked: false, info: { price: 45 } } : ok()));
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 2), order('valor', 1)])], invokeFn }));
    expect(rows[0]).toMatchObject({ status: 'price_changed', bought: 0, detail: 'Новая цена на сайте: 45' });
    expect(rows[1]).toMatchObject({ status: 'done', bought: 1 });
  });

  it('нет входа: остальное у этого аккаунта не выполняется, другие аккаунты идут', async () => {
    const invokeFn = async (_, a) => (a.charId === 'a' ? { status: 'not_logged_in', clicked: false } : ok());
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('light', 1), order('valor', 1)]), acct('b', [order('valor', 1)])], invokeFn }));
    expect(rows.map(r => r.status)).toEqual(['not_logged_in', 'not_run', 'done']);
  });
});

describe('runShopBatch: неясный исход и повторы', () => {
  const unknown = (history) => ({ status: 'unknown', clicked: true, error: 'no_signal', history });

  it('неясно, а в «Истории монет» покупка есть — засчитывается', async () => {
    const history = [{ at: '2026-10-08 12:00', delta: -10, after: 90, action: 'Покупка предмета Знак доблести' }];
    const invokeFn = async () => unknown(history);
    const rows = await runShopBatch(base({ accounts: [acct('a', [order('valor', 1)])], invokeFn }));
    expect(rows[0]).toMatchObject({ status: 'done', bought: 1, viaHistory: 1 });
  });

  it('неясно и подтвердить нельзя: «не распознан», остальное не выполняется, повторов нет', async () => {
    const invokeFn = vi.fn(async () => unknown([]));
    const rows = await runShopBatch(base({ retries: 3, accounts: [acct('a', [order('valor', 2), order('light', 1)])], invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'unknown', bought: 0, clicked: true });
    expect(rows[1].status).toBe('not_run');
    expect(rows[1].detail).toContain('Историю монет');
  });

  it('до нажатия повторяем (таймаут, нет окна подтверждения), после нажатия — нет', async () => {
    let n = 0;
    const flaky = vi.fn(async () => (++n === 1 ? { status: 'error', error: 'modal_missing', clicked: false } : ok()));
    const rows = await runShopBatch(base({ retries: 1, accounts: [acct('a', [order('valor', 1)])], invokeFn: flaky }));
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ status: 'done', bought: 1 });

    const clicked = vi.fn(async () => ({ status: 'error', error: 'timeout', clicked: true }));
    const rows2 = await runShopBatch(base({ retries: 2, accounts: [acct('a', [order('valor', 1)])], invokeFn: clicked }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(rows2[0]).toMatchObject({ status: 'error', bought: 0, clicked: true });
  });

  it('исключение вызова — это повторяемая ошибка до нажатия', async () => {
    let n = 0;
    const invokeFn = async () => { if (++n === 1) throw new Error('ipc'); return ok(); };
    const rows = await runShopBatch(base({ retries: 1, accounts: [acct('a', [order('valor', 1)])], invokeFn }));
    expect(rows[0].status).toBe('done');
  });
});

describe('runShopBatch: стоп, пробный запуск, параллельность', () => {
  it('«Стоп» после первой покупки: новых нет, остальное «остановлено»', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async () => { signal.cancelled = true; return ok(); });
    const rows = await runShopBatch(base({ signal, accounts: [acct('a', [order('valor', 3), order('light', 1)])], invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'cancelled', bought: 1 });
    expect(rows[1].status).toBe('cancelled');
  });

  it('пробный запуск: один вызов на предмет с dryRun, без покупок', async () => {
    const invokeFn = vi.fn(async () => ({ status: 'dry_run', clicked: false, detail: 'Купить' }));
    const onPurchase = vi.fn();
    const rows = await runShopBatch(base({ dryRun: true, accounts: [acct('a', [order('valor', 5)])], invokeFn, onPurchase }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(invokeFn.mock.calls[0][1].dryRun).toBe(true);
    expect(onPurchase).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'dry_run', bought: 0, dryRun: true });
  });

  it('одновременно работает не больше окон, чем разрешено', async () => {
    let active = 0, max = 0;
    const invokeFn = async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--; return ok(); };
    const accounts = ['a', 'b', 'c', 'd', 'e'].map(id => acct(id, [order('valor', 1)]));
    const rows = await runShopBatch(base({ accounts, invokeFn, limiter: createLimiter(2) }));
    expect(max).toBe(2);
    expect(rows).toHaveLength(5);
  });

  it('onRow получает каждую строку один раз, счётчик растёт', async () => {
    const onRow = vi.fn();
    await runShopBatch(base({ accounts: [acct('a', [order('valor', 1), order('light', 1)])], invokeFn: async () => ok(), onRow }));
    expect(onRow.mock.calls.map(c => [c[1], c[2]])).toEqual([[1, 2], [2, 2]]);
  });
});
