import { expect, it } from 'vitest';
import { siteItemImage, siteItemIconHtml } from '../js/modules/automation/siteItemIcon.js';
it('renders only actual same-site HTTPS images without credentials, queries, fragments or arbitrary remote hosts', () => {
  const image = 'https://pwonline.ru/images/items/site-original.png';
  expect(siteItemImage(image)).toBe(image);
  const el = document.createElement('div');
  el.innerHTML = siteItemIconHtml(image);
  expect(el.querySelector('img').getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(el.querySelector('img').src).toBe(image);
  for (const url of [
    'javascript:alert(1)',
    'data:image/svg+xml,hi',
    'http://pwonline.ru/x',
    'https://pwonline.ru.evil.test/x',
    'https://evil.test/x',
    'https://user@pwonline.ru/x',
    'https://pwonline.ru/x?token=secret',
    'https://pwonline.ru/x#secret',
    'https://pwonline.ru:8443/x'
  ]) {
    expect(siteItemImage(url)).toBe('');
    expect(siteItemIconHtml(url)).not.toContain('<img');
  }
});
it('keeps a neutral fallback rather than guessing an icon from an item name', () => {
  expect(siteItemIconHtml('')).toContain('🎁');
});

it('crops only the framed promo item preview to its central icon, shared by shop and transfer', () => {
  const image = '//cdn.pwonline.ru/img/promo_items/item_72297.png';
  const el = document.createElement('div');
  el.innerHTML = siteItemIconHtml(image, 'Небесная пилюля 1-го уровня');
  expect(el.querySelector('.site-item-icon--framed')).not.toBeNull();
  expect(el.querySelector('img').src).toBe('https:' + image);
  expect(siteItemIconHtml(image, 'Сундук караванщика')).not.toContain('site-item-icon--framed');
  expect(siteItemIconHtml('https://cdn.pwonline.ru/images/chest.png')).not.toContain('site-item-icon--framed');
});
