// Скрипты разбора страниц pwonline.ru (src-tauri/src/scripts/*.js) на сохранённых страницах (issue #9).
// Фикстуры — обезличенные страницы из tests/fixtures (правила: docs/FIXTURES.md).
// Для каждого парсера: «хорошая» страница → ожидаемый JSON; «вёрстка изменилась» → ошибка, а не тихий ноль.
import { describe, it, expect } from 'vitest';
import { fixture, runPageScript, runOnFixture, editDom } from './helpers/pageScript.js';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';

const balance = (file, edit) => runOnFixture('balance.js', 'TF_BAL_V5_', file, edit);
const auth = (file, edit) => runOnFixture('check_auth.js', 'TF_AUTH_V2_', file, edit);
const titles = (file, edit) => runOnFixture('marathon_titles.js', 'TF_TITLE_V4_', file, edit);
const progress = (file, edit) => runOnFixture('marathon_progress.js', 'TF_MARATHON_DATA_', file, edit);
const news = (file, edit) => runOnFixture('marathon_news.js', 'TF_NEWS_V1_', file, edit);
const detail = (file, edit) => runOnFixture('marathon_detail.js', 'TF_DETAIL_V4_', file, edit);

// «Проверка безопасности» (anti-bot): синтетическая страница, на реальной сохранить её не удалось
const CHALLENGE_TITLE = '<html><head><title>Проверка безопасности</title></head><body><p>Проверяем браузер…</p></body></html>';
const CHALLENGE_SCRIPT = '<html><head><title>Perfect World</title></head><body><script src="/bp_chl/challenge.js"></script></body></html>';
const EMPTY_PAGE = '<html><head><title>Perfect World</title></head><body><div id="content_body"></div></body></html>';

describe('баланс (chests2.php, balance.js)', () => {
  it('магазин подарков → баланс из блока «Ваш текущий баланс»', () => {
    expect(balance('site-chests2.html')).toEqual({ data: 464, error: null });
  });

  it('дробный баланс и пробелы тысяч', () => {
    const withValue = (v) => (h) => h.replace(/<strong>464<\/strong>/, `<strong>${v}</strong>`);
    expect(balance('site-chests2.html', withValue('28,5')).data).toBe(28.5);
    expect(balance('site-chests2.html', withValue('1&nbsp;285,5')).data).toBe(1285.5);
  });

  it('реальный нулевой баланс залогиненного игрока — это 0, а не «сессия истекла»', () => {
    const r = balance('site-chests2.html', (h) => h.replace(/<strong>464<\/strong>/, '<strong>0</strong>'));
    expect(r).toEqual({ data: 0, error: null });
  });

  it('ноль без признаков входа (ссылки на кабинет с ником) → сессия истекла', () => {
    const r = balance('site-chests2.html', (h) => editDom(h, (d) => {
      d.querySelector('.points_info strong').textContent = '0';
      d.querySelectorAll('a[href="/usercp.php"]').forEach((a) => a.remove());
    }));
    expect(r).toEqual({ data: null, error: 'zero_no_user_session_expired' });
  });

  it('страница «Предупреждение» (не вошли) → not_logged_in', () => {
    expect(balance('site-warning.html')).toEqual({ data: null, error: 'not_logged_in' });
  });

  it('вёрстка изменилась: нет блока баланса / значения / число не читается → ошибка, не ноль', () => {
    expect(balance('site-chests2.html', (h) => editDom(h, (d) => d.querySelector('.points_info').remove()))).toEqual({ data: null, error: 'container_missing' });
    expect(balance('site-chests2.html', (h) => editDom(h, (d) => { d.querySelector('.points_info strong').outerHTML = '<span>464</span>'; }))).toEqual({ data: null, error: 'no_value_tag' });
    expect(balance('site-chests2.html', (h) => editDom(h, (d) => { d.querySelector('.points_info strong').textContent = 'скоро'; }))).toEqual({ data: null, error: 'parse_nan' });
  });

  it('«Проверка безопасности» → challenge (Rust подождёт и повторит)', () => {
    expect(runPageScript('balance.js', CHALLENGE_TITLE, 'TF_BAL_V5_').error).toBe('challenge');
    expect(runPageScript('balance.js', CHALLENGE_SCRIPT, 'TF_BAL_V5_').error).toBe('challenge');
  });
});

describe('проверка входа (usercp.php, check_auth.js)', () => {
  it('личный кабинет → online', () => {
    expect(auth('site-usercp.html')).toEqual({ data: 'online', error: null });
  });

  it('страница «Предупреждение» → offline / not_logged_in', () => {
    expect(auth('site-warning.html')).toEqual({ data: 'offline', error: 'not_logged_in' });
  });

  it('вёрстка изменилась: нет блока с ником → pending (повтор), но не online и не offline', () => {
    const r = auth('site-usercp.html', (h) => editDom(h, (d) => d.querySelector('.info__forumname').className = 'info__nick'));
    // 'complete' — страница загружена целиком: по таймауту Rust сообщит об этом, а не «сайт не ответил»
    expect(r).toEqual({ data: 'complete', error: 'pending' });
  });

  it('страница ещё грузится → challenge со значением loading; проверка безопасности → page (Rust по таймауту различает)', () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    try {
      expect(runPageScript('check_auth.js', EMPTY_PAGE, 'TF_AUTH_V2_')).toEqual({ data: 'loading', error: 'challenge' });
    } finally {
      delete document.readyState;
    }
    expect(runPageScript('check_auth.js', CHALLENGE_TITLE, 'TF_AUTH_V2_')).toEqual({ data: 'page', error: 'challenge' });
  });

  it('пустая страница → pending; «Проверка безопасности» → challenge', () => {
    expect(runPageScript('check_auth.js', EMPTY_PAGE, 'TF_AUTH_V2_')).toEqual({ data: 'complete', error: 'pending' });
    expect(runPageScript('check_auth.js', CHALLENGE_TITLE, 'TF_AUTH_V2_').error).toBe('challenge');
    expect(runPageScript('check_auth.js', CHALLENGE_SCRIPT, 'TF_AUTH_V2_').error).toBe('challenge');
  });
});

