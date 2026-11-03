import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => localStorage.removeItem('tf_today_news_v1'));

it('sorts cached official news before limiting to the three newest', async () => {
  vi.resetModules();
  localStorage.setItem(
    'tf_today_news_v1',
    JSON.stringify({
      version: 1,
      articles: [2, 1, 4, 3].map(id => ({ title: `Новость ${id}`, url: `https://pwonline.ru/news.php?article=${id}` }))
    })
  );
  const { siteFeedSnapshot } = await import('../js/modules/dashboard/siteFeed.js');
  expect(siteFeedSnapshot().articles.map(a => a.id)).toEqual(['4', '3', '2']);
});

it('keeps cross-PC UI hidden and inert in the main application', () => {
  const html = readFileSync('index.html', 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const panel = doc.getElementById('cloud-registration-panel');
  expect(panel.hidden).toBe(true);
  expect(panel.hasAttribute('inert')).toBe(true);
});
