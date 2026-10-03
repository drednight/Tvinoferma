import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог промокодов и блок «История промокодов» в Настройках (Issue #25)
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(() => true), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }) }));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));   // без реальных пауз
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmDialog: mocks.confirm }));

const $ = (s) => document.querySelector(s);
const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));
let state, openPromoDialog, renderPromoLog, recordRun;

const chars = [{ id: 'a', nick: 'Аа' }, { id: 'b', nick: 'Бб' }, { id: 'c', nick: 'Вв', isLoggedIn: true }];
const okRow = (charId, code = 'CODE1234', extra = {}) => ({ code, charId, nick: chars.find(c => c.id === charId).nick, status: 'success', error: null, clicked: true, dryRun: false, skipped: false, rewards: null, at: new Date().toISOString(), ...extra });

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  mocks.invoke.mockReset();
  mocks.confirm.mockReset().mockReturnValue(true);
  mocks.toast.mockReset();
  document.body.innerHTML = '<div id="modal-root"></div><div id="promo-log-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = chars.map(c => ({ ...c })); state.parties = [];
  ({ openPromoDialog } = await import('../js/modules/automation/promo.js'));
  ({ renderPromoLog } = await import('../js/modules/automation/promoLogView.js'));
  ({ recordRun } = await import('../js/modules/automation/promoLog.js'));
});

describe('форма промокодов', () => {
  it('нет галочек и пояснения про страницу /pin; есть «Выбрать всех», фильтра по пати нет', () => {
    openPromoDialog();
    expect($('.tf-dialog').querySelectorAll('input[type=checkbox]:not([data-id])')).toHaveLength(0);
    expect($('.tf-dialog').textContent).not.toMatch(/pwonline\.ru\/pin|Ввести|Пробный/);
    expect($('.tf-dialog').querySelector('#promo-party')).toBeNull();
    expect($('[data-q="all"]').textContent).toContain('Выбрать всех');
    expect($('.tf-dialog-title').textContent).toContain('🎁');
    expect($('.promo-hint').textContent).toContain('До 10');
  });

  it('«Выбрать всех» отмечает всех, «Снять выбор» — снимает', () => {
    openPromoDialog();
    $('[data-q="all"]').click();
    expect($('#promo-count').textContent).toBe('Выбрано: 3 из 3');
    $('[data-q="none"]').click();
    expect($('#promo-count').textContent).toBe('Выбрано: 0 из 3');
  });

  it('под полем сразу видно, что код уже был введён и у скольких пропущу', () => {
    recordRun('CODE1234', [okRow('a'), okRow('b')], { known: chars });
    openPromoDialog({ ids: ['a', 'b', 'c'] });
    const ta = $('#promo-code');
    ta.value = 'code1234, NEWCODE99';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const info = $('#promo-codes-info').textContent;
    expect(info).toContain('уже был введён');
    expect(info).toContain('у 2 из 3 выбранных');
    expect(info).toContain('запущу у 1');
    expect(info).toContain('новый код');
  });

  it('неподходящий код: предупреждение и запуск не начинается', async () => {
    openPromoDialog({ ids: ['a'] });
    $('#promo-code').value = 'ab';
    $('#promo-code').dispatchEvent(new Event('input', { bubbles: true }));
    expect($('#promo-codes-info').textContent).toContain('Не похоже на промокод');
    $('[data-act="start"]').click(); await wait();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('запуск', () => {
  const run = async (codes, ids) => {
    openPromoDialog({ ids });
    $('#promo-code').value = codes;
    $('#promo-code').dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-act="start"]').click();
    await wait(400);
  };

  it('несколько кодов: у каждого персонажа каждый код — отдельный вызов; итог — таблица «персонаж × код», награда и журнал', async () => {
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'success', clicked: true, rewards: [{ name: 'Метеорит', qty: 100, id: '1', bound: true }] }));
    await run('AAAA1111, BBBB2222', ['a', 'b']);
    expect(mocks.invoke).toHaveBeenCalledTimes(4);
    expect(mocks.invoke.mock.calls.every(c => c[0] === 'activate_promo' && c[1].dryRun === false)).toBe(true);
    expect([...document.querySelectorAll('.promo-table thead th')].map(t => t.textContent)).toEqual(['Персонаж', 'AAAA1111', 'BBBB2222']);
    expect($('.tf-dialog-sub').textContent).toContain('Введено: 4 из 4');
    expect($('.promo-sums').textContent).toContain('Метеорит ×100');
    expect($('[data-act="retry"]')).not.toBeNull();
    // журнал в Настройках
    renderPromoLog();
    expect([...document.querySelectorAll('.promo-log-item > summary code')].map(c => c.textContent).sort()).toEqual(['AAAA1111', 'BBBB2222']);
  });

  it('недействительный код: предупреждение «не принят» и ничего в журнале', async () => {
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'invalid_code', clicked: true, detail: 'Не добавлены бонусы для этого типа пин-кода' }));
    await run('BADD0001', ['a', 'b']);
    expect($('.promo-alert').textContent).toContain('BADD0001');
    expect($('.promo-alert').textContent).toContain('не принят');
    renderPromoLog();
    expect(document.querySelectorAll('.promo-log-item')).toHaveLength(0);
  });

  it('повторный ввод того же кода: введённых пропускает без запроса, остальных прогоняет заново', async () => {
    mocks.invoke.mockImplementation(async (_, a) => (a.charId === 'b' ? { charId: 'b', status: 'challenge', clicked: false } : { charId: a.charId, status: 'success', clicked: true }));
    await run('AAAA1111', ['a', 'b']);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    mocks.invoke.mockClear();
    mocks.invoke.mockImplementation(async (_, a) => ({ charId: a.charId, status: 'success', clicked: true }));
    $('[data-act="retry"]').click(); await wait(400);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].charId).toBe('b');
    expect($('.tf-dialog-sub').textContent).toContain('Введено: 2 из 2');
    expect($('.tf-dialog-sub').textContent).toContain('уже были введены раньше: 1');
  });

  it('кнопка «Стоп» есть во время ввода; введённое сохраняется', async () => {
    let release;
    const { browserSlots } = await import('../js/modules/sync/queue.js');
    browserSlots.max = 1;   // по одному, чтобы остальные ждали в очереди, когда нажат «Стоп»
    mocks.invoke.mockImplementation((_, a) => new Promise(res => { release = () => res({ charId: a.charId, status: 'success', clicked: true }); }));
    openPromoDialog({ ids: ['a', 'b', 'c'] });
    $('#promo-code').value = 'AAAA1111';
    $('#promo-code').dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-act="start"]').click(); await wait(100);
    const stop = $('[data-act="stop"]');
    expect(stop).not.toBeNull();
    stop.click();
    release(); await wait(300);
    // начатый ввод завершился и сохранён, остальные не начинались
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    renderPromoLog();
    expect(document.querySelectorAll('.promo-log-item')).toHaveLength(1);
    expect($('.tf-dialog-sub').textContent).toContain('Остановлено');
  });
});

