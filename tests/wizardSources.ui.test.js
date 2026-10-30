import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';
import { fixture, parseSitePage } from './helpers/pageScript.js';
import { parseNewsList } from '../js/modules/marathons/newsList.js';

// Мастер: «С сайта» и «Из новости» объединены в один блок (issue #3).
const mocks = vi.hoisted(() => ({
  scanner: { id: 'c1', nick: 'Ник', isLoggedIn: true },
  news: null,
  site: null,
  siteCalls: [],
  list: []
}));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({ getAuthView: () => ({ icon: '' }) }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  SITE_PAGES: [],
  customPages: () => [],
  rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(async () => ({ titles: [], errors: [] })),
  pickScannerCharacter: () => mocks.scanner,
  isNewsUrl: u => /news\.php\?.*article=\d+/i.test(String(u || '')),
  loadNewsPage: vi.fn(async () => ({ marathon: mocks.news, error: null, task: null })),
  searchNewsList: vi.fn(async () => ({ items: mocks.list, error: null, task: null })),
  parseMarathonPage: vi.fn(async url => {
    mocks.siteCalls.push(url);
    return { marathon: mocks.site, error: null, task: null };
  })
}));

const NEWS_URL = 'https://pwonline.ru/news.php?article=9046';
const $ = sel => document.querySelector(sel);
const click = sel => $(sel).click();

let state, openMarathonWizard;
beforeEach(async () => {
  vi.resetModules();
  mocks.siteCalls.length = 0;
  mocks.news = parseNewsHtml(fixture('news-summer-2026.html'), {
    title: 'Летний марафон',
    publishedAt: '29.05.2026',
    newsUrl: NEWS_URL
  });
  mocks.site = {
    ...parseSitePage('site-supermarathon2.html').data,
    sourceUrl: 'https://pwonline.ru/supermarathon2.php'
  };
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = [mocks.scanner];
  state.marathons = [];
  state.parties = [];
  state.marathonTemplates = [];
  ({ openMarathonWizard } = await import('../js/modules/marathons/wizard.js'));
});

async function loadNews({ verify }) {
  openMarathonWizard();
  click('[data-src="site"]');
  expect($('[data-src="news"]')).toBeNull(); // отдельной карточки «Из новости» больше нет
  const input = $('[data-news-url]');
  input.value = NEWS_URL;
  input.dispatchEvent(new Event('input'));
  const check = $('[data-news-verify]');
  check.checked = verify;
  check.dispatchEvent(new Event('change'));
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
    click('[data-act="next"]'); // шаг «Задания», первая вкладка — июнь
    click('.tf-tab[data-tab="1"]'); // июль
    const titles = [...document.querySelectorAll('.tf-task input[data-t="title"]')].map(i => i.value);
    expect(titles).toContain('Испытание снов (июль)');
    expect(titles).not.toContain('Испытание снов');
    const row = [...document.querySelectorAll('.tf-task')].find(r =>
      r.querySelector('[data-t="title"]').value.startsWith('Последователь Пань Гу')
    );
    expect(row.querySelector('textarea[data-t="description"]').value).toMatch(/Цзинсюань/); // описание из новости
    expect(row.querySelector('[data-desc-mark]').textContent).toContain('из новости');
  });

  it('правка описания в мастере помечается как ручная', async () => {
    await loadNews({ verify: true });
    await vi.waitFor(() => expect($('.tf-src-summary').textContent).toContain('Страница отметок: заданий 10'));
    click('[data-act="next"]');
    const row = document.querySelector('.tf-task');
    const ta = row.querySelector('textarea[data-t="description"]');
    ta.value = 'Моё описание';
    ta.dispatchEvent(new Event('input'));
    expect(row.querySelector('[data-desc-mark]').textContent).toContain('изменено вручную');
  });

  it('только новость (без галочки сверки): страница не запрашивается, можно сверить кнопкой', async () => {
    await loadNews({ verify: false });
    expect(mocks.siteCalls).toEqual([]);
    expect($('.tf-src-summary').textContent).toContain('Страница отметок: не загружено');
    expect($('.tf-src-summary').textContent).toContain('Испытание рыцарей'); // название из новости
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

describe('мастер: поиск новости о марафоне (issue #72 п.4)', () => {
  it('«Найти новость» показывает марафоны; «Выбрать» подставляет ссылку и разбирает новость', async () => {
    mocks.list = parseNewsList(fixture('news_list_p2.html'));
    openMarathonWizard();
    click('[data-src="site"]');
    click('[data-act="find-news"]');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-pick-news]').length).toBe(3));
    expect($('.tf-news-search').textContent).toContain('Летний марафон');
    expect($('.tf-news-search').textContent).not.toContain('День смеха');
    // «показать все»
    const all = $('[data-news-all]');
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('[data-pick-news]').length).toBe(15);
    all.checked = false;
    $('[data-news-all]').dispatchEvent(new Event('change'));
    // выбор найденной новости
    const pick = [...document.querySelectorAll('[data-pick-news]')].find(b =>
      b.dataset.pickNews.endsWith('article=9046')
    );
    pick.click();
    await vi.waitFor(() => expect($('.tf-src-summary')).not.toBeNull());
    expect($('[data-news-url]').value).toBe(NEWS_URL);
    expect($('.tf-src-summary').textContent).toContain('Новость: заданий 15');
  });

  it('пустой результат: подсказка вместо списка', async () => {
    mocks.list = [];
    openMarathonWizard();
    click('[data-src="site"]');
    click('[data-act="find-news"]');
    await vi.waitFor(() => expect($('.tf-news-search .tf-warn')).not.toBeNull());
  });
});

