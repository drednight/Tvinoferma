import { describe, it, expect } from 'vitest';
import { fixture, runPageScript } from './helpers/pageScript.js';
import { parseNewsList, filterNews, isMarathonTitle, mergeNewsPages, newsListUrl, NEWS_LIST_PAGES } from '../js/modules/marathons/newsList.js';

// Фикстуры — реальные страницы архива событий pwonline.ru (стр. 1 и 2), перекодированные в UTF-8.
const p1 = fixture('news_list_p1.html');
const p2 = fixture('news_list_p2.html');
// То, что реально приходит из приложения: скрипт страницы удаляет атрибуты class/style
const stripped = (h) => h.replace(/\s(class|style|align|width|valign)="[^"]*"/g, '');

describe('parseNewsList', () => {
  it('разбирает 15 новостей на странице', () => {
    const a = parseNewsList(p1);
    expect(a).toHaveLength(15);
    expect(a[0]).toMatchObject({ id: '9124', title: 'День середины осени в Идеальном Мире', date: '24.09.2026', isoDate: '2026-09-24', url: 'https://pwonline.ru/news.php?article=9124' });
  });
  it('работает с HTML без классов (как отдаёт приложение)', () => {
    expect(parseNewsList(stripped(p2))).toEqual(parseNewsList(p2));
    expect(parseNewsList(stripped(p2))[0]).toMatchObject({ id: '9046', title: 'Летний марафон', date: '29.05.2026' });
  });
  it('пустой и мусорный ввод не падает', () => {
    expect(parseNewsList('')).toEqual([]);
    expect(parseNewsList(null)).toEqual([]);
    expect(parseNewsList('<p><a href="/news.php?article=1">вне таблицы</a></p>')).toEqual([]);
  });
});

describe('поиск марафонов', () => {
  it('находит новости про марафоны на страницах 1–2', () => {
    const found = filterNews(mergeNewsPages([parseNewsList(p1), parseNewsList(p2)]));
    expect(found.map(x => x.title)).toEqual([
      'Марафон активности на «Капелле»', 'Летний марафон', 'Весенний марафон', 'Обновление гильдейских марафонов «Капеллы»'
    ]);
  });
  it('«показать все» не фильтрует, новые сверху', () => {
    const all = filterNews(mergeNewsPages([parseNewsList(p2), parseNewsList(p1)]), { all: true });
    expect(all).toHaveLength(30);
    expect(all[0].id).toBe('9124');
  });
  it('регистр не важен, посторонние названия не проходят', () => {
    expect(isMarathonTitle('ЛЕТНИЙ МАРАФОН')).toBe(true);
    expect(isMarathonTitle('Итоги сезона Арены Авроры')).toBe(false);
  });
  it('повторы между страницами убираются', () => {
    const a = parseNewsList(p1);
    expect(mergeNewsPages([a, a.slice(0, 3)])).toHaveLength(15);
  });
});

describe('адрес страницы', () => {
  it('только первые 3 страницы архива событий', () => {
    expect(NEWS_LIST_PAGES).toBe(3);
    expect(newsListUrl(2)).toBe('https://pwonline.ru/news.php?archive=news&type=event&page=2');
    expect(newsListUrl(0)).toContain('page=1');
  });
});

describe('через настоящий скрипт страницы (marathon_news.js, как в приложении)', () => {
  it('отдаёт HTML списка, из которого находится «Летний марафон»', () => {
    const { data, error } = runPageScript('marathon_news.js', p2, 'TF_NEWS_V1_');
    expect(error).toBeNull();
    const items = parseNewsList(data.html);
    expect(items).toHaveLength(15);
    expect(filterNews(items).map(x => x.id)).toEqual(['9046', '9019', '9001']);
  });
});
