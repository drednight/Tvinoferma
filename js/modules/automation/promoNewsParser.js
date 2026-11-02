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
  // Template contents stay inert, including resource elements: no images/iframes
  // are fetched while parsing HTTP HTML from the news site.
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content
    .querySelectorAll(
      'script,style,noscript,iframe,nav,header,footer,img,svg,video,audio,source,object,embed,link,meta,base'
    )
    .forEach(n => n.remove());
  const doc = document.implementation.createHTMLDocument('');
  doc.title = template.content.querySelector('title')?.textContent || '';
  doc.body.append(template.content);
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
    /(?:срок действия|промокод|пин[- ]?код|активир\S*)[^!?]{0,180}?(?:до|по)\s+(?:(\d{1,2}:\d{2})\s*(мск|по Москве)?\s*)?(\d{1,2})[.\s/-]+(\d{1,2}|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[.\s/-]*(\d{4})?(?:\s*года)?(?:\s*включительно)?(?:\s*[,;]?\s*(?:до|в)?\s*\d{1,2}:\d{2}\s*(?:мск|по Москве)?)?/i.exec(
      clean
    );
  if (!match) return { expiresText: null, expiresOn: null };
  const month = /^\d+$/.test(match[4])
    ? Number(match[4])
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
      ].indexOf(match[4].toLowerCase()) + 1;
  const day = Number(match[3]);
  let expiresOn = null;
  if (match[5]) {
    const iso = `${match[5]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
    const paragraphCodes = new Set(
      [...paragraph.querySelectorAll('a[href]')]
        .map(link => pinCode(link.getAttribute('href'), sourceUrl))
        .filter(Boolean)
    );
    const allCodes = new Set(
      [...content.querySelectorAll('a[href]')]
        .map(link => pinCode(link.getAttribute('href'), sourceUrl))
        .filter(Boolean)
    );
    const scope = allCodes.size === 1 ? content : paragraph;
    const hints =
      paragraphCodes.size > 1
        ? { expiresText: 'Несколько кодов и условий — проверьте новость', expiresOn: null }
        : expiryHint((scope?.textContent || '').replace(/\s+/g, ' ').slice(0, 50000));
    const serverMatch =
      /(?:перевести|переводить|передать)[^.!?]{0,100}?только\s+на\s+(?:сервер\s*)?[«"]([^»"]{1,60})[»"]/i.exec(
        scope?.textContent || ''
      );
    const rewards = [];
    for (const list of scope.querySelectorAll('ul,ol')) {
      let previous = list.previousElementSibling;
      for (let n = 0; n < 3 && previous && !previous.textContent.trim(); n++)
        previous = previous.previousElementSibling;
      const before = previous?.textContent || '';
      if (
        /(?:состав|содержим|внутри|вы получите|вам достанутся|в награду|код (?:содержит|включает)|следующие предметы)/i.test(
          before
        )
      ) {
        rewards.push(
          ...[...list.querySelectorAll(':scope > li')]
            .map(n => {
              const copy = n.cloneNode(true);
              // На сайте описание находится во всплывающей карточке, не в названии награды.
              copy.querySelectorAll('.img_item_small_cont, .item-tooltip, [role="tooltip"]').forEach(el => el.remove());
              return copy.textContent
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/^[•–—-]\s*/, '')
                .slice(0, 300);
            })
            .filter(Boolean)
        );
      }
    }
    const old = found.get(code);
    found.set(code, {
      code,
      title,
      sourceUrl,
      pinUrl: `${SITE}/pin/${code}`,
      ...hints,
      serverRestriction: serverMatch ? serverMatch[1].trim() : null,
      rewards: rewards.slice(0, 60),
      ...(old && old.expiresText !== hints.expiresText
        ? { expiresText: 'В новости несколько условий — проверьте источник', expiresOn: null }
        : {})
    });
  }
  return [...found.values()];
}
