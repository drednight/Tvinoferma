import { existsSync } from 'node:fs';
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
  el.innerHTML = siteItemIconHtml(image, 'Неизвестный предмет');
  expect(el.querySelector('.site-item-icon--framed')).not.toBeNull();
  expect(el.querySelector('img').src).toBe('https:' + image);
  expect(siteItemIconHtml(image, 'Сундук караванщика')).not.toContain('site-item-icon--framed');
  expect(siteItemIconHtml('https://cdn.pwonline.ru/images/chest.png')).not.toContain('site-item-icon--framed');
});

it('uses all 34 exact local icons before remote art, without framed cropping', async () => {
  const { localItemNames, localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  expect(localItemNames).toHaveLength(34);
  expect(new Set(localItemNames).size).toBe(34);
  for (const name of localItemNames) {
    expect(existsSync(`public/${localItemIcon(name).replace(/^\//, '')}`)).toBe(true);
    expect(localItemIcon(name)).toMatch(/assets\/icons\/items\/[a-z0-9-]+\.webp$/);
    const html = siteItemIconHtml('https://evil.test/image.png', name);
    expect(html).toContain(localItemIcon(name));
    expect(html).not.toContain('site-item-icon--framed');
    expect(html).not.toContain('evil.test');
  }
  expect(localItemIcon('  Набор «Самоцветы грёз» ')).toBe(localItemIcon('Набор «Самоцветы грез»'));
  expect(localItemIcon('Великий метеорит (+ бонус)')).toBe('');
});

it('keeps the three dream gem categories distinct and normalizes ё and whitespace', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  const urls = ['доспех', 'оружие', 'реликвия'].map(category => localItemIcon(`Самоцвет грез (${category})`));
  expect(new Set(urls).size).toBe(3);
  expect(urls.every(Boolean)).toBe(true);
  expect(localItemIcon('  Самоцвет грёз (доспех)  ')).toBe(urls[0]);
  expect(localItemIcon('Золотой камень жребия')).not.toBe(localItemIcon('Серебряный камень жребия'));
});
