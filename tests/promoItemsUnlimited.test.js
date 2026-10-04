// Видимое окно персонажа на /promo_items.php: лимит сайта «не более 6 предметов» снят, слева под «Помощником входа»
// панель «Типы предметов» (Issue #26). Лимит сайта в тесте воспроизведён так, как его обычно пишут:
// обработчик change на документе снимает 7-ю галочку.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fixture } from './helpers/pageScript.js';

const SCRIPT = readFileSync('src-tauri/src/scripts/promo_items_unlimited.js', 'utf8');
const BOXES = 'input[type="checkbox"][name="cart_items[]"]';
const boxes = () => [...document.querySelectorAll(BOXES)];
const checked = () => boxes().filter(b => b.checked).length;
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

let alerts;
let shadow;
const origAttach = Element.prototype.attachShadow;

function siteLimiter() {
  document.addEventListener('change', (e) => {
    if (e.target.matches(BOXES) && checked() > 6) { e.target.checked = false; alerts++; }
  });
}
function mount(search = '') {
  const doc = new DOMParser().parseFromString(fixture('site-promoitems.html'), 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  window.history.replaceState(null, '', `/promo_items.php${search}`);
  delete window.__tfUnlimitedItems;
  localStorage.clear();
}
const run = () => new Function(SCRIPT)();
const clickAll = (n) => boxes().slice(0, n).forEach(b => b.click());
const panel = () => shadow;
const rows = () => [...shadow.querySelectorAll('.row')];
const rowOf = (type) => rows().find(r => r.querySelector('.tname').textContent === type);
const btn = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent === text);

beforeEach(() => {
  alerts = 0; shadow = null;
  document.body.innerHTML = '';
  // closed shadow DOM в тесте делаем открытым, чтобы его можно было проверить
  Element.prototype.attachShadow = function (init) { shadow = origAttach.call(this, { ...init, mode: 'open' }); return shadow; };
});

describe('promo_items_unlimited.js: лимит', () => {
  it('контроль: без скрипта сайт пропускает только 6 галочек', () => {
    mount(); siteLimiter();
    expect(boxes().length).toBeGreaterThan(8);
    clickAll(10);
    expect(checked()).toBe(6);
    expect(alerts).toBeGreaterThan(0);
  });

  it('со скриптом пользователь отмечает любое число галочек; счётчик в панели обновляется', async () => {
    mount();
    run();
    clickAll(7);
    await wait();
    expect(checked()).toBe(7);
    expect(alerts).toBe(0);
    expect(shadow.querySelector('.count').textContent).toBe(`Отмечено: 7 из ${boxes().length}`);
    boxes()[0].click();                       // снять галочку по-прежнему можно
    await wait();
    expect(shadow.querySelector('.count').textContent).toBe(`Отмечено: 6 из ${boxes().length}`);
  });

  it('другие страницы сайта и «История передачи» не затрагиваются', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    mount('?do=history');
    run();
    window.history.replaceState(null, '', '/usercp.php');
    delete window.__tfUnlimitedItems;
    run();
    expect(spy.mock.calls.filter(c => c[2] === true)).toEqual([]);
    expect(document.getElementById('__tf_items_panel__')).toBeNull();
    spy.mockRestore();
  });
});

describe('promo_items_unlimited.js: панель «Типы предметов»', () => {
  it('только типы, которые есть на странице: по алфавиту, с количеством; у каждого «Отметить» и «Снять»', () => {
    mount(); run();
    expect(document.getElementById('__tf_items_panel__')).not.toBeNull();
    expect(rows().map(r => r.querySelector('.tname').textContent)).toEqual(['Артефакт', 'Валюта', 'Магические карты', 'Опыт', 'Пропуск', 'Расходник', 'Ресурс']);
    expect(rowOf('Расходник').querySelector('.tcnt').textContent).toBe('0/2');
    expect(rows().every(r => btn(r, 'Отметить') && btn(r, 'Снять'))).toBe(true);
    expect(shadow.textContent).not.toContain('Без типа');     // строки без галочки (сундуки, отметки) в панель не попадают
  });

  it('«Отметить» / «Снять» действуют только на свой тип', async () => {
    mount(); run();
    btn(rowOf('Расходник'), 'Отметить').click();
    expect(checked()).toBe(2);
    expect(rowOf('Расходник').querySelector('.tcnt').textContent).toBe('2/2');
    btn(rowOf('Опыт'), 'Отметить').click();
    expect(checked()).toBe(4);
    btn(rowOf('Расходник'), 'Снять').click();
    expect(checked()).toBe(2);
    expect(rowOf('Опыт').querySelector('.tcnt').textContent).toBe('2/2');
    btn(shadow, 'Отметить все').click();
    expect(checked()).toBe(boxes().length);
    btn(shadow, 'Снять все').click();
    expect(checked()).toBe(0);
  });

  it('список «какой предмет к какому типу» скрыт при запуске и описывает предметы по типам', () => {
    mount(); run();
    const det = shadow.querySelector('details');
    expect(det.open).toBe(false);
    const text = det.textContent;
    expect(text).toContain('Пропуск (2)');
    expect(text).toContain('Самоцвет грез (оружие) x50');
    expect(text).not.toContain('до 13');                      // срок «до …» в названия не попадает
    const li = [...det.querySelectorAll('.grp')].find(g => g.textContent.startsWith('Расходник'));
    expect(li.nextElementSibling.querySelectorAll('li')).toHaveLength(2);
  });

  it('панель сворачивается во вкладку и помнит это; список снова скрыт при новом запуске окна', () => {
    mount(); run();
    shadow.querySelector('details').open = true;
    btn(shadow, '–').click();
    expect(shadow.querySelector('.tab').textContent).toContain('Типы предметов');
    expect(localStorage.getItem('__tf_ip_collapsed')).toBe('1');
    shadow.querySelector('.tab').click();
    expect(shadow.querySelector('.card')).not.toBeNull();
    // новый документ (переход/перезапуск окна)
    mount(); localStorage.setItem('__tf_ip_collapsed', '0'); run();
    expect(shadow.querySelector('details').open).toBe(false);
  });

  it('стоит под панелью «Помощник входа», а без неё — на своём месте', () => {
    mount();
    const login = document.createElement('div');
    login.id = '__tf_login_panel__';
    login.getBoundingClientRect = () => ({ top: 90, bottom: 400, left: 0, right: 250, width: 250, height: 310 });
    document.body.appendChild(login);
    run();
    expect(document.getElementById('__tf_items_panel__').style.top).toBe('410px');
    mount(); run();
    expect(document.getElementById('__tf_items_panel__').style.top).toBe('90px');
  });
});
