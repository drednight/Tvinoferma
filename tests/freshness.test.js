import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  formatAge, thresholdHours, freshnessOf, marathonSyncAt, charFreshness, isStale, staleness,
  freshnessRowHtml, freshnessChipHtml, refreshFreshnessLabels, startFreshnessTicker
} from '../js/core/freshness.js';
import { filterCharacters, sortCharacters } from '../js/modules/characters/filters.js';

// Метки свежести данных (issue #16): «Обновлено N ч назад», подсветка устаревших, фильтр и сортировка.

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn(), showModal: vi.fn(), closeModal: vi.fn(), confirmDialog: vi.fn(() => true) }));
vi.mock('../js/modules/characters/index.js', () => ({ openCharacterProfile: vi.fn(), openCharacterForm: vi.fn() }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAllBalances: vi.fn(), refreshAllLoginStatuses: vi.fn(), openSyncHelper: vi.fn() }));

const NOW = new Date('2026-06-10T12:00:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
const SETTINGS = { freshness: { balanceHours: 24, loginHours: 12, marathonHours: 24 } };

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
    expect(thresholdHours({ freshness: { loginHours: 'abc' } }, 'login')).toBe(12);
    expect(thresholdHours(undefined, 'marathon')).toBe(24);
  });

  it('свежие данные, устаревшие, никогда не обновлявшиеся', () => {
    expect(freshnessOf('balance', ago(3), SETTINGS, NOW)).toMatchObject({ stale: false, never: false, text: '3 ч назад' });
    expect(freshnessOf('balance', ago(24), SETTINGS, NOW).stale).toBe(false);          // ровно на пороге — ещё свежие
    expect(freshnessOf('balance', ago(25), SETTINGS, NOW)).toMatchObject({ stale: true, text: '1 дн. назад' });
    expect(freshnessOf('login', ago(13), SETTINGS, NOW).stale).toBe(true);              // у входа порог меньше
    const never = freshnessOf('balance', null, SETTINGS, NOW);
    expect(never).toMatchObject({ stale: true, never: true, text: 'нет данных' });
    expect(freshnessOf('balance', 'не дата', SETTINGS, NOW).never).toBe(true);
  });

  it('в подсказке — точное время и порог', () => {
    expect(freshnessOf('balance', ago(30), SETTINGS, NOW).title).toMatch(/Баланс: обновлено \d{2}\.\d{2}\.\d{4}.*устарело \(порог 24 ч\)/);
  });
});

describe('marathonSyncAt: когда прогресс персонажа последний раз сверялся с сайтом', () => {
  const marathon = (id, over = {}) => ({
    id, kind: 'single', status: 'active', participantIds: ['c'], source: { url: 'https://pwonline.ru/supermarathon.php' },
    progress: { c: { t1: { syncedAt: ago(5) }, t2: { syncedAt: ago(2) } } }, ...over
  });

  it('нет идущих марафонов с сайтом → undefined (метку не показываем)', () => {
    expect(marathonSyncAt('c', [])).toBeUndefined();
    expect(marathonSyncAt('c', [marathon('a', { status: 'completed' })])).toBeUndefined();
    expect(marathonSyncAt('c', [marathon('a', { source: { url: null } })])).toBeUndefined();   // ручной марафон сверять не с чем
    expect(marathonSyncAt('c', [marathon('a', { participantIds: ['x'] })])).toBeUndefined();
    expect(marathonSyncAt('c', [marathon('s', { kind: 'series' })])).toBeUndefined();
  });

  it('последняя сверка по заданиям марафона', () => {
    expect(marathonSyncAt('c', [marathon('a')])).toBe(ago(2));
  });

  it('несколько марафонов: берётся самая старая сверка', () => {
    const b = marathon('b', { progress: { c: { t1: { syncedAt: ago(30) } } } });
    expect(marathonSyncAt('c', [marathon('a'), b])).toBe(ago(30));
  });

  it('марафон ещё не сверялся → null (считается устаревшим)', () => {
    expect(marathonSyncAt('c', [marathon('a'), marathon('b', { progress: { c: { t1: { syncedAt: null } } } })])).toBeNull();
    expect(marathonSyncAt('c', [marathon('a', { progress: {} })])).toBeNull();
  });

  it('адрес страницы можно взять у серии', () => {
    const series = { id: 's', kind: 'series', source: { url: 'https://pwonline.ru/supermarathon2.php' } };
    const child = marathon('a', { source: { url: null }, seriesId: 's' });
    expect(marathonSyncAt('c', [series, child])).toBe(ago(2));
  });
});

