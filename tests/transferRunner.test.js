// Запуск передачи (transferRunner.js, Issue #26): чтение серверов и передача по плану.
import { describe, it, expect, vi } from 'vitest';
import { createLimiter } from '../js/modules/sync/queue.js';
import { scanRosters, runTransferBatch, readServerStatus } from '../js/modules/automation/transferRunner.js';

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, nick: `N${i}` }));
const plansOf = (chars) => chars.map(char => ({ char, run: true, shardId: '3', serverName: 'Фенрир', recipient: { key: '1_3_2', name: '#Тест' } }));
const MSK = (d = new Date()) => new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const sent = (a, extra = {}) => ({ charId: a.charId, status: 'submitted', clicked: true, count: 1, items: [{ name: 'М', qty: 1 }], history: [{ name: 'М', qty: 1, char: '#Тест', server: 'Фенрир', status: 'В обработке', at: MSK() }], ...extra });
const base = (o) => ({ plans: plansOf(mk(3)), invokeFn: vi.fn(), limiter: createLimiter(3), retries: 0, retryDelayMs: 1, sleepFn: async () => {}, random: () => 0, ...o });

describe('scanRosters', () => {
  it('читает каждый браузер командой read_transfer_page; ошибка одного не мешает остальным', async () => {
    const invokeFn = vi.fn(async (cmd, a) => {
      if (a.charId === 'c1') throw new Error('boom');
      return a.charId === 'c2' ? { charId: a.charId, status: 'not_logged_in' } : { charId: a.charId, status: 'ok', roster: { shards: [] } };
    });
    const onRow = vi.fn();
    const rows = await scanRosters({ chars: mk(3), invokeFn, limiter: createLimiter(3), sleepFn: async () => {}, random: () => 0, onRow });
    expect(invokeFn.mock.calls.every(c => c[0] === 'read_transfer_page')).toBe(true);
    expect(rows.map(r => r.status)).toEqual(['ok', 'error', 'not_logged_in']);
    expect(rows[0].roster).toEqual({ shards: [] });
    expect(rows[1].error).toBe('boom');
    expect(onRow).toHaveBeenCalledTimes(3);
  });

  it('чтение безопасно: временный сбой повторяется до лимита настроек', async () => {
    let n = 0;
    const invokeFn = vi.fn(async (_, a) => (++n < 3 ? { charId: a.charId, status: 'error', error: 'timeout' } : { charId: a.charId, status: 'ok', roster: {} }));
    const rows = await scanRosters({ chars: mk(1), invokeFn, retries: 2, retryDelayMs: 1, sleepFn: async () => {} });
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(rows[0].status).toBe('ok');
    expect(invokeFn.mock.calls.map(c => c[1].timeoutSeconds)).toEqual([25, 40, 55]);
  });

  it('стоп до старта: на сайт не ходили, все cancelled', async () => {
    const invokeFn = vi.fn();
    const rows = await scanRosters({ chars: mk(2), invokeFn, signal: { cancelled: true } });
    expect(invokeFn).not.toHaveBeenCalled();
    expect(rows.map(r => r.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('runTransferBatch', () => {
  it('каждому по плану: transfer_items с сервером, получателем и ником; успех сверяется с историей', async () => {
    const invokeFn = vi.fn(async (_, a) => sent(a));
    const rows = await runTransferBatch(base({ invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(invokeFn.mock.calls[0]).toEqual(['transfer_items', { charId: 'c0', shardId: '3', recipient: '1_3_2', charName: '#Тест', skipSources: [], dryRun: false, timeoutSeconds: 30 }]);
    expect(rows.map(r => r.status)).toEqual(['success', 'success', 'success']);
    expect(rows[0]).toMatchObject({ nick: 'N0', server: 'Фенрир', recipient: '#Тест', clicked: true });
  });

  it('строки плана без run получают свой статус и на сайт не ходят', async () => {
    const plans = plansOf(mk(3)); plans[1] = { ...plans[1], run: false, status: 'same_site', detail: 'как у «N0»' }; plans[2] = { ...plans[2], run: false, status: 'no_recipient' };
    const invokeFn = vi.fn(async (_, a) => sent(a));
    const rows = await runTransferBatch(base({ plans, invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.status)).toEqual(['success', 'same_site', 'no_recipient']);
    expect(rows[1].detail).toBe('как у «N0»');
  });

  it('пробный запуск: dryRun уходит в команду, строки dry_run', async () => {
    const invokeFn = vi.fn(async (_, a) => ({ charId: a.charId, status: 'dry_run', dryRun: true, count: 4, items: [] }));
    const rows = await runTransferBatch(base({ invokeFn, dryRun: true }));
    expect(invokeFn.mock.calls.every(c => c[1].dryRun === true)).toBe(true);
    expect(rows.every(r => r.status === 'dry_run' && !r.clicked)).toBe(true);
  });

  it('временный сбой повторяется, пока «Передать» не нажато; после нажатия — никогда', async () => {
    let n = 0;
    const flaky = vi.fn(async (_, a) => (++n < 3 ? { charId: a.charId, status: 'challenge', clicked: false } : sent(a)));
    const sleepFn = vi.fn(async () => {});
    const rows = await runTransferBatch(base({ plans: plansOf(mk(1)), invokeFn: flaky, retries: 2, retryDelayMs: 100, sleepFn }));
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(rows[0].status).toBe('success');
    expect(flaky.mock.calls.map(c => c[1].timeoutSeconds)).toEqual([30, 45, 60]);
    const clicked = vi.fn(async (_, a) => ({ charId: a.charId, status: 'error', error: 'timeout', clicked: true }));
    await runTransferBatch(base({ plans: plansOf(mk(1)), invokeFn: clicked, retries: 3 }));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('неясный ответ после нажатия → unknown и без повторов', async () => {
    const invokeFn = vi.fn(async (_, a) => ({ charId: a.charId, status: 'unknown', error: 'timeout', clicked: true, count: 2 }));
    const rows = await runTransferBatch(base({ plans: plansOf(mk(1)), invokeFn, retries: 3 }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'unknown', clicked: true });
  });

  it('ошибка вызова одного браузера не останавливает остальных', async () => {
    const invokeFn = vi.fn(async (_, a) => { if (a.charId === 'c1') throw new Error('boom'); return sent(a); });
    const rows = await runTransferBatch(base({ invokeFn }));
    expect(rows.map(r => r.status)).toEqual(['success', 'error', 'success']);
    expect(rows[1].error).toBe('boom');
  });

  it('стоп: новые передачи не начинаются, начатая заканчивается, остальные — cancelled', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async (_, a) => { signal.cancelled = true; return sent(a); });
    const rows = await runTransferBatch(base({ invokeFn, signal, limiter: createLimiter(1) }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.status)).toEqual(['success', 'cancelled', 'cancelled']);
  });

  it('стоп до старта: на сайт не ходили', async () => {
    const invokeFn = vi.fn();
    const rows = await runTransferBatch(base({ invokeFn, signal: { cancelled: true } }));
    expect(invokeFn).not.toHaveBeenCalled();
    expect(rows.every(r => r.status === 'cancelled')).toBe(true);
  });

  it('onRow получает прогресс по каждой строке', async () => {
    const onRow = vi.fn();
    await runTransferBatch(base({ invokeFn: async (_, a) => sent(a), onRow }));
    expect(onRow.mock.calls.map(c => c[1])).toEqual([1, 2, 3]);
    expect(onRow.mock.calls[0][2]).toBe(3);
  });
});

describe('readServerStatus', () => {
  const ok = () => ({ status: 'ok', servers: [{ name: 'Фенрир', online: true }], recommended: 'Фенрир' });

  it('читает командой read_server_status без персонажа и аккаунта', async () => {
    const invokeFn = vi.fn(async () => ok());
    const res = await readServerStatus({ invokeFn });
    expect(res).toEqual({ status: 'ok', servers: [{ name: 'Фенрир', online: true }], recommended: 'Фенрир' });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(invokeFn).toHaveBeenCalledWith('read_server_status', { timeoutSeconds: 20 });
  });

  it('проверка безопасности — не успех и не повторяется без лимита; ответ без списка — ошибка; исключение — ошибка; стоп — на сайт не ходим', async () => {
    expect(await readServerStatus({ invokeFn: async () => ({ status: 'challenge' }) })).toEqual({ status: 'challenge', error: null });
    expect((await readServerStatus({ invokeFn: async () => ({ status: 'ok' }) })).status).toBe('error');
    expect(await readServerStatus({ invokeFn: async () => { throw new Error('boom'); } })).toEqual({ status: 'error', error: 'boom' });
    const invokeFn = vi.fn();
    expect(await readServerStatus({ invokeFn, signal: { cancelled: true } })).toEqual({ status: 'cancelled', error: null });
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it('временный сбой повторяется до лимита настроек', async () => {
    let n = 0;
    const invokeFn = vi.fn(async () => (++n < 2 ? { status: 'error', error: 'timeout' } : ok()));
    expect((await readServerStatus({ invokeFn, retries: 2, retryDelayMs: 1, sleepFn: async () => {} })).status).toBe('ok');
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });
});
