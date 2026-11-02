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
          expiresText: 'до 23:59 МСК 25 октября 2026',
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
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('open_promo_news_article', { article: '9142' }));
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('/pin/');
  });
  it('does not disable the main window behind an already running script', () => {
    mocks.current = { status: 'running' };
    render(dlg);
    expect(button().disabled).toBe(true);
    button().click();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('closes an owned article as soon as a background script starts, restoring access to Stop', async () => {
    button().click();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    mocks.current = { status: 'running' };
    mocks.changed();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('close_promo_news_article'));
    expect(button().disabled).toBe(true);
    mocks.current = null;
    mocks.changed();
    expect(button().disabled).toBe(false);
  });
  it('also covers a script starting while native viewer creation is still pending', async () => {
    let release;
    mocks.invoke.mockImplementation(cmd =>
      cmd === 'open_promo_news_article'
        ? new Promise(r => {
            release = r;
          })
        : Promise.resolve()
    );
    button().click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    mocks.current = { status: 'running' };
    mocks.changed();
    release();
    await vi.waitFor(() =>
      expect(mocks.invoke.mock.calls.filter(c => c[0] === 'close_promo_news_article').length).toBeGreaterThanOrEqual(1)
    );
  });
  it('shows deadline, restriction and reward text without executing source markup', () => {
    expect(document.body.textContent).toContain('23:59 МСК');
    expect(document.body.textContent).toContain('Только сервер «Цефей»');
    expect(document.querySelectorAll('.promo-news-option li')).toHaveLength(2);
    expect(document.querySelector('img')).toBeNull();
  });
  it('persists hiding only the chosen code', () => {
    [...document.querySelectorAll('button')].find(b => b.textContent === 'Больше не показывать').click();
    expect(mocks.hide).toHaveBeenCalledWith('PWEXAMPLE26');
  });
});
