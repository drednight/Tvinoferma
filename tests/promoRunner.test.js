// Запуск активации промокодов по очереди (Issue #25): параллельность, коды по очереди, повторы, пропуск, стоп.
import { describe, it, expect, vi } from 'vitest';
import { runPromoBatch, CODE_PAUSE_MS, START_STAGGER_MS, REJECT_LIMIT } from '../js/modules/automation/promoRunner.js';
import { createLimiter } from '../js/modules/sync/queue.js';

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, nick: `Ник${i}` }));
const ok = (charId, extra = {}) => ({ charId, status: 'success', clicked: true, dryRun: false, rewards: null, ...extra });
const noSleep = async () => {};
const base = (over) => ({ codes: ['AAAA1111'], chars: mk(3), limiter: createLimiter(3), sleepFn: noSleep, random: () => 0, ...over });

describe('runPromoBatch: параллельность', () => {
  it('одновременно работают столько персонажей, сколько разрешает лимит окон', async () => {
    let active = 0, maxActive = 0;
    const invokeFn = vi.fn(async (_, a) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return ok(a.charId);
    });
    const rows = await runPromoBatch(base({ chars: mk(6), invokeFn, limiter: createLimiter(3) }));
    expect(maxActive).toBe(3);
    expect(rows).toHaveLength(6);
  });

  it('лимит 1 — строго по одному', async () => {
    let active = 0, maxActive = 0;
    const invokeFn = async (_, a) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 2)); active--; return ok(a.charId); };
    await runPromoBatch(base({ invokeFn, limiter: createLimiter(1) }));
    expect(maxActive).toBe(1);
  });

  it('старты персонажей разведены паузой, у первого паузы нет', async () => {
    const sleepFn = vi.fn(async () => {});
    await runPromoBatch(base({ invokeFn: async (_, a) => ok(a.charId), sleepFn, limiter: createLimiter(1) }));
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(START_STAGGER_MS[0]);
  });
});

