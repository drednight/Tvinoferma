// «Сундук караванщика»: чистая логика (строки результата, статусы, тексты, сводка) и запуск пачки персонажей.
import { describe, it, expect, vi } from 'vitest';
import {
  rowFromPayload, plainRow, canAutoRetry, isRerunnable, rowLabel, rowNotes, chestLine, summarize, summaryText, taskLevel,
  caravanErrorText, isTransient, statusInfo
} from '../js/modules/automation/caravanCore.js';
import { runCaravanBatch, START_STAGGER_MS } from '../js/modules/automation/caravanRunner.js';
import { createLimiter } from '../js/modules/sync/queue.js';

const ch = { id: 'a', nick: 'Аа' };
const chest = (over = {}) => ({ cartId: '1001', until: '15:04 10.10.2026', state: 'opened', error: null, items: ['x', 'y'], ...over });
const payload = (over = {}) => ({ charId: 'a', status: 'success', error: null, dryRun: false, clicked: true, found: 2, other: 1, opened: 2, chests: [chest(), chest({ cartId: '1002' })], ...over });

describe('rowFromPayload', () => {
  it('нормализует ответ команды', () => {
    const r = rowFromPayload(ch, payload());
    expect(r).toMatchObject({ charId: 'a', nick: 'Аа', status: 'success', found: 2, opened: 2, other: 1, clicked: true, error: null });
    expect(r.chests).toHaveLength(2);
    expect(r.chests[0]).toMatchObject({ cartId: '1001', state: 'opened', items: ['x', 'y'] });
  });

  it('нет ответа, исключение или не-объект → ошибка', () => {
    expect(rowFromPayload(ch, null, null)).toMatchObject({ status: 'error', error: 'no_response' });
    expect(rowFromPayload(ch, undefined, new Error('boom'))).toMatchObject({ status: 'error', error: 'boom' });
    expect(rowFromPayload(ch, 'ok')).toMatchObject({ status: 'error' });
  });

  it('неизвестный статус не считается успехом', () => {
    expect(rowFromPayload(ch, payload({ status: 'wow' }))).toMatchObject({ status: 'error', error: 'bad_response' });
    expect(rowFromPayload(ch, payload({ status: 'cancelled' })).status).toBe('error');
  });

  it('мусор в числах и сундуках не ломает строку', () => {
    const r = rowFromPayload(ch, payload({ found: 'x', opened: -3, other: null, chests: 'нет' }));
    expect([r.found, r.opened, r.other, r.chests]).toEqual([0, 0, 0, []]);
  });
});

describe('подписи и статусы', () => {
  it('подписи по статусам', () => {
    expect(rowLabel(rowFromPayload(ch, payload()))).toBe('Открыто сундуков: 2');
    expect(rowLabel(rowFromPayload(ch, payload({ status: 'partial', opened: 1 })))).toBe('Открыто 1 из 2');
    expect(rowLabel(rowFromPayload(ch, payload({ status: 'nothing', found: 0, opened: 0, clicked: false })))).toBe('Сундуков нет');
    expect(rowLabel(rowFromPayload(ch, payload({ status: 'dry_run', dryRun: true, clicked: false })))).toBe('Сундуков караванщика: 2');
    expect(rowLabel(rowFromPayload(ch, payload({ status: 'error', error: 'timeout', clicked: false })))).toContain('сайт не ответил вовремя');
    expect(rowLabel(rowFromPayload(ch, payload({ status: 'not_logged_in' })))).toBe('Нет входа на сайт');
  });

  it('пояснения: чужие сундуки, лишние сверх лимита, неясный итог', () => {
    const notes = rowNotes(rowFromPayload(ch, { ...payload({ status: 'unknown' }), truncated: 3 }));
    expect(notes.join(' | ')).toContain('Других сундуков (не трогали): 1');
    expect(notes.join(' | ')).toContain('Сверх лимита за запуск: 3');
    expect(notes.join(' | ')).toContain('Проверьте инвентарь');
    expect(rowNotes(plainRow(ch, 'nothing'))).toEqual([]);
  });

  it('строка про сундук: состояние, номер, срок, число предметов, ошибка', () => {
    expect(chestLine(chest())).toBe('✅ открыт №1001 · до 15:04 10.10.2026 · предметов: 2');
    expect(chestLine(chest({ state: 'error', error: 'selection_changed', items: [], until: '' }))).toContain('отметки в сундуке изменились');
  });

  it('тексты ошибок сундука не говорят про «Активировать» и «передачу»', () => {
    expect(caravanErrorText('button_not_found')).not.toMatch(/Активировать/);
    expect(caravanErrorText('selection_changed')).not.toMatch(/передано/);
    expect(caravanErrorText('page_not_found')).toContain('инвентаря');
    expect(caravanErrorText('что-то новое')).toBe('что-то новое');
  });

  it('у каждого статуса есть иконка и уровень; неизвестный = ошибка', () => {
    ['success', 'partial', 'nothing', 'dry_run', 'not_logged_in', 'challenge', 'unknown', 'error', 'cancelled', 'not_run']
      .forEach(s => expect(statusInfo(s).icon).toBeTruthy());
    expect(statusInfo('zzz').level).toBe('error');
  });
});

