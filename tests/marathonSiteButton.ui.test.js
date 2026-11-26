import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn(async () => {}), openLink: vi.fn(async () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/linkBrowser.js', () => ({ openCharacterWebLink: mocks.open, openWebLink: mocks.openLink }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  syncMarathons: vi.fn(),
  marathonUrlOf: m => m.source?.url || null,
  SITE_PAGES: [],
  customPages: () => [],
  rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(),
  parseMarathonPage: vi.fn(),
  pickScannerCharacter: () => null,
  loadNewsPage: vi.fn(),
  isNewsUrl: () => false
}));
import { state } from '../js/core/state.js';
import { createMarathon } from '../js/modules/marathons/model.js';
import { bindMarathons, openMarathon } from '../js/modules/marathons/page.js';
beforeEach(() => {
  mocks.open.mockClear();
  mocks.openLink.mockClear();
  document.body.innerHTML = '<div id="marathon-list"></div><div id="modal-root"></div>';
  state.characters = [{ id: 'a', nick: 'Alice', isLoggedIn: true }];
  state.parties = [];
  state.marathons = [
    createMarathon({
      id: 'm',
      title: 'Test',
      participantIds: ['a'],
      tasks: [{ id: 't', title: 'Task' }],
      assignments: { a: ['t'] },
      source: { url: 'https://pwonline.ru/supermarathon.php' }
    })
  ];
  bindMarathons();
  openMarathon('m');
});
it('places the browser column directly after the nickname and opens that character session', async () => {
  expect(document.querySelectorAll('.mr-matrix thead th')[1].textContent).toBe('Сайт');
  document.querySelector('.mr-row td:nth-child(2) button').click();
  await vi.waitFor(() =>
    expect(mocks.open).toHaveBeenCalledWith('https://pwonline.ru/supermarathon.php', state.characters[0])
  );
});
it('does not offer a misleading link when there is no source page', () => {
  state.marathons[0].source.url = null;
  openMarathon('m');
  expect(document.querySelector('[data-character-site]').disabled).toBe(true);
});

it('opens the news the marathon description came from, address included', async () => {
  state.marathons[0].source.newsUrl = 'https://pwonline.ru/news.php?article=9046';
  openMarathon('m');
  const news = document.querySelector('.mr-meta-news');
  expect(news.textContent).toContain('news.php?article=9046'); // адрес виден и его можно выделить
  news.querySelector('[data-act="open-news"]').click();
  await vi.waitFor(() => expect(mocks.openLink).toHaveBeenCalledWith('https://pwonline.ru/news.php?article=9046'));
});

it('does not offer a news button when the marathon was made without a news', () => {
  expect(document.querySelector('[data-act="open-news"]')).toBeNull();
});

it('keeps the page working when the browser refuses to open the news', async () => {
  mocks.openLink.mockRejectedValueOnce(new Error('браузер ссылок не настроен'));
  state.marathons[0].source.newsUrl = 'https://pwonline.ru/news.php?article=9046';
  openMarathon('m');
  document.querySelector('[data-act="open-news"]').click();
  await vi.waitFor(() => expect(mocks.openLink).toHaveBeenCalled());
  expect(document.querySelector('.mr-matrix')).not.toBeNull(); // кнопка не уронила раздел
});