describe('устойчивые идентификаторы в настоящем мастере', () => {
  const ids = [
    'a9115bf2-e834-444d-aeb6-7c3af1db8890',
    'b9115bf2-e834-444d-aeb6-7c3af1db8890',
    'c9115bf2-e834-444d-aeb6-7c3af1db8890',
    'd9115bf2-e834-444d-aeb6-7c3af1db8890'
  ];

  it('редактирование марафона сохраняет его ID и ID заданий, наград и бонусов', async () => {
    const { createMarathon } = await import('../js/modules/marathons/model.js');
    const marathon = createMarathon({
      id: 'm',
      syncId: ids[0],
      title: 'До',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      participantIds: ['c1'],
      assignments: { c1: ['t'] },
      tasks: [{ id: 't', syncId: ids[1], title: 'Задание', rewards: [{ id: 'r', syncId: ids[2], threshold: 1 }] }],
      bonuses: [{ id: 'b', syncId: ids[3], needTasks: 1, text: 'Бонус' }]
    });
    state.marathons = [marathon];
    openMarathonWizard({ marathon });
    const title = $('[data-f="title"]');
    title.value = 'После';
    title.dispatchEvent(new Event('input'));
    click('[data-act="save"]');
    await vi.waitFor(() => expect(state.marathons[0].title).toBe('После'));
    expect(state.marathons[0]).toMatchObject({
      syncId: ids[0],
      tasks: [{ syncId: ids[1], rewards: [{ syncId: ids[2] }] }],
      bonuses: [{ syncId: ids[3] }]
    });
  });

  it('создание из шаблона и новый шаблон не наследуют ID копируемых вложений', async () => {
    state.marathonTemplates = [
      {
        id: 'tpl',
        name: 'Шаблон',
        createdAt: '2026-10-01',
        sourceUrl: null,
        tasks: [
          {
            id: 'old-task',
            syncId: ids[0],
            title: 'Задание',
            targetChecks: 1,
            schedule: { mode: 'everyDay', dates: [], weekStartDay: 1 },
            rewards: [{ id: 'old-reward', syncId: ids[1], threshold: 1, rewardText: 'Подарок', rewardCoins: 0 }]
          }
        ],
        bonuses: [{ id: 'old-bonus', syncId: ids[2], needTasks: 1, text: 'Бонус' }]
      }
    ];
    openMarathonWizard({ source: 'template' });
    const radio = $('input[name="tpl"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    click('[data-act="next"]');
    click('[data-act="next"]');
    click('[data-act="all"]');
    click('[data-act="next"]');
    const saveTemplate = $('[data-act="tpl"]');
    saveTemplate.checked = true;
    saveTemplate.dispatchEvent(new Event('change'));
    click('[data-act="save"]');
    await vi.waitFor(() => expect(state.marathons).toHaveLength(1));
    const created = state.marathons[0];
    expect(created.tasks[0]).not.toHaveProperty('syncId');
    expect(created.tasks[0].rewards[0]).not.toHaveProperty('syncId');
    expect(created.bonuses[0]).not.toHaveProperty('syncId');
    expect(created.tasks[0].id).not.toBe('old-task');
    expect(state.marathonTemplates).toHaveLength(2);
    expect(state.marathonTemplates[1].tasks[0].rewards[0]).not.toHaveProperty('syncId');
    expect(state.marathonTemplates[1].bonuses[0]).not.toHaveProperty('syncId');
    expect(state.marathonTemplates[0].tasks[0].syncId).toBe(ids[0]);
  });
});
