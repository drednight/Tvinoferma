// js/modules/sync/queue.js
// Общий планировщик фоновых скриптов (вход, балансы, марафоны):
// - лимит одновременно работающих скрытых окон на всё приложение;
// - повтор при таймауте / «Проверке безопасности» с растущей паузой;
// - прогресс и итог по каждому элементу.

/** Семафор: не больше `max` задач одновременно. Лимит можно менять на лету. */
export function createLimiter(max = 3) {
  let active = 0;
  const waiting = [];
  const limiter = {
    get max() { return max; },
    set max(v) { max = Math.max(1, Number(v) || 1); drain(); },
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(fn) {
      // Слот либо занимается сразу, либо передаётся из drain() (active уже учтён)
      if (active < max) active++;
      else await new Promise(resolve => waiting.push(resolve));
      try { return await fn(); }
      finally { active--; drain(); }
    }
  };
  function drain() {
    while (waiting.length && active < max) { active++; waiting.shift()(); }
  }
  return limiter;
}

/** Общий лимит скрытых окон браузера для всех скриптов. */
export const browserSlots = createLimiter(3);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Ошибки, которые имеет смысл повторить (сайт не успел, anti-bot, страница не дорисована). */
export const RETRYABLE = new Set([
  'timeout', 'challenge', 'pending', 'container_missing', 'no_value_tag',
  'timeout_parsing_marathon', 'timeout_parsing_details', 'unknown'
]);
export const isRetryableCode = (code) => !!code && (RETRYABLE.has(code) || String(code).startsWith('exception_') || String(code).startsWith('timeout'));

/**
 * Выполнить `worker(item, attempt)` для всех элементов.
 * worker возвращает результат; `shouldRetry(result, error, attempt)` решает, нужен ли повтор.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, attempt: number) => Promise<R>} worker
 * @param {{
 *   limiter?: ReturnType<typeof createLimiter>,
 *   retries?: number,
 *   retryDelayMs?: number,
 *   shouldRetry?: (result: R|undefined, error: any, attempt: number) => boolean,
 *   onStart?: (item: T, attempt: number) => void,
 *   onDone?: (entry: { item: T, result?: R, error?: any, attempts: number }, done: number, total: number) => void,
 *   signal?: { cancelled: boolean, paused?: boolean, onPause?: (fn: () => void) => void }
 * }} [opts]
 * @returns {Promise<Array<{ item: T, result?: R, error?: any, attempts: number, cancelled?: boolean }>>}
 */
export async function runQueue(items, worker, opts = {}) {
  const {
    limiter = browserSlots,
    retries = 2,
    retryDelayMs = 2000,
    shouldRetry = (_result, error) => !!error,
    onStart, onDone, signal
  } = opts;
  const total = items.length;
  let done = 0;

  /** Пауза перед следующей попыткой: уже выполняющийся скрипт дожидает, остальные ждут. */
  const waitWhilePaused = async () => {
    while (signal?.paused && !signal.cancelled) await sleep(200);
  };

  const runOne = async (item) => {
    let attempt = 0;
    let result, error;
    while (true) {
      if (signal?.cancelled) return { item, attempts: attempt, cancelled: true };
      await waitWhilePaused();
      if (signal?.cancelled) return { item, attempts: attempt, cancelled: true };
      onStart?.(item, attempt);
      result = undefined; error = undefined;
      try {
        result = await limiter.run(() => worker(item, attempt));
      } catch (e) {
        error = e;
      }
      attempt++;
      if (attempt > retries || !shouldRetry(result, error, attempt - 1)) break;
      await sleep(retryDelayMs * attempt);
      await waitWhilePaused();
    }
    const entry = { item, result, error, attempts: attempt };
    done++;
    onDone?.(entry, done, total);
    return entry;
  };

  return Promise.all(items.map(runOne));
}
