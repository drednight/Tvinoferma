import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';
import { fixture, parseSitePage } from './helpers/pageScript.js';

// Мастер: «С сайта» и «Из новости» объединены в один блок (issue #3).
const mocks = vi.hoisted(() => ({ scanner: { id: 'c1', nick: 'Ник', isLoggedIn: true }, news: null, site: null, siteCalls: [] }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({ getAuthView: () => ({ icon: '' }) }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  SITE_PAGES: [], customPages: () => [], rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(async () => ({ titles: [], errors: [] })),
  pickScannerCharacter: () => mocks.scanner,
  isNewsUrl: (u) => /news\.php\?.*article=\d+/i.test(String(u || '')),
  loadNewsPage: vi.fn(async () => ({ marathon: mocks.news, error: null, task: null })),
  parseMarathonPage: vi.fn(async (url) => { mocks.siteCalls.push(url); return { marathon: mocks.site, error: null, task: null }; })
}));

const NEWS_URL = 'https://pwonline.ru/news.php?article=9046';
const $ = (sel) => document.querySelector(sel);
const click = (sel) => $(sel).click();

let state, openMarathonWizard;
beforeEach(async () => {
  vi.resetModules();
  mocks.siteCalls.length = 0;
  mocks.news = parseNewsHtml(fixture('news-summer-2026.html'), { title: 'Летний марафон', publishedAt: '29.05.2026', newsUrl: NEWS_URL });
  mocks.site = { ...parseSitePage('site-supermarathon2.html').data, sourceUrl: 'https://pwonline.ru/supermarathon2.php' };
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = [mocks.scanner]; state.marathons = []; state.parties = []; state.marathonTemplates = [];
  ({ openMarathonWizard } = await import('../js/modules/marathons/wizard.js'));
});

async function loadNews({ verify }) {
  openMarathonWizard();
  click('[data-src="site"]');
  expect($('[data-src="news"]')).toBeNull();                      // отдельной карточки «Из новости» больше нет
  const input = $('[data-news-url]'); input.value = NEWS_URL; input.dispatchEvent(new Event('input'));
  const check = $('[data-news-verify]'); check.checked = verify; check.dispatchEvent(new Event('change'));
  click('[data-act="parse-news"]');
  await vi.waitFor(() => expect($('.tf-src-summary')).not.toBeNull());
}

describe('мастер: один блок «С сайта» с новостью и страницей отметок', () => {
  it('новость + автосверка со страницей: названия со страницы, описания и награды из новости', async () => {
    await loadNews({ verify: true });
    await vi.waitFor(() => expect($('.tf-src-summary').textContent).toContain('Страница отметок: заданий 10'));
    expect(mocks.siteCalls).toEqual(['https://pwonline.ru/supermarathon2.php']);
    const text = $('.tf-src-summary').textContent;
    expect(text).toContain('Новость: заданий 15');
    expect(text).toContain('Испытание снов (июль)');
    expect(text).toContain('описаний 15');
    click('[data-act="next"]');                                   // шаг «Задания», первая вкладка — июнь
    click('.tf-tab[data-tab="1"]');                               // июль
    const titles = [...document.querySelectorAll('.tf-task input[data-t="title"]')].map(i => i.value);
    expect(titles).toContain('Испытание снов (июль)');
    expect(titles).not.toContain('Испытание снов');
    const row = [...document.querySelectorAll('.tf-task')].find(r => r.querySelector('[data-t="title"]').value.startsWith('Последователь Пань Гу'));
    expect(row.querySelector('textarea[data-t="description"]').value).toMatch(/Цзинсюань/);   // описание из новости
    expect(row.querySelector('[data-desc-mark]').textContent).toContain('из новости');
  });

  it('правка описания в мастере помечается как ручная', async () => {
    await loadNews({ verify: true });
    await vi.waitFor(() => expect($('.tf-src-summary').textContent).toContain('Страница отметок: заданий 10'));
    click('[data-act="next"]');
    const row = document.querySelector('.tf-task');
    const ta = row.querySelector('textarea[data-t="description"]');
    ta.value = 'Моё описание'; ta.dispatchEvent(new Event('input'));
    expect(row.querySelector('[data-desc-mark]').textContent).toContain('изменено вручную');
  });

  it('только новость (без галочки сверки): страница не запрашивается, можно сверить кнопкой', async () => {
    await loadNews({ verify: false });
    expect(mocks.siteCalls).toEqual([]);
    expect($('.tf-src-summary').textContent).toContain('Страница отметок: не загружено');
    expect($('.tf-src-summary').textContent).toContain('Испытание рыцарей');   // название из новости
    click('[data-act="verify-site"]');
    await vi.waitFor(() => expect($('.tf-src-summary').textContent).toContain('Страница отметок: заданий 10'));
    expect(mocks.siteCalls).toHaveLength(1);
  });

  it('расхождение цели показывается предупреждением', async () => {
    mocks.site.quests[0].goal = 20;
    await loadNews({ verify: true });
    await vi.waitFor(() => expect($('.tf-compare')).not.toBeNull());
    expect($('.tf-compare').textContent).toContain('цель в новости 25, на странице отметок 20');
  });
});
