import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог передачи предметов и вид «Передачи» в «Настройки → Журналы» (Issue #26)
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(async () => true), toast: vi.fn(), backup: vi.fn(async () => 'b') }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}), createBackup: mocks.backup }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));   // без реальных пауз
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));

const $ = (s) => document.querySelector(s);
const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));
let state, openTransferDialog, setRoster, loadPrefs, loadTransferLog, mountLogHub;
// «Настройки → Журналы», вид «Передачи» (единый модуль логов)
const renderTransferLog = () => { $('#transfer-log-root').innerHTML = ''; mountLogHub($('#transfer-log-root'), { source: 'transfer' }); };

const chars = [{ id: 'a', nick: 'Аа' }, { id: 'b', nick: 'Бб' }, { id: 'c', nick: 'Вв', isLoggedIn: true }];
const K = (shard, ch) => `100_${shard}_${ch}`;
const rosterOf = (siteId, extra = {}) => ({
  siteId, accountName: `u_${siteId}`,
  shards: [
    { id: '3', name: 'Фенрир', chars: [{ key: K(3, 1), name: 'Первый', cls: 'Лучник', level: 105 }, { key: K(3, 2), name: 'Второй', cls: 'Жрец', level: 90 }] },
    { id: '5', name: 'Мицар', chars: [{ key: K(5, 7), name: 'Одинокий', cls: 'Бард', level: 80 }] }
  ],
  items: [{ id: '1', name: 'Метеорит', qty: 100 }], chests: 1, locked: 0, ...extra
});
const MSK = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const sent = (a, extra = {}) => ({ charId: a.charId, status: 'submitted', clicked: true, count: 1, items: [{ name: 'Метеорит', qty: 100 }], history: [{ name: 'Метеорит', qty: 100, char: 'Первый', server: 'Фенрир', status: 'В обработке', at: MSK() }], ...extra });

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  mocks.invoke.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  mocks.backup.mockClear();
  document.body.innerHTML = '<div id="modal-root"></div><p id="transfer-log-summary"></p><div id="transfer-log-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = chars.map(c => ({ ...c })); state.parties = [];
  ({ openTransferDialog } = await import('../js/modules/automation/transfer.js'));
  await import('../js/modules/automation/transferLogView.js');
  ({ mountLogHub } = await import('../js/core/logHub.js'));
  ({ setRoster, loadPrefs, loadTransferLog } = await import('../js/modules/automation/transferStore.js'));
});

const preload = () => { setRoster('a', rosterOf('77')); setRoster('b', rosterOf('88')); };
const pick = (sel, value) => { const el = $(sel); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };

const pickRow = (id, sid) => pick(`[data-srv="${id}"]`, sid);
const rowOf = (id) => document.querySelector(`.tr-row[data-row="${id}"]`);

