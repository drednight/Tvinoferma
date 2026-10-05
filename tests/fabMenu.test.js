import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Круглая кнопка «+» на вкладке «Марафоны»: меню «Создать папку / Создать марафон»
const createFolder = vi.fn();
const createMarathon = vi.fn();
vi.mock('../js/modules/characters/index.js', () => ({ openCharacterForm: vi.fn() }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAllLoginStatuses: vi.fn(), refreshAllBalances: vi.fn(), refreshAllMarathonStats: vi.fn() }));
vi.mock('../js/modules/parties/manager.js', () => ({ openCreatePartyModal: vi.fn() }));
vi.mock('../js/modules/marathons/page.js', () => ({ createFolderFromFab: createFolder, createMarathonFromFab: createMarathon }));

let section;
beforeEach(async () => {
  vi.resetModules();
  createFolder.mockClear(); createMarathon.mockClear();
  const html = readFileSync('index.html', 'utf8');
  const fab = html.slice(html.indexOf('<div class="fab-container"'), html.indexOf('<!-- ====', html.indexOf('<div class="fab-container"')));
  document.body.innerHTML = `
    <nav><button class="tab" data-tab="marathons">Марафоны</button></nav>
    <section class="page active" data-section="marathons"></section>
    ${fab}`;
  section = document.querySelector('.page');
  const { initUiActions } = await import('../js/core/uiActions.js');
  initUiActions();
});

const menu = () => document.getElementById('fab-menu');
const fab = () => document.getElementById('fab-main-btn');

describe('кнопка «+» на вкладке «Марафоны»', () => {
  it('видна на вкладке и открывает меню из двух пунктов', () => {
    expect(document.getElementById('global-fab-container').classList.contains('visible')).toBe(true);
    expect(menu().hidden).toBe(true);
    fab().click();
    expect(menu().hidden).toBe(false);
    expect(fab().classList.contains('is-open')).toBe(true);
    expect([...menu().querySelectorAll('.fab-menu-item')].map(b => b.textContent.trim())).toEqual(['📁Создать папку', '🏃Создать марафон']);
  });

  it('«Создать папку» и «Создать марафон» вызывают свои диалоги и закрывают меню', async () => {
    fab().click();
    menu().querySelector('[data-fab-action="folder"]').click();
    await vi.waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1));
    expect(createMarathon).not.toHaveBeenCalled();
    expect(menu().hidden).toBe(true);
    fab().click();
    menu().querySelector('[data-fab-action="marathon"]').click();
    await vi.waitFor(() => expect(createMarathon).toHaveBeenCalledTimes(1));
  });

  it('повторный клик, Esc, клик мимо и смена вкладки закрывают меню', () => {
    fab().click(); fab().click();
    expect(menu().hidden).toBe(true);
    fab().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu().hidden).toBe(true);
    fab().click();
    document.body.click();
    expect(menu().hidden).toBe(true);
    fab().click();
    document.querySelector('.tab').click();
    expect(menu().hidden).toBe(true);
    expect(fab().classList.contains('is-open')).toBe(false);
  });

  it('на странице марафона или папки кнопку прячет CSS (у страницы свои кнопки)', () => {
    const css = readFileSync('css/core/fab.css', 'utf8');
    expect(css).toContain('.page[data-section="marathons"].active[data-view="detail"]) .fab-container');
    expect(css).toContain('.page[data-section="marathons"].active[data-view="series"]) .fab-container');
    expect(section.dataset.view).toBeUndefined(); // атрибут ставит page.js при отрисовке
  });
});