describe('повторы', () => {
  it('сами повторяем только то, что не нажато и временное', () => {
    const base = { clicked: false, dryRun: false };
    expect(canAutoRetry({ ...base, status: 'challenge' })).toBe(true);
    expect(canAutoRetry({ ...base, status: 'error', error: 'timeout' })).toBe(true);
    expect(canAutoRetry({ ...base, status: 'error', error: 'exception_x' })).toBe(true);
    expect(canAutoRetry({ ...base, status: 'error', error: 'bad_char' })).toBe(false);
    expect(canAutoRetry({ ...base, status: 'not_logged_in' })).toBe(false);
    expect(canAutoRetry({ ...base, status: 'error', error: 'timeout', clicked: true })).toBe(false);
    expect(canAutoRetry({ ...base, status: 'success' })).toBe(false);
    expect(isTransient('pending')).toBe(true);
    expect(isTransient('no_items')).toBe(false);
  });

  it('«Повторить» предлагается для частичных, ошибочных и неясных, но не для успешных и пробных', () => {
    const r = (status, extra) => ({ ...rowFromPayload(ch, payload({ status, ...extra })) });
    ['partial', 'error', 'challenge', 'unknown'].forEach(s => expect(isRerunnable(r(s))).toBe(true));
    ['success', 'nothing', 'dry_run', 'not_logged_in'].forEach(s => expect(isRerunnable(r(s))).toBe(false));
    expect(isRerunnable(plainRow(ch, 'cancelled'))).toBe(true);
    expect(isRerunnable(r('error', { dryRun: true }))).toBe(false);
  });
});

describe('сводка', () => {
  const rows = [
    rowFromPayload(ch, payload()),
    rowFromPayload({ id: 'b', nick: 'Бб' }, payload({ status: 'nothing', found: 0, opened: 0, clicked: false })),
    rowFromPayload({ id: 'c', nick: 'Вв' }, payload({ status: 'partial', found: 3, opened: 1 })),
    rowFromPayload({ id: 'd', nick: 'Гг' }, payload({ status: 'not_logged_in', found: 0, opened: 0, clicked: false }))
  ];

  it('считает персонажей, найденные и открытые сундуки', () => {
    expect(summarize(rows)).toMatchObject({ total: 4, success: 1, nothing: 1, partial: 1, noLogin: 1, found: 5, opened: 3, rerun: 1 });
  });

  it('текст итога и уровень записи в журнале', () => {
    expect(summaryText(rows)).toBe('Открыто сундуков: 3; без сундуков: 1 перс.; открыто не всё: 1; без входа: 1');
    expect(taskLevel(rows)).toBe('warn');
    expect(taskLevel([rows[0], rows[1]])).toBe('done');
    expect(summaryText([rows[0]], { stopped: true })).toMatch(/^Остановлено\./);
  });

  it('пробный запуск: «ничего не открыто»', () => {
    const dry = [rowFromPayload(ch, payload({ status: 'dry_run', dryRun: true, clicked: false, opened: 0 }))];
    const t = summaryText(dry, { dry: true });
    expect(t).toContain('сундуков караванщика 2');
    expect(t).toContain('Ничего не открыто');
  });
});

