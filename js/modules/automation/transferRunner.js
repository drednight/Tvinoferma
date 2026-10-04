// js/modules/automation/transferRunner.js
// Запуск передачи предметов (Issue #26): чтение серверов и персонажей и сама передача.
// - браузеры идут параллельно, общий лимит окон (browserSlots) из «Настройки → Скрипты»;
// - чтение страницы безопасно, поэтому его можно повторять; передача повторяется только пока «Передать» не нажато:
//   после нажатия повтор мог бы отправить предметы дважды (сайт и так вернёт «не удалось определить»);
// - «Стоп» не даёт начаться новым передачам; уже нажатая заканчивается и учитывается.
// Без интерфейса: всё внешнее передаётся параметрами (так проще тестировать).

import { runQueue, sleep, browserSlots } from '../sync/queue.js';
import { rowFromPayload, plainRow, canAutoRetry, isTransient } from './transferCore.js';

/** Разброс старта новых браузеров, мс: окна открываются не одновременно. */
export const START_STAGGER_MS = [400, 1400];
const range = (r, random) => r[0] + random() * (r[1] - r[0]);

/**
 * Чтение серверов и персонажей у набора браузеров (команда `read_transfer_page`, только чтение).
 * @returns {Promise<Array<{ charId: string, nick: string, status: string, error: string|null, roster: object|null }>>}
 */
export async function scanRosters({
  chars, signal = { cancelled: false }, invokeFn, limiter = browserSlots,
  retries = 0, retryDelayMs = 2000, task, onRow, sleepFn = sleep, random = Math.random
}) {
  let started = 0;
  const rows = new Map();
  const entries = await runQueue(chars, async (char, attempt) => {
    if (signal.cancelled) return { cancelled: true };
    if (attempt === 0 && started++ > 0) await sleepFn(range(START_STAGGER_MS, random));
    task?.setStep?.(`${char.nick}: читаю серверы и персонажей${attempt ? ` (повтор ${attempt}/${retries})` : ''}`);
    return await invokeFn('read_transfer_page', { charId: char.id, timeoutSeconds: Math.min(25 + 15 * attempt, 60) });
  }, {
    limiter, retries, retryDelayMs, signal,
    shouldRetry: (res, err) => !!err || res?.status === 'challenge' || (res?.status === 'error' && isTransient(res.error)),
    onDone: ({ item, result, error }, done, total) => {
      if (result?.cancelled) return;
      const row = error || !result
        ? { charId: item.id, nick: item.nick, status: 'error', error: String(error?.message || error || 'no_response'), roster: null }
        : { charId: item.id, nick: item.nick, status: result.status, error: result.error || null, roster: result.status === 'ok' ? result.roster : null };
      rows.set(item.id, row);
      task?.progress?.(done, total, item.nick);
      onRow?.(row, done, total);
    }
  });
  entries.forEach(e => { if (!rows.has(e.item.id)) rows.set(e.item.id, { charId: e.item.id, nick: e.item.nick, status: 'cancelled', error: null, roster: null }); });
  return chars.map(c => rows.get(c.id));
}

/**
 * Передача предметов по плану (planTransfer из transferCore.js).
 * Строки плана без `run` получают готовый статус (нет сервера, не выбран получатель, тот же аккаунт…) и на сайт не ходят.
 * @param {{
 *   plans: object[], dryRun?: boolean, signal?: { cancelled: boolean },
 *   invokeFn: (cmd: string, args: object) => Promise<any>,
 *   limiter?: object, retries?: number, retryDelayMs?: number,
 *   task?: { setStep?: Function, progress?: Function, log?: Function },
 *   onRow?: (row: object, done: number, total: number) => void,
 *   sleepFn?: (ms: number) => Promise<void>, random?: () => number
 * }} opts
 * @returns {Promise<object[]>} строки результата в порядке плана
 */
export async function runTransferBatch({
  plans, dryRun = false, signal = { cancelled: false }, invokeFn, limiter = browserSlots,
  retries = 0, retryDelayMs = 2000, task, onRow, sleepFn = sleep, random = Math.random
}) {
  const total = plans.length;
  const rows = new Map();
  let started = 0;
  let done = 0;
  const emit = (plan, row) => {
    if (rows.has(plan.char.id)) return;
    rows.set(plan.char.id, row);
    done++;
    task?.progress?.(done, total, plan.char.nick);
    onRow?.(row, done, total);
  };

  plans.filter(p => !p.run).forEach(p => emit(p, plainRow(p, p.status, p.detail ?? null)));

  const attempt = async (plan) => {
    for (let a = 0; ; a++) {
      task?.setStep?.(`${plan.char.nick} → ${plan.serverName} → ${plan.recipient.name}: ${dryRun ? 'пробный запуск' : 'передаю предметы'}${a ? ` (повтор ${a}/${retries})` : ''}`);
      let payload, error;
      try {
        payload = await invokeFn('transfer_items', {
          charId: plan.char.id, shardId: plan.shardId, recipient: plan.recipient.key, charName: plan.recipient.name,
          dryRun, timeoutSeconds: Math.min(30 + 15 * a, 75)
        });
      } catch (e) { error = e; }
      const row = rowFromPayload(plan, payload, error);
      if (a >= retries || signal.cancelled || !canAutoRetry(row)) return row;
      task?.log?.(`${plan.char.nick}: повтор ${a + 1}/${retries} (${row.status === 'challenge' ? 'проверка безопасности' : row.error})`, 'info');
      await sleepFn(retryDelayMs * (a + 1));
    }
  };

  const runnable = plans.filter(p => p.run);
  const entries = await runQueue(runnable, async (plan) => {
    if (signal.cancelled) return null;
    if (started++ > 0) await sleepFn(range(START_STAGGER_MS, random));
    if (signal.cancelled) return null;
    const row = await attempt(plan);
    emit(plan, row);
    return row;
  }, {
    limiter, retries: 0, signal,
    onDone: (entry) => { if (entry.error) task?.log?.(`${entry.item.char.nick}: ${entry.error?.message || entry.error}`, 'error'); }
  });
  // «Стоп» нажат до старта браузера (или он упал): строка остановленного/ошибочного
  entries.forEach(e => emit(e.item, e.error ? { ...plainRow(e.item, 'error'), error: String(e.error?.message || e.error) } : plainRow(e.item, 'cancelled')));

  return plans.map(p => rows.get(p.char.id)).filter(Boolean);
}
