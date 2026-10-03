import { describe, it, expect, beforeEach, vi } from 'vitest';

// Состояние парсеров (issue #12): статусы проверок, плашка «Парсер устарел», диагностика
// и главное — при изменённой вёрстке данные в базе не затираются.

const mocks = vi.hoisted(() => ({ progress: { quests: null, error: null }, toast: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd, args) => {
    if (cmd === 'fetch_marathon_progress_v1') {
      const { quests, error } = mocks.progress;
      // ответ приходит событием после вызова — как в Rust
      queueMicrotask(() => mocks.siteSync.onCharMarathonData(args.charId, quests, error));
    }
    return {};
  })
}));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: (...a) => mocks.toast(...a), showModal: vi.fn(), closeModal: vi.fn(), confirmDialog: vi.fn(() => true) }));
vi.mock('../js/modules/characters/list.js', () => ({ renderCharacters: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));

let health, ui, state, disposeUi;

beforeEach(async () => {
  disposeUi?.(); disposeUi = null;
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  mocks.toast.mockClear();
  health = await import('../js/core/parserHealth.js');
  ui = await import('../js/settings/parserHealthUi.js');
  ({ state } = await import('../js/core/state.js'));
});

describe('classifyResult: код ошибки → статус', () => {
  const cases = [
    [null, 'ok'],
    ['not_logged_in', 'not_logged_in'],
    ['zero_no_user_session_expired', 'not_logged_in'],
    ['session_lost_during_parse', 'not_logged_in'],
    ['challenge', 'challenge'],
    ['timeout', 'timeout'],
    ['timeout_parsing_marathon', 'timeout'],
    ['timeout_parsing_details', 'timeout'],
    ['container_missing', 'layout_changed'],
    ['no_value_tag', 'layout_changed'],
    ['parse_nan', 'layout_changed'],
    ['no_progress_found', 'layout_changed'],
    ['no_article', 'layout_changed'],
    ['pending', 'layout_changed'],
    ['config_missing', 'layout_changed'],
    ['exception_Cannot read prop', 'layout_changed'],
    ['container_not_found', 'empty'],
    ['no_title_found', 'empty'],
    ['что-то непонятное', 'error']
  ];
  it.each(cases)('%s → %s', (code, status) => {
    expect(health.classifyResult(code)).toBe(status);
  });

  it('успешный, но пустой результат → empty (реальный «ноль», а не поломка)', () => {
    expect(health.classifyResult(null, { empty: true })).toBe('empty');
  });

  it('несколько ошибок (поиск по нескольким страницам): берётся самая серьёзная', () => {
    expect(health.classifyErrors(['timeout', 'container_missing', 'not_logged_in']).status).toBe('layout_changed');
    expect(health.classifyErrors(['timeout', 'not_logged_in']).error).toBe('not_logged_in');
    expect(health.classifyErrors(['no_title_found'])).toEqual({ status: 'empty', error: 'no_title_found' });
    expect(health.classifyErrors([])).toEqual({ status: 'empty', error: null });
  });
});

describe('recordParserResult: серия неудач и плашка', () => {
  it('одна неудача — ещё не повод для плашки; вторая подряд — повод', () => {
    health.recordParserResult('balance', 'container_missing');
    expect(health.problemParsers()).toEqual([]);
    health.recordParserResult('balance', 'container_missing');
    expect(health.problemParsers().map(p => p.id)).toEqual(['balance']);
    expect(health.getParserHealth().balance).toMatchObject({ status: 'layout_changed', failStreak: 2, lastError: 'container_missing' });
  });

  it('успех сбрасывает серию и запоминает время последней успешной проверки', () => {
    health.recordParserResult('balance', 'parse_nan', { at: '2026-05-01T10:00:00.000Z' });
    health.recordParserResult('balance', null, { at: '2026-05-01T11:00:00.000Z' });
    expect(health.getParserHealth().balance).toEqual({
      status: 'ok', lastCheckAt: '2026-05-01T11:00:00.000Z', lastOkAt: '2026-05-01T11:00:00.000Z', lastError: null, failStreak: 0
    });
    expect(health.problemParsers()).toEqual([]);
  });

  it('нет входа, проверка безопасности и таймаут серию не увеличивают и не сбрасывают', () => {
    health.recordParserResult('auth', 'pending');
    for (const code of ['not_logged_in', 'challenge', 'timeout', 'странная ошибка']) health.recordParserResult('auth', code);
    expect(health.getParserHealth().auth.failStreak).toBe(1);
    health.recordParserResult('auth', 'pending');
    expect(health.problemParsers().map(p => p.id)).toEqual(['auth']);
  });

  it('пустой результат — это нормальная работа, серия сбрасывается', () => {
    health.recordParserResult('progress', 'no_progress_found');
    health.recordParserResult('progress', 'container_not_found');
    expect(health.getParserHealth().progress).toMatchObject({ status: 'empty', failStreak: 0 });
    expect(health.getParserHealth().progress.lastOkAt).toBeTruthy();
  });

  it('парсеры независимы, неизвестный ключ игнорируется', () => {
    health.recordParserResult('balance', 'container_missing');
    health.recordParserResult('balance', 'container_missing');
    health.recordParserResult('auth', null);
    expect(health.recordParserResult('нет-такого', 'container_missing')).toBeNull();
    expect(health.problemParsers().map(p => p.id)).toEqual(['balance']);
    expect(health.getParserHealth().news.status).toBeNull();
  });

  it('статусы переживают перезапуск (localStorage) и подписчики получают изменения', async () => {
    const seen = [];
    health.subscribeHealth((h) => seen.push(h.balance.status));
    health.recordParserResult('balance', 'no_value_tag');
    expect(seen).toEqual([null, 'layout_changed']);
    vi.resetModules();
    const again = await import('../js/core/parserHealth.js');
    expect(again.getParserHealth().balance).toMatchObject({ status: 'layout_changed', failStreak: 1 });
  });

  it('испорченные данные в localStorage не ломают запуск', async () => {
    localStorage.setItem('tf-parser-health', '{не json');
    vi.resetModules();
    const again = await import('../js/core/parserHealth.js');
    expect(again.getParserHealth().balance.status).toBeNull();
  });
});

describe('buildDiagnostics', () => {
  it('содержит версии, статус, код ошибки и времена; без паролей и ников', () => {
    state.characters = [{ id: 'c1', nick: 'СекретныйНик', password: 'hunter2', email: 'a@b.ru' }];
    health.recordParserResult('balance', 'container_missing', { at: '2026-05-01T10:00:00.000Z' });
    const text = health.buildDiagnostics();
    expect(text).toContain('Диагностика парсеров');
    expect(text).toMatch(/Приложение: \d+\.\d+\.\d+ · selectors\.json: версия \d+/);
    expect(text).toContain('Парсер: Баланс монет (balance)');
    expect(text).toContain('[layout_changed]');
    expect(text).toContain('container_missing — на странице нет блока с балансом');
    expect(text).toContain('Парсер: Новости (news)');
    expect(text).toContain('ещё не проверялся');
    for (const secret of ['СекретныйНик', 'hunter2', 'a@b.ru']) expect(text).not.toContain(secret);
  });

  it('по одному парсеру — только он', () => {
    const text = health.buildDiagnostics('auth');
    expect(text).toContain('(auth)');
    expect(text).not.toContain('(balance)');
  });
});

describe('плашка и таблица', () => {
  const mount = () => {
    document.body.innerHTML = `<button class="tab" data-tab="settings"></button><div id="parser-health-banner" hidden></div>
      <div id="parser-health-panel"><div id="parser-health-list"></div><span id="parser-health-config"></span></div>`;
    disposeUi = ui.initParserHealthUi();
  };
  const banner = () => document.getElementById('parser-health-banner');

  it('плашка скрыта, пока всё работает, и появляется после двух неудач подряд', () => {
    mount();
    expect(banner().hidden).toBe(true);
    health.recordParserResult('balance', 'container_missing');
    expect(banner().hidden).toBe(true);
    health.recordParserResult('balance', 'container_missing');
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Парсер баланса устарел');
    expect(banner().textContent).toContain('сайт pwonline.ru изменил вёрстку');
    expect(banner().textContent).toContain('Данные в приложении не тронуты');
    expect(banner().querySelector('[data-health-copy]')).toBeTruthy();
  });

  it('исчезает, когда парсер снова работает', () => {
    mount();
    health.recordParserResult('balance', 'parse_nan');
    health.recordParserResult('balance', 'parse_nan');
    health.recordParserResult('balance', null);
    expect(banner().hidden).toBe(true);
  });

  it('«Скрыть» убирает плашку до следующей неудачи', () => {
    mount();
    health.recordParserResult('auth', 'pending');
    health.recordParserResult('auth', 'pending');
    banner().querySelector('[data-health-hide]').click();
    expect(banner().hidden).toBe(true);
    health.recordParserResult('auth', 'pending');
    expect(banner().hidden).toBe(false);
  });

  it('несколько парсеров перечисляются в одной плашке', () => {
    mount();
    for (let i = 0; i < 2; i++) { health.recordParserResult('balance', 'parse_nan'); health.recordParserResult('progress', 'no_progress_found'); }
    expect(banner().textContent).toContain('Устарели парсеры: баланса, прогресса марафона');
  });

  it('таблица в настройках: все парсеры, статус, последняя успешная проверка, версия конфига', () => {
    mount();
    health.recordParserResult('balance', null, { at: '2026-05-01T10:00:00.000Z' });
    health.recordParserResult('auth', 'pending');
    const rows = [...document.querySelectorAll('#parser-health-list tbody tr')];
    expect(rows).toHaveLength(Object.keys(health.PARSERS).length);
    expect(rows[0].textContent).toContain('работает');
    expect(rows[0].textContent).toMatch(/01\.05\.2026/);
    const auth = rows.find(r => r.textContent.includes('Проверка входа'));
    expect(auth.textContent).toContain('сайт изменил вёрстку');
    expect(auth.textContent).toContain('pending');
    expect(rows.find(r => r.textContent.includes('Новости')).textContent).toContain('ещё не проверялся');
    expect(document.getElementById('parser-health-config').textContent).toMatch(/Версия selectors\.json в этой сборке: \d+/);
  });

  it('«Скопировать диагностику» кладёт текст в буфер обмена', async () => {
    mount();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    health.recordParserResult('balance', 'container_missing');
    document.querySelector('#parser-health-list [data-health-copy="balance"]').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('Парсер: Баланс монет (balance)');
    expect(writeText.mock.calls[0][0]).not.toContain('(auth)');
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('скопирована'), 'success'));
  });
});

