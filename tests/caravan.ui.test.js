import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог «Сундук караванщика»: выбор персонажей → проверка инвентарей → итоги
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(async () => true), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd, args) =>
    ['resume_scope_command', 'cancel_scope_command'].includes(cmd) ? Promise.resolve() : mocks.invoke(cmd, args)
}));
vi.mock('../js/modules/sync/syncManager.js', () => ({ scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }) }));
vi.mock('../js/modules/sync/queue.js', async orig => ({ ...(await orig()), sleep: async () => {} }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));

const $ = s => document.querySelector(s);
const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));
let state, openCaravanDialog;

const chars = [
  { id: 'a', nick: 'Аа' },
  { id: 'b', nick: 'Бб' },
  { id: 'c', nick: 'Вв', isLoggedIn: true }
];
const reply = (charId, over = {}) => ({
  charId,
  accountKey: String(charId).repeat(64),
  status: 'success',
  error: null,
  dryRun: false,
  clicked: true,
  found: 2,
  other: 0,
  opened: 2,
  chests: [
    { cartId: '1', until: '15:04 10.10.2026', state: 'opened', error: null, items: ['x'] },
    { cartId: '2', until: '', state: 'opened', error: null, items: ['y'] }
  ],
  ...over
});

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  mocks.invoke.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = chars.map(c => ({ ...c }));
  state.parties = [];
  ({ openCaravanDialog } = await import('../js/modules/automation/caravan.js'));
});

describe('форма «Сундук караванщика»', () => {
  it('заголовок, объяснение, онлайн выбраны; без выбора кнопки заблокированы', () => {
    openCaravanDialog();
    expect($('.tf-dialog-title').textContent).toContain('Сундук караванщика');
    expect($('.tf-dialog').textContent).toContain('«Сундуки караванщика»');
    expect($('[data-act="start"]').textContent).toContain('Открыть сундуки');
    expect($('[data-act="dry"]').textContent).toContain('Проверить сайт');
    expect($('[data-act="start"]').disabled).toBe(true);
    expect($('.script-target input[value="logged"]').checked).toBe(true);
    expect($('[data-act="dry"]').disabled).toBe(false);
    $('[data-q="none"]').click();
    expect($('[data-act="dry"]').disabled).toBe(true);
  });

  it('«Выбрать всех» / «Все с входом» / «Снять выбор» и счётчик', () => {
    openCaravanDialog();
    $('[data-q="all"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 3 из 3');
    expect($('[data-act="start"]').disabled).toBe(true);
    $('[data-q="none"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 0 из 3');
    $('[data-q="logged"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 1 из 3');
  });

  it('предвыбор через ids и поиск по нику', () => {
    openCaravanDialog({ ids: ['b', 'zzz'] });
    expect($('#caravan-count').textContent).toBe('Выбрано: 1 из 3');
    expect($('[data-id="b"]').checked).toBe(true);
    const s = $('#caravan-search');
    s.value = 'вв';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelectorAll('[data-id]')).toHaveLength(1);
  });

  it('без персонажей диалог не открывается', () => {
    state.characters = [];
    expect(openCaravanDialog()).toBeNull();
    expect(mocks.toast).toHaveBeenCalled();
    expect($('.tf-dialog')).toBeNull();
  });
});

describe('сначала реальный сайт, независимо от GameCenter', () => {
  it('проверяет даже сохранённый статус false без просьбы запомнить GameCenter', async () => {
    state.characters.forEach(c => {
      c.isLoggedIn = false;
    });
    mocks.invoke.mockImplementation(async (_, a) =>
      reply(a.charId, { status: 'dry_run', dryRun: true, clicked: false, opened: 0 })
    );
    openCaravanDialog({ ids: ['a', 'b', 'c'] });
    expect($('#caravan-nologin')).toBeNull();
    expect($('[data-act="start"]').disabled).toBe(true);
    $('[data-act="dry"]').click();
    await wait(150);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(c => c[1].charId).sort()).toEqual(['a', 'b', 'c']);
    expect(mocks.invoke.mock.calls.every(c => c[1].dryRun)).toBe(true);
  });
  it('истинное отсутствие сессии показывает результат сайта, а не отказ по GameCenter', async () => {
    mocks.invoke.mockImplementation(async (_, a) =>
      reply(a.charId, { status: 'not_logged_in', dryRun: true, clicked: false, found: 0, opened: 0, chests: [] })
    );
    openCaravanDialog({ ids: ['a'] });
    $('[data-act="dry"]').click();
    await wait(150);
    expect($('.tf-dialog').textContent).toContain('Нет входа на сайт');
    expect($('[data-act="real"]')).toBeNull();
    expect($('[data-act="dry-again"]')).not.toBeNull();
  });
});

