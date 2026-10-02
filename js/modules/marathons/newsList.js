// js/modules/marathons/newsList.js
// Список новостей-событий pwonline.ru (news.php?archive=news&type=event&page=N):
// чистые функции разбора и фильтра, чтобы найти новость о марафоне и не вставлять ссылку руками.

export const NEWS_ORIGIN = 'https://pwonline.ru';
/** Сколько страниц архива просматриваем (свежие марафоны всегда на первых страницах). */
export const NEWS_LIST_PAGES = 3;

export const newsListUrl = (page = 1) =>
  `${NEWS_ORIGIN}/news.php?archive=news&type=event&page=${Math.max(1, Number(page) || 1)}`;

const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/** «24.09.2026» → «2026-09-24» (для сортировки); иначе ''. */
const toIso = (ddmmyyyy) => {
  const m = String(ddmmyyyy || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

/**
 * Разбирает HTML страницы списка (целиком или только #content_body — приложение получает
 * очищенный HTML без классов, поэтому опираемся на ссылки article=N и дату в той же строке).
 * → [{ id, url, title, date: '24.09.2026', isoDate: '2026-09-24' }] в порядке страницы, без повторов.
 */
export function parseNewsList(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const out = [], seen = new Set();
  doc.querySelectorAll('a[href*="article="]').forEach(a => {
    const id = (a.getAttribute('href').match(/article=(\d+)/) || [])[1];
    const title = norm(a.textContent);
    if (!id || !title || seen.has(id)) return;
    const row = a.closest('tr');
    if (!row) return;                       // ссылки вне таблицы списка (меню, «читайте также»)
    const date = (norm(row.textContent).match(/\d{2}\.\d{2}\.\d{4}/) || [''])[0];
    seen.add(id);
    out.push({ id, url: `${NEWS_ORIGIN}/news.php?article=${id}`, title, date, isoDate: toIso(date) });
  });
  return out;
}

/** Название похоже на новость о марафоне (в т.ч. «Летний марафон», «Весенний марафон»). */
export const isMarathonTitle = (title) => /марафон/i.test(String(title || ''));

/** Фильтр списка: по умолчанию только марафоны; новые сверху. */
export function filterNews(items, { all = false } = {}) {
  const list = all ? items.slice() : items.filter(x => isMarathonTitle(x.title));
  return list.sort((a, b) => (b.isoDate || '').localeCompare(a.isoDate || '') || Number(b.id) - Number(a.id));
}

/** Объединяет страницы, убирая повторы (новость могла сдвинуться между запросами). */
export function mergeNewsPages(pages) {
  const seen = new Set();
  return pages.flat().filter(x => !seen.has(x.id) && seen.add(x.id));
}
