import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toolbarBootstrap, buildPanelScript, SITE_LINKS } from '../js/desktop/loginPanel.js';

// Issue #54-3: тулбар навигации в окне браузера персонажа
let shadow;
let origAttach;
let api;

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  origAttach = origAttach || Element.prototype.attachShadow;
  const orig = origAttach;
  Element.prototype.attachShadow = function (init) { shadow = orig.call(this, { ...init, mode: 'open' }); return shadow; };
  api = { go: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() };
});

const btn = (title) => [...shadow.querySelectorAll('button')].find(b => b.title === title);

describe('SITE_LINKS', () => {
  it('ведут только на pwonline.ru по https и без параметров', () => {
    SITE_LINKS.forEach(([label, url, path]) => {
      const u = new URL(url);
      expect(label).toBeTruthy();
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('pwonline.ru');
      expect(u.pathname).toBe(path);
      expect(u.search).toBe('');
    });
  });
});

describe('toolbarBootstrap', () => {
  it('рисует навигацию и быстрые ссылки', () => {
    toolbarBootstrap(SITE_LINKS, api);
    expect(document.getElementById('__tf_toolbar__')).not.toBeNull();
    expect(btn('Назад')).toBeTruthy();
    expect(btn('Вперёд')).toBeTruthy();
    expect(btn('Обновить страницу')).toBeTruthy();
    expect(shadow.textContent).toContain('Сундуки');
    expect(shadow.textContent).toContain('Марафон');
  });

  it('кнопки вызывают навигацию', () => {
    toolbarBootstrap(SITE_LINKS, api);
    btn('Назад').click();
    btn('Вперёд').click();
    btn('Обновить страницу').click();
    btn('https://pwonline.ru/chests2.php').click();
    expect(api.back).toHaveBeenCalledTimes(1);
    expect(api.forward).toHaveBeenCalledTimes(1);
    expect(api.reload).toHaveBeenCalledTimes(1);
    expect(api.go).toHaveBeenCalledWith('https://pwonline.ru/chests2.php');
  });

  it('показывает домен; не pwonline.ru помечается как посторонний', () => {
    toolbarBootstrap(SITE_LINKS, api);
    const site = shadow.querySelector('.site');
    expect(site.textContent).toBe(window.location.hostname);
    expect(site.classList.contains('foreign')).toBe(true);   // в тесте адрес localhost
  });

  it('сворачивается в значок и запоминает состояние', () => {
    toolbarBootstrap(SITE_LINKS, api);
    btn('Свернуть').click();
    expect(localStorage.getItem('__tf_tb_collapsed')).toBe('1');
    expect(btn('Назад')).toBeUndefined();
    toolbarBootstrap(SITE_LINKS, api);   // «новая страница»: остаётся свёрнутым
    expect(btn('Назад')).toBeUndefined();
    btn('Развернуть навигацию').click();
    expect(btn('Назад')).toBeTruthy();
  });

  it('повторный запуск заменяет тулбар, а не дублирует', () => {
    toolbarBootstrap(SITE_LINKS, api);
    toolbarBootstrap(SITE_LINKS, api);
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