// A separate, successful read-only scan always precedes destructive test runs.
async function scanAndOpen() {
  const implementation = mocks.invoke.getMockImplementation();
  mocks.invoke.mockImplementation(async (cmd, a) =>
    a.dryRun
      ? reply(a.charId, { status: 'dry_run', dryRun: true, clicked: false, opened: 0 })
      : implementation?.(cmd, a)
  );
  $('[data-act="dry"]').click();
  await wait(150);
  mocks.invoke.mockClear();
  $('[data-act="real"]').click();
  await wait(100);
}

describe('запуск', () => {
  it('«Проверить инвентари» спрашивает подтверждение и вызывает команду для выбранных', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    openCaravanDialog({ ids: ['a', 'c'] });
    await scanAndOpen();
    await wait(150);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0][0].text).toContain('Персонажей: 2');
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId).sort()).toEqual(['a', 'c']);
    expect(calls.every(c => c[1].dryRun === false)).toBe(true);
    expect($('.tf-dialog').textContent).toContain('Открыто сундуков: 2');
    expect($('.tf-dialog-sub').textContent).toContain('Открыто сундуков: 4');
  });

  it('отказ в подтверждении — ничего не запускается', async () => {
    mocks.confirm.mockResolvedValue(false);
    openCaravanDialog({ ids: ['a'] });
    await scanAndOpen();
    await wait();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect($('[data-act="real"]')).not.toBeNull();
  });

  it('«Только посчитать» не спрашивает подтверждение, шлёт dryRun и предлагает открыть найденное', async () => {
    mocks.invoke.mockImplementation(async (_, a) =>
      reply(
        a.charId,
        a.charId === 'a'
          ? {
              status: 'dry_run',
              dryRun: true,
              clicked: false,
              opened: 0,
              chests: [
                { cartId: '7', until: '', state: 'found', error: null, items: [] },
                { cartId: '8', until: '', state: 'found', error: null, items: [] }
              ]
            }
          : { status: 'nothing', found: 0, opened: 0, clicked: false, chests: [] }
      )
    );
    openCaravanDialog({ ids: ['a', 'b'] });
    $('[data-act="dry"]').click();
    await wait(150);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.every(c => c[1].dryRun === true)).toBe(true);
    expect($('.tf-dialog').textContent).toContain('Сундуков нет');
    expect($('.tf-dialog').textContent).toContain('Ничего не открыто');
    expect($('[data-act="real"]')).not.toBeNull();

    // «Открыть найденные» — только у тех, у кого сундуки есть
    mocks.invoke.mockReset().mockImplementation(async (_, a) => reply(a.charId));
    $('[data-act="real"]').click();
    await wait(150);
    expect(mocks.confirm.mock.calls[0][0].text).toContain('Персонажей: 1');
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId)).toEqual(['a']);
    expect(calls[0][1].dryRun).toBe(false);
  });

  it('частичный итог: «Повторить» запускает только тех, у кого осталось', async () => {
    mocks.invoke.mockImplementation(async (_, a) =>
      a.charId === 'a'
        ? reply('a', {
            status: 'partial',
            opened: 1,
            chests: [
              { cartId: '1', until: '', state: 'opened', error: null, items: [] },
              { cartId: '2', until: '', state: 'not_opened', error: null, items: [] }
            ]
          })
        : reply(a.charId)
    );
    openCaravanDialog({ ids: ['a', 'b'] });
    await scanAndOpen();
    await wait(150);
    expect($('.tf-dialog').textContent).toContain('Открыто 1 из 2');
    expect($('.tf-dialog').textContent).toContain('остался в инвентаре');
    expect($('[data-act="retry"]').textContent).toContain('(1)');

    mocks.invoke.mockReset().mockImplementation(async (_, a) => reply(a.charId));
    $('[data-act="retry"]').click();
    await wait(150);
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId)).toEqual(['a']);
    $('[data-act="report"]').click();
    const report = [...document.querySelectorAll('.tf-dialog')].at(-1);
    expect(report.textContent).toContain('Сундук №1');
    expect(report.textContent).toContain('остался в инвентаре');
  });

  it('нет входа виден в таблице и его можно повторить после восстановления входа', async () => {
    mocks.invoke.mockImplementation(async (_, a) =>
      reply(
        a.charId,
        a.charId === 'a'
          ? { status: 'not_logged_in', found: 0, opened: 0, clicked: false, chests: [] }
          : { status: 'nothing', found: 0, opened: 0, clicked: false, chests: [] }
      )
    );
    openCaravanDialog({ ids: ['a', 'b'] });
    $('[data-act="dry"]').click();
    await wait(150);
    expect($('.tf-dialog').textContent).toContain('Нет входа на сайт');
    expect($('[data-act="dry-again"]')).not.toBeNull();
  });

  it('«← К списку» возвращает форму с сохранённым выбором', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    openCaravanDialog({ ids: ['a'] });
    await scanAndOpen();
    await wait(150);
    $('[data-act="back"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 1 из 3');
  });

  it('«Стоп» во время работы: начатые заканчиваются, остальные не стартуют', async () => {
    state.characters.push({ id: 'd', nick: 'Гг' }, { id: 'e', nick: 'Дд' });
    const releases = [];
    mocks.invoke.mockImplementation(
      (_, a) =>
        new Promise(r => {
          releases.push(() => r(reply(a.charId)));
        })
    );
    openCaravanDialog({ ids: ['a', 'b', 'c', 'd', 'e'] });
    await scanAndOpen();
    await wait(150);
    expect(releases).toHaveLength(3); // по лимиту окон — три одновременно
    $('[data-act="stop"]').click();
    releases.forEach(f => f());
    await wait(200);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect($('.tf-dialog-sub').textContent).toContain('Остановлено');
    expect($('.tf-dialog').textContent).toContain('Открыто сундуков: 2');
  });
});