describe('runPromoBatch: несколько кодов', () => {
  it('у персонажа коды идут по очереди, между ними пауза; строки — по персонажам и кодам', async () => {
    const calls = [];
    const sleepFn = vi.fn(async () => {});
    const rows = await runPromoBatch(base({
      codes: ['AAAA1111', 'BBBB2222'], chars: mk(2), limiter: createLimiter(1), sleepFn,
      invokeFn: async (cmd, a) => { calls.push(`${a.charId}:${a.code}`); return ok(a.charId); }
    }));
    expect(calls).toEqual(['c0:AAAA1111', 'c0:BBBB2222', 'c1:AAAA1111', 'c1:BBBB2222']);
    expect(rows.map(r => `${r.charId}:${r.code}`)).toEqual(calls);
    expect(sleepFn).toHaveBeenCalledWith(CODE_PAUSE_MS[0]);
  });

  it('нет входа или проверка безопасности: остальные коды этого персонажа не вводятся', async () => {
    const invokeFn = vi.fn(async (_, a) => a.charId === 'c0' ? { charId: a.charId, status: 'not_logged_in', clicked: false } : ok(a.charId));
    const rows = await runPromoBatch(base({ codes: ['AAAA1111', 'BBBB2222'], chars: mk(2), invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(rows.filter(r => r.charId === 'c0').map(r => r.status)).toEqual(['not_logged_in', 'not_run']);
    expect(rows[1].detail).toBe('У персонажа нет входа — остальные коды не вводились');
    expect(rows.filter(r => r.charId === 'c1').map(r => r.status)).toEqual(['success', 'success']);
  });

  it(`код, который сайт ${REJECT_LIMIT} раза отклонил и ни разу не принял, остальным не вводится`, async () => {
    const invokeFn = vi.fn(async (_, a) => ({ charId: a.charId, status: 'invalid_code', clicked: true, detail: 'Не добавлены бонусы' }));
    const rows = await runPromoBatch(base({ chars: mk(8), invokeFn, limiter: createLimiter(1) }));
    expect(invokeFn).toHaveBeenCalledTimes(REJECT_LIMIT);
    expect(rows.filter(r => r.status === 'invalid_code')).toHaveLength(REJECT_LIMIT);
    expect(rows.filter(r => r.status === 'not_run')).toHaveLength(8 - REJECT_LIMIT);
    expect(rows.find(r => r.status === 'not_run').detail).toBe('Сайт не принял этот код у других персонажей — здесь он не вводился');
  });

  it('если код хоть раз приняли, отказы его не «убивают»', async () => {
    const invokeFn = vi.fn(async (_, a) => a.charId === 'c0' ? ok(a.charId) : { charId: a.charId, status: 'expired', clicked: true });
    const rows = await runPromoBatch(base({ chars: mk(6), invokeFn, limiter: createLimiter(1) }));
    expect(invokeFn).toHaveBeenCalledTimes(6);
    expect(rows.some(r => r.status === 'not_run')).toBe(false);
  });
});

describe('runPromoBatch: пропуск, повторы, стоп', () => {
  it('skip: окно не открывается, строка помечена skipped и считается успехом', async () => {
    const invokeFn = vi.fn(async (_, a) => ok(a.charId));
    const rows = await runPromoBatch(base({
      invokeFn, skip: (code, ch) => (ch.id === 'c1' ? { status: 'already_used', detail: 'Введён ранее' } : null)
    }));
    expect(invokeFn.mock.calls.map(c => c[1].charId)).toEqual(['c0', 'c2']);
    expect(rows[1]).toMatchObject({ charId: 'c1', status: 'already_used', skipped: true, clicked: false, detail: 'Введён ранее' });
  });

  it('временный сбой повторяется до лимита настроек и только пока кнопка не нажата', async () => {
    let n = 0;
    const invokeFn = vi.fn(async (_, a) => (++n < 3 ? { charId: a.charId, status: 'challenge', clicked: false } : ok(a.charId)));
    const sleepFn = vi.fn(async () => {});
    const rows = await runPromoBatch(base({ chars: mk(1), invokeFn, retries: 2, retryDelayMs: 100, sleepFn }));
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(rows[0].status).toBe('success');
    expect(sleepFn.mock.calls.map(c => c[0])).toEqual([100, 200]);
    expect(invokeFn.mock.calls.map(c => c[1].timeoutSeconds)).toEqual([25, 40, 55]);
  });

  it('retries=0 — без повторов; после нажатия кнопки повторов нет никогда', async () => {
    const challenge = vi.fn(async (_, a) => ({ charId: a.charId, status: 'challenge', clicked: false }));
    await runPromoBatch(base({ chars: mk(1), invokeFn: challenge, retries: 0 }));
    expect(challenge).toHaveBeenCalledTimes(1);
    const clicked = vi.fn(async (_, a) => ({ charId: a.charId, status: 'error', error: 'timeout', clicked: true }));
    await runPromoBatch(base({ chars: mk(1), invokeFn: clicked, retries: 3 }));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('ошибка вызова одного персонажа не останавливает остальных', async () => {
    const invokeFn = vi.fn(async (_, a) => { if (a.charId === 'c1') throw new Error('boom'); return ok(a.charId); });
    const rows = await runPromoBatch(base({ invokeFn, retries: 0 }));
    expect(rows.map(r => r.status)).toEqual(['success', 'error', 'success']);
    expect(rows[1].error).toBe('boom');
  });

  it('стоп: новые вводы не начинаются, начатый заканчивается, остальные — cancelled', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async (_, a) => { signal.cancelled = true; return ok(a.charId); });
    const rows = await runPromoBatch(base({ codes: ['AAAA1111', 'BBBB2222'], chars: mk(3), invokeFn, signal, limiter: createLimiter(1) }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.status)).toEqual(['success', 'cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
  });

  it('стоп до старта: все строки cancelled, на сайт не ходили', async () => {
    const invokeFn = vi.fn();
    const rows = await runPromoBatch(base({ invokeFn, signal: { cancelled: true } }));
    expect(invokeFn).not.toHaveBeenCalled();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.status === 'cancelled')).toBe(true);
  });

  it('onRow получает прогресс по каждой строке', async () => {
    const onRow = vi.fn();
    await runPromoBatch(base({ codes: ['AAAA1111', 'BBBB2222'], chars: mk(2), invokeFn: async (_, a) => ok(a.charId), onRow }));
    expect(onRow).toHaveBeenCalledTimes(4);
    expect(onRow.mock.calls.map(c => c[1])).toEqual([1, 2, 3, 4]);
    expect(onRow.mock.calls[0][2]).toBe(4);
  });
});
