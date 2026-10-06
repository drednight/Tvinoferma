// Скрипт магазина подарков (src-tauri/src/scripts/shop.js) на НАСТОЯЩИХ страницах pwonline.ru:
//   site-shop.html         — /chests2.php: баланс 54, камни, сундуки «Знак…», «Камень асуров» упёрся в лимит («Доступно Вам: 0 шт.»)
//   site-shop-history.html — /chests2.php?do=history: 6 записей «Покупка предмета …»
// Данные очищены: логин заменён, токены покупок обнулены.
import { describe, it, expect, beforeEach } from 'vitest';
import { runPageScript, fixture, editDom } from './helpers/pageScript.js';

const WANTED = ['Камень светлого духа', 'Камень асуров', 'Камень лагеря', 'Камень государя', 'Знак доблести (25 штук)', 'Знак единства (25 штук)', 'Сундук средоточия', 'Ключ от Книги наставлений'];
const page = (body, title = 'Perfect World') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const run = (html, mode = 'scan', extra = {}) => {
  window.__TF_SHOP = { mode, wanted: WANTED, ...extra };
  return runPageScript('shop.js', html, 'TF_SHOP_V1_');
};
const shop = () => fixture('site-shop.html');
const byName = (r, name) => r.data.items.find((i) => i.want === name);

beforeEach(() => { window.__TF_SHOP = undefined; });

describe('shop.js: чтение магазина (scan, только чтение)', () => {
  it('аккаунт, баланс и все найденные предметы', () => {
    const r = run(shop());
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'scan', account: 'u_1000000001', balance: 54 });
    expect(r.data.items).toHaveLength(WANTED.length);
  });

  it('камни: цена 40, «Доступно Вам: 4», кнопка «Купить», id и вид предмета', () => {
    const r = run(shop());
    expect(byName(r, 'Камень светлого духа')).toMatchObject({ found: true, id: '42746', kind: 'item', price: 40, available: 4, label: 'Купить', blocked: false, hasLink: true });
    expect(byName(r, 'Камень лагеря')).toMatchObject({ id: '42765', price: 40, available: 4 });
    expect(byName(r, 'Камень государя')).toMatchObject({ id: '47278', price: 40, available: 4 });
  });

  it('«Камень асуров» упёрся в лимит: 0 шт. и блок «В данный момент вы не можете купить»', () => {
    const a = byName(run(shop()), 'Камень асуров');
    expect(a).toMatchObject({ found: true, id: '47276', price: 40, available: 0, blocked: true });
  });

  it('сундуки: «Открыть», 10 монет, без лимита; название в списке с «(25 штук)»', () => {
    const r = run(shop());
    expect(byName(r, 'Знак доблести (25 штук)')).toMatchObject({ found: true, name: 'Знак доблести (25 штук)', id: '479', kind: 'chest', price: 10, label: 'Открыть', available: null, blocked: false });
    expect(byName(r, 'Знак единства (25 штук)')).toMatchObject({ id: '480', kind: 'chest', price: 10 });
  });

  it('описание берётся с сайта; «Доступно Вам» в описание не попадает', () => {
    const r = run(shop());
    expect(byName(r, 'Знак доблести (25 штук)').desc).toContain('Знак доблести x 25');
    const stone = byName(r, 'Камень лагеря').desc;
    expect(stone).toContain('инкрустации экипировки');
    expect(stone).not.toContain('Доступно Вам');
    expect(stone.split('\n').length).toBeGreaterThan(1);
  });

  it('картинка получает полный адрес', () => {
    expect(byName(run(shop()), 'Камень лагеря').image).toMatch(/^https:\/\/cdn\.pwonline\.ru\/img\/promo_items\/item_\d+\.png$/);
  });

  it('предметов нет на сайте (ивентовые) → found:false, остальное читается', () => {
    const r = run(shop());
    expect(byName(r, 'Сундук средоточия')).toEqual({ want: 'Сундук средоточия', found: false, ambiguous: false });
    expect(byName(r, 'Ключ от Книги наставлений').found).toBe(false);
  });

  it('ивентовый предмет появился на сайте: цена берётся оттуда, а не из памяти', () => {
    const html = editDom(shop(), (d) => {
      const li = d.querySelector('#hash_chest479').cloneNode(true);
      li.id = 'hash_chest999';
      li.querySelector('.chest_title').textContent = 'Сундук средоточия';
      li.querySelector('.chest_price strong').textContent = '35';
      d.querySelector('#chest2').appendChild(li);
    });
    expect(byName(run(html), 'Сундук средоточия')).toMatchObject({ found: true, price: 35 });
  });

  it('два предмета с одним названием → не найден, ambiguous (покупать наугад нельзя)', () => {
    const html = editDom(shop(), (d) => d.querySelector('#chest2').appendChild(d.querySelector('#hash_item42765').cloneNode(true)));
    expect(byName(run(html), 'Камень лагеря')).toMatchObject({ found: false, ambiguous: true });
  });

  it('регистр и «ё» в названии не важны', () => {
    const r = run(shop(), 'scan', { wanted: ['КАМЕНЬ ЛАГЕРЯ', 'знак доблести'] });
    expect(r.data.items.map((i) => i.found)).toEqual([true, true]);
  });

  it('дробная цена читается: «2.50» → 2.5', () => {
    const html = editDom(shop(), (d) => { d.querySelector('#hash_item42765 .chest_price strong').textContent = '2.50'; });
    expect(byName(run(html), 'Камень лагеря').price).toBe(2.5);
  });

  it('нет входа → not_logged_in; «Проверка безопасности» → challenge', () => {
    expect(run(fixture('site-warning.html')).error).toBe('not_logged_in');
    expect(run(page('<p>Проверяем браузер…</p>', 'Проверка безопасности')).error).toBe('challenge');
  });

  it('вёрстка изменилась: нет списка предметов → pending; нет баланса → container_missing', () => {
    const noList = editDom(shop(), (d) => d.querySelectorAll('li.chest_info_container').forEach((li) => li.remove()));
    expect(run(noList)).toEqual({ data: 'complete', error: 'pending' });
    const noBalance = editDom(shop(), (d) => d.querySelector('.points_info').remove());
    expect(run(noBalance)).toEqual({ data: null, error: 'container_missing' });
  });
});

