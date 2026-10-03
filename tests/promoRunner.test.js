// Запуск активации промокода по очереди (Issue #25): порядок, паузы, отмена, отсутствие повторов.
import { describe, it, expect, vi } from 'vitest';
import { runPromoBatch, PAUSE_MS } from '../js/modules/automation/promoRunner.js';

const chars = [{ id: 'a', nick: 'А' }, { id: 'b', nick: 'Б' }, { id: 'c', nick: 'В' }];
const ok = (charId, extra = {}) => ({ charId, status: 'success', clicked: true, dryRun: false, ...extra });

describe('runPromoBatch', () => {
  it('идёт по одному, по порядку, с паузой между персонажами, но не перед первым', async () => {
    let active = 0, maxActive = 0;
    const order = [];
    const invokeFn = vi.fn(async (cmd, args) => {
      active++; maxActive = Math.max(maxActive, active);
      order.push(args.charId);
      await Promise.resolve();
      active--;
      return ok(args.charId);
    });
    const sleepFn = vi.fn(async () => {});
    const rows = await runPromoBatch({ code: 'ABCD1234', chars, invokeFn, sleepFn, random: () => 0 });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(PAUSE_MS[0]);
    expect(invokeFn).toHaveBeenCalledWith('activate_promo', { charId: 'a', code: 'ABCD1234', dryRun: false });
    expect(rows.map(r => r.status)).toEqual(['success', 'success', 'success']);
    expect(rows.map(r => r.nick)).toEqual(['А', 'Б', 'В']);
  });

  it('случайная пауза укладывается в диапазон', async () => {
    const sleepFn = vi.fn(async () => {});
    await runPromoBatch({ code: 'ABCD1234', chars: chars.slice(0, 2), invokeFn: async (_, a) => ok(a.charId), sleepFn, random: () => 1 });
    expect(sleepFn).toHaveBeenCalledWith(PAUSE_MS[1]);
  });

  it('ошибка одного персонажа не останавливает остальных и не повторяется', async () => {
    const invokeFn = vi.fn(async (_, a) => { if (a.charId === 'b') throw new Error('boom'); return ok(a.charId); });
    const rows = await runPromoBatch({ code: 'ABCD1234', chars, invokeFn, sleepFn: async () => {} });
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(rows.map(r => r.status)).toEqual(['success', 'error', 'success']);
    expect(rows[1].error).toBe('boom');
  });

  it('отмена: оставшиеся помечаются cancelled и на сайт не ходят', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async (_, a) => { signal.cancelled = true; return ok(a.charId); });
    const rows = await runPromoBatch({ code: 'ABCD1234', chars, invokeFn, signal, sleepFn: async () => {} });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.status)).toEqual(['success', 'cancelled', 'cancelled']);
    expect(rows[1].clicked).toBe(false);
  });

  it('отмена во время паузы не запускает следующего', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async (_, a) => ok(a.charId));
    const sleepFn = vi.fn(async () => { signal.cancelled = true; });
    const rows = await runPromoBatch({ code: 'ABCD1234', chars: chars.slice(0, 2), invokeFn, signal, sleepFn });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows[1].status).toBe('cancelled');
  });

  it('пробный запуск передаёт dryRun и сообщает о прогрессе', async () => {
    const invokeFn = vi.fn(async (_, a) => ({ charId: a.charId, status: 'dry_run', clicked: false, dryRun: true }));
    const onRow = vi.fn();
    const rows = await runPromoBatch({ code: 'ABCD1234', chars: chars.slice(0, 2), dryRun: true, invokeFn, onRow, sleepFn: async () => {} });
    expect(invokeFn.mock.calls.every(c => c[1].dryRun === true)).toBe(true);
    expect(onRow).toHaveBeenCalledTimes(2);
    expect(onRow.mock.calls[1].slice(1)).toEqual([2, 2]);
    expect(rows.every(r => r.dryRun)).toBe(true);
  });
});
