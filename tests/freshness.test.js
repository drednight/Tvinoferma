import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  formatAge, thresholdHours, freshnessOf, marathonSyncList, formatHoursSpan, formatWhen,
  freshnessChipHtml, refreshFreshnessLabels, startFreshnessTicker
} from '../js/core/freshness.js';

// Свежесть данных (issue #16): «N назад», подсветка устаревших, пороги в настройках. Показывается в окне
// «Когда что проверено» в профиле персонажа; на маленьких карточках списка проверок нет.

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), showModal: vi.fn(), closeModal: vi.fn(), confirmDialog: vi.fn(() => true) }));
vi.mock('../js/modules/characters/index.js', () => ({ openCharacterProfile: vi.fn(), openCharacterForm: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAllBalances: vi.fn(), refreshAllLoginStatuses: vi.fn(), openSyncHelper: vi.fn() }));

const NOW = new Date('2026-06-10T12:00:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
const SETTINGS = { freshness: { balanceHours: 24, loginHours: 24, marathonHours: 24 } };

describe('formatAge', () => {
  it.each([
    [0, 'только что'], [59 * 1000, 'только что'], [60 * 1000, '1 мин назад'], [59 * 60e3, '59 мин назад'],
    [60 * 60e3, '1 ч назад'], [23.9 * 3600e3, '23 ч назад'], [24 * 3600e3, '1 дн. назад'], [72 * 3600e3, '3 дн. назад'],
    [-5 * 60e3, 'только что']
  ])('%d мс → %s', (ms, text) => expect(formatAge(ms)).toBe(text));
});

describe('freshnessOf и пороги', () => {
  it('порог берётся из настроек; мусор и 0 заменяются значением по умолчанию', () => {
    expect(thresholdHours({ freshness: { balanceHours: 6 } }, 'balance')).toBe(6);
    expect(thresholdHours({ freshness: { balanceHours: 0 } }, 'balance')).toBe(24);
    expect(thresholdHours({ freshness: { loginHours: 'abc' } }, 'login')).toBe(24);
    expect(thresholdHours(undefined, 'marathon')).toBe(24);
  });

  it('свежие данные, устаревшие, никогда не обновлявшиеся', () => {
    expect(freshnessOf('balance', ago(3), SETTINGS, NOW)).toMatchObject({ stale: false, never: false, text: '3 ч назад' });
    expect(freshnessOf('balance', ago(24), SETTINGS, NOW).stale).toBe(false);          // ровно на пороге — ещё свежие
    expect(freshnessOf('balance', ago(25), SETTINGS, NOW)).toMatchObject({ stale: true, text: '1 дн. назад' });
    expect(freshnessOf('login', ago(25), SETTINGS, NOW).stale).toBe(true);
    expect(freshnessOf('login', ago(25), { freshness: { loginHours: 72 } }, NOW).stale).toBe(false);   // порог можно увеличить
    const never = freshnessOf('balance', null, SETTINGS, NOW);
    expect(never).toMatchObject({ stale: true, never: true, text: 'нет данных' });
    expect(freshnessOf('balance', 'не дата', SETTINGS, NOW).never).toBe(true);
  });

  it('в подсказке — точное время и порог', () => {
    expect(freshnessOf('balance', ago(30), SETTINGS, NOW).title).toMatch(/Баланс: обновлено \d{2}\.\d{2}\.\d{4}.*устарело \(порог 24 ч\)/);
  });
});

describe('marathonSyncList: когда прогресс персонажа последний раз сверялся с сайтом', () => {
  const marathon = (id, over = {}) => ({
    id, title: `М-${id}`, kind: 'single', status: 'active', participantIds: ['c'], source: { url: 'https://pwonline.ru/supermarathon.php' },
    progress: { c: { t1: { syncedAt: ago(5) }, t2: { syncedAt: ago(2) } } }, ...over
  });

  it('нет идущих марафонов с сайтом → пустой список', () => {
    expect(marathonSyncList('c', [])).toEqual([]);
    expect(marathonSyncList('c', [marathon('a', { status: 'completed' })])).toEqual([]);
    expect(marathonSyncList('c', [marathon('a', { source: { url: null } })])).toEqual([]);   // ручной марафон сверять не с чем
    expect(marathonSyncList('c', [marathon('a', { participantIds: ['x'] })])).toEqual([]);
    expect(marathonSyncList('c', [marathon('s', { kind: 'series' })])).toEqual([]);
  });

  it('последняя сверка по заданиям марафона', () => {
    const [row] = marathonSyncList('c', [marathon('a')]);
    expect(row.marathon.id).toBe('a');
    expect(row.at).toBe(ago(2));
  });

  it('по строке на каждый марафон', () => {
    const b = marathon('b', { progress: { c: { t1: { syncedAt: ago(30) } } } });
    expect(marathonSyncList('c', [marathon('a'), b]).map(r => [r.marathon.id, r.at])).toEqual([['a', ago(2)], ['b', ago(30)]]);
  });

  it('марафон ещё не сверялся → at = null', () => {
    const rows = marathonSyncList('c', [marathon('a', { progress: { c: { t1: { syncedAt: null } } } }), marathon('b', { progress: {} })]);
    expect(rows.map(r => r.at)).toEqual([null, null]);
  });

  it('адрес страницы можно взять у серии', () => {
    const series = { id: 's', kind: 'series', source: { url: 'https://pwonline.ru/supermarathon2.php' } };
    const child = marathon('a', { source: { url: null }, seriesId: 's' });
    expect(marathonSyncList('c', [series, child]).map(r => r.at)).toEqual([ago(2)]);
  });
});

describe('formatHoursSpan: часы словами для настроек', () => {
  it.each([
    [1, '1 час'], [2, '2 часа'], [4, '4 часа'], [5, '5 часов'], [11, '11 часов'], [12, '12 часов'], [21, '21 час'], [23, '23 часа'],
    [24, '1 день'], [25, '1 день 1 час'], [30, '1 день 6 часов'], [48, '2 дня'], [72, '3 дня'], [96, '4 дня'], [120, '5 дней'],
    [264, '11 дней'], [504, '21 день'], [720, '30 дней'], [26, '1 день 2 часа'], [53, '2 дня 5 часов']
  ])('%d ч → %s', (h, text) => expect(formatHoursSpan(h)).toBe(text));

  it('дробные округляются, строки из поля ввода принимаются', () => {
    expect(formatHoursSpan('24')).toBe('1 день');
    expect(formatHoursSpan(5.4)).toBe('5 часов');
    expect(formatHoursSpan(23.6)).toBe('1 день');
  });

  it('пусто, ноль, отрицательное и мусор → пустая строка', () => {
    for (const v of ['', 0, -3, 'abc', null, undefined, NaN, 0.2]) expect(formatHoursSpan(v)).toBe('');
  });
});

describe('formatWhen', () => {
  it('дата и время; для пустого — «ещё не проверялось»', () => {
    expect(formatWhen(ago(1))).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
    expect(formatWhen(null)).toBe('ещё не проверялось');
    expect(formatWhen('не дата')).toBe('ещё не проверялось');
  });
});

describe('метки на странице', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); });

  it('метка с подсветкой устаревшего; bare — без значка', () => {
    const stale = freshnessOf('login', ago(30), SETTINGS, NOW);
    document.body.innerHTML = freshnessChipHtml(freshnessOf('balance', ago(3), SETTINGS, NOW)) + freshnessChipHtml(stale, { bare: true });
    const chips = [...document.querySelectorAll('.fresh-chip')];
    expect(chips.map(c => c.textContent.trim())).toEqual(['🪙 3 ч назад', '1 дн. назад']);
    expect(chips.map(c => c.classList.contains('is-stale'))).toEqual([false, true]);
  });

  it('refreshFreshnessLabels пересчитывает текст, подсветку и подсказку без перерисовки', () => {
    document.body.innerHTML = freshnessChipHtml(freshnessOf('balance', ago(23), SETTINGS, NOW));
    const chip = document.querySelector('.fresh-chip');
    expect(chip.classList.contains('is-stale')).toBe(false);
    refreshFreshnessLabels(SETTINGS, document, NOW + 2 * 3600e3);                 // прошло 2 часа
    expect(chip.textContent.trim()).toBe('🪙 1 дн. назад');
    expect(chip.classList.contains('is-stale')).toBe(true);
    expect(chip.getAttribute('title')).toContain('устарело');
    refreshFreshnessLabels({ freshness: { balanceHours: 72 } }, document, NOW + 2 * 3600e3);   // порог увеличили в настройках
    expect(chip.classList.contains('is-stale')).toBe(false);
  });

  it('таймер раз в минуту обновляет подписи и останавливается', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    document.body.innerHTML = freshnessChipHtml(freshnessOf('login', new Date(NOW).toISOString(), SETTINGS, NOW));
    const stop = startFreshnessTicker(() => SETTINGS, 60000);
    expect(document.querySelector('[data-fresh-text]').textContent).toBe('только что');
    vi.advanceTimersByTime(5 * 60000);
    expect(document.querySelector('[data-fresh-text]').textContent).toBe('5 мин назад');
    stop();
    vi.advanceTimersByTime(60 * 60000);
    expect(document.querySelector('[data-fresh-text]').textContent).toBe('5 мин назад');
  });
});

