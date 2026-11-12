import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const { handlers, invoke, task } = vi.hoisted(() => ({
  handlers: new Map(),
  invoke: vi.fn(),
  task: {
    waitTurn: vi.fn(async () => {}),
    watch: vi.fn(),
    ready: vi.fn(async () => {}),
    log: vi.fn(),
    setStep: vi.fn(),
    finish: vi.fn()
  }
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, handler) => {
    handlers.set(name, handler);
    return () => {};
  }
}));
vi.mock('../js/core/taskLog.js', () => ({ startTask: () => task, errorText: value => value }));
import { state } from '../js/core/state.js';
import { initSiteListeners, loadNewsPage } from '../js/modules/marathons/siteSync.js';
import { parseCheckPageHtml } from '../js/modules/marathons/checkPageParser.js';
const html = readFileSync('tests/fixtures/news-jingxuan.html', 'utf8');
const check = parseCheckPageHtml(readFileSync('tests/fixtures/check-page-jingxuan.html', 'utf8'), { year: 2026 });
beforeEach(async () => {
  window.__TAURI_INTERNALS__ = {};
  await initSiteListeners();
  state.characters = [];
  state.settings.browser = { marathonFollowCheckLinks: true };
  invoke.mockReset();
  invoke.mockImplementation(async command => {
    if (command === 'fetch_marathon_news')
      handlers.get('marathon-news-parsed-global')({
        payload: {
          news: {
            html,
            title: 'Активность «Покоритель Цзинсюаня»',
            url: 'https://pwonline.ru/news.php?article=1',
            publishedAt: '11.11.2026'
          }
        }
      });
    if (command === 'parse_specific_marathon_page')
      handlers.get('single-marathon-parsed-global')({
        payload: { marathon: { ...check, quests: check.quests.map(({ rewards, ...quest }) => quest) } }
      });
  });
});
it('builds a preview from a linked check page when the actual news has no quest table', async () => {
  const result = await loadNewsPage('https://pwonline.ru/news.php?article=1');
  expect(result.error).toBeNull();
  expect(result.marathon.quests).toHaveLength(4);
  expect(result.marathon.sourceUrl).toBe('https://pwonline.ru/supermarathon.php');
  expect(result.marathon.stages[0].startDate).toBe('2026-11-11');
  expect(invoke).toHaveBeenCalledWith('parse_specific_marathon_page', {
    url: 'https://pwonline.ru/supermarathon.php',
    charId: null
  });
});
it('does not follow links when disabled in website settings', async () => {
  state.settings.browser.marathonFollowCheckLinks = false;
  await loadNewsPage('https://pwonline.ru/news.php?article=1');
  expect(invoke.mock.calls.some(([c]) => c === 'parse_specific_marathon_page')).toBe(false);
});
it('accepts a news navigation that landed directly on a check page', async () => {
  invoke.mockImplementation(async command => {
    if (command === 'fetch_marathon_news')
      handlers.get('marathon-news-parsed-global')({
        payload: {
          news: {
            html: readFileSync('tests/fixtures/check-page-jingxuan.html', 'utf8'),
            url: 'https://pwonline.ru/supermarathon.php'
          }
        }
      });
  });
  const result = await loadNewsPage('https://pwonline.ru/news.php?article=1');
  expect(result.marathon.quests).toHaveLength(4);
  expect(result.marathon.sourceUrl).toBe('https://pwonline.ru/supermarathon.php');
});