describe('shop.js: осмотр перед покупкой (inspect, только чтение)', () => {
  const inspect = (target, extra = {}) => run(shop(), 'inspect', { target, ...extra });

  it('камень можно купить: цена, баланс, подпись кнопки', () => {
    const r = inspect('Камень лагеря', { expectPrice: 40 });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'ready', label: 'Купить', balance: 54, account: 'u_1000000001' });
    expect(r.data.item).toMatchObject({ id: '42765', price: 40, available: 4 });
    expect(r.data.sig).toMatch(/^\d+$/);
  });

  it('сундук «Знак доблести»: кнопка «Открыть»', () => {
    expect(inspect('Знак доблести (25 штук)', { expectPrice: 10 }).data).toMatchObject({ state: 'ready', label: 'Открыть' });
  });

  it('лимит исчерпан → limit_reached, ничего не нажимается', () => {
    expect(inspect('Камень асуров', { expectPrice: 40 })).toEqual({ data: { price: 40, available: 0 }, error: 'limit_reached' });
  });

  it('цена на сайте изменилась → price_changed с новой ценой', () => {
    expect(inspect('Камень лагеря', { expectPrice: 35 })).toEqual({ data: { price: 40, available: 4 }, error: 'price_changed' });
  });

  it('не хватает монет → no_funds', () => {
    const html = editDom(shop(), (d) => { d.querySelector('.points_info strong').textContent = '39'; });
    expect(run(html, 'inspect', { target: 'Камень лагеря', expectPrice: 40 })).toEqual({ data: { price: 40, balance: 39 }, error: 'no_funds' });
  });

  it('предмета нет на сайте → item_missing', () => {
    expect(inspect('Сундук средоточия')).toEqual({ data: null, error: 'item_missing' });
  });

  it('у предмета пропала кнопка → button_not_found', () => {
    const html = editDom(shop(), (d) => d.querySelector('#hash_item42765 a.chest_buy_link').remove());
    expect(run(html, 'inspect', { target: 'Камень лагеря', expectPrice: 40 }).error).toBe('button_not_found');
  });
});