describe('название марафона (supermarathon*.php, marathon_titles.js)', () => {
  it('supermarathon.php → «Ликвидатор зла»', () => {
    expect(titles('site-supermarathon.html').data.name).toBe('Ликвидатор зла');
  });

  it('supermarathon2.php → «Летний марафон»', () => {
    expect(titles('site-supermarathon2.html').data.name).toBe('Летний марафон');
  });

  it('не вошли → not_logged_in; нет заголовков → no_title_found; challenge', () => {
    expect(titles('site-warning.html')).toEqual({ data: null, error: 'not_logged_in' });
    expect(titles('site-supermarathon.html', (h) => editDom(h, (d) => d.querySelectorAll('h2').forEach((e) => e.remove())))).toEqual({ data: null, error: 'no_title_found' });
    expect(runPageScript('marathon_titles.js', CHALLENGE_TITLE, 'TF_TITLE_V4_').error).toBe('challenge');
  });
});

describe('прогресс заданий (marathon_progress.js)', () => {
  it('supermarathon2.php → все задания с числами «выполнено / всего»', () => {
    const { data, error } = progress('site-supermarathon2.html');
    expect(error).toBeNull();
    expect(data.length).toBeGreaterThanOrEqual(5);
    data.forEach((q) => {
      expect(q.title.length).toBeGreaterThan(3);
      expect(q.total).toBeGreaterThan(0);
      expect(q.completed).toBeLessThanOrEqual(q.total);
      expect(q.percentage).toBe(Math.round((q.completed / q.total) * 100));
    });
  });

  it('supermarathon.php → задания с описаниями', () => {
    const { data, error } = progress('site-supermarathon.html');
    expect(error).toBeNull();
    expect(data.length).toBeGreaterThan(0);
    data.forEach((q) => expect(q.description.length).toBeGreaterThan(10));
  });

  it('не вошли → not_logged_in; кабинет без марафона → container_not_found (с пустым списком)', () => {
    expect(progress('site-warning.html')).toEqual({ data: null, error: 'not_logged_in' });
    expect(progress('site-usercp.html')).toEqual({ data: [], error: 'container_not_found' });
  });

  it('вёрстка изменилась: нет контейнера / нет полос прогресса → ошибка, а не «0 заданий»', () => {
    const r1 = progress('site-supermarathon2.html', (h) => editDom(h, (d) => d.querySelector('.season_marathon').className = 'marathon_list'));
    expect(r1.error).toBe('container_not_found');
    const r2 = progress('site-supermarathon2.html', (h) => editDom(h, (d) => d.querySelectorAll('.progress').forEach((e) => e.className = 'bar')));
    expect(r2).toEqual({ data: [], error: 'no_progress_found' });
  });

  it('challenge', () => {
    expect(runPageScript('marathon_progress.js', CHALLENGE_TITLE, 'TF_MARATHON_DATA_').error).toBe('challenge');
  });
});

describe('страница марафона (marathon_detail.js) и новость (marathon_news.js)', () => {
  it('supermarathon2.php → название, этапы и задания', () => {
    const { data, error } = detail('site-supermarathon2.html');
    expect(error).toBeNull();
    expect(data.name).toBe('Летний марафон');
    expect(data.quests.length).toBeGreaterThan(5);
  });

  it('не вошли → not_logged_in; challenge', () => {
    expect(detail('site-warning.html')).toEqual({ data: null, error: 'not_logged_in' });
    expect(runPageScript('marathon_detail.js', CHALLENGE_TITLE, 'TF_DETAIL_V4_').error).toBe('challenge');
  });

  it('новость → заголовок, дата и очищенный HTML, который разбирается в 15 заданий', () => {
    const { data, error } = news('site-news-summer.html');
    expect(error).toBeNull();
    expect(data.title).toMatch(/Летний марафон/);
    expect(data.publishedAt).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(data.html).toContain('<table');
    expect(data.html).not.toMatch(/<script|<img/);
    expect(parseNewsHtml(data.html, { title: data.title, publishedAt: data.publishedAt, newsUrl: data.url }).quests).toHaveLength(15);
  });

  it('вёрстка изменилась: нет блока статьи → no_article; challenge', () => {
    expect(runPageScript('marathon_news.js', '<html><body><p>пусто</p></body></html>', 'TF_NEWS_V1_')).toEqual({ data: null, error: 'no_article' });
    expect(runPageScript('marathon_news.js', CHALLENGE_TITLE, 'TF_NEWS_V1_').error).toBe('challenge');
  });
});

describe('фикстуры подключены', () => {
  it('все страницы читаются', () => {
    ['site-usercp.html', 'site-warning.html', 'site-chests2.html', 'site-supermarathon.html', 'site-supermarathon2.html', 'site-news-summer.html'].forEach((f) => expect(fixture(f).length).toBeGreaterThan(1000));
  });
});
