// Логика передачи предметов (Issue #26): серверы и получатели, сверка с историей, итоги, хранилище, журнал.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeRoster, serverList, resolveRecipient, planTransfer, itemTotals, totalsText, latestBatch, isFresh,
  verifyHistory, rowFromPayload, plainRow, canAutoRetry, summarize, isRerunnable, statusInfo
} from '../js/modules/automation/transferCore.js';
import { loadRosters, setRoster, clearPending, pruneRosters, loadPrefs, savePrefs, recordTransfer, loadTransferLog, clearTransferLog, LOG_MAX } from '../js/modules/automation/transferStore.js';

const K = (shard, ch) => `100_${shard}_${ch}`;
const scan = (extra = {}) => ({
  siteId: '77', accountName: 'u_77',
  shards: [
    { id: '5', name: 'Мицар', chars: [{ key: K(5, 1), name: 'Мицарный', cls: 'Бард', level: 90 }] },
    { id: '3', name: 'Фенрир', chars: [{ key: K(3, 2), name: '#Тест', cls: 'Лучник', level: 105 }, { key: K(3, 3), name: 'Второй', cls: 'Убийца', level: 101 }] }
  ],
  items: [{ id: '1', name: 'Метеорит', qty: 100, until: 'x', source: 'А' }, { id: '2', name: 'Метеорит', qty: 5 }],
  chests: 2, locked: 1, ...extra
});
const NOW = new Date('2026-10-04T00:45:00Z');           // 03:45 по Москве
const hist = (over = {}) => ({ name: 'Метеорит', qty: 100, source: 'А', account: 'u', char: '#Тест', server: 'Фенрир', status: 'В обработке', at: '2026-10-04 03:44:10', ...over });

beforeEach(() => { window.localStorage.clear(); });

describe('список серверов и получатель', () => {
  it('normalizeRoster: серверы по алфавиту, лишнее и неверные ключи отбрасываются', () => {
    const r = normalizeRoster(scan({ shards: [...scan().shards, { id: 'x', name: 'Плохой', chars: [] }, { id: '9', name: 'Девятый', chars: [{ key: 'bad', name: 'Ж' }] }] }), NOW);
    expect(r.shards.map(s => s.name)).toEqual(['Девятый', 'Мицар', 'Фенрир']);
    expect(r.shards[0].chars).toEqual([]);
    expect(r.pending).toEqual({ items: expect.any(Array), chests: 2, locked: 1 });
    expect(r.pending.items).toHaveLength(2);
    expect(r.siteId).toBe('77');
    expect(normalizeRoster(null).shards).toEqual([]);
  });

  it('serverList: объединяет браузеры; название берётся из самого свежего чтения (сервера переименовывают и сливают)', () => {
    const a = normalizeRoster(scan(), new Date('2026-10-01T00:00:00Z'));
    const b = normalizeRoster(scan({ shards: [{ id: '3', name: 'Фенрир-Мицар', chars: [{ key: K(3, 9), name: 'Z', cls: '', level: 1 }] }] }), NOW);
    const list = serverList({ a, b });
    expect(list.map(s => [s.id, s.name, s.chars, s.browsers])).toEqual([['5', 'Мицар', 1, ['a']], ['3', 'Фенрир-Мицар', 3, ['a', 'b']]]);
    expect(serverList({})).toEqual([]);
  });

  it('resolveRecipient: выбранный → ему; один персонаж → ему; несколько и не выбран → не передаём', () => {
    const r = normalizeRoster(scan(), NOW);
    expect(resolveRecipient(r, '3', K(3, 3))).toMatchObject({ ok: true, auto: false, char: { name: 'Второй' } });
    expect(resolveRecipient(r, '5', '')).toMatchObject({ ok: true, auto: true, char: { name: 'Мицарный' } });
    expect(resolveRecipient(r, '3', '')).toEqual({ ok: false, status: 'no_recipient' });
    // сохранённый выбор устарел (персонажа на сервере уже нет): как «не выбран»
    expect(resolveRecipient(r, '3', K(3, 99))).toEqual({ ok: false, status: 'no_recipient' });
    expect(resolveRecipient(r, '8', '')).toEqual({ ok: false, status: 'no_server' });
    expect(resolveRecipient(null, '3', '')).toEqual({ ok: false, status: 'no_roster' });
  });

  it('planTransfer: браузеры одного аккаунта сайта передают один раз; пропуски с причинами', () => {
    const rosters = { a: normalizeRoster(scan(), NOW), b: normalizeRoster(scan(), NOW), c: normalizeRoster(scan({ siteId: '88' }), NOW), d: null };
    const chars = ['a', 'b', 'c', 'd'].map(id => ({ id, nick: id.toUpperCase() }));
    const plans = planTransfer(chars, rosters, { shardId: '3', picks: { a: { 3: K(3, 2) }, b: { 3: K(3, 2) }, c: {} } });
    expect(plans.map(p => [p.char.id, p.run, p.status])).toEqual([['a', true, undefined], ['b', false, 'same_site'], ['c', false, 'no_recipient'], ['d', false, 'no_roster']]);
    expect(plans[1].detail).toContain('«A»');
    expect(plans[0]).toMatchObject({ shardId: '3', serverName: 'Фенрир', recipient: { name: '#Тест' }, pendingCount: 2 });
    // другой сервер: у всех по одному персонажу или ни одного
    expect(planTransfer(chars.slice(0, 1), rosters, { shardId: '5' })[0]).toMatchObject({ run: true, auto: true });
  });

  it('itemTotals / totalsText: одинаковые названия складываются', () => {
    expect(itemTotals([{ name: 'М', qty: 2 }, { name: 'М', qty: 3 }, { name: 'К' }])).toEqual([{ name: 'М', qty: 5 }, { name: 'К', qty: 1 }]);
    expect(totalsText([{ name: 'М', qty: 5 }, { name: 'К', qty: 1 }, { name: 'Л', qty: 1 }], 2)).toBe('М ×5; К; … ещё 1');
  });
});

