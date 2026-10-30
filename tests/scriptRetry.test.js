import { describe, expect, it, vi } from 'vitest';
import { planShopRetry } from '../js/modules/automation/shopCore.js';
import { runShopBatch } from '../js/modules/automation/shopRunner.js';
import { runPromoBatch } from '../js/modules/automation/promoRunner.js';
import { runTransferBatch } from '../js/modules/automation/transferRunner.js';
import { runCaravanBatch } from '../js/modules/automation/caravanRunner.js';
import { createLimiter } from '../js/modules/sync/queue.js';

const ch = { id: 'a', nick: 'Альфа' };
const order = (key, qty) => ({ key, qty, requested: qty, price: 10, available: 20 });
const account = (siteKey, orders) => ({ siteKey, char: ch, members: [ch], balance: 100, orders });
const noSleep = async () => {};
const batch = { limiter: createLimiter(1), sleepFn: noSleep, random: () => 0, retries: 3 };

describe('повтор покупок', () => {
  it('после нескольких покупок повторяет только остаток, включая следующий предмет, а успех не повторяет', () => {
    const accounts = [account('a', [order('valor', 3), order('light', 2), order('focus', 1)])];
    const rows = [
      { siteKey: 'a', itemKey: 'valor', status: 'error', bought: 2, spent: 20, clicked: true },
      { siteKey: 'a', itemKey: 'light', status: 'not_run', bought: 0, spent: 0 },
      { siteKey: 'a', itemKey: 'focus', status: 'done', bought: 1, spent: 10 }
    ];
    const result = planShopRetry(accounts, rows);
    expect(result).toHaveLength(1);
    expect(result[0].balance).toBe(70);
    expect(result[0].orders.map(o => [o.key, o.qty, o.requested])).toEqual([
      ['valor', 1, 1],
      ['light', 2, 2]
    ]);
    expect(planShopRetry(accounts, rows, new Map([['a', { ok: true, balance: 53 }]]))[0].balance).toBe(53);
  });

  it('неясная покупка блокирует ВСЕ следующие заказы аккаунта, но не другие аккаунты', () => {
    const accounts = [account('a', [order('valor', 2), order('light', 1)]), account('b', [order('valor', 1)])];
    const rows = [
      { siteKey: 'a', itemKey: 'valor', status: 'unknown', bought: 1 },
      { siteKey: 'a', itemKey: 'light', status: 'not_run', retryBlocked: true },
      { siteKey: 'b', itemKey: 'valor', status: 'error', bought: 0 }
    ];
    const result = planShopRetry(accounts, rows);
    expect(result.map(a => a.siteKey)).toEqual(['b']);
    expect(result[0].orders[0].qty).toBe(1);
  });

  it('исключение после покупки нельзя автоповторить или запускать последующие предметы', async () => {
    let calls = 0;
    const invokeFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return { status: 'success', clicked: true };
      throw new Error('ipc disconnected');
    });
    const accounts = [account('a', [order('valor', 3), order('light', 1)])];
    const rows = await runShopBatch({ ...batch, accounts, invokeFn });
    expect(calls).toBe(2);
    expect(rows[0]).toMatchObject({ status: 'unknown', bought: 1, spent: 10 });
    expect(rows[1]).toMatchObject({ status: 'not_run', retryBlocked: true });
    expect(planShopRetry(accounts, rows)).toEqual([]);
  });

  it('снимок подтверждённой покупки поступает до окончания заказа', async () => {
    const seen = [];
    await runShopBatch({
      ...batch,
      accounts: [account('a', [order('valor', 2)])],
      invokeFn: async () => ({ status: 'success', clicked: true }),
      onPurchase: info => seen.push(info.row)
    });
    expect(seen.map(row => row.bought)).toEqual([1, 2]);
    expect(seen.map(row => row.spent)).toEqual([10, 20]);
  });
});

describe('неизвестный исход вызова', () => {
  it('промокод: исключение и пропуск неизвестной строки не теряют защиту от повтора', async () => {
    const invokeFn = vi.fn(async () => {
      throw new Error('ipc');
    });
    const opts = { ...batch, codes: ['CODE1234'], chars: [ch], invokeFn };
    const [first] = await runPromoBatch(opts);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: 'unknown', uncertain: true, clicked: false });
    const [second] = await runPromoBatch({ ...opts, skip: () => first });
    const [third] = await runPromoBatch({ ...opts, skip: () => second });
    expect(third).toMatchObject({ status: 'unknown', skipped: true, uncertain: true });
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it('передача: исключение не перезапускается, даже если настроены автоматические повторы', async () => {
    const invokeFn = vi.fn(async () => {
      throw new Error('ipc');
    });
    const plans = [{ char: ch, run: true, shardId: '1', serverName: 'Сервер', recipient: { key: '1', name: 'Бета' } }];
    const [row] = await runTransferBatch({ ...batch, plans, invokeFn });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ status: 'unknown', uncertain: true, clicked: false });
  });

  it('неполный ответ без признака нажатия не запускается повторно', async () => {
    const plans = [{ char: ch, run: true, shardId: '1', serverName: 'Сервер', recipient: { key: '1', name: 'Бета' } }];
    for (const run of [
      invokeFn => runPromoBatch({ ...batch, codes: ['CODE1234'], chars: [ch], invokeFn }),
      invokeFn => runTransferBatch({ ...batch, plans, invokeFn }),
      invokeFn => runCaravanBatch({ ...batch, chars: [ch], invokeFn })
    ]) {
      const invokeFn = vi.fn(async () => ({ status: 'challenge' }));
      const [row] = await run(invokeFn);
      expect(invokeFn).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({ status: 'unknown', uncertain: true });
    }
  });

  it('частичный ответ каравана без проверенного списка сундуков остаётся неясным', async () => {
    const invokeFn = vi.fn(async () => ({ status: 'partial', clicked: true }));
    const [row] = await runCaravanBatch({ ...batch, chars: [ch], invokeFn });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ status: 'unknown', uncertain: true });
  });

  it('караван: ошибка после возможного нажатия не перезапускается', async () => {
    const invokeFn = vi.fn(async () => {
      throw new Error('navigate after click');
    });
    const [row] = await runCaravanBatch({ ...batch, chars: [ch], invokeFn });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ status: 'unknown', uncertain: true, clicked: false });
  });
});
