import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toolbarBootstrap, buildPanelScript, SITE_LINKS, TOOLBAR_HEIGHT } from '../js/desktop/loginPanel.js';

// Issue #54-3: тулбар навигации сверху окна браузера персонажа
let shadow;
let origAttach;
let api;

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  origAttach = origAttach || Element.prototype.attachShadow;
  const orig = origAttach;
  Element.prototype.attachShadow = function (init) { shadow = orig.call(this, { ...init, mode: 'open' }); return shadow; };
  api = { go: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() };
});

const btn = (title) => [...shadow.querySelectorAll('button')].find(b => b.title === title);
const labels = () => [...shadow.querySelectorAll('button')].map(b => b.textContent);

describe('SITE_LINKS', () => {
  it('ровно три раздела: Домой, МДМ, Перевод подарков', () => {
    expect(SITE_LINKS.map(l => l[0])).toEqual(['🏠 Домой', 'МДМ', '🎁 Перевод подарков']);
    expect(SITE_LINKS.map(l => l[1])).toEqual([
      'https://pwonline.ru/',
      'https://pwonline.ru/chests2.php',
      'https://pwonline.ru/promo_items.php'
    ]);
  });

  it('ведут только на pwonline.ru по https и без параметров', () => {
    SITE_LINKS.forEach(([, url, path]) => {
      const u = new URL(url);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('pwonline.ru');
      expect(u.pathname).toBe(path);
      expect(u.search).toBe('');
    });
  });
});

describe('toolbarBootstrap', () => {
  it('остаются только назад / вперёд / обновить, Домой, МДМ, Перевод подарков', () => {
    toolbarBootstrap(SITE_LINKS, TOOLBAR_HEIGHT, api);
    expect(labels()).toEqual(['◀', '▶', '⟳', '🏠 Домой', 'МДМ', '🎁 Перевод подарков']);
    expect(shadow.textContent).not.toMatch(/Марафон|Сундуки|Профиль|Новости|Баланс|Промокод|pwonline\.ru/);
  });

  it('кнопки вызывают навигацию', () => {
    toolbarBootstrap(SITE_LINKS, TOOLBAR_HEIGHT, api);
    btn('Назад').click();
    btn('Вперёд').click();
    btn('Обновить страницу').click();
    btn('https://pwonline.ru/chests2.php').click();
    btn('https://pwonline.ru/promo_items.php').click();
    expect(api.back).toHaveBeenCalledTimes(1);
    expect(api.forward).toHaveBeenCalledTimes(1);
    expect(api.reload).toHaveBeenCalledTimes(1);
    expect(api.go).toHaveBeenNthCalledWith(1, 'https://pwonline.ru/chests2.php');
    expect(api.go).toHaveBeenNthCalledWith(2, 'https://pwonline.ru/promo_items.php');
  });

  it('полоса сверху на всю ширину, сайт сдвигается вниз на её высоту', () => {
    toolbarBootstrap(SITE_LINKS, TOOLBAR_HEIGHT, api);
    const css = document.getElementById('__tf_toolbar__').style.cssText;
    expect(css).toContain('position: fixed');
    expect(css).toMatch(/top: 0(px)?/);
    expect(css).toMatch(/left: 0(px)?/);
    expect(css).toMatch(/right: 0(px)?/);
    expect(document.documentElement.style.getPropertyValue('margin-top')).toBe(`${TOOLBAR_HEIGHT}px`);
  });

  it('повторный запуск заменяет тулбар, а не дублирует', () => {
    toolbarBootstrap(SITE_LINKS, TOOLBAR_HEIGHT, api);
    toolbarBootstrap(SITE_LINKS, TOOLBAR_HEIGHT, api);
    expect(document.querySelectorAll('#__tf_toolbar__').length).toBe(1);
  });
});

describe('buildPanelScript', () => {
  it('внедряет и панель контактов, и тулбар', () => {
    (0, eval)(buildPanelScript({ nick: 'N', contacts: {} }));
    expect(document.getElementById('__tf_login_panel__')).not.toBeNull();
    expect(document.getElementById('__tf_toolbar__')).not.toBeNull();
  });
});
