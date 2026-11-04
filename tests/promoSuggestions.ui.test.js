import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ current: null, changed: null, invoke: vi.fn(), hide: vi.fn(), restore: vi.fn() }));
vi.mock('../js/core/taskLog.js', () => ({
  dockCurrentTask: () => mocks.current,
  onTaskChange: fn => {
    mocks.changed = fn;
    return () => {};
  }
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => mocks.invoke(...args) }));
vi.mock('../js/core/state.js', () => ({ state: { characters: [{ id: 'a' }] } }));
vi.mock('../js/modules/automation/promoLog.js', () => ({ loadLog: () => ({}) }));
vi.mock('../js/modules/automation/promoDiscovery.js', () => ({
  promoDiscovery: () => ({
    snapshot: () => ({
      status: 'checked',
      codes: [
        {
          code: 'PWEXAMPLE26',
          title: 'Новость',
          sourceUrl: 'https://pwonline.ru/news.php?article=9142',
          expiresText: 'до 23:59 мск 25 октября 2099',
          serverRestriction: 'Цефей',
          rewards: ['Метеорит ×75', '<img src=x onerror=alert(1)>']
        }
      ],
      hiddenCodes: []
    }),
    setHidden: mocks.hide,
    restoreHidden: mocks.restore
  }),
  promoCoverage: codes => codes.map(c => ({ ...c, remaining: 1 }))
}));
let render, dlg;
beforeEach(async () => {
  vi.resetModules();
  mocks.current = null;
  mocks.changed = null;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.hide.mockReset();
  window.__TAURI_INTERNALS__ = {};
  document.body.innerHTML = '<div class="field"><textarea id="promo-code"></textarea></div>';
  ({ renderPromoSuggestions: render } = await import('../js/modules/automation/promoSuggestions.js'));
  dlg = { body: document.body };
  render(dlg);
});
const button = () => document.querySelector('[data-promo-news-open]');
describe('article viewer and accessible Stop', () => {
  it('opens the exact news article through native IPC, never a PIN URL', async () => {
    button().click();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('open_link_browser', {
        url: 'https://pwonline.ru/news.php?article=9142',
        charId: null,
        charNick: null
      })
    );
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('/pin/');
  });
  it('does not disable the main window behind an already running script', () => {
    mocks.current = { status: 'running' };
    render(dlg);
    expect(button().disabled).toBe(true);
    button().click();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('keeps the independent nonmodal viewer open when a background script starts', async () => {
    button().click();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    mocks.current = { status: 'running' };
    mocks.changed();
    expect(mocks.invoke).not.toHaveBeenCalledWith('close_promo_news_article');
    expect(button().disabled).toBe(true);
    mocks.current = null;
    mocks.changed();
    expect(button().disabled).toBe(false);
  });
  it('shows deadline, restriction and reward text without executing source markup', () => {
    expect(document.body.textContent).toContain('23:59 мск');
    expect(document.body.textContent).toContain('Доступен для сервера: «Цефей»');
    expect(document.querySelectorAll('.promo-news-option li')).toHaveLength(2);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img').getAttribute('src')).toContain('/items/meteorite.webp');
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(document.querySelectorAll('li')[1].textContent).toBe('<img src=x onerror=alert(1)>');
  });
  it('persists hiding only the chosen code', () => {
    [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Скрыть промокод').click();
    expect(mocks.hide).toHaveBeenCalledWith('PWEXAMPLE26');
  });
});

it('offers article/text add/hide actions in the requested order with accessible labels', () => {
  const card = document.querySelector('.promo-news-option');
  expect(
    [...card.querySelectorAll('.promo-news-actions button')].map(button => button.getAttribute('aria-label'))
  ).toEqual(['Открыть статью', 'Добавить промокод', 'Скрыть промокод']);
  expect([...card.querySelectorAll('.promo-news-actions button')].map(button => button.textContent)).toEqual([
    '🌐',
    'Добавить промокод',
    '⊘'
  ]);
});

it('matches the reference order and collapses reward list initially, with a full-width text add action', () => {
  const card = document.querySelector('.promo-news-option');
  expect([...card.children].map(el => el.tagName)).toEqual(['B', 'SPAN', 'SMALL', 'SMALL', 'SMALL', 'DETAILS', 'DIV']);
  expect(card.children[1].textContent).toBe('Новость');
  expect(card.children[2].textContent).toContain('Промокод активен до: 23:59 мск');
  expect(card.querySelector('details').open).toBe(false);
  expect(card.querySelector('.promo-news-actions button:nth-child(2)').classList.contains('promo-news-add')).toBe(true);
});