describe('сверка с историей сайта', () => {
  it('latestBatch: строки самой новой передачи (одно время)', () => {
    const rows = [hist(), hist({ name: 'Б' }), hist({ at: '2026-09-30 21:02:53' })];
    expect(latestBatch(rows)).toHaveLength(2);
    expect(latestBatch([])).toEqual([]);
  });

  it('isFresh: время в истории московское (UTC+3), допуск ±15 минут', () => {
    expect(isFresh('2026-10-04 03:44:10', NOW)).toBe(true);
    expect(isFresh('2026-10-04 03:10:00', NOW)).toBe(false);
    expect(isFresh('2026-10-04 00:44:10', NOW)).toBe(false);     // было бы свежо, если бы время считалось UTC
    expect(isFresh('мусор', NOW)).toBe(false);
  });

  const expectation = { count: 2, char: '#Тест', server: 'Фенрир' };
  it('успех: свежая запись, тот получатель и сервер, записей не меньше предметов', () => {
    const v = verifyHistory([hist(), hist({ name: 'Б' }), hist({ at: '2026-09-30 21:02:53' })], expectation, NOW);
    expect(v.status).toBe('success');
    expect(v.detail).toContain('2 зап.');
    expect(v.rows).toHaveLength(2);
  });

  it('записей меньше, чем предметов → partial; остаток остался на сайте', () => {
    const v = verifyHistory([hist()], expectation, NOW);
    expect(v.status).toBe('partial');
    expect(v.detail).toContain('1 из 2');
  });

  it('старая запись, чужой получатель или чужой сервер, пустая история → unknown, а не успех', () => {
    expect(verifyHistory([hist({ at: '2026-09-30 21:02:53' }), hist({ at: '2026-09-30 21:02:53' })], expectation, NOW).status).toBe('unknown');
    expect(verifyHistory([hist({ char: 'Другой' }), hist()], expectation, NOW).detail).toContain('другой получатель');
    expect(verifyHistory([hist({ server: 'Мицар' }), hist({ server: 'Мицар' })], expectation, NOW).status).toBe('unknown');
    expect(verifyHistory([], expectation, NOW)).toMatchObject({ status: 'unknown' });
  });
});