describe('данные в базе не затираются, а статус записывается', () => {
  const mkChar = () => ({ id: 'c', nick: 'Ник', isLoggedIn: true, ancientCoins: 120, coinHistory: [{ at: '2026-05-01T10:00:00.000Z', balance: 120 }], lastCoinUpdate: '2026-05-01T10:00:00.000Z' });

  it('баланс: ошибка вёрстки не меняет монеты и историю, но попадает в состояние парсера', async () => {
    const sync = await import('../js/modules/sync/syncManager.js');
    const char = mkChar();
    state.characters = [char];
    const before = JSON.stringify(char);
    sync.applyBalanceResult({ charId: 'c', balance: null, error: 'container_missing' });
    sync.applyBalanceResult({ charId: 'c', balance: 0, error: 'no_value_tag' });
    expect(JSON.stringify(char)).toBe(before);
    expect(health.problemParsers().map(p => p.id)).toEqual(['balance']);
    sync.applyBalanceResult({ charId: 'c', balance: 150, error: null });
    expect(char.ancientCoins).toBe(150);
    expect(health.getParserHealth().balance.status).toBe('ok');
  });

  it('вход: причина попадает в состояние, нет входа ≠ поломка парсера', async () => {
    const sync = await import('../js/modules/sync/syncManager.js');
    state.characters = [mkChar()];
    sync.applyLoginResult({ charId: 'c', status: 'offline', reason: 'not_logged_in' });
    expect(health.getParserHealth().auth).toMatchObject({ status: 'not_logged_in', failStreak: 0 });
    sync.applyLoginResult({ charId: 'c', status: 'offline', reason: 'pending' });
    expect(health.getParserHealth().auth).toMatchObject({ status: 'layout_changed', failStreak: 1 });
    sync.applyLoginResult({ charId: 'c', status: 'online', reason: null });
    expect(health.getParserHealth().auth).toMatchObject({ status: 'ok', failStreak: 0 });
  });

  it('сверка марафона: «нет полос прогресса» не обнуляет сохранённый прогресс', async () => {
    const siteSync = await import('../js/modules/marathons/siteSync.js');
    mocks.siteSync = siteSync;
    const { createMarathon } = await import('../js/modules/marathons/model.js');
    state.settings = { scripts: { retries: 0, retryDelayMs: 0 } };
    state.characters = [mkChar()];
    const m = createMarathon({
      id: 'm', title: 'Летний', participantIds: ['c'], source: { type: 'site', url: 'https://pwonline.ru/supermarathon.php' },
      tasks: [{ id: 't', title: 'Задание', targetChecks: 25 }], assignments: { c: ['t'] }
    });
    m.progress.c = { t: { site: 7, siteTotal: 25, adjust: 0, marks: [], history: {} } };
    state.marathons = [m];

    mocks.progress = { quests: null, error: 'no_progress_found' };
    await siteSync.syncMarathons([m]);
    await siteSync.syncMarathons([m]);
    expect(m.progress.c.t.site).toBe(7);
    expect(m.lastSync.errors).toEqual([{ charId: 'c', error: 'no_progress_found' }]);
    expect(health.problemParsers().map(p => p.id)).toEqual(['progress']);

    mocks.progress = { quests: [{ title: 'Задание', completed: 9, total: 25 }], error: null };
    await siteSync.syncMarathons([m]);
    expect(m.progress.c.t.site).toBe(9);
    expect(health.getParserHealth().progress).toMatchObject({ status: 'ok', failStreak: 0 });
  });
});
