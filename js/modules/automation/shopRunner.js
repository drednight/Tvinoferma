// js/modules/automation/shopRunner.js
// Покупка за Древние монеты (магазин подарков) для набора аккаунтов.
// - аккаунты идут параллельно, как при проверке входа: общий лимит окон (browserSlots) из «Настройки → Скрипты»;
// - у одного аккаунта предметы идут по порядку списка, каждая штука — отдельная команда `buy_shop_item`
//   (сайт обновляет страницу после покупки, токены покупки каждый раз новые), с короткой паузой;
// - повторы только пока кнопка не нажата (таймаут, окно подтверждения не успело появиться):
//   после нажатия повтор мог бы купить предмет дважды;
// - неясный исход сверяется с «Историей монет»; если подтвердить нельзя, остальное у аккаунта не выполняется;
// - «Стоп» не начинает новых покупок; начатая заканчивается и учитывается.
// Без интерфейса: всё внешнее передаётся параметрами (так проще тестировать).

import { roundCoins } from '../../core/coins.js';
import { runQueue, sleep, browserSlots } from '../sync/queue.js';
import { itemByKey, wantedNames, interpretBuy, afterPurchase, countHistoryPurchases } from './shopCore.js';

/** Пауза между покупками одного аккаунта, мс: от и до (случайная). */
export const PURCHASE_PAUSE_MS = [1000, 2000];
/** Разброс старта новых аккаунтов, мс: окна открываются не одновременно. */
export const START_STAGGER_MS = [400, 1400];

const range = (r, random) => r[0] + random() * (r[1] - r[0]);

const BLOCK_TEXT = {
  not_logged_in: 'У аккаунта нет входа — остальное не выполнялось',
  challenge: 'Сайт показал проверку безопасности — остальное не выполнялось',
  unknown: 'Результат предыдущей покупки неясен — остальное не выполнялось, проверьте «Историю монет»',
  error: 'Остановлено из-за ошибки — остальное не выполнялось'
};

/**
 * @param {{
 *   accounts: Array<{ siteKey: string, char: { id: string, nick: string }, members?: Array<{ nick: string }>, account?: string,
 *     balance: number, orders: Array<{ key: string, qty: number, requested: number, price: number, available: number|null, cap?: string|null }> }>,
 *   dryRun?: boolean,
 *   signal?: { cancelled: boolean },
 *   invokeFn: (cmd: string, args: object) => Promise<any>,
 *   limiter?: object, retries?: number, retryDelayMs?: number,
 *   task?: { setStep?: Function, progress?: Function, log?: Function },
 *   onRow?: (row: object, done: number, total: number) => void,
 *   onPurchase?: (info: object) => void,
 *   sleepFn?: (ms: number) => Promise<void>, random?: () => number, now?: () => Date
 * }} opts
 * @returns {Promise<object[]>} строки итога: по аккаунтам, у каждого предметы по порядку
 */