describe('отдельный выбор количества после сайта', () => {
  const setupScan = async ({ shared = false } = {}) => {
    mocks.invoke.mockImplementation(async (_, a) =>
      reply(
        a.charId,
        a.dryRun
          ? {
              status: 'dry_run',
              dryRun: true,
              clicked: false,
              opened: 0,
              found: 5,
              accountKey: shared ? 'a'.repeat(64) : (a.charId === 'a' ? 'a' : 'b').repeat(64)
            }
          : { opened: a.maxChests || 5, found: 5 }
      )
    );
    openCaravanDialog({ ids: shared ? ['a', 'b'] : ['a'] });
    $('[data-act="dry"]').click();
    await wait(150);
  };
  const count = (id, n) => {
    const input = $(`[data-caravan-limit="${id}"]`);
    input.value = String(n);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const custom = () => {
    const radio = $('[name=caravan-amount][value=count]');
    radio.checked = true;
    radio.dispatchEvent(new Event('input', { bubbles: true }));
  };
  it('сайт читается для всех; один общий аккаунт открывается ровно один раз и остаётся привязан к проверенному входу', async () => {
    await setupScan({ shared: true });
    expect(mocks.invoke.mock.calls).toHaveLength(2);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-caravan-limit]')).toHaveLength(1);
    expect($('[data-caravan-limit]').closest('td').cellIndex).toBe(3);
    expect($('[data-caravan-quantity-head]').hidden).toBe(false);
    expect($('[data-act=real]').disabled).toBe(false);
    custom();
    count('a', 2);
    mocks.invoke.mockClear();
    $('[data-act="real"]').click();
    await wait(150);
    expect(mocks.invoke.mock.calls).toHaveLength(1);
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject({
      charId: 'a',
      dryRun: false,
      maxChests: 2,
      expectedAccountKey: 'a'.repeat(64)
    });
  });
  it('«все» не передаёт ограничение от прежнего ручного количества', async () => {
    await setupScan();
    custom();
    count('a', 1);
    const all = $('[name=caravan-amount][value=all]');
    all.checked = true;
    all.dispatchEvent(new Event('input', { bubbles: true }));
    mocks.invoke.mockClear();
    $('[data-act="real"]').click();
    await wait(150);
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('maxChests');
  });
  it('некорректное, дробное и завышенное количество не запускает открытие', async () => {
    await setupScan();
    custom();
    for (const n of [1.5, 6, -1]) {
      count('a', n);
      mocks.invoke.mockClear();
      $('[data-act="real"]').click();
      await wait(20);
      expect(mocks.invoke).not.toHaveBeenCalled();
    }
  });
  it('повтор частичного результата берёт только остаток выбранного количества, не первоначальный лимит', async () => {
    await setupScan();
    custom();
    count('a', 2);
    mocks.invoke.mockReset().mockImplementation(async (_, a) =>
      reply(a.charId, {
        status: 'partial',
        opened: 1,
        found: 5,
        chests: [
          { cartId: '1', state: 'opened' },
          { cartId: '2', state: 'not_opened' }
        ]
      })
    );
    $('[data-act="real"]').click();
    await wait(150);
    expect(mocks.invoke.mock.calls[0][1].maxChests).toBe(2);
    mocks.invoke.mockReset().mockImplementation(async (_, a) => reply(a.charId, { opened: 1, found: 4 }));
    $('[data-act="retry"]').click();
    await wait(150);
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ maxChests: 1, expectedAccountKey: 'a'.repeat(64) });
  });
});