describe('форма', () => {
  const STATUS = { status: 'ok', recommended: 'Капелла', servers: [{ name: 'Центавр', online: true }, { name: 'Фенрир', online: true }, { name: 'Мицар', online: false }, { name: 'Капелла', online: true }] };
  const answer = (cmd, a) => (cmd === 'read_server_status' ? { ...STATUS } : { charId: a.charId, status: 'ok', roster: rosterOf(a.charId === 'a' ? '77' : '88') });

  it('строка браузера: галочка · персонаж · что известно · сервер · получатель с этого сервера', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    const cells = [...rowOf('a').children].map(el => el.className.split(' ').find(c => c.startsWith('tr-')) || el.tagName);
    expect(cells).toEqual(['tr-pick', 'tr-refresh', 'tr-info', 'tr-server', 'tr-recipient']);
    expect(rowOf('a').querySelector('input[type=checkbox]').checked).toBe(true);
    expect(rowOf('a').querySelector('.tr-pick b').textContent).toBe('Аа');
    expect(rowOf('a').querySelector('.tr-info').textContent).toContain('Мицар, Фенрир');
    // сервер не выбран → получатель недоступен
    expect(rowOf('a').querySelector('.tr-recipient').disabled).toBe(true);
    pickRow('a', '3');
    expect(rowOf('a').querySelector('.tr-recipient').disabled).toBe(false);
    expect([...rowOf('a').querySelectorAll('.tr-recipient option')].map(o => o.textContent)).toEqual(['— не выбран: не передавать —', 'Первый (Лучник, ур. 105)', 'Второй (Жрец, ур. 90)']);
    // другой сервер: получатели другого сервера
    pickRow('a', '5');
    expect([...rowOf('a').querySelectorAll('.tr-recipient option')].map(o => o.textContent)).toEqual(['Авто: Одинокий (Бард, ур. 80)', 'Одинокий (Бард, ур. 80)']);
  });

  it('у каждого браузера свой сервер и свой получатель: передача идёт по выбранному серверу + персонажу в его строке', async () => {
    mocks.invoke.mockImplementation(async (_, a) => sent(a));
    preload();
    openTransferDialog({ ids: ['a', 'b'] });
    pickRow('a', '3'); pick('[data-pick="a"]', K(3, 2));
    pickRow('b', '5');
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(400);
    const calls = Object.fromEntries(mocks.invoke.mock.calls.map(c => [c[1].charId, c[1]]));
    expect(calls.a).toMatchObject({ shardId: '3', recipient: K(3, 2), charName: 'Второй' });
    expect(calls.b).toMatchObject({ shardId: '5', recipient: K(5, 7), charName: 'Одинокий' });
  });

  it('сервер не выбран в строке — браузер пропускается с понятной причиной; остальные идут', () => {
    preload();
    openTransferDialog({ ids: ['a', 'b'] });
    pickRow('b', '5');
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 1 из 2');
    $('#tr-plan-btn').click();
    expect($('#tr-plan').textContent).toContain('Сервер не выбран');
  });

  it('сервер и получатель каждой строки запоминаются между открытиями', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    pickRow('a', '3'); pick('[data-pick="a"]', K(3, 2));
    expect(loadPrefs()).toEqual({ servers: { a: '3' }, picks: { a: { 3: K(3, 2) } } });
    document.querySelector('.tf-dialog [data-act="close"]').click();
    openTransferDialog({ ids: ['a'] });
    expect(rowOf('a').querySelector('.tr-server').value).toBe('3');
    expect(rowOf('a').querySelector('.tr-recipient').value).toBe(K(3, 2));
  });

  it('сохранённый сервер, где у аккаунта больше нет персонажей, не применяется', () => {
    preload();
    window.localStorage.setItem('tf_transfer_prefs_v1', JSON.stringify({ servers: { a: '9' }, picks: {} }));
    openTransferDialog({ ids: ['a'] });
    expect(rowOf('a').querySelector('.tr-server').value).toBe('');
  });

  it('сверху нет выбора сервера «для всех»: вместо него плашка «Статус серверов» без управляющих элементов', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    expect($('#tr-server-all')).toBeNull();
    const plaque = $('.tr-top .server-status');
    expect(plaque.querySelector('b').textContent).toBe('Статус серверов');
    expect(plaque.querySelectorAll('button, select, input, a')).toHaveLength(0);
    expect(plaque.textContent).toContain('нет данных');
  });

  it('«Обновить сервера» — рядом с плашкой, галочки не нужны: читается только «Статус серверов» (без аккаунтов)', async () => {
    mocks.invoke.mockImplementation(async (cmd, a) => answer(cmd, a));
    preload();
    openTransferDialog({ ids: [] });
    expect($('.tr-top [data-act="refresh-servers"]')).not.toBeNull();
    $('[data-act="refresh-servers"]').click();
    await wait(300);
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(['read_server_status']);
    expect(mocks.invoke.mock.calls[0][1]).toEqual({ timeoutSeconds: 20 });   // без charId: страница открыта всем
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(document.querySelector('[data-task-card]')).toBeNull();            // задачи в журнале нет
    expect(JSON.parse(window.localStorage.getItem('tf_task_journal_v1') || '[]')).toEqual([]);
    const names = [...document.querySelectorAll('.tr-top .srv')].map(li => li.textContent);
    expect(names).toEqual(['Центавр', 'Фенрир', 'Мицар', 'Капелла']);        // как на странице сайта
    expect(document.querySelector('.tr-top .srv.is-off').textContent).toBe('Мицар');
    expect($('.tr-top .srv-plaque').title).toContain('Рекомендуемый сервер: Капелла');
    const opts = [...rowOf('a').querySelectorAll('.tr-server option')];
    const byName = (n) => opts.find(o => o.textContent.includes(n));
    expect(byName('Фенрир').disabled).toBe(false);
    expect(byName('Мицар').textContent).toContain('🔴');
    // серверы появились и в строках
    expect(rowOf('a').querySelector('.tr-server').textContent).toContain('Мицар');
  });

  it('«Обновить информацию по всем персонажам» — читает ВСЕХ, даже если никто не отмечен; серверы тоже', async () => {
    mocks.invoke.mockImplementation(async (cmd, a) => answer(cmd, a));
    openTransferDialog({ ids: [] });
    $('[data-act="refresh-all"]').click();
    await wait(900);
    const reads = mocks.invoke.mock.calls.filter(c => c[0] === 'read_transfer_page').map(c => c[1].charId).sort();
    expect(reads).toEqual(['a', 'b', 'c']);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_server_status')).toHaveLength(1);
    expect(rowOf('c').querySelector('.tr-info').textContent).toContain('Фенрир');
    expect($('#tr-list input[type=checkbox]:checked')).toBeNull();     // отметки не появились сами
  });

  it('блок подтверждения: «Обойти ограничения» не применяет запомненные ограничения; «Забыть» стирает их', async () => {
    const MIC = 'День рождения «Мицара»';
    const { saveLimits, loadLimits } = await import('../js/modules/automation/transferStore.js');
    const { normKey } = await import('../js/modules/automation/transferCore.js');
    saveLimits({ server: 'Мицар', sources: [MIC] });
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'dry_run', clicked: false, count: 1, items: [] }));
    preload();
    openTransferDialog({ ids: ['a'] });
    pickRow('a', '3'); pick('[data-pick="a"]', K(3, 1));
    expect($('.tr-ack-box #tr-ack')).not.toBeNull();
    expect($('#tr-forget').textContent).toContain('(1)');
    $('[data-act="dry"]').click(); await wait(300);
    expect(mocks.invoke.mock.calls[0][1].skipSources).toEqual([normKey(MIC)]);
    // обход
    mocks.invoke.mockClear();
    $('[data-act="back"]').click();
    pickRow('a', '3'); pick('[data-pick="a"]', K(3, 1));
    $('#tr-force').click();
    expect($('#tr-summary').textContent).toContain('Обход ограничений включён');
    $('[data-act="dry"]').click(); await wait(300);
    expect(mocks.invoke.mock.calls[0][1].skipSources).toEqual([]);
    expect(Object.keys(loadLimits())).toHaveLength(1);       // обход ничего не стирает
    // забыть
    $('[data-act="back"]').click();
    $('#tr-forget').click();
    // Подтверждение асинхронное (confirmModal), поэтому дожидаемся результата
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await vi.waitFor(() => expect(Object.keys(loadLimits())).toHaveLength(0));
    expect($('#tr-forget').disabled).toBe(true);
  });

  it('персонаж без ника на сайте: он в списке получателей как «без ника (Класс, ур. N)» и подставляется сам', () => {
    setRoster('a', { ...rosterOf('77'), shards: [{ id: '3', name: 'Фенрир', chars: [{ key: K(3, 9), name: '', cls: 'Призрак', level: 103 }] }] });
    openTransferDialog({ ids: ['a'] });
    pickRow('a', '3');
    expect([...rowOf('a').querySelectorAll('.tr-recipient option')].map(o => o.textContent)).toEqual(['Авто: без ника (Призрак, ур. 103)', 'без ника (Призрак, ур. 103)']);
    $('#tr-plan-btn').click();
    expect($('.tr-line').textContent).toContain('без ника (Призрак, ур. 103)');
  });

  it('🔄 в строке читает только этого персонажа (без «Статуса серверов»)', async () => {
    preload();
    mocks.invoke.mockImplementation(async (cmd, a) => answer(cmd, a));
    openTransferDialog({ ids: ['a', 'b'] });
    rowOf('b').querySelector('[data-act="refresh-one"]').click();
    await wait(500);
    expect(mocks.invoke.mock.calls.map(c => [c[0], c[1].charId])).toEqual([['read_transfer_page', 'b']]);
    expect(rowOf('b')).not.toBeNull();
  });

  it('«Проверить персонажа» слева от «Что будет передано»: читает только отмеченных; без отметок — подсказка', async () => {
    preload();
    setRoster('c', rosterOf('99'));
    mocks.invoke.mockImplementation(async (cmd, a) => answer(cmd, a));
    openTransferDialog({ ids: ['a', 'c'] });
    const btns = [...document.querySelectorAll('.promo-quick button')];
    expect(btns.indexOf($('#tr-check-btn'))).toBe(btns.indexOf($('#tr-plan-btn')) - 1);
    expect($('#tr-check-btn').textContent).toContain('Проверить персонажей (2)');
    $('#tr-check-btn').click();
    await wait(600);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_transfer_page').map(c => c[1].charId).sort()).toEqual(['a', 'c']);
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'read_server_status')).toBe(false);
    mocks.invoke.mockClear();
    $('[data-q="none"]').click();
    $('#tr-check-btn').click();
    await wait(100);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
  });

  it('без списков: выбранный браузер читается автоматически', async () => {
    mocks.invoke.mockImplementation(async (cmd, a) => answer(cmd, a));
    openTransferDialog({ ids: ['a'] });
    await wait(500);
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(['read_transfer_page', 'read_server_status']);
    expect(rowOf('a').querySelector('.tr-server').textContent).toContain('Фенрир');
    expect($('[data-act="start"]').disabled).toBe(true);
  });

  it('страница «Статус серверов» не прочиталась: ни уведомлений, ни записей в журнале; предупреждение только на плашке; серверы с персонажами всё равно есть', async () => {
    mocks.invoke.mockImplementation(async (cmd, a) => (cmd === 'read_server_status' ? { status: 'challenge' } : answer(cmd, a)));
    openTransferDialog({ ids: ['a'] });
    await wait(500);
    expect($('#tr-notes').textContent).toBe('');
    expect(mocks.toast).not.toHaveBeenCalled();
    expect($('.tr-top .srv-plaque').classList.contains('is-warn')).toBe(true);
    expect(rowOf('a').querySelector('.tr-server').textContent).toContain('Фенрир');
    expect(rowOf('a').querySelector('.tr-server').textContent).not.toContain('Капелла');
  });

  it('кнопка «Передать» неактивна без галочки; пробный запуск доступен при выбранных сервере и получателе', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    expect($('[data-act="dry"]').disabled).toBe(true);
    pickRow('a', '3');
    // на «Фенрире» два персонажа и получатель не выбран → некому передавать
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 0 из 1');
    pick('[data-pick="a"]', K(3, 2));
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 1 из 1');
    expect($('[data-act="dry"]').disabled).toBe(false);
    expect($('[data-act="start"]').disabled).toBe(true);
    $('#tr-ack').click();
    expect($('[data-act="start"]').disabled).toBe(false);
  });

  it('единственный персонаж на сервере — получатель подставляется сам', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    pickRow('a', '5');
    $('#tr-plan-btn').click();
    expect($('#tr-plan').textContent).toContain('единственный на сервере');
    expect($('[data-act="dry"]').disabled).toBe(false);
  });

  it('«Что будет передано»: после выбора персонажей, раскрывает ПОЛНЫЙ список предметов (без «ещё N»), список браузеров остаётся', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ id: String(i), name: `Награда ${i}`, qty: i === 0 ? 5 : 1 }));
    setRoster('a', rosterOf('77', { items })); setRoster('b', rosterOf('88'));
    openTransferDialog({ ids: [] });
    $('[data-q="all"]').click();
    ['a', 'b'].forEach(id => pickRow(id, '5'));
    expect($('#tr-plan').hidden).toBe(true);
    expect($('#tr-summary').textContent).not.toContain('Награда');
    expect($('#tr-plan-btn').textContent).toContain('Что будет передано');
    $('#tr-plan-btn').click();
    expect($('#tr-plan').hidden).toBe(false);
    expect($('#tr-plan').querySelectorAll('li')).toHaveLength(13 + 1);          // 13 предметов у «Аа» и 1 у «Бб»
    expect($('#tr-plan').textContent).not.toContain('ещё');
    expect($('#tr-plan').textContent).toContain('×5');
    // окно прокручивается, блоки не сжимаются: список браузеров остался на месте
    expect($('.tf-dialog-body').classList.contains('tr-body')).toBe(true);
    expect(document.querySelectorAll('#tr-list .tr-row')).toHaveLength(3);
    $('#tr-plan-btn').click();
    expect($('#tr-plan').hidden).toBe(true);
  });

  it('сохранённый получатель пропал с сайта: в плане подсказка «выберите заново»', () => {
    preload();
    window.localStorage.setItem('tf_transfer_prefs_v1', JSON.stringify({ servers: { a: '3' }, picks: { a: { 3: K(3, 99) } } }));
    openTransferDialog({ ids: ['a'] });
    $('#tr-plan-btn').click();
    expect($('#tr-plan').textContent).toContain('выберите заново');
  });

  it('два браузера одного аккаунта сайта передают один раз', () => {
    setRoster('a', rosterOf('77')); setRoster('b', rosterOf('77'));
    openTransferDialog({ ids: ['a', 'b'] });
    pickRow('a', '5'); pickRow('b', '5');
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 1 из 2');
  });
});