export async function runShopBatch({
  accounts, dryRun = false, signal = { cancelled: false }, invokeFn, limiter = browserSlots,
  retries = 0, retryDelayMs = 2000, task, onRow, onPurchase, sleepFn = sleep, random = Math.random, now = () => new Date()
}) {
  const total = accounts.reduce((n, a) => n + a.orders.length, 0);
  const wanted = wantedNames();
  const rows = new Map();                                   // "siteKey|ключ предмета" → строка
  let started = 0;
  let done = 0;

  const rowKey = (acc, order) => `${acc.siteKey}|${order.key}`;
  const baseRow = (acc, order, balance) => ({
    siteKey: acc.siteKey, charId: acc.char.id, nick: acc.char.nick, members: (acc.members || []).map(m => m.nick), account: acc.account || '',
    itemKey: order.key, item: itemByKey(order.key)?.name || order.key, requested: order.requested, planned: order.qty,
    bought: 0, spent: 0, viaHistory: 0, price: order.price, balanceBefore: balance, balanceAfter: balance,
    status: 'not_run', detail: null, code: null, clicked: false, dryRun, at: now().toISOString()
  });
  const emit = (acc, order, row) => {
    if (rows.has(rowKey(acc, order))) return;
    rows.set(rowKey(acc, order), row);
    done++;
    task?.progress?.(done, total, acc.char.nick);
    onRow?.(row, done, total);
  };

  const attempt = async (acc, order) => {
    for (let a = 0; ; a++) {
      task?.setStep?.(`${acc.char.nick}: ${dryRun ? 'осматриваю' : 'покупаю'} «${itemByKey(order.key)?.name}»${a ? ` (повтор ${a}/${retries})` : ''}`);
      let payload, error;
      try {
        payload = await invokeFn('buy_shop_item', {
          charId: acc.char.id, item: itemByKey(order.key).name, expectPrice: order.price, wanted, dryRun,
          timeoutSeconds: Math.min(25 + 15 * a, 60)
        });
      } catch (e) { error = e; }
      const decision = interpretBuy(payload, error);
      if (decision.kind !== 'retry' || a >= retries || signal.cancelled) return { payload, decision };
      task?.log?.(`${acc.char.nick}: повтор ${a + 1}/${retries} (${decision.code})`, 'info');
      await sleepFn(retryDelayMs * (a + 1));
    }
  };

  const worker = async (acc) => {
    let balance = acc.balance;
    let blocked = null;                                     // статус, из-за которого остальное у аккаунта не выполняется
    let invoked = 0;
    for (const order of acc.orders) {
      const def = itemByKey(order.key);
      const row = baseRow(acc, order, balance);
      if (!def || !(order.qty > 0)) { emit(acc, order, { ...row, status: 'skipped', detail: order.cap === 'limit' ? 'Лимит исчерпан' : order.cap === 'funds' ? 'Не хватает монет' : null }); continue; }
      if (signal.cancelled) { emit(acc, order, { ...row, status: 'cancelled' }); continue; }
      if (blocked) { emit(acc, order, { ...row, status: 'not_run', detail: BLOCK_TEXT[blocked] || BLOCK_TEXT.error }); continue; }

      const startedAt = now().toISOString();
      let availableNow = order.available ?? null;
      let stop = null;                                      // { status, detail }
      const count = dryRun ? 1 : order.qty;
      for (let i = 0; i < count; i++) {
        if (signal.cancelled) break;
        if (invoked === 0 && started++ > 0) await sleepFn(range(START_STAGGER_MS, random));
        else if (invoked > 0) await sleepFn(range(PURCHASE_PAUSE_MS, random));
        invoked++;
        if (signal.cancelled) break;

        const { payload, decision } = await attempt(acc, order);
        if (payload?.clicked) row.clicked = true;
        if (decision.kind === 'dry') { row.status = 'dry_run'; row.detail = payload.detail || null; stop = { status: 'dry_run', detail: payload.detail || null }; break; }

        let bought = decision.kind === 'bought';
        if (decision.kind === 'block' && decision.status === 'unknown' && Array.isArray(payload?.history)) {
          // Покупка могла пройти: в «Истории монет» должно быть больше записей, чем куплено нами в этом заказе
          const seen = countHistoryPurchases(payload.history, def, order.price, startedAt);
          if (seen > row.bought) { bought = true; row.viaHistory++; }
        }
        if (bought) {
          const after = afterPurchase(payload, def);
          const before = availableNow;
          row.bought++;
          row.spent = roundCoins(row.spent + order.price);
          balance = after.balance ?? roundCoins(balance - order.price);
          row.balanceAfter = balance;
          availableNow = after.item?.available ?? (before != null ? Math.max(0, before - 1) : null);
          onPurchase?.({ acc, order, def, at: now().toISOString(), balanceAfter: balance, availableBefore: before, availableAfter: availableNow, itemAfter: after.item });
          continue;
        }

        row.code = decision.code || null;
        const detail = decision.status === 'price_changed' && decision.price != null ? `Новая цена на сайте: ${decision.price}` : (payload?.detail || (decision.status === 'error' ? decision.code : null));
        stop = { status: decision.kind === 'retry' ? 'error' : decision.status, detail };
        if (decision.kind === 'block') blocked = decision.status;
        break;
      }

      if (stop) { row.status = stop.status; row.detail = stop.detail ?? row.detail; }
      else if (signal.cancelled && row.bought < order.qty) row.status = 'cancelled';
      else if (row.bought >= order.requested) row.status = 'done';
      else row.status = order.cap === 'limit' ? 'limit' : order.cap === 'funds' ? 'no_funds' : 'done';
      row.balanceAfter = balance;
      emit(acc, order, row);
    }
  };

  const entries = await runQueue(accounts, worker, {
    limiter, retries: 0, signal,
    onDone: (entry) => { if (entry.error) task?.log?.(`${entry.item.char.nick}: ${entry.error?.message || entry.error}`, 'error'); }
  });
  // Если «Стоп» нажат до старта аккаунта или worker упал, строки помечаются остановленными / не выполненными
  entries.forEach(e => e.item.orders.forEach(order => {
    if (rows.has(rowKey(e.item, order))) return;
    emit(e.item, order, { ...baseRow(e.item, order, e.item.balance), status: e.error ? 'error' : 'cancelled', detail: e.error ? String(e.error?.message || e.error) : null });
  }));

  return accounts.flatMap(acc => acc.orders.map(order => rows.get(rowKey(acc, order))).filter(Boolean));
}
