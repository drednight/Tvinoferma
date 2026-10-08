// Скрипт «Сундука караванщика» (src-tauri/src/scripts/caravan.js) на НАСТОЯЩИХ страницах pwonline.ru:
//   site-promoitems-caravan.html — /promo_items.php: 4 «Сундука караванщика» и 4 «Подарочных мешка» (их не трогаем)
//   site-chest-activate.html     — /promo_items.php?do=activate&cart_id=43915985: 4 предмета, кнопка отправки
// Данные очищены (scripts/sanitize-fixture.mjs): логин заменён, адреса и номера сундуков сохранены.
import { describe, it, expect, beforeEach } from 'vitest';
import { runPageScript, fixture, editDom, buildScript } from './helpers/pageScript.js';

const PREFIX = 'TF_CARAVAN_V1_';
const run = (html, cfg = { mode: 'scan' }, url = '/promo_items.php') => {
  window.history.replaceState(null, '', url);
  window.__TF_CARAVAN = cfg;
  return runPageScript('caravan.js', html, PREFIX);
};
const list = () => fixture('site-promoitems-caravan.html');
const chest = () => fixture('site-chest-activate.html');
const CHEST_URL = '/promo_items.php?do=activate&cart_id=43915985';
const page = (body, title = 'Perfect World') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;

beforeEach(() => { window.__TF_CARAVAN = undefined; window.__TF_CARAVAN_MARK = undefined; });

describe('caravan.js: чтение инвентаря (scan, только чтение)', () => {
  it('находит четыре «Сундука караванщика» с номерами и сроком; «Подарочные мешки» считает чужими', () => {
    const r = run(list());
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('scan');
    expect(r.data.chests.map(c => c.cartId)).toEqual(['43915985', '43921742', '43931627', '43955414']);
    expect(r.data.chests[0].until).toBe('15:04 10.10.2026');
    expect(r.data.other).toBe(4);
  });

  it('ничего не нажимает и не отмечает', () => {
    run(list());
    expect(document.querySelectorAll('input:checked')).toHaveLength(0);
  });

  it('в инвентаре нет сундуков караванщика → пустой список, но страница прочитана', () => {
    const html = editDom(list(), (doc) => {
      doc.querySelectorAll('.chest_input_block').forEach((b) => {
        if (b.textContent.includes('Сундук караванщика')) b.remove();
      });
    });
    const r = run(html);
    expect(r.error).toBeNull();
    expect(r.data.chests).toEqual([]);
    expect(r.data.other).toBe(4);
  });

  it('нет входа на сайт → not_logged_in', () => {
    const r = run(page('<p>Вы не авторизованы</p>'));
    expect(r.error).toBe('not_logged_in');
  });

  it('страница без списка предметов → pending (Rust превратит это в page_not_found)', () => {
    const r = run(page('<p>Что-то другое</p>'));
    expect(r.error).toBe('pending');
  });

  it('«Проверка безопасности» → challenge', () => {
    const r = run(page('<h1>Проверка безопасности</h1>', 'Проверка безопасности'));
    expect(r.error).toBe('challenge');
  });
});