describe('runCaravanBatch', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, nick: `Ник${i}` }));
  const noSleep = async () => {};
  const base = (over) => ({ chars: mk(3), limiter: createLimiter(3), sleepFn: noSleep, random: () => 0, ...over });
  const ok = (charId, extra = {}) => payload({ charId, ...extra });

  it('по одному вызову команды на персонажа, строки в порядке списка', async () => {
    const invokeFn = vi.fn(async (_, a) => ok(a.charId));
    const rows = await runCaravanBatch(base({ invokeFn }));
    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(invokeFn.mock.calls[0][0]).toBe('open_caravan_chests');
    expect(invokeFn.mock.calls[0][1]).toMatchObject({ charId: 'c0', dryRun: false });
    expect(rows.map(r => r.charId)).toEqual(['c0', 'c1', 'c2']);
    expect(rows.every(r => r.status === 'success')).toBe(true);
  });

  it('одновременно работает столько персонажей, сколько разрешает лимит окон', async () => {
    let active = 0, max = 0;
    const invokeFn = async (_, a) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--; return ok(a.charId); };
    await runCaravanBatch(base({ chars: mk(6), invokeFn, limiter: createLimiter(2) }));
    expect(max).toBe(2);
  });

  it('только подсчёт: dryRun уходит в команду', async () => {
    const invokeFn = vi.fn(async (_, a) => ok(a.charId, { status: 'dry_run', dryRun: true, clicked: false, opened: 0 }));
    const rows = await runCaravanBatch(base({ invokeFn, dryRun: true }));
    expect(invokeFn.mock.calls.every(c => c[1].dryRun === true)).toBe(true);
    expect(summarize(rows)).toMatchObject({ dry: 3, opened: 0, rerun: 0 });
  });

  it('сбой команды у одного персонажа не мешает остальным', async () => {
    const invokeFn = async (_, a) => { if (a.charId === 'c1') throw new Error('сломалось'); return ok(a.charId); };
    const rows = await runCaravanBatch(base({ invokeFn }));
    expect(rows.map(r => r.status)).toEqual(['success', 'error', 'success']);
    expect(rows[1].error).toBe('сломалось');
  });

  it('временный сбой повторяется, пока ничего не нажато', async () => {
    let n = 0;
    const invokeFn = vi.fn(async (_, a) => (n++ === 0 ? payload({ charId: a.charId, status: 'error', error: 'timeout', clicked: false, opened: 0, found: 0, chests: [] }) : ok(a.charId)));
    const rows = await runCaravanBatch(base({ chars: mk(1), invokeFn, retries: 2 }));
    expect(invokeFn).toHaveBeenCalledTimes(2);
    expect(rows[0].status).toBe('success');
  });

  it('после нажатия кнопки вслепую не повторяем', async () => {
    const invokeFn = vi.fn(async (_, a) => payload({ charId: a.charId, status: 'error', error: 'timeout', clicked: true }));
    const rows = await runCaravanBatch(base({ chars: mk(1), invokeFn, retries: 3 }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows[0].clicked).toBe(true);
  });

  it('«нет входа» не повторяется', async () => {
    const invokeFn = vi.fn(async (_, a) => payload({ charId: a.charId, status: 'not_logged_in', clicked: false, found: 0, opened: 0, chests: [] }));
    await runCaravanBatch(base({ chars: mk(1), invokeFn, retries: 3 }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it('«Стоп»: новые персонажи не стартуют, они помечены остановленными', async () => {
    const signal = { cancelled: false };
    const invokeFn = vi.fn(async (_, a) => { signal.cancelled = true; return ok(a.charId); });
    const rows = await runCaravanBatch(base({ chars: mk(4), invokeFn, signal, limiter: createLimiter(1) }));
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.status)).toEqual(['success', 'cancelled', 'cancelled', 'cancelled']);
  });

  it('старт персонажей разнесён паузой START_STAGGER_MS', async () => {
    const sleepFn = vi.fn(async () => {});
    await runCaravanBatch(base({ invokeFn: async (_, a) => ok(a.charId), sleepFn, random: () => 0.5 }));
    const pause = START_STAGGER_MS[0] + 0.5 * (START_STAGGER_MS[1] - START_STAGGER_MS[0]);
    expect(sleepFn.mock.calls.filter(c => c[0] === pause)).toHaveLength(2);
  });

  it('onRow и прогресс вызываются по разу на персонажа', async () => {
    const onRow = vi.fn();
    const progress = vi.fn();
    await runCaravanBatch(base({ invokeFn: async (_, a) => ok(a.charId), onRow, task: { progress } }));
    expect(onRow).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(3, 3, expect.any(String));
  });
});
