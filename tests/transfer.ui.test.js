import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог передачи предметов и блок «Логи переводов» в Настройках (Issue #26)
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(() => true), toast: vi.fn(), backup: vi.fn(async () => 'b') }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}), createBackup: mocks.backup }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));   // без реальных пауз
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmDialog: mocks.confirm }));

const $ = (s) => document.querySelector(s);
const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));
let state, openTransferDialog, renderTransferLog, setRoster, loadPrefs, loadTransferLog;

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
  mocks.confirm.mockReset().mockReturnValue(true);
  mocks.toast.mockReset();
  mocks.backup.mockClear();
  document.body.innerHTML = '<div id="modal-root"></div><p id="transfer-log-summary"></p><div id="transfer-log-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = chars.map(c => ({ ...c })); state.parties = [];
  ({ openTransferDialog } = await import('../js/modules/automation/transfer.js'));
  ({ renderTransferLog } = await import('../js/modules/automation/transferLogView.js'));
  ({ setRoster, loadPrefs, loadTransferLog } = await import('../js/modules/automation/transferStore.js'));
});

const preload = () => { setRoster('a', rosterOf('77')); setRoster('b', rosterOf('88')); };
const pick = (sel, value) => { const el = $(sel); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };

describe('форма', () => {
  it('без списков: сервер недоступен, передать нельзя; выбранный браузер без списка читается автоматически', async () => {
    mocks.invoke.mockImplementation(async (cmd, a) => ({ charId: a.charId, status: 'ok', roster: rosterOf('77') }));
    openTransferDialog({ ids: ['a'] });
    await wait(400);
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(['read_transfer_page']);
    expect($('#tr-server').textContent).toContain('Фенрир');
    expect($('[data-act="start"]').disabled).toBe(true);
  });

  it('нет сервера → предупреждение; кнопка «Передать» неактивна без галочки; пробный запуск доступен при выбранном получателе', async () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    expect($('#tr-summary').textContent).toContain('Выберите сервер назначения');
    expect($('[data-act="dry"]').disabled).toBe(true);
    pick('#tr-server', '3');
    // на «Фенрире» два персонажа и получатель не выбран → некому передавать
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 0 из 1');
    pick('[data-pick="a"]', K(3, 2));
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 1 из 1');
    expect($('[data-act="dry"]').disabled).toBe(false);
    expect($('[data-act="start"]').disabled).toBe(true);
    $('#tr-ack').click();
    expect($('[data-act="start"]').disabled).toBe(false);
    expect(loadPrefs().picks).toEqual({ a: { 3: K(3, 2) } });
    expect(loadPrefs().server).toBe('3');
  });

  it('единственный персонаж на сервере — получатель подставляется сам', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    pick('#tr-server', '5');
    expect($('#tr-summary').textContent).toContain('единственный на сервере');
    expect($('[data-act="dry"]').disabled).toBe(false);
  });

  it('последний сервер запоминается между открытиями', () => {
    preload();
    openTransferDialog({ ids: ['a'] });
    pick('#tr-server', '5');
    document.querySelector('.tf-dialog [data-act="close"]').click();
    openTransferDialog({ ids: ['a'] });
    expect($('#tr-server').value).toBe('5');
  });

  it('два браузера одного аккаунта сайта передают один раз', () => {
    setRoster('a', rosterOf('77')); setRoster('b', rosterOf('77'));
    openTransferDialog({ ids: ['a', 'b'] });
    pick('#tr-server', '5');
    expect($('#tr-summary').textContent).toContain('Будет передано с аккаунтов: 1 из 2');
  });
});

describe('запуск', () => {
  const open = (ids = ['a', 'b']) => {
    preload();
    openTransferDialog({ ids });
    pick('#tr-server', '3');
    ids.forEach(id => pick(`[data-pick="${id}"]`, K(3, 1)));
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
    expect(document.querySelectorAll('[data-transfer-entry]')).toHaveLength(2);
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

  it('отказ от резервной копии останавливает передачу', async () => {
    mocks.backup.mockRejectedValueOnce(new Error('disk'));
    mocks.confirm.mockReturnValue(false);
    open(['a']);
    $('#tr-ack').click();
    $('[data-act="start"]').click(); await wait(100);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('Настройки → Логи переводов', () => {
  it('пустой журнал: кнопка очистки неактивна', () => {
    renderTransferLog();
    expect($('#transfer-log-summary').textContent).toBeTruthy();
    expect($('[data-transfer-log="clear"]').disabled).toBe(true);
  });
});
