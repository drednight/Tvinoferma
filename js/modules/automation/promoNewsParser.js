// Read-only extraction. HTML is parsed in an inert document, never inserted into the application.
const SITE = 'https://pwonline.ru';
export function officialUrl(value, base = SITE + '/news.php') {
  try {
    const u = new URL(value, base);
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      !['pwonline.ru', 'www.pwonline.ru'].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      return null;
    return u;
  } catch {
    return null;
  }
}
export function articleId(value) {
  const u = officialUrl(value);
  const id = u?.searchParams.get('article');
  return u?.pathname === '/news.php' && /^\d{1,12}$/.test(id || '') ? id : null;
}
export function pinCode(value, base) {
  const u = officialUrl(value, base);
  if (!u) return null;
  try {
    const m = /^\/pin\/([A-Za-z0-9_-]{4,40})\/?$/.exec(decodeURIComponent(u.pathname));
    return m?.[1].toUpperCase() || null;
  } catch {
    return null;
  }
}
function documentOf(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw Error('news_size');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,iframe,nav,header,footer').forEach(n => n.remove());
  if (
    /проверка безопасности|checking your browser|just a moment|captcha/i.test(
      doc.title + ' ' + doc.body.textContent.slice(0, 300)
    )
  )
    throw Error('news_challenge');
  return doc;
}
export function newsArticles(html) {
  const doc = documentOf(html);
  const ids = [
    ...new Set([...doc.querySelectorAll('a[href]')].map(a => articleId(a.getAttribute('href'))).filter(Boolean))
  ];
  if (!ids.length) throw Error('news_markup');
  return ids;
}
export function expiryHint(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const match =
    /(?:срок действия|промокод|пин[- ]?код|активир\S*)[^.!?]{0,100}?(?:до|по)\s+(\d{1,2})[.\s/-]+(\d{1,2}|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[.\s/-]*(\d{4})?(?:[^.!?]{0,45})/i.exec(
      clean
    );
  if (!match) return { expiresText: null, expiresOn: null };
  const month = /^\d+$/.test(match[2])
    ? Number(match[2])
    : [
        'января',
        'февраля',
        'марта',
        'апреля',
        'мая',
        'июня',
        'июля',
        'августа',
        'сентября',
        'октября',
        'ноября',
        'декабря'
      ].indexOf(match[2].toLowerCase()) + 1;
  const day = Number(match[1]);
  let expiresOn = null;
  if (match[3]) {
    const iso = `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(iso + 'T00:00:00Z');
    if (Number.isFinite(+date) && date.toISOString().startsWith(iso)) expiresOn = iso;
  }
  return { expiresText: match[0].slice(0, 220), expiresOn };
}
export function articleCodes(html, id) {
  if (!/^\d{1,12}$/.test(String(id))) throw Error('news_request_invalid');
  const doc = documentOf(html);
  const sourceUrl = `${SITE}/news.php?article=${id}`;
  const content =
    doc.querySelector('.js-mediator-article,#content_body,article,.news-text,.news_text,.news-content,#news-content') ||
    doc.body;
  const title = (doc.querySelector('h1')?.textContent || doc.title || 'Новость Perfect World').trim().slice(0, 200);
  if (content === doc.body && !doc.querySelector('h1')) throw Error('news_markup');
  const found = new Map();
  for (const a of content.querySelectorAll('a[href]')) {
    const code = pinCode(a.getAttribute('href'), sourceUrl);
    if (!code) continue;
    const paragraph = a.closest('p,li') || a.parentElement;
    const text = paragraph?.textContent || '';
    const paragraphCodes = new Set(
      [...paragraph.querySelectorAll('a[href]')]
        .map(link => pinCode(link.getAttribute('href'), sourceUrl))
        .filter(Boolean)
    );
    const hints =
      paragraphCodes.size > 1
        ? { expiresText: 'Несколько кодов и условий — проверьте новость', expiresOn: null }
        : expiryHint(text.length <= 900 ? text : '');
    const old = found.get(code);
    found.set(code, {
      code,
      title,
      sourceUrl,
      pinUrl: `${SITE}/pin/${code}`,
      ...hints,
      ...(old && old.expiresText !== hints.expiresText
        ? { expiresText: 'В новости несколько условий — проверьте источник', expiresOn: null }
        : {})
    });
  }
  return [...found.values()];
}