it('does not open any inventory without a site account binding, even when chests were counted', async () => {
  mocks.invoke.mockImplementation(async (_, a) =>
    reply(a.charId, { status: 'dry_run', dryRun: true, clicked: false, opened: 0, accountKey: null })
  );
  openCaravanDialog({ ids: ['a'] });
  $('[data-act="dry"]').click();
  await wait(150);
  mocks.invoke.mockClear();
  $('[data-act="real"]').click();
  await wait(50);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Сайт не сообщил аккаунт'), 'warning');
});

it('initial plan is a chest-count table, unknown before the website check and observed after returning to the list', async () => {
  mocks.invoke.mockImplementation(async (cmd, args) =>
    reply(args.charId, { status: 'dry_run', dryRun: true, clicked: false, opened: 0, found: 7 })
  );
  openCaravanDialog({ ids: ['a'] });
  expect($('.caravan-plan-table thead').textContent).toBe(
    'ПерсонажСундуки караванщикаСостояниеПеревести / открыть, шт.'
  );
  expect($('.caravan-plan-table tbody').textContent).toContain('Аа');
  expect($('.caravan-plan-table tbody').textContent).toContain('Не проверено');
  expect($('.caravan-plan-table tbody').textContent).not.toContain('0 шт.');
  $('[data-act="dry"]').click();
  await vi.waitFor(() => expect($('[data-act="back"]')).not.toBeNull());
  $('[data-act="back"]').click();
  expect($('.caravan-plan-table tbody').textContent).toContain('7 шт.');
});

it('keeps the exact plan/table DOM through counting, opening and results; controls are locked only while running', async () => {
  let finish;
  mocks.invoke.mockImplementation(
    async (_, args) =>
      new Promise(resolve => {
        finish = () =>
          resolve(
            reply(args.charId, {
              status: args.dryRun ? 'dry_run' : 'success',
              dryRun: args.dryRun,
              clicked: !args.dryRun,
              found: 4,
              opened: args.dryRun ? 0 : 2
            })
          );
      })
  );
  openCaravanDialog({ ids: ['a'] });
  const table = $('.caravan-plan-table'),
    plan = table.closest('.script-plan');
  $('[data-act="dry"]').click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect($('.caravan-plan-table')).toBe(table);
  expect(table.closest('.script-plan')).toBe(plan);
  expect(plan.querySelector('h4').textContent).toBe('План запуска');
  expect($('.sp-side').inert).toBe(true);
  finish();
  await vi.waitFor(() => expect($('[data-act="real"]')).not.toBeNull());
  expect($('.caravan-plan-table')).toBe(table);
  expect(table.textContent).toContain('4 шт.');
  expect($('.sp-side').inert).toBe(false);
  finish = null;
  $('[data-act="real"]').click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect($('.caravan-plan-table')).toBe(table);
  finish();
  await vi.waitFor(() => expect($('[data-act="retry"]')).not.toBeNull());
  expect($('.caravan-plan-table')).toBe(table);
  expect(table.textContent).toContain('2 шт.');
  expect(document.querySelectorAll('.caravan-plan-table')).toHaveLength(1);
});
