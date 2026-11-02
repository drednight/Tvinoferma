import { it, expect } from 'vitest';
import { runPageScript } from './helpers/pageScript.js';
it('returns public article links and stripped inert HTML; never includes resource/script markup', () => {
  window.__TF_PUBLIC_PROMO_NEWS = { article: false, url: window.location.href.split('#')[0] };
  const r = runPageScript(
    'promo_news_public.js',
    '<h1>Новости</h1><a href="news.php?article=1">Новость</a><script>window.BAD=true</script><img src="https://other.test/a">',
    'TF_PUBLIC_NEWS_V1_'
  );
  expect(r.error).toBe(null);
  expect(r.data.html).toContain('article=1');
  expect(r.data.html).not.toMatch(/<script|<img/);
  expect(window.BAD).toBeUndefined();
});
it('reports denial, challenge and missing article markup instead of code-free success', () => {
  window.__TF_PUBLIC_PROMO_NEWS = { article: true, url: window.location.href.split('#')[0] };
  for (const [html, error] of [
    ['<title>403 Forbidden</title>', 'news_http_403'],
    ['<title>Just a moment</title>', 'news_challenge'],
    ['<h1>Недоступно</h1>', 'news_markup']
  ])
    expect(runPageScript('promo_news_public.js', html, 'TF_PUBLIC_NEWS_V1_').error).toBe(error);
});

it('never reads the previous document or a stale article while browser navigation is still pending', () => {
  window.__TF_PUBLIC_PROMO_NEWS = {
    article: false,
    url: new URL('/news.php?archive=news&type=last&page=2', window.location.href).href
  };
  expect(
    runPageScript('promo_news_public.js', '<a href="news.php?article=OLD">Old index</a>', 'TF_PUBLIC_NEWS_V1_')
  ).toEqual({ data: null, error: 'pending' });
});
it('waits when the pathname matches but the previous article or index query is still visible', () => {
  const original = window.location.href;
  try {
    for (const [actual, expected] of [
      ['article=111', 'article=222'],
      ['archive=news&type=last&page=1', 'archive=news&type=last&page=2']
    ]) {
      history.replaceState(null, '', `/news.php?${actual}`);
      window.__TF_PUBLIC_PROMO_NEWS = {
        article: actual.startsWith('article'),
        url: new URL(`/news.php?${expected}`, original).href
      };
      expect(
        runPageScript(
          'promo_news_public.js',
          '<article><a href="/pin/OLD2026">Old page</a></article>',
          'TF_PUBLIC_NEWS_V1_'
        )
      ).toEqual({ data: null, error: 'pending' });
    }
  } finally {
    history.replaceState(null, '', original);
  }
});
it('reads actual article content without visiting its PIN links', () => {
  window.__TF_PUBLIC_PROMO_NEWS = { article: true, url: window.location.href.split('#')[0] };
  const result = runPageScript(
    'promo_news_public.js',
    '<article><h1>Новость</h1><p>До 10.11.2026 <a href="/pin/NEW2026">Получить подарок</a></p></article>',
    'TF_PUBLIC_NEWS_V1_'
  );
  expect(result.error).toBeNull();
  expect(result.data.html).toContain('/pin/NEW2026');
  expect(result.data.html).toContain('10.11.2026');
});