describe('карточки персонажей и настройки', () => {
  let state, renderCharacters, bindCharacters;
  const html = readFileSync('index.html', 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    ({ renderCharacters, bindCharacters } = await import('../js/modules/characters/list.js'));
    const now = Date.now();
    const at = (h) => new Date(now - h * 3600e3).toISOString();
    state.settings = { freshness: { balanceHours: 24, loginHours: 24, marathonHours: 24 } };
    state.marathons = [];
    state.parties = [];
    state.characters = [
      { id: 'a', nick: 'Свежий', class: 'Маг', level: 1, isLoggedIn: true, lastCoinUpdate: at(1), lastLoginCheck: at(1), contacts: {}, tags: [], partyIds: [] },
      { id: 'b', nick: 'Давний', class: 'Маг', level: 1, isLoggedIn: false, lastCoinUpdate: at(50), lastLoginCheck: at(1), contacts: {}, tags: [], partyIds: [] },
      { id: 'c', nick: 'Новый', class: 'Маг', level: 1, isLoggedIn: false, lastCoinUpdate: null, lastLoginCheck: null, contacts: {}, tags: [], partyIds: [] }
    ];
    bindCharacters();
  });

  it('на маленьких карточках списка нет информации о проверках', () => {
    renderCharacters();
    expect(document.querySelectorAll('.character-card')).toHaveLength(3);
    expect(document.querySelector('.character-card .fresh-row')).toBeNull();
    expect(document.querySelector('.character-card .fresh-chip')).toBeNull();
    expect(document.querySelector('.character-card [data-fresh-kind]')).toBeNull();
  });

  it('селекторов «Порядок карточек» и «Свежесть данных» нет; порядок прежний: в сети сверху, затем по нику', () => {
    expect(document.getElementById('sort-select')).toBeNull();
    expect(document.getElementById('fresh-filter')).toBeNull();
    renderCharacters();
    expect([...document.querySelectorAll('.character-card h3')].map(h => h.textContent)).toEqual(['Свежий', 'Давний', 'Новый']);
  });

  it('в настройках три порога, подключённые к settings.freshness', () => {
    const inputs = [...document.querySelectorAll('[data-setting^="freshness."]')].map(i => i.dataset.setting);
    expect(inputs).toEqual(['freshness.balanceHours', 'freshness.loginHours', 'freshness.marathonHours']);
    const hints = [...document.querySelectorAll('[data-hours-for]')].map(i => i.dataset.hoursFor);
    expect(hints).toEqual(inputs);
  });

  it('панели «Свежесть данных» и «Состояние парсеров» свёрнуты по умолчанию; в свёрнутом виде видны название и описание', () => {
    const folds = [...document.querySelectorAll('details.panel.fold')];
    const titles = folds.map(d => d.querySelector('summary h3').textContent);
    expect(titles).toEqual(expect.arrayContaining(['⏳ Свежесть данных', '🩺 Состояние парсеров']));
    for (const d of folds) {
      expect(d.hasAttribute('open')).toBe(false);
      expect(d.querySelector('summary p').textContent.length).toBeGreaterThan(20);
    }
    expect(document.getElementById('parser-health-panel').tagName).toBe('DETAILS');
  });

  it('описание панели «Свежесть данных» объясняет, где видны устаревшие значения', () => {
    const d = [...document.querySelectorAll('details.fold')].find(x => x.textContent.includes('Свежесть данных'));
    const text = d.querySelector('summary p').textContent;
    expect(text).toContain('Через сколько времени данные считаются устаревшими');
    expect(text).toContain('Когда что проверено');
  });

  it('подписи «= 1 день», «= 3 дня» у полей порогов', async () => {
    vi.doMock('../js/core/storage.js', () => ({
      persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}), createBackup: vi.fn(), forceRenderAndPersist: vi.fn(),
      isTauri: () => false, getAdapter: () => ({ getDataDir: async () => '/d', listBackups: async () => [] })
    }));
    state.settings = { freshness: { balanceHours: 24, loginHours: 72, marathonHours: 30 } };
    const { renderSettings, bindSettings } = await import('../js/settings/settings.js');
    await renderSettings();
    const hint = (key) => document.querySelector(`[data-hours-for="freshness.${key}"]`).textContent;
    expect([hint('balanceHours'), hint('loginHours'), hint('marathonHours')]).toEqual(['= 1 день', '= 3 дня', '= 1 день 6 часов']);
    bindSettings();
    const input = document.querySelector('[data-setting="freshness.balanceHours"]');
    input.value = '5'; input.dispatchEvent(new Event('input'));
    expect(hint('balanceHours')).toBe('= 5 часов');
    input.value = ''; input.dispatchEvent(new Event('input'));
    expect(hint('balanceHours')).toBe('');
    vi.doUnmock('../js/core/storage.js');
  });

  it('старый state.json без settings.freshness получает значения по умолчанию — все по 24 ч', async () => {
    const { normalizeState } = await import('../js/core/state.js');
    const s = normalizeState({ characters: [], settings: { scripts: { concurrency: 2 } } });
    expect(s.settings.freshness).toEqual({ balanceHours: 24, loginHours: 24, marathonHours: 24 });
  });
});

describe('карточка задания марафона', () => {
  it('строки «Можно получить: до … ДМ за задание» в карточке задания нет', () => {
    expect(readFileSync('js/modules/marathons/page.js', 'utf8')).not.toContain('Можно получить');
  });
});
