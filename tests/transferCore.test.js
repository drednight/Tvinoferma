// Логика передачи предметов (Issue #26): серверы и получатели, сверка с историей, итоги, хранилище, журнал.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeRoster, normalizeStatus, serverList, resolveRecipient, planTransfer, itemTotals, totalsText, latestBatch, isFresh,
  verifyHistory, rowFromPayload, plainRow, canAutoRetry, summarize, isRerunnable, statusInfo, compareItems, splitByLimits, normKey, charTitle
} from '../js/modules/automation/transferCore.js';
import { loadStatus, saveStatus, loadRosters, setRoster, clearPending, pruneRosters, loadPrefs, savePrefs, recordTransfer, loadTransferLog, clearTransferLog, LOG_MAX, loadLimits, limitsMap, saveLimits, clearLimits } from '../js/modules/automation/transferStore.js';

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

  it('serverList + «Статус серверов»: видны ВСЕ серверы сайта; без номера — id пустой; онлайн подтягивается; ё и регистр не важны', () => {
    const r = normalizeRoster(scan(), NOW);
    const status = normalizeStatus({ recommended: ' Капелла ', servers: [
      { name: 'ФЕНРИР', online: true }, { name: 'Мицар', online: false }, { name: 'Центавр', online: true }, { name: 'Капелла', online: true },
      { name: 'Капелла', online: false }, { name: '', online: true }
    ] }, NOW);
    expect(status.recommended).toBe('Капелла');
    expect(status.servers.map(s => s.name)).toEqual(['ФЕНРИР', 'Мицар', 'Центавр', 'Капелла']);   // дубль и пустое имя отброшены
    const list = serverList({ a: r }, status);
    expect(list.map(s => [s.id, s.name, s.online, s.chars])).toEqual([
      ['', 'Капелла', true, 0], ['5', 'Мицар', false, 1], ['3', 'Фенрир', true, 2], ['', 'Центавр', true, 0]
    ]);
    // страницы статуса нет — прежнее поведение
    expect(serverList({ a: r }).map(s => s.id)).toEqual(['5', '3']);
    expect(serverList({}, status).map(s => s.id)).toEqual(['', '', '', '']);
  });

  it('planTransfer: у каждого браузера свой сервер и свой получатель; без сервера — пропуск', () => {
    const rosters = { a: normalizeRoster(scan({ siteId: '1' }), NOW), b: normalizeRoster(scan({ siteId: '2' }), NOW), c: normalizeRoster(scan({ siteId: '3' }), NOW), d: null };
    const chars = ['a', 'b', 'c', 'd'].map(id => ({ id, nick: id.toUpperCase() }));
    const plans = planTransfer(chars, rosters, { shards: { a: '3', b: '5', c: '', d: '3' }, picks: { a: { 3: K(3, 3) } } });
    expect(plans.map(p => [p.char.id, p.run, p.status, p.shardId, p.serverName])).toEqual([
      ['a', true, undefined, '3', 'Фенрир'], ['b', true, undefined, '5', 'Мицар'], ['c', false, 'no_server_chosen', '', ''], ['d', false, 'no_roster', '3', '']
    ]);
    expect(plans[0].recipient.name).toBe('Второй');          // выбранный на «Фенрире»
    expect(plans[1].recipient.name).toBe('Мицарный');        // единственный на «Мицаре»
    // выбор сервера у браузера без общего shardId: не выбран нигде — никто не передаёт
    expect(planTransfer(chars.slice(0, 2), rosters, { picks: {} }).map(p => p.status)).toEqual(['no_server_chosen', 'no_server_chosen']);
  });

  it('planTransfer: сохранённый получатель пропал с сайта — подсказка «выберите заново»', () => {
    const rosters = { a: normalizeRoster(scan(), NOW) };
    const [p] = planTransfer([{ id: 'a', nick: 'A' }], rosters, { shardId: '3', picks: { a: { 3: K(3, 99) } } });
    expect(p).toMatchObject({ run: false, status: 'no_recipient' });
    expect(p.detail).toContain('выберите заново');
  });

  it('totalsText по умолчанию показывает всё, без «ещё N»', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ name: `Предмет ${i}`, qty: 1 }));
    expect(totalsText(items).split('; ')).toHaveLength(13);
    expect(totalsText(items)).not.toContain('ещё');
    expect(totalsText(items, 2)).toContain('ещё 11');
  });

  it('resolveRecipient: выбранный → ему; один персонаж → ему; несколько и не выбран → не передаём', () => {
    const r = normalizeRoster(scan(), NOW);
    expect(resolveRecipient(r, '3', K(3, 3))).toMatchObject({ ok: true, auto: false, char: { name: 'Второй' } });
    expect(resolveRecipient(r, '5', '')).toMatchObject({ ok: true, auto: true, char: { name: 'Мицарный' } });
    expect(resolveRecipient(r, '3', '')).toEqual({ ok: false, status: 'no_recipient' });
    // сохранённый выбор устарел (персонажа на сервере уже нет): как «не выбран»
    expect(resolveRecipient(r, '3', K(3, 99))).toEqual({ ok: false, status: 'no_recipient', stale: true });
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

describe('персонаж без ника (на сайте: «(Призрак, уровень:103)»)', () => {
  const NONICK = { key: K(3, 9), name: '', cls: 'Призрак', level: 103 };
  const roster = () => normalizeRoster(scan({ shards: [{ id: '3', name: 'Фенрир', chars: [NONICK] }] }), NOW);

  it('normalizeRoster не выбрасывает персонажа без ника; resolveRecipient подставляет его сам', () => {
    const r = roster();
    expect(r.shards[0].chars).toEqual([{ key: K(3, 9), name: '', cls: 'Призрак', level: 103 }]);
    expect(resolveRecipient(r, '3', '')).toMatchObject({ ok: true, auto: true });
    expect(charTitle(r.shards[0].chars[0])).toBe('без ника');
    expect(charTitle({ name: ' Ник ' })).toBe('Ник');
  });

  it('planTransfer: передача идёт, в строках — «без ника»; история без имени получателя проверяется по серверу', () => {
    const chars = [{ id: 'a', nick: 'Аа' }];
    const [p] = planTransfer(chars, { a: roster() }, { shards: { a: '3' } });
    expect(p.run).toBe(true);
    expect(plainRow(p, 'success').recipient).toBe('без ника');
    const v = verifyHistory([hist({ char: '' }), hist({ char: '', name: 'Б' })], { count: 2, char: '', server: 'Фенрир' }, NOW);
    expect(v.status).toBe('success');
    expect(verifyHistory([hist({ char: '', server: 'Мицар' }), hist({ char: '', server: 'Мицар' })], { count: 2, char: '', server: 'Фенрир' }, NOW).status).toBe('unknown');
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
    expect(loadPrefs()).toEqual({ servers: {}, picks: {} });
    expect(loadTransferLog()).toEqual([]);
  });

  it('настройки: сервер и получатели каждого браузера', () => {
    savePrefs({ servers: { a: '3' }, picks: { a: { 3: K(3, 2) } } });
    expect(loadPrefs()).toEqual({ servers: { a: '3' }, picks: { a: { 3: K(3, 2) } } });
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

describe('хранилище: список серверов сайта', () => {
  it('saveStatus сохраняет прочитанное; пустой ответ старый список не затирает', () => {
    expect(loadStatus()).toBeNull();
    saveStatus({ recommended: 'Капелла', servers: [{ name: 'Фенрир', online: true }, { name: 'Капелла', online: null }] }, NOW);
    expect(loadStatus()).toEqual({ at: NOW.toISOString(), recommended: 'Капелла', servers: [{ name: 'Фенрир', online: true }, { name: 'Капелла', online: null }] });
    saveStatus({ servers: [] });
    expect(loadStatus().servers).toHaveLength(2);
    window.localStorage.setItem('tf_transfer_servers_v1', '{"servers":"плохо"}');
    expect(loadStatus()).toBeNull();
  });
});


/* ---- Живой случай: 21 предмет отправлен на «Фенрир», сайт принял 8, на остальные показал «только на сервер «Мицар»» ---- */
describe('предупреждение сайта: предметы акции только для другого сервера', () => {
  const SUB = 'Подарки за подписку';
  const MIC = 'День рождения «Мицара»';
  const subItems = [['Солдатское жалование', 100], ['Волшебная кукла', 5], ['Набор «Самоцветы грез»', 5], ['Талон на платиновый амулет', 1], ['Талон на платиновый идол', 1], ['Дар из прошлого', 10], ['Королевское особое печенье', 300], ['Королевские особые пирожки', 300]];
  const micItems = [['Коробочка с картой S', 60], ['Метеорит', 100], ['Самоцвет грез (оружие)', 50], ['Самоцвет грез (реликвия)', 50], ['Шкатулка с платиновым амулетом', 5], ['Шкатулка с платиновым идолом', 5], ['Порошок духов', 300], ['Экстракт жидкого золота', 50], ['Карта божества', 60], ['Самоцвет грез (доспех)', 50], ['Набор рун (8-го ур.)', 1], ['Запечатанная грамота Лиги', 25], ['Приказ Феникса', 50]];
  const mk = (list, source) => list.map(([name, qty]) => ({ name, qty, source }));
  const sent = [...mk(micItems, MIC), ...mk(subItems, SUB)];
  const row = (name, qty, over = {}) => ({ name, qty, source: SUB, account: 'u', char: 'LastEnd', server: 'Фенрир', status: 'В обработке', at: '2026-10-04 03:44:10', ...over });
  const plan = { char: { id: 'a', nick: 'Ластэнд' }, shardId: '3', serverName: 'Фенрир', recipient: { key: K(3, 9), name: 'LastEnd' } };
  const warning = { message: 'Уважаемый пользователь, данные предметы можно перевести только на сервер «Мицар»', onlyServer: 'Мицар' };
  const payload = (over = {}) => ({ status: 'submitted', clicked: true, count: 21, items: sent, history: subItems.map(([n, q]) => row(n, q)), warning, ...over });

  it('compareItems: сравнение по названию и количеству, каждая запись истории — один раз', () => {
    const r = compareItems(sent, subItems.map(([n, q]) => row(n, q)));
    expect(r.done.map(i => i.name)).toEqual(subItems.map(([n]) => n));
    expect(r.missing).toHaveLength(13);
    const dup = compareItems([{ name: 'Камень', qty: 1 }, { name: 'камень', qty: 1 }], [row('Камень', 1)]);
    expect([dup.done.length, dup.missing.length]).toEqual([1, 1]);
    expect(compareItems([{ name: 'Метеорит', qty: 100 }], [row('Метеорит', 5)]).missing).toHaveLength(1);   // количество другое — не то же самое
    expect(compareItems([{ name: 'Ёж', qty: 1 }], [row('еж', 1)]).done).toHaveLength(1);
  });

  it('8 из 21 приняты, на остальные — предупреждение: «передано не всё», видно какие именно и почему', () => {
    const r = rowFromPayload(plan, payload(), null, NOW);
    expect(r.status).toBe('partial');
    expect(r.clicked).toBe(true);
    expect(r.done.map(i => i.name)).toEqual(subItems.map(([n]) => n));
    expect(r.missing.map(i => i.name)).toEqual(micItems.map(([n]) => n));
    expect(r.detail).toContain('передано 8 из 21');
    expect(r.detail).toContain('только на сервер «Мицар»');
    expect(r.detail).toContain('Приказ Феникса ×50');
    expect(r.warning).toEqual(warning);
    // акция запоминается: в следующий раз её не отмечаем на других серверах
    expect(r.limit).toEqual({ server: 'Мицар', sources: [MIC] });
  });

  it('сайт не принял ничего (в истории нет новой записи) → «не тот сервер», ограничение запоминается', () => {
    const r = rowFromPayload(plan, payload({ history: [row('Старый', 1, { at: '2026-09-15 20:15:56' })], items: mk(micItems, MIC), count: 13 }), null, NOW);
    expect(r.status).toBe('wrong_server');
    expect(r.detail).toContain('только на сервер «Мицар»');
    expect(r.limit).toEqual({ server: 'Мицар', sources: [MIC] });
    expect(statusInfo(r.status).icon).toBe('🚫');
    expect(summarize([r])).toMatchObject({ wrong: 1, ok: 0, rerun: 0 });
    expect(isRerunnable(r)).toBe(false);
  });

  it('предупреждение, а все предметы в истории → «передано»; предупреждение без сервера и без записей → не распознано с его текстом', () => {
    expect(rowFromPayload(plan, payload({ history: sent.map(i => row(i.name, i.qty)) }), null, NOW).status).toBe('success');
    const other = rowFromPayload(plan, payload({ history: [], warning: { message: 'Передача недоступна', onlyServer: '' } }), null, NOW);
    expect(other.status).toBe('unknown');
    expect(other.detail).toBe('Передача недоступна');
    expect(other.limit).toBeNull();
  });

  it('история после предупреждения не прочиталась (unknown от Rust): остаётся «не распознано», предупреждение сохранено', () => {
    const r = rowFromPayload(plan, { status: 'unknown', clicked: true, count: 21, items: sent, history: null, detail: warning.message, warning }, null, NOW);
    expect(r.status).toBe('unknown');
    expect(r.detail).toBe(warning.message);
    expect(r.warning.onlyServer).toBe('Мицар');
    expect(r.clicked).toBe(true);
  });

  it('если часть предметов акции принята, ограничение для неё не запоминается', () => {
    const mixed = [...mk(micItems, MIC), ...mk(subItems, SUB)];
    const hist2 = [...subItems.map(([n, q]) => row(n, q)), row('Метеорит', 100, { source: MIC })];
    const r = rowFromPayload(plan, payload({ items: mixed, history: hist2 }), null, NOW);
    expect(r.status).toBe('partial');
    expect(r.limit).toBeNull();
  });

  it('без предупреждения: нехватка записей в истории — «не всё», в тексте названия ненайденного', () => {
    const r = rowFromPayload(plan, payload({ warning: null, items: sent.slice(0, 3), count: 3, history: [row(sent[0].name, sent[0].qty, { source: MIC })] }), null, NOW);
    expect(r.status).toBe('partial');
    expect(r.detail).toContain('не найдено в истории');
    expect(r.limit).toBeNull();
  });
});

describe('акции, привязанные к серверу', () => {
  const MIC = 'День рождения «Мицара»';
  const roster = (items) => ({ ...scan({ items }), at: NOW.toISOString() });
  const norm = (items) => normalizeRoster(roster(items), NOW);
  const items = [{ id: '1', name: 'Метеорит', qty: 100, source: MIC }, { id: '2', name: 'Печенье', qty: 300, source: 'Подарки за подписку' }];

  it('splitByLimits: на другом сервере акция пропускается, на своём — нет; регистр и «ё» не важны', () => {
    const limits = { [normKey(MIC)]: 'Мицар' };
    const other = splitByLimits(items, limits, 'Фенрир');
    expect(other.skipped.map(i => i.name)).toEqual(['Метеорит']);
    expect(other.skipped[0].server).toBe('Мицар');
    expect(other.keep.map(i => i.name)).toEqual(['Печенье']);
    expect(splitByLimits(items, limits, 'мицар').skipped).toHaveLength(0);
    expect(splitByLimits(items, {}, 'Фенрир').skipped).toHaveLength(0);
  });

  it('planTransfer: передаётся то, что можно; пропущенное видно; если можно только на другой сервер — строка не запускается', () => {
    const chars = [{ id: 'a', nick: 'А' }];
    const limits = { [normKey(MIC)]: 'Мицар' };
    const rosters = { a: norm(items) };
    const p = planTransfer(chars, rosters, { shards: { a: '3' }, picks: { a: { 3: K(3, 2) } }, limits })[0];
    expect(p).toMatchObject({ run: true, skipSources: [normKey(MIC)], pendingCount: 1 });
    expect(p.skipped.map(i => i.name)).toEqual(['Метеорит']);
    // на Мицаре (единственный персонаж) всё отмечается
    const m = planTransfer(chars, rosters, { shards: { a: '5' }, limits })[0];
    expect(m).toMatchObject({ run: true, skipSources: [], pendingCount: 2 });
    // на аккаунте только предметы этой акции
    const only = planTransfer(chars, { a: norm([items[0]]) }, { shards: { a: '3' }, picks: { a: { 3: K(3, 2) } }, limits })[0];
    expect(only).toMatchObject({ run: false, status: 'only_other_server', detail: 'только на «Мицар»' });
    expect(only.skipped).toHaveLength(1);
    expect(plainRow(only, only.status, only.detail).limited).toHaveLength(1);
    expect(summarize([plainRow(only, only.status, only.detail)]).skipped).toBe(1);
    // что ждёт передачи неизвестно (после передачи список устарел) — акции всё равно не отмечаются
    const stale = { a: { ...norm(items), pending: { ...norm(items).pending, stale: true } } };
    expect(planTransfer(chars, stale, { shards: { a: '3' }, picks: { a: { 3: K(3, 2) } }, limits })[0]).toMatchObject({ run: true, skipSources: [normKey(MIC)], skipped: [], pendingCount: null });
    // без ограничений ничего не меняется
    expect(planTransfer(chars, rosters, { shards: { a: '3' }, picks: { a: { 3: K(3, 2) } } })[0]).toMatchObject({ run: true, skipSources: [] });
  });

  describe('хранилище', () => {
    beforeEach(() => window.localStorage.clear());

    it('запоминает акцию и сервер, ключ — без учёта регистра; старше 60 дней забывается', () => {
      saveLimits({ server: 'Мицар', sources: [MIC, '  '] }, NOW);
      expect(limitsMap(NOW)).toEqual({ [normKey(MIC)]: 'Мицар' });
      expect(loadLimits(NOW)[normKey(MIC)]).toMatchObject({ source: MIC, server: 'Мицар' });
      expect(limitsMap(new Date(NOW.getTime() + 59 * 86400000))).toHaveProperty(normKey(MIC));
      expect(limitsMap(new Date(NOW.getTime() + 61 * 86400000))).toEqual({});
      clearLimits();
      expect(limitsMap(NOW)).toEqual({});
    });

    it('мусор в хранилище не ломает загрузку', () => {
      window.localStorage.setItem('tf_transfer_limits_v1', '[1,2]');
      expect(limitsMap(NOW)).toEqual({});
      window.localStorage.setItem('tf_transfer_limits_v1', JSON.stringify({ a: { source: 'x' }, b: 5 }));
      expect(limitsMap(NOW)).toEqual({});
    });

    it('журнал хранит что передано, что нет и текст предупреждения', () => {
      const row = { ...plainRow({ char: { id: 'a', nick: 'А' }, shardId: '3', serverName: 'Фенрир', recipient: { name: 'LastEnd' } }, 'partial', 'x'), clicked: true, items: [{ name: 'А', qty: 1 }, { name: 'Б', qty: 2 }], done: [{ name: 'А', qty: 1 }], missing: [{ name: 'Б', qty: 2, source: MIC }], warning: { message: 'только на сервер «Мицар»' } };
      const e = recordTransfer(row);
      expect(e).toMatchObject({ done: [{ name: 'А', qty: 1 }], missing: [{ name: 'Б', qty: 2, source: MIC }], warning: 'только на сервер «Мицар»' });
    });
  });
});