describe('строки результата', () => {
  const plan = { char: { id: 'a', nick: 'А' }, shardId: '3', serverName: 'Фенрир', recipient: { key: K(3, 2), name: '#Тест' }, run: true };
  const sub = (extra = {}) => ({ charId: 'a', status: 'submitted', clicked: true, count: 2, items: [{ name: 'Метеорит', qty: 100, source: 'А' }, { name: 'К', qty: 1 }], history: [hist(), hist({ name: 'К' })], ...extra });

  it('submitted превращается в success / partial / unknown сверкой с историей', () => {
    expect(rowFromPayload(plan, sub(), null, NOW)).toMatchObject({ status: 'success', clicked: true, count: 2, recipient: '#Тест', server: 'Фенрир' });
    expect(rowFromPayload(plan, sub({ history: [hist()] }), null, NOW).status).toBe('partial');
    expect(rowFromPayload(plan, sub({ history: [] }), null, NOW).status).toBe('unknown');
  });

  it('пробный запуск, ошибки и неизвестные статусы', () => {
    expect(rowFromPayload(plan, { status: 'dry_run', dryRun: true, count: 3, items: [] }, null, NOW)).toMatchObject({ status: 'dry_run', dryRun: true, clicked: false });
    expect(rowFromPayload(plan, null, new Error('boom'), NOW)).toMatchObject({ status: 'error', error: 'boom' });
    expect(rowFromPayload(plan, { status: 'странный' }, null, NOW).status).toBe('error');
    expect(rowFromPayload(plan, { status: 'nothing' }, null, NOW).status).toBe('nothing');
  });

  it('автоповтор только пока «Передать» не нажато и причина временная', () => {
    expect(canAutoRetry({ status: 'challenge', clicked: false })).toBe(true);
    expect(canAutoRetry({ status: 'error', error: 'timeout', clicked: false })).toBe(true);
    expect(canAutoRetry({ status: 'error', error: 'timeout', clicked: true })).toBe(false);
    expect(canAutoRetry({ status: 'unknown', clicked: true })).toBe(false);
    expect(canAutoRetry({ status: 'error', error: 'char_not_found', clicked: false })).toBe(false);
    expect(canAutoRetry({ status: 'not_logged_in', clicked: false })).toBe(false);
  });

  it('summarize и «Повторить»: нажатые передачи не повторяются никогда', () => {
    const rows = [
      rowFromPayload(plan, sub(), null, NOW), rowFromPayload(plan, sub({ history: [] }), null, NOW),
      plainRow(plan, 'same_site'), plainRow(plan, 'no_recipient'), plainRow(plan, 'cancelled'),
      { ...plainRow(plan, 'error'), error: 'timeout' }, plainRow(plan, 'not_logged_in'), { ...plainRow(plan, 'dry_run'), dryRun: true }
    ];
    expect(summarize(rows)).toMatchObject({ total: 8, ok: 1, unknown: 1, skipped: 2, stopped: 1, failed: 2, dry: 1, rerun: 3, items: 2 });
    expect(isRerunnable(rows[0])).toBe(false);
    expect(isRerunnable(rows[1])).toBe(false);
    expect(isRerunnable(rows[5])).toBe(true);
    expect(statusInfo('nope').icon).toBe('❌');
  });
});

describe('хранилище', () => {
  it('списки серверов: запись, пометка «устарел» после передачи, удаление списков удалённых браузеров', () => {
    setRoster('a', scan(), NOW); setRoster('b', scan(), NOW);
    expect(Object.keys(loadRosters())).toEqual(['a', 'b']);
    clearPending('a');
    expect(loadRosters().a.pending).toMatchObject({ items: [], stale: true, chests: 2 });
    pruneRosters(['b']);
    expect(Object.keys(loadRosters())).toEqual(['b']);
  });

  it('повреждённые данные не ломают чтение', () => {
    window.localStorage.setItem('tf_transfer_roster_v1', '{не json');
    window.localStorage.setItem('tf_transfer_prefs_v1', '[1,2]');
    window.localStorage.setItem('tf_transfer_log_v1', '"x"');
    expect(loadRosters()).toEqual({});
    expect(loadPrefs()).toEqual({ server: '', picks: {} });
    expect(loadTransferLog()).toEqual([]);
  });

  it('настройки: последний сервер и получатели', () => {
    savePrefs({ server: '3', picks: { a: { 3: K(3, 2) } } });
    expect(loadPrefs()).toEqual({ server: '3', picks: { a: { 3: K(3, 2) } } });
  });

  it('журнал: только реально нажатые передачи, новые сверху, не больше LOG_MAX', () => {
    const plan = { char: { id: 'a', nick: 'А' }, shardId: '3', serverName: 'Фенрир', recipient: { name: '#Тест' } };
    const row = (at, extra = {}) => ({ ...plainRow(plan, 'success'), at, clicked: true, count: 2, items: [{ name: 'М', qty: 2 }], history: [hist()], ...extra });
    expect(recordTransfer(plainRow(plan, 'error'))).toBeNull();
    expect(recordTransfer({ ...row('2026-10-04T00:00:00Z'), dryRun: true })).toBeNull();
    recordTransfer(row('2026-10-04T00:00:00Z'));
    recordTransfer(row('2026-10-04T01:00:00Z', { status: 'unknown', detail: 'нет' }));
    const log = loadTransferLog();
    expect(log.map(e => e.status)).toEqual(['unknown', 'success']);
    expect(log[1]).toMatchObject({ nick: 'А', server: 'Фенрир', recipient: '#Тест', count: 2, siteStatus: 'В обработке', items: [{ name: 'М', qty: 2 }] });
    for (let i = 0; i < LOG_MAX + 5; i++) recordTransfer(row(new Date(2026, 9, 5, 0, i).toISOString()));
    expect(loadTransferLog()).toHaveLength(LOG_MAX);
    clearTransferLog();
    expect(loadTransferLog()).toEqual([]);
  });
});