describe('charFreshness, isStale, staleness', () => {
  const char = (over = {}) => ({ id: 'c', nick: 'A', lastCoinUpdate: ago(1), lastLoginCheck: ago(1), ...over });
  const ctx = (marathons = []) => ({ settings: SETTINGS, marathons, now: NOW });

  it('без марафонов — две метки: баланс и вход', () => {
    expect(charFreshness(char(), ctx()).map(i => i.kind)).toEqual(['balance', 'login']);
    expect(isStale(char(), ctx())).toBe(false);
  });

  it('метка марафона появляется, когда есть идущие марафоны с сайтом', () => {
    const m = { id: 'm', status: 'active', participantIds: ['c'], source: { url: 'u' }, progress: { c: { t: { syncedAt: ago(40) } } } };
    const items = charFreshness(char(), ctx([m]));
    expect(items.map(i => i.kind)).toEqual(['balance', 'login', 'marathon']);
    expect(items[2].stale).toBe(true);
    expect(isStale(char(), ctx([m]))).toBe(true);
  });

  it('устарел один вид — персонаж «давно не обновлялся»; ни разу не обновлялись — самый давний', () => {
    expect(isStale(char({ lastLoginCheck: ago(20) }), ctx())).toBe(true);
    expect(staleness(char({ lastLoginCheck: ago(20) }), ctx())).toBe(20 * 3600e3);
    expect(staleness(char({ lastCoinUpdate: null }), ctx())).toBe(Infinity);
  });
});

describe('фильтр и сортировка по свежести', () => {
  const mk = (nick, balanceH, loginH, over = {}) => ({
    id: nick, nick, class: '', partyIds: [], tags: [], isLoggedIn: false,
    lastCoinUpdate: balanceH === null ? null : ago(balanceH), lastLoginCheck: loginH === null ? null : ago(loginH), ...over
  });
  const chars = [mk('Бета', 2, 2, { isLoggedIn: true }), mk('Альфа', 30, 1), mk('Гамма', null, null), mk('Дельта', 5, 40, { isLoggedIn: true })];
  const freshness = { settings: SETTINGS, marathons: [], now: NOW };
  const nicks = (list) => list.map(c => c.nick);

  it('«Давно не обновлялись» / «Свежие» / без фильтра', () => {
    expect(nicks(filterCharacters(chars, { fresh: 'stale', freshness }))).toEqual(['Альфа', 'Гамма', 'Дельта']);
    expect(nicks(filterCharacters(chars, { fresh: 'fresh', freshness }))).toEqual(['Бета']);
    expect(filterCharacters(chars, { fresh: '', freshness })).toHaveLength(4);
  });

  it('фильтр свежести сочетается с остальными фильтрами', () => {
    expect(nicks(filterCharacters(chars, { fresh: 'stale', auth: 'online', freshness }))).toEqual(['Дельта']);
  });

  it('сортировка: по умолчанию (в сети, затем ник), по нику, давно не обновлялись сверху', () => {
    expect(nicks(sortCharacters(chars, 'default', freshness))).toEqual(['Бета', 'Дельта', 'Альфа', 'Гамма']);
    expect(nicks(sortCharacters(chars, 'nick', freshness))).toEqual(['Альфа', 'Бета', 'Гамма', 'Дельта']);
    expect(nicks(sortCharacters(chars, 'stale', freshness))).toEqual(['Гамма', 'Дельта', 'Альфа', 'Бета']);
  });

  it('сортировка не меняет исходный массив', () => {
    const copy = [...chars];
    sortCharacters(chars, 'stale', freshness);
    expect(chars).toEqual(copy);
  });
});

