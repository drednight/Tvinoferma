// Память картинок предметов: картинка сайта, которую приложение уже видело для такого же
// названия, показывает иконку там, где своей картинки нет (itemIconMemory.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  rememberItemIcons,
  rememberedItemIcon,
  itemIconHtml,
  forgetItemIcons,
  ITEM_ICON_KEY,
  ITEM_ICON_MAX
} from '../js/modules/automation/itemIconMemory.js';
import { siteItemImage } from '../js/modules/automation/siteItemIcon.js';

const A = 'https://pwonline.ru/img/promo_items/item_47278.png';
const B = 'https://cdn.pwonline.ru/img/promo_items/item_72297.png';

/** Разобрать строку списка так, как её видит браузер. */
const img = html => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};

beforeEach(() => {
  localStorage.clear();
  forgetItemIcons();
});

describe('память картинок предметов', () => {
  it('предмет без своего рисунка получает картинку сайта, виденную для этого названия', () => {
    // «Камень светлого духа» — предмет магазина: в списке передачи сайт свою картинку
    // не нарисовал (или строка прочитана давно), а в магазине приложение её уже видело.
    expect(itemIconHtml('', 'Камень светлого духа')).toContain('🎁');
    expect(rememberItemIcons([{ name: 'Камень светлого духа', image: A }])).toBe(1);
    expect(img(itemIconHtml('', 'Камень светлого духа')).querySelector('img').src).toBe(A);
    expect(localStorage.getItem(ITEM_ICON_KEY)).toContain('item_47278');
  });

  it('картинка из строки списка важнее запомненной, а рисунок из приложения важе обеих', () => {
    rememberItemIcons([{ name: 'Осколок сумеречной души', image: A }]);
    expect(
      img(itemIconHtml(B, 'Осколок сумеречной души')).querySelector('img').src.startsWith('https://cdn.pwonline.ru/')
    ).toBe(true);
    // Свой файл — всегда впереди: он и без сети, и без чужих запросов.
    expect(itemIconHtml(A, 'Великий метеорит')).toContain('great-meteorite.webp');
    expect(itemIconHtml(A, 'Великий метеорит')).not.toContain('pwonline.ru');
  });

  it('число и привязка в названии — тот же предмет; категория и уровень — уже нет', () => {
    rememberItemIcons([{ name: 'Приказ феникса', image: A }]);
    expect(rememberedItemIcon('Приказ феникса (30 шт.)')).toBe(A);
    expect(rememberedItemIcon('Приказ феникса ×30 (привязанный)')).toBe(A);
    expect(rememberedItemIcon('приказ   феникса.')).toBe(A);
    expect(rememberedItemIcon('Приказ феникса (60 шт.)')).toBe(A);
    rememberItemIcons([{ name: 'Самоцвет грез (доспех)', image: A }]);
    expect(rememberedItemIcon('Самоцвет грез (оружие)')).toBe('');
  });

  it('в память не попадает ничего, кроме картинки самого сайта', () => {
    expect(
      rememberItemIcons([
        { name: 'Один', image: 'https://evil.test/x.png' },
        { name: 'Два', image: 'https://pwonline.ru.evil.test/x.png' },
        { name: 'Три', image: 'javascript:alert(1)' },
        { name: 'Четыре', image: '/img/promo_items/item_1.png' },
        { name: 'Пять', image: 'https://pwonline.ru/x.png?token=secret' },
        { name: '', image: A },
        null
      ])
    ).toBe(0);
    expect(rememberedItemIcon('Один')).toBe('');
    expect(localStorage.getItem(ITEM_ICON_KEY)).toBeNull();
  });

  it('память перечитывается с диска и чистится от чужих адресов', () => {
    // Так выглядит запуск после того, как ключ записала прежняя версия приложения.
    localStorage.setItem(ITEM_ICON_KEY, JSON.stringify({ 'камень асуров': A, подделка: 'https://evil.test/x.png' }));
    expect(rememberedItemIcon('Камень асуров')).toBe(A);
    expect(rememberedItemIcon('подделка')).toBe('');
    forgetItemIcons();
    expect(rememberedItemIcon('Камень асуров')).toBe('');
    expect(localStorage.getItem(ITEM_ICON_KEY)).toBeNull();
  });

  it('память не растёт вместе со списком акций', () => {
    rememberItemIcons(Array.from({ length: ITEM_ICON_MAX + 40 }, (_, i) => ({ name: `Награда ${i}`, image: A })));
    const stored = JSON.parse(localStorage.getItem(ITEM_ICON_KEY));
    expect(Object.keys(stored)).toHaveLength(ITEM_ICON_MAX);
    // Самые первые вытеснены, последние — на месте.
    expect(rememberedItemIcon('Награда 0')).toBe('');
    expect(rememberedItemIcon(`Награда ${ITEM_ICON_MAX + 39}`)).toBe(A);
  });

  it('один и тот же адрес не пишется повторно (страницы перечитываются часто)', () => {
    expect(rememberItemIcons([{ name: 'Камень лагеря', image: A }])).toBe(1);
    expect(rememberItemIcons([{ name: 'Камень лагеря', image: A }])).toBe(0);
    expect(rememberItemIcons([{ name: 'Камень лагеря', image: B }])).toBe(1);
    expect(rememberedItemIcon('Камень лагеря')).toBe(B);
    expect(rememberItemIcons([])).toBe(0);
    expect(rememberItemIcons(undefined)).toBe(0);
  });

  it('сайт-превью обрезается по центр иконки, а нейтральный знак объясняет себя', () => {
    rememberItemIcons([{ name: 'Неизвестный предмет', image: A }]);
    const el = img(itemIconHtml('', 'Неизвестный предмет'));
    expect(el.querySelector('.site-item-icon--framed')).not.toBeNull();
    const blank = img(itemIconHtml('', 'Предмет, которого приложение никогда не видело'));
    expect(blank.querySelector('img')).toBeNull();
    expect(blank.textContent).toBe('🎁');
    expect(blank.querySelector('.site-item-icon').title).toContain('не показал картинку');
    expect(siteItemImage(A)).toBe(A);
  });

  it('списки передачи и магазина рисуют иконку через память', () => {
    // Иначе правка дошла бы только до модуля: без этих строк строки списка снова остались бы
    // без картинок, и проверить это можно только по исходнику раздела.
    for (const [file, needle] of [
      ['js/modules/automation/transfer.js', 'itemIconHtml(group.image, group.name)'],
      ['js/modules/automation/shop.js', 'itemIconHtml(it?.image, def.name)'],
      ['js/modules/automation/transferStore.js', 'rememberItemIcons(next.pending.items)'],
      ['js/modules/automation/shopStore.js', 'rememberItemIcons(Object.values(scan.items || {}))']
    ])
      expect(readFileSync(file, 'utf8'), file).toContain(needle);
  });
});
