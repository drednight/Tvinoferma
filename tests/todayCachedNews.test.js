import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => localStorage.removeItem('tf_today_news_v2'));

it('preserves the editorial order of cached official news', async () => {
  vi.resetModules();
  localStorage.setItem(
    'tf_today_news_v2',
    JSON.stringify({
      version: 2,
      articles: [9151, 9154, 9152, 9150].map(id => ({
        title: `Новость ${id}`,
        url: `https://pwonline.ru/news.php?article=${id}`
      }))
    })
  );
  const { siteFeedSnapshot } = await import('../js/modules/dashboard/siteFeed.js');
  expect(siteFeedSnapshot().articles.map(a => a.id)).toEqual(['9151', '9154', '9152']);
});

it('keeps cross-PC UI hidden and inert in the main application', () => {
  const html = readFileSync('index.html', 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const panel = doc.getElementById('cloud-registration-panel');
  expect(panel.hidden).toBe(true);
  expect(panel.hasAttribute('inert')).toBe(true);
});

it('does not reuse old numerically sorted news caches', async () => {
  localStorage.removeItem('tf_today_news_v2');
  localStorage.setItem(
    'tf_today_news_v1',
    JSON.stringify({
      version: 1,
      articles: [{ title: 'Old sorted', url: 'https://pwonline.ru/news.php?article=9154' }]
    })
  );
  vi.resetModules();
  const { siteFeedSnapshot } = await import('../js/modules/dashboard/siteFeed.js');
  expect(siteFeedSnapshot().articles).toEqual([]);
  localStorage.removeItem('tf_today_news_v1');
});
