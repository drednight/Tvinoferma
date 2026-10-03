import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Issue #54-1: скрипт против попапов (вшивается в окна персонажей как initialization_script)
const SCRIPT = readFileSync('src-tauri/src/scripts/popup_patch.js', 'utf8');
let openSpy;

function install() {
  delete window.__tfPopupPatched;
  openSpy = vi.fn(() => 'native-window');
  window.open = openSpy;
  (0, eval)(SCRIPT);
}

function click(el) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  // отменяем переход, чтобы jsdom не ругался на навигацию
  el.addEventListener('click', e => e.preventDefault());
  el.dispatchEvent(ev);
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  install();
});

describe('popup_patch.js', () => {
  it('window.open на http(s) не создаёт попап (переход в этом же окне)', () => {
    expect(window.open('https://account.vkplay.ru/login')).toBeNull();
    expect(window.open('https://id.vk.com/auth?x=1')).toBeNull();
    expect(window.open('/relative/path')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('служебные адреса (about:blank) проходят в оригинальный window.open', () => {
    expect(window.open('about:blank')).toBe('native-window');
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('повторная установка не оборачивает window.open второй раз', () => {
    const patched = window.open;
    (0, eval)(SCRIPT);
    expect(window.open).toBe(patched);
  });

  it('ссылка с target="_blank" превращается в _self', () => {
    document.body.innerHTML = '<a id="a" href="https://account.vkplay.ru/" target="_blank"><span id="s">Вход</span></a>';
    click(document.getElementById('s'));   // клик по вложенному элементу
    expect(document.getElementById('a').target).toBe('_self');
  });

  it('ссылки без target и с _self не трогаются', () => {
    document.body.innerHTML = '<a id="a" href="https://pwonline.ru/"></a><a id="b" href="https://pwonline.ru/" target="_top"></a>';
    click(document.getElementById('a'));
    click(document.getElementById('b'));
    expect(document.getElementById('a').getAttribute('target')).toBeNull();
    expect(document.getElementById('b').target).toBe('_top');
  });

  it('ссылки не на http(s) (mailto:) остаются как есть', () => {
    document.body.innerHTML = '<a id="a" href="mailto:a@b.ru" target="_blank">m</a>';
    click(document.getElementById('a'));
    expect(document.getElementById('a').target).toBe('_blank');
  });

  it('форма с target="_blank" отправляется в этом же окне', () => {
    document.body.innerHTML = '<form id="f" target="_blank"><input></form>';
    const f = document.getElementById('f');
    f.addEventListener('submit', e => e.preventDefault());
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(f.target).toBe('_self');
  });
});
