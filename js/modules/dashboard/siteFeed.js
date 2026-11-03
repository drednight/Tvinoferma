// Shared public feed: the same allowlisted reader as promo discovery, no credentials.
import { createPublicNewsReader } from '../automation/publicNewsReader.js';
import { articleId } from '../automation/promoNewsParser.js';
const KEY = 'tf_today_news_v1';
let current = { articles: [], updatedAt: null, status: 'idle' },
  flight = null;
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || 'null');
  if (saved?.version === 1 && Array.isArray(saved.articles))
    current = {
      articles: saved.articles
        .filter(a => articleId(a.url) && typeof a.title === 'string')
        .slice(0, 3)
        .map(a => ({
          id: articleId(a.url),
          url: `https://pwonline.ru/news.php?article=${articleId(a.url)}`,
          title: a.title.slice(0, 240)
        })),
      updatedAt:
        typeof saved.updatedAt === 'string' && Number.isFinite(Date.parse(saved.updatedAt)) ? saved.updatedAt : null,
      status: 'cached'
    };
} catch {}
export function parseLatestNews(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw Error('news_size');
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,img,object,embed,link,meta,base').forEach(e => e.remove());
  if (/captcha|checking your browser|проверка безопасности/i.test(template.content.textContent.slice(0, 500)))
    throw Error('news_challenge');
  const rows = new Map();
  for (const a of template.content.querySelectorAll('a[href]')) {
    const id = articleId(a.getAttribute('href'));
    const title = a.textContent.trim().replace(/\s+/g, ' ').slice(0, 240);
    if (id && title.length > 3 && !rows.has(id))
      rows.set(id, { title, url: `https://pwonline.ru/news.php?article=${id}`, id });
  }
  const articles = [...rows.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 3);
  if (!articles.length) throw Error('news_markup');
  return articles;
}
export const siteFeedSnapshot = () => structuredClone(current);
function notify() {
  globalThis.window?.dispatchEvent(new Event('tf-site-feed-changed'));
}
export function refreshSiteFeed({ invokeFn, now = () => new Date() } = {}) {
  if (flight) return flight;
  current = { ...current, status: 'checking' };
  notify();
  flight = (async () => {
    try {
      const read = createPublicNewsReader(invokeFn);
      const response = await read({ page: 1, article: null });
      if (response?.status !== 200) throw Error('news_http');
      const articles = parseLatestNews(response.html);
      current = { articles, updatedAt: now().toISOString(), status: 'ready' };
      try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify({ version: 1, ...current }));
      } catch {}
      return siteFeedSnapshot();
    } catch {
      current = { ...current, status: 'unavailable' };
      return siteFeedSnapshot();
    } finally {
      flight = null;
      notify();
    }
  })();
  return flight;
}