describe('shop.js: нажатие (click) — как человек: «Купить», затем «Да»', () => {
  /** Повторяет скрипт страницы: клик по ссылке показывает окно и подставляет адрес в кнопку «Да». */
  const withSiteScript = (html, { prevent = true, shownTitle } = {}) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    document.querySelector('.modalDialog').style.display = 'none';
    const clicks = [];
    document.querySelectorAll('.chest_buy_link').forEach((a) => a.addEventListener('click', (e) => {
      if (!prevent) return;
      e.preventDefault();
      document.querySelector('.modalTitle').innerHTML = shownTitle ?? a.closest('li').querySelector('.chest_title').innerHTML;
      document.querySelector('.modalDialog .buy').setAttribute('href', a.getAttribute('href'));
      document.querySelector('.modalDialog').style.display = 'block';
    }));
    document.querySelector('.modalDialog .buy').addEventListener('click', (e) => { e.preventDefault(); clicks.push(e.currentTarget.getAttribute('href')); });
    return clicks;
  };
  const fire = async (target, extra = {}) => {
    window.__TF_SHOP = { mode: 'click', wanted: WANTED, target, expectPrice: 40, ...extra };
    window.location.hash = '';
    const { buildScript } = await import('./helpers/pageScript.js');
    new Function(buildScript('shop.js'))();
    await new Promise((r) => setTimeout(r, 700));
    const m = window.location.hash.match(/#TF_SHOP_V1_(.*)$/);
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  };

  it('нажимает «Купить», сверяет окно и один раз нажимает «Да» по адресу этого предмета', async () => {
    const clicks = withSiteScript(shop());
    expect(await fire('Камень лагеря')).toBeNull();      // ответ пишется только при отказе
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toContain('do=buy&id=42765&use_item=1');
  });

  it('сундук: адрес use_chest, цена 10', async () => {
    const clicks = withSiteScript(shop());
    expect(await fire('Знак единства (25 штук)', { expectPrice: 10 })).toBeNull();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toContain('id=480&use_chest=1');
  });

  it('страница не показала окно подтверждения → ничего не покупается (modal_missing)', async () => {
    const clicks = withSiteScript(shop(), { prevent: false });
    const r = await fire('Камень лагеря');
    expect(r).toEqual({ data: null, error: 'modal_missing' });
    expect(clicks).toHaveLength(0);
  });

  it('в окне другое название → не подтверждаем (modal_mismatch)', async () => {
    const clicks = withSiteScript(shop(), { shownTitle: 'Камень государя' });
    const r = await fire('Камень лагеря');
    expect(r.error).toBe('modal_mismatch');
    expect(clicks).toHaveLength(0);
  });

  it('лимит, цена и баланс проверяются и перед нажатием', async () => {
    const clicks = withSiteScript(shop());
    expect((await fire('Камень асуров')).error).toBe('limit_reached');
    expect((await fire('Камень лагеря', { expectPrice: 30 })).error).toBe('price_changed');
    expect(clicks).toHaveLength(0);
  });
});

describe('shop.js: страница после покупки (after)', () => {
  const baseline = () => run(shop(), 'inspect', { target: 'Камень лагеря', expectPrice: 40 }).data.sig;

  it('страница не изменилась → pending (старый текст нельзя принять за ответ)', () => {
    expect(run(shop(), 'after', { baseline: baseline() })).toEqual({ data: 'complete', error: 'pending' });
  });

  it('баланс и «Доступно» изменились → читаются новые значения', () => {
    const html = editDom(shop(), (d) => {
      d.querySelector('.points_info strong').textContent = '14';
      d.querySelector('#hash_item42765 .img_item_cont span').innerHTML = d.querySelector('#hash_item42765 .img_item_cont span').innerHTML.replace('4 шт.', '3 шт.');
    });
    const r = run(html, 'after', { baseline: baseline() });
    expect(r.error).toBeNull();
    expect(r.data.balance).toBe(14);
    expect(byName(r, 'Камень лагеря').available).toBe(3);
  });

  it('другая страница без списка предметов → other_page с текстом', () => {
    const r = run(page('<p>Покупка выполнена</p>'), 'after', { baseline: baseline() });
    expect(r.error).toBe('other_page');
    expect(r.data).toContain('Покупка выполнена');
  });
});

describe('shop.js: история монет (history)', () => {
  it('читает записи: дата, сумма (со знаком), баланс до и после, действие', () => {
    const r = run(fixture('site-shop-history.html'), 'history');
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('history');
    expect(r.data.rows).toHaveLength(6);
    expect(r.data.rows[0]).toEqual({ at: '2026-10-07 01:11', delta: -40, before: 54, after: 14, action: 'Покупка предмета Камень светлого духа' });
    expect(r.data.rows[1]).toMatchObject({ at: '2026-09-15 20:07', delta: -40, action: 'Покупка предмета Камень асуров' });
  });

  it('нет таблицы → pending; нет входа → not_logged_in', () => {
    expect(run(page('<p>пусто</p>'), 'history')).toEqual({ data: 'complete', error: 'pending' });
    expect(run(fixture('site-warning.html'), 'history').error).toBe('not_logged_in');
  });
});