describe('метки на странице', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); });

  it('строка «Обновлено: …» с подсветкой устаревших', () => {
    const items = [freshnessOf('balance', ago(3), SETTINGS, NOW), freshnessOf('login', ago(20), SETTINGS, NOW), freshnessOf('marathon', null, SETTINGS, NOW)];
    document.body.innerHTML = freshnessRowHtml(items);
    const chips = [...document.querySelectorAll('.fresh-chip')];
    expect(chips.map(c => c.textContent.trim())).toEqual(['🪙 3 ч назад', '🔐 20 ч назад', '🏆 нет данных']);
    expect(chips.map(c => c.classList.contains('is-stale'))).toEqual([false, true, true]);
    expect(document.querySelector('.fresh-row').textContent).toContain('Обновлено:');
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
  const cards = () => [...document.querySelectorAll('.character-card h3')].map(h => h.textContent);

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    ({ state } = await import('../js/core/state.js'));
    ({ renderCharacters, bindCharacters } = await import('../js/modules/characters/list.js'));
    const now = Date.now();
    const at = (h) => new Date(now - h * 3600e3).toISOString();
    state.settings = { freshness: { balanceHours: 24, loginHours: 12, marathonHours: 24 } };
    state.marathons = [];
    state.parties = [];
    state.characters = [
      { id: 'a', nick: 'Свежий', class: 'Маг', level: 1, isLoggedIn: true, lastCoinUpdate: at(1), lastLoginCheck: at(1), contacts: {}, tags: [], partyIds: [] },
      { id: 'b', nick: 'Давний', class: 'Маг', level: 1, isLoggedIn: false, lastCoinUpdate: at(50), lastLoginCheck: at(1), contacts: {}, tags: [], partyIds: [] },
      { id: 'c', nick: 'Новый', class: 'Маг', level: 1, isLoggedIn: false, lastCoinUpdate: null, lastLoginCheck: null, contacts: {}, tags: [], partyIds: [] }
    ];
    bindCharacters();
  });

  it('на карточке — строка «Обновлено», устаревшее подсвечено', () => {
    const card = (nick) => [...document.querySelectorAll('.character-card')].find(c => c.querySelector('h3').textContent === nick);
    expect(card('Свежий').querySelector('.fresh-row').textContent).toContain('1 ч назад');
    expect(card('Свежий').querySelectorAll('.fresh-chip.is-stale')).toHaveLength(0);
    expect(card('Давний').querySelector('[data-fresh-kind="balance"]').classList.contains('is-stale')).toBe(true);
    expect(card('Новый').querySelector('[data-fresh-kind="balance"]').textContent).toContain('нет данных');
  });

  it('фильтр «Давно не обновлялись» и сортировка в панели над списком', () => {
    const fresh = document.getElementById('fresh-filter');
    fresh.value = 'stale'; fresh.dispatchEvent(new Event('change'));
    expect(cards()).toEqual(['Давний', 'Новый']);
    fresh.value = 'fresh'; fresh.dispatchEvent(new Event('change'));
    expect(cards()).toEqual(['Свежий']);
    fresh.value = ''; fresh.dispatchEvent(new Event('change'));
    const sort = document.getElementById('sort-select');
    sort.value = 'stale'; sort.dispatchEvent(new Event('change'));
    expect(cards()).toEqual(['Новый', 'Давний', 'Свежий']);
    sort.value = 'nick'; sort.dispatchEvent(new Event('change'));
    expect(cards()).toEqual(['Давний', 'Новый', 'Свежий']);
  });

  it('порог из настроек влияет на подсветку после перерисовки', () => {
    state.settings.freshness.balanceHours = 100;
    renderCharacters();
    const stale = document.querySelectorAll('.character-card [data-fresh-kind="balance"].is-stale');
    expect([...stale].map(el => el.closest('.character-card').querySelector('h3').textContent)).toEqual(['Новый']);
  });

  it('в настройках есть три порога, подключённые к settings.freshness', () => {
    const inputs = [...document.querySelectorAll('[data-setting^="freshness."]')].map(i => i.dataset.setting);
    expect(inputs).toEqual(['freshness.balanceHours', 'freshness.loginHours', 'freshness.marathonHours']);
  });

  it('старый state.json без settings.freshness получает значения по умолчанию', async () => {
    const { normalizeState } = await import('../js/core/state.js');
    const s = normalizeState({ characters: [], settings: { scripts: { concurrency: 2 } } });
    expect(s.settings.freshness).toEqual({ balanceHours: 24, loginHours: 12, marathonHours: 24 });
  });
});