describe('caravan.js: отметка предметов сундука (fill)', () => {
  it('отмечает все четыре предмета и сообщает их названия, ничего не отправляя', () => {
    let submitted = false;
    document.addEventListener('submit', () => { submitted = true; }, { once: true });
    const r = run(chest(), { mode: 'fill', cartId: '43915985' }, CHEST_URL);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'ready', cartId: '43915985', count: 4 });
    expect(r.data.names[0]).toContain('Самоцвет грез (оружие)');
    expect(document.querySelectorAll('input[name="chest_items[]"]:checked')).toHaveLength(4);
    expect(submitted).toBe(false);
  });

  it('адрес страницы — другой сундук → pending (ждём нужную страницу)', () => {
    const r = run(chest(), { mode: 'fill', cartId: '43921742' }, CHEST_URL);
    expect(r.error).toBe('pending');
    expect(document.querySelectorAll('input[name="chest_items[]"]:checked')).toHaveLength(0);
  });

  it('формы сундука на странице нет (уже открыт) → chest_not_found', () => {
    const html = editDom(chest(), (doc) => doc.querySelector('form[action*="do=activate"]').remove());
    const r = run(html, { mode: 'fill', cartId: '43915985' }, CHEST_URL);
    expect(r.error).toBe('chest_not_found');
  });

  it('форма от другого сундука не подходит', () => {
    const html = editDom(chest(), (doc) => {
      const f = doc.querySelector('form[action*="do=activate"]');
      f.setAttribute('action', f.getAttribute('action').replace('43915985', '43921742'));
    });
    expect(run(html, { mode: 'fill', cartId: '43915985' }, CHEST_URL).error).toBe('chest_not_found');
  });

  it('нет предметов → no_items', () => {
    const html = editDom(chest(), (doc) => doc.querySelectorAll('input[name="chest_items[]"]').forEach(b => b.remove()));
    expect(run(html, { mode: 'fill', cartId: '43915985' }, CHEST_URL).error).toBe('no_items');
  });

  it('нет кнопки отправки → button_not_found', () => {
    const html = editDom(chest(), (doc) => doc.querySelectorAll('input[type="submit"], .chest_submit_button').forEach(b => b.remove()));
    expect(run(html, { mode: 'fill', cartId: '43915985' }, CHEST_URL).error).toBe('button_not_found');
  });

  it('нет входа → not_logged_in', () => {
    expect(run(page('<p>Вы не авторизованы</p>'), { mode: 'fill', cartId: '43915985' }, CHEST_URL).error).toBe('not_logged_in');
  });
});

describe('caravan.js: нажатие кнопки (click)', () => {
  const doClick = (cfg, prep = () => {}) => {
    let submits = 0;
    const onSubmit = (e) => { e.preventDefault(); submits++; };
    document.addEventListener('submit', onSubmit, true);
    window.history.replaceState(null, '', CHEST_URL);
    window.__TF_CARAVAN = { mode: 'click', cartId: '43915985', ...cfg };
    const doc = new DOMParser().parseFromString(chest(), 'text/html');
    document.body.innerHTML = doc.body.innerHTML;
    prep();
    window.location.hash = '';
    // runPageScript перезаписывает body, поэтому запускаем скрипт напрямую
    new Function(buildScript('caravan.js'))();
    document.removeEventListener('submit', onSubmit, true);
    const hash = window.location.hash.replace(`#${PREFIX}`, '');
    return { submits, reply: hash ? JSON.parse(decodeURIComponent(hash)) : null };
  };
  const checkAll = () => document.querySelectorAll('input[name="chest_items[]"]').forEach(b => { b.checked = true; });

  it('все предметы отмечены → форма отправляется один раз, ответа скрипт не пишет', () => {
    const r = doClick({ count: 4 }, checkAll);
    expect(r.submits).toBe(1);
    expect(r.reply).toBeNull();
    expect(window.__TF_CARAVAN_MARK).toBe(true);
  });

  it('отметки изменились (отмечено 3 из 4) → selection_changed, ничего не нажато', () => {
    const r = doClick({ count: 4 }, () => { checkAll(); document.querySelector('input[name="chest_items[]"]').checked = false; });
    expect(r.submits).toBe(0);
    expect(r.reply.error).toBe('selection_changed');
    expect(window.__TF_CARAVAN_MARK).toBeUndefined();
  });

  it('при fill было 4 предмета, а теперь отмечено меньше/больше → отказ', () => {
    const r = doClick({ count: 3 }, checkAll);
    expect(r.submits).toBe(0);
    expect(r.reply.error).toBe('selection_changed');
  });
});

describe('caravan.js: страница после нажатия (after, только чтение)', () => {
  it('пока стоит метка старой страницы — pending', () => {
    window.__TF_CARAVAN_MARK = true;
    expect(run(chest(), { mode: 'after' }, CHEST_URL).error).toBe('pending');
  });

  it('новая страница описывается заголовком и началом текста', () => {
    const r = run(page('<h1>Передача предметов</h1><p>Готово</p>'), { mode: 'after' }, '/promo_items.php');
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'after', hasForm: false });
    expect(r.data.text).toContain('Готово');
  });
});

describe('caravan.js: служебное', () => {
  it('неизвестный режим → bad_mode', () => {
    expect(run(list(), { mode: 'xyz' }).error).toBe('bad_mode');
  });
});
