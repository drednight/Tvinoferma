import { describe, it, expect, vi } from 'vitest';
import { createLimiter, runQueue, isRetryableCode } from '../js/scripts/queue.js';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

describe('createLimiter', () => {
  it('не превышает лимит параллельности', async () => {
    const limiter = createLimiter(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      active++; peak = Math.max(peak, active);
      await tick();
      active--;
    })));
    expect(peak).toBe(2);
  });
});

describe('runQueue', () => {
  it('повторяет при ошибке и возвращает число попыток', async () => {
    const worker = vi.fn(async (item, attempt) => {
      if (item === 'flaky' && attempt < 2) return { error: 'timeout' };
      return { ok: item };
    });
    const res = await runQueue(['a', 'flaky'], worker, {
      limiter: createLimiter(3), retries: 3, retryDelayMs: 1,
      shouldRetry: (r, e) => !!e || isRetryableCode(r?.error)
    });
    expect(res.map(r => [r.item, r.attempts, r.result.ok])).toEqual([['a', 1, 'a'], ['flaky', 3, 'flaky']]);
  });

  it('не повторяет окончательные ошибки и учитывает лимит повторов', async () => {
    const worker = vi.fn(async () => ({ error: 'not_logged_in' }));
    const [r] = await runQueue(['x'], worker, { limiter: createLimiter(1), retries: 5, retryDelayMs: 1, shouldRetry: (res) => isRetryableCode(res?.error) });
    expect(r.attempts).toBe(1);

    const thrower = vi.fn(async () => { throw new Error('boom'); });
    const [t] = await runQueue(['y'], thrower, { limiter: createLimiter(1), retries: 2, retryDelayMs: 1 });
    expect(t.attempts).toBe(3);
    expect(t.error.message).toBe('boom');
  });

  it('сообщает прогресс', async () => {
    const seen = [];
    await runQueue([1, 2, 3], async (n) => n, { limiter: createLimiter(2), onDone: (_e, done, total) => seen.push(`${done}/${total}`) });
    expect(seen).toEqual(['1/3', '2/3', '3/3']);
  });
});

describe('isRetryableCode', () => {
  it('классифицирует коды', () => {
    expect(isRetryableCode('challenge')).toBe(true);
    expect(isRetryableCode('timeout_polling_smart')).toBe(true);
    expect(isRetryableCode('exception_TypeError')).toBe(true);
    expect(isRetryableCode('not_logged_in')).toBe(false);
    expect(isRetryableCode(null)).toBe(false);
  });
});