describe('запуск', () => {
  const open = (ids = ['a', 'b']) => {
    preload();
    openTransferDialog({ ids });
    ids.forEach(id => { pickRow(id, '3'); pick(`[data-pick="${id}"]`, K(3, 1)); });
  };

  it('пробный запуск: dryRun=true, без бэкапа и без записи в журнал', async () => {
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'dry_run', clicked: false, count: 1, items: [{ name: 'Метеорит', qty: 100 }] }));
    open();
    $('[data-act="dry"]').click(); await wait(400);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.every(c => c[0] === 'transfer_items' && c[1].dryRun === true)).toBe(true);
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ shardId: '3', recipient: K(3, 1), charName: 'Первый' });
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(loadTransferLog()).toHaveLength(0);
    expect($('.tf-dialog-sub').textContent).toContain('Пробный запуск');
  });

  it('реальная передача: бэкап один раз, вызовы transfer_items, итог и журнал; сайт, где «Передать» нажато, пишется в журнал', async () => {
    mocks.invoke.mockImplementation(async (_, a) => sent(a));
    open();
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(400);
    expect(mocks.backup).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.every(c => c[0] === 'transfer_items' && c[1].dryRun === false)).toBe(true);
    expect($('.tf-dialog-sub').textContent).toContain('Передано: 2 из 2');
    expect(loadTransferLog()).toHaveLength(2);
    renderTransferLog();
    expect(document.querySelectorAll('[data-lh-key]')).toHaveLength(2);
    // «что ждёт» после передачи считается устаревшим
    expect($('[data-act="back"]')).not.toBeNull();
  });

  it('«Стоп»: начатая передача завершается и записывается, остальные не начинаются', async () => {
    let release;
    const { browserSlots } = await import('../js/modules/sync/queue.js');
    browserSlots.max = 1;
    mocks.invoke.mockImplementation((_, a) => new Promise(res => { release = () => res(sent(a)); }));
    open();
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(100);
    const stop = $('[data-act="stop"]');
    expect(stop).not.toBeNull();
    stop.click();
    release(); await wait(300);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(loadTransferLog()).toHaveLength(1);
    expect($('.tf-dialog-sub').textContent).toContain('Остановлено');
  });

  it('«Не распознано» не повторяется автоматически; «Повторить неудачные» берёт только ошибки', async () => {
    mocks.invoke.mockImplementation(async (_, a) => (a.charId === 'a' ? { charId: 'a', status: 'challenge', clicked: false } : sent(a)));
    open();
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(400);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    mocks.invoke.mockClear();
    mocks.invoke.mockImplementation(async (_, a) => sent(a));
    $('[data-act="retry"]').click(); await wait(400);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].charId).toBe('a');
  });

  it('сайт принял не всё: «Предупреждение… только на сервер «Мицар»» — сверка по истории, итог «Не всё», акция запоминается и в следующий раз пропускается', async () => {
    const MIC = 'День рождения «Мицара»', SUB = 'Подарки за подписку';
    const items = [{ name: 'Метеорит', qty: 100, source: MIC }, { name: 'Коробочка', qty: 1, source: SUB }];
    mocks.invoke.mockImplementation(async (_, a) => ({
      charId: a.charId, status: 'submitted', clicked: true, count: 2, items,
      history: [{ name: 'Коробочка', qty: 1, char: 'Первый', server: 'Фенрир', status: 'В обработке', at: MSK() }],
      warning: { message: 'Уважаемый пользователь, данные предметы можно перевести только на сервер «Мицар»', onlyServer: 'Мицар' }
    }));
    open(['a']);
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(400);
    expect($('.tf-dialog-sub').textContent).toContain('Не всё: 1');
    expect(document.body.textContent).toContain('Мицар');
    const { loadLimits } = await import('../js/modules/automation/transferStore.js');
    const { normKey } = await import('../js/modules/automation/transferCore.js');
    expect(Object.keys(loadLimits())).toEqual([normKey(MIC)]);
    const [entry] = loadTransferLog();
    expect(entry.done).toHaveLength(1);
    expect(entry.missing).toHaveLength(1);
    // следующий запуск: акция «Мицара» на другом сервере не отмечается
    mocks.invoke.mockClear();
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'dry_run', clicked: false, count: 1, items: [] }));
    $('[data-act="back"]').click();
    $('[data-act="dry"]').click(); await wait(300);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].skipSources).toEqual([normKey(MIC)]);
  });

  it('отказ от резервной копии останавливает передачу', async () => {
    mocks.backup.mockRejectedValueOnce(new Error('disk'));
    mocks.confirm.mockReturnValue(false);
    open(['a']);
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(100);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('Журналы → Передачи', () => {
  it('пустой журнал: кнопка очистки неактивна', () => {
    renderTransferLog();
    expect($('#transfer-log-root').textContent).toContain('Ничего не найдено');
    expect($('[data-lh-clear]').disabled).toBe(true);
  });

  it('кнопка «Журнал» в диалоге открывает единый журнал на виде «Передачи»; запись открывает подробности передачи', async () => {
    mocks.invoke.mockImplementation(async (_, a) => sent(a));
    preload();
    openTransferDialog({ ids: ['a'] });
    pickRow('a', '3'); pick('[data-pick="a"]', K(3, 1));
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(400);
    $('[data-act="log"]').click();
    const dialogs = document.querySelectorAll('.tf-dialog');
    const hub = dialogs[dialogs.length - 1];
    expect(hub.querySelector('.lh-chip.active').textContent).toContain('Передачи');
    const row = hub.querySelector('[data-lh-key]');
    expect(row.textContent).toContain('Первый');
    row.click();
    const all = document.querySelectorAll('.tf-dialog');
    expect(all[all.length - 1].textContent).toContain('Метеорит');
  });
});