describe('Настройки → История промокодов', () => {
  it('пусто: понятная заглушка, кнопки выгрузки и очистки неактивны', () => {
    renderPromoLog();
    expect($('#promo-log-root').textContent).toContain('Пока ни один промокод не введён');
    expect($('[data-promo-log="clear"]').disabled).toBe(true);
    expect($('[data-promo-log="archive"]').disabled).toBe(true);
  });

  it('свёрнутая строка — код и дата; внутри кто получил, награда и отдельно кому не введён (с причиной)', () => {
    recordRun('CODE1234', [
      okRow('a', 'CODE1234', { rewards: [{ name: 'Метеорит', qty: 100, id: '1', bound: true }] }),
      okRow('b', 'CODE1234', { status: 'challenge', clicked: false })
    ], { known: chars });
    renderPromoLog();
    const item = $('.promo-log-item');
    expect(item.querySelector('summary').textContent).toMatch(/CODE1234\s+— введён/);
    const text = item.querySelector('.promo-log-body').textContent;
    expect(text).toContain('Метеорит ×100');
    expect(text).toContain('Введён (1)');
    expect(text).toContain('Аа');
    expect(text).toContain('Не введён (2)');
    expect(text).toMatch(/Бб[\s\S]*Нужна проверка безопасности/);
    expect(text).toMatch(/Вв[\s\S]*не запускался/);
  });

  it('очистка журнала оставляет архив', async () => {
    recordRun('CODE1234', [okRow('a')], { known: chars });
    renderPromoLog();
    $('[data-promo-log="clear"]').click();
    expect(document.querySelectorAll('.promo-log-item')).toHaveLength(0);
    expect($('[data-promo-log="archive"]').textContent).toContain('(1)');
  });
});
