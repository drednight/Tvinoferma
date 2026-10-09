import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог «Сундук караванщика»: выбор персонажей → проверка инвентарей → итоги
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(async () => true), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));

const $ = (s) => document.querySelector(s);
const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));
let state, openCaravanDialog;

const chars = [{ id: 'a', nick: 'Аа' }, { id: 'b', nick: 'Бб' }, { id: 'c', nick: 'Вв', isLoggedIn: true }];
const reply = (charId, over = {}) => ({
  charId, status: 'success', error: null, dryRun: false, clicked: true, found: 2, other: 0, opened: 2,
  chests: [{ cartId: '1', until: '15:04 10.10.2026', state: 'opened', error: null, items: ['x'] }, { cartId: '2', until: '', state: 'opened', error: null, items: ['y'] }],
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
  state.characters = chars.map(c => ({ ...c })); state.parties = [];
  ({ openCaravanDialog } = await import('../js/modules/automation/caravan.js'));
});

describe('форма «Сундук караванщика»', () => {
  it('заголовок, объяснение, две кнопки; без выбора кнопки заблокированы', () => {
    openCaravanDialog();
    expect($('.tf-dialog-title').textContent).toContain('Сундук караванщика');
    expect($('.tf-dialog').textContent).toContain('«Сундуки караванщика»');
    expect($('[data-act="start"]').textContent).toContain('Проверить инвентари');
    expect($('[data-act="dry"]').textContent).toContain('Только посчитать');
    expect($('[data-act="start"]').disabled).toBe(true);
    expect($('[data-act="dry"]').disabled).toBe(true);
  });

  it('«Выбрать всех» / «Все с входом» / «Снять выбор» и счётчик', () => {
    openCaravanDialog();
    $('[data-q="all"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 3 из 3');
    expect($('[data-act="start"]').disabled).toBe(false);
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

describe('персонажи без входа на сайт', () => {
  const noLogin = () => state.characters.map(c => c.id === 'c' ? { ...c, isLoggedIn: true } : { ...c, isLoggedIn: false });

  it('в форме видна подсказка с ними по именам', () => {
    state.characters = noLogin();
    openCaravanDialog({ ids: ['a', 'b', 'c'] });
    const warn = $('#caravan-nologin');
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain('Аа, Бб');
    expect(warn.textContent).toContain('Запомнить текущий вход');
  });

  it('без входа у всех выбор не запускается, объясняем почему', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    state.characters = [{ id: 'a', nick: 'Аа', isLoggedIn: false }];
    openCaravanDialog({ ids: ['a'] });
    $('[data-act="start"]').click();
    await wait(100);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls[0][0]).toContain('нет входа на сайт');
  });

  it('при запуске пропускает их и спрашивает, продолжать ли без них', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    state.characters = noLogin();
    openCaravanDialog({ ids: ['a', 'b', 'c'] });
    $('[data-act="start"]').click();
    await wait(200);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);          // «пропустить?» и подтверждение открытия
    expect(mocks.confirm.mock.calls[0][0].text).toContain('Пропущу 2 из 3');
    expect(mocks.confirm.mock.calls[0][0].text).toContain('Аа, Бб');
    expect(mocks.confirm.mock.calls[1][0].text).toContain('Персонажей: 1');
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId)).toEqual(['c']);
  });

  it('отказ пропустить — не запускаем ничего', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    mocks.confirm.mockResolvedValueOnce(false);
    state.characters = noLogin();
    openCaravanDialog({ ids: ['a', 'c'] });
    $('[data-act="start"]').click();
    await wait(100);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('у кого вход есть — лишних вопросов нет', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    state.characters = [{ id: 'a', nick: 'Аа' }, { id: 'c', nick: 'Вв', isLoggedIn: true }];
    openCaravanDialog({ ids: ['a', 'c'] });
    expect($('#caravan-nologin').hidden).toBe(true);
    $('[data-act="start"]').click();
    await wait(150);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId).sort()).toEqual(['a', 'c']);
  });
});

describe('запуск', () => {
  it('«Проверить инвентари» спрашивает подтверждение и вызывает команду для выбранных', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    openCaravanDialog({ ids: ['a', 'c'] });
    $('[data-act="start"]').click();
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
    $('[data-act="start"]').click();
    await wait();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect($('[data-act="start"]')).not.toBeNull();
  });

  it('«Только посчитать» не спрашивает подтверждение, шлёт dryRun и предлагает открыть найденное', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId, a.charId === 'a'
      ? { status: 'dry_run', dryRun: true, clicked: false, opened: 0, chests: [{ cartId: '7', until: '', state: 'found', error: null, items: [] }, { cartId: '8', until: '', state: 'found', error: null, items: [] }] }
      : { status: 'nothing', found: 0, opened: 0, clicked: false, chests: [] }));
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
    mocks.invoke.mockImplementation(async (_, a) => (a.charId === 'a'
      ? reply('a', { status: 'partial', opened: 1, chests: [{ cartId: '1', until: '', state: 'opened', error: null, items: [] }, { cartId: '2', until: '', state: 'not_opened', error: null, items: [] }] })
      : reply(a.charId)));
    openCaravanDialog({ ids: ['a', 'b'] });
    $('[data-act="start"]').click();
    await wait(150);
    expect($('.tf-dialog').textContent).toContain('Открыто 1 из 2');
    expect($('.tf-dialog').textContent).toContain('остался в инвентаре');
    expect($('[data-act="retry"]').textContent).toContain('(1)');

    mocks.invoke.mockReset().mockImplementation(async (_, a) => reply(a.charId));
    $('[data-act="retry"]').click();
    await wait(150);
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'open_caravan_chests');
    expect(calls.map(c => c[1].charId)).toEqual(['a']);
  });

  it('нет входа и ошибка видны в таблице, «Повторить» недоступно, если повторять нечего', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId, a.charId === 'a'
      ? { status: 'not_logged_in', found: 0, opened: 0, clicked: false, chests: [] }
      : { status: 'nothing', found: 0, opened: 0, clicked: false, chests: [] }));
    openCaravanDialog({ ids: ['a', 'b'] });
    $('[data-act="start"]').click();
    await wait(150);
    expect($('.tf-dialog').textContent).toContain('Нет входа на сайт');
    expect($('[data-act="retry"]').disabled).toBe(true);
  });

  it('«← К списку» возвращает форму с сохранённым выбором', async () => {
    mocks.invoke.mockImplementation(async (_, a) => reply(a.charId));
    openCaravanDialog({ ids: ['a'] });
    $('[data-act="start"]').click();
    await wait(150);
    $('[data-act="back"]').click();
    expect($('#caravan-count').textContent).toBe('Выбрано: 1 из 3');
  });

  it('«Стоп» во время работы: начатые заканчиваются, остальные не стартуют', async () => {
    state.characters.push({ id: 'd', nick: 'Гг' }, { id: 'e', nick: 'Дд' });
    const releases = [];
    mocks.invoke.mockImplementation((_, a) => new Promise(r => { releases.push(() => r(reply(a.charId))); }));
    openCaravanDialog({ ids: ['a', 'b', 'c', 'd', 'e'] });
    $('[data-act="start"]').click();
    await wait(150);
    expect(releases).toHaveLength(3);          // по лимиту окон — три одновременно
    $('[data-act="stop"]').click();
    releases.forEach(f => f());
    await wait(200);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect($('.tf-dialog-sub').textContent).toContain('Остановлено');
    expect($('.tf-dialog').textContent).toContain('Открыто сундуков: 2');
  });
});
