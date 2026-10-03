// js/modules/automation/promoRunner.js
// Запуск активации промокода для набора персонажей (Issue #25): строго по одному, с паузами между
// персонажами, с отменой. Без интерфейса — всё внешнее передаётся параметрами (так проще тестировать).

import { createLimiter, runQueue, sleep } from '../sync/queue.js';
import { rowFromPayload } from './promoCore.js';

/** Пауза между персонажами, мс: от и до (случайная, чтобы запросы не шли «по метроному»). */
export const PAUSE_MS = [1500, 3500];

const cancelledRow = (char, now = new Date()) => ({
  charId: char.id, nick: char.nick, status: 'cancelled', error: null, detail: null, clicked: false, dryRun: false, at: now.toISOString()
});

/**
 * @param {{
 *   code: string,
 *   chars: Array<{ id: string, nick: string }>,
 *   dryRun?: boolean,
 *   signal?: { cancelled: boolean },
 *   invokeFn: (cmd: string, args: object) => Promise<any>,
 *   task?: { setStep?: Function, progress?: Function, log?: Function },
 *   onRow?: (row: object, done: number, total: number) => void,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   random?: () => number
 * }} opts
 * @returns {Promise<object[]>} строки результата в порядке персонажей
 */
export async function runPromoBatch({ code, chars, dryRun = false, signal = { cancelled: false }, invokeFn, task, onRow, sleepFn = sleep, random = Math.random }) {
  const limiter = createLimiter(1);   // по одному персонажу за раз
  let started = 0;

  const toRow = (entry) => {
    if (entry.cancelled || (entry.result === null && !entry.error)) return cancelledRow(entry.item);
    return rowFromPayload(entry.item, entry.result, entry.error);
  };

  const entries = await runQueue(chars, async (char) => {
    if (signal.cancelled) return null;
    if (started++ > 0) await sleepFn(PAUSE_MS[0] + random() * (PAUSE_MS[1] - PAUSE_MS[0]));
    if (signal.cancelled) return null;
    task?.setStep?.(`${char.nick}: ${dryRun ? 'осматриваю страницу промокода' : 'ввожу промокод'}`);
    // Повторов нет: если кнопка уже нажата, второй запуск мог бы применить код дважды
    return await invokeFn('activate_promo', { charId: char.id, code, dryRun });
  }, {
    limiter,
    retries: 0,
    signal,
    onDone: (entry, done, total) => {
      const row = toRow(entry);
      task?.progress?.(done, total, entry.item.nick);
      onRow?.(row, done, total);
    }
  });

  return entries.map(toRow);
}
