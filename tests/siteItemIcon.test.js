import { existsSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { siteItemImage, siteItemIconHtml } from '../js/modules/automation/siteItemIcon.js';
import { buildScript, fixture, runPageScript } from './helpers/pageScript.js';

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

it('crops any picture from the site preview folder, not only one item_NNN file name', () => {
  const el = document.createElement('div');
  el.innerHTML = siteItemIconHtml('https://pwonline.ru/img/promo_items/gift_9.png', 'Осколок сумеречной души');
  expect(el.querySelector('.site-item-icon--framed')).not.toBeNull();
  // И нейтральный знак объясняет, почему картинки нет.
  const blank = document.createElement('div');
  blank.innerHTML = siteItemIconHtml('', 'Предмет без картинки');
  expect(blank.querySelector('.site-item-icon').title).toContain('не показал картинку');
});

it('uses every shipped local icon before remote art, without framed cropping', async () => {
  const { localItemNames, localItemIcons, localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  expect(localItemIcons).toHaveLength(37);
  expect(new Set(localItemIcons).size).toBe(37);
  expect(localItemNames).toHaveLength(39);
  expect(new Set(localItemNames).size).toBe(39);
  for (const name of localItemNames) {
    expect(existsSync(`public/${localItemIcon(name).replace(/^\//, '')}`)).toBe(true);
    expect(localItemIcon(name)).toMatch(/assets\/icons\/items\/[a-z0-9-]+\.webp$/);
    const html = siteItemIconHtml('https://evil.test/image.png', name);
    expect(html).toContain(localItemIcon(name));
    expect(html).not.toContain('site-item-icon--framed');
    expect(html).not.toContain('evil.test');
  }
  // Каждый файл в каталоге привязан к предмету: лишних иконок нет.
  const shipped = readdirSync('public/assets/icons/items').map(f => f.replace(/\.webp$/, ''));
  expect(shipped.sort()).toEqual([...localItemIcons].sort());
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

it('matches real item labels with quantities, binding tags and typographic dashes across sections', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  for (const name of [
    'Приказ феникса (30 шт.).',
    'Приказ феникса: 30 шт.',
    'Приказ феникса ×30',
    'Приказ феникса (30 шт.) (привязанный)'
  ])
    expect(localItemIcon(name)).toContain('phoenix-order.webp');
  expect(localItemIcon('Томик стихов — Бесстрашие (10 шт.)')).toContain('poems-fearlessness.webp');
  expect(siteItemIconHtml('', 'Самоцвет грёз (доспех) (5 шт.)')).toContain('dream-gem-armor.webp');
  expect(siteItemIconHtml('', 'Приказ феникса (30 шт.)')).not.toContain('loading="lazy"');
});

it('binds the newly supplied artwork to the items it was drawn for', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  expect(localItemIcon('Карта божества')).toContain('divinity-map.webp');
  expect(localItemIcon('Карта божества x 60')).toContain('divinity-map.webp');
  expect(localItemIcon('Набор рун (8-го ур.)')).toContain('rune-set-8.webp');
  expect(localItemIcon('Запечатанная грамота Лиги')).toContain('sealed-league-charter.webp');
  // Карта божества — не камень божества, это разные предметы с разными иконками.
  expect(localItemIcon('Карта божества')).not.toBe(localItemIcon('Камень божества'));
});

it('gives the same artwork to the wordings the site uses for one item', async () => {
  const { localItemIcon, localItemWordings } = await import('../js/modules/automation/localItemIcons.js');
  expect(localItemWordings).toHaveLength(5);
  for (const wording of localItemWordings) expect(localItemIcon(wording), wording).not.toBe('');
  expect(localItemIcon('Набор рун (8-й уровень)')).toBe(localItemIcon('Набор рун (8-го ур.)'));
  expect(localItemIcon('Томик стихов: Безупречность')).toBe(localItemIcon('Томик стихов - Безупречность'));
  expect(localItemIcon('Томик стихов: Неуязвимость')).toBe(localItemIcon('Томик стихов - Неуязвимость'));
  expect(localItemIcon('Тайная пилюля: Покой')).toBe(localItemIcon('Тайная пилюля - Покой'));
});

it('keeps the platinum box and its ticket apart while using the picture the site draws', async () => {
  const { localItemIcon, localItemNames } = await import('../js/modules/automation/localItemIcons.js');
  expect(localItemNames).toContain('Шкатулка с платиновым амулетом');
  expect(localItemNames).toContain('Шкатулка с платиновым идолом');
  expect(localItemNames).toContain('Талон на платиновый амулет');
  expect(localItemNames).toContain('Талон на платиновый идол');
  // Сайт рисует для шкатулки ту же картинку, что и для талона: файл один, предметы разные.
  expect(localItemIcon('Шкатулка с платиновым амулетом')).toBe(localItemIcon('Талон на платиновый амулет'));
  expect(localItemIcon('Шкатулка с платиновым идолом')).toBe(localItemIcon('Талон на платиновый идол'));
  expect(localItemIcon('Шкатулка с платиновым амулетом')).not.toBe(localItemIcon('Шкатулка с платиновым идолом'));
});

it('does not lend an icon to a similar item', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  for (const name of [
    'Тайная пилюля: Меч',
    'Коробочка с картой C',
    'Шкатулка с картой категории S',
    'Набор рун (7 ур.)',
    'Набор рун (9 ур.)',
    'Набор рун (10 ур.)',
    'Набор рун 7-го уровня',
    'Набор рун 10-го уровня',
    'Золотая руна 8 ур.',
    'Пилюля звездного духа 1 ур.',
    'Высший камень божества',
    'Осколок сумеречной души',
    'Серебряная карта героя'
  ])
    expect(localItemIcon(name), name).toBe('');
});

it('gives every reward of a real promo answer a local icon', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  const promo = (html, mode, extra = {}) => {
    window.__TF_PIN = { mode, code: 'PWZNANIYA26', ...extra };
    return runPageScript('promo.js', html, 'TF_PIN_V1_');
  };
  const baseline = promo(fixture('site-pin-code.html'), 'inspect').data.sig;
  const rewards = promo(fixture('site-pin-result-ok.html'), 'result', { baseline }).data.rewards;
  expect(rewards).toHaveLength(13);
  for (const reward of rewards) expect(localItemIcon(reward.name), reward.name).not.toBe('');
  window.__TF_PIN = undefined;
});

it('gives every transfer item with supplied artwork a local icon', async () => {
  const { localItemIcon } = await import('../js/modules/automation/localItemIcons.js');
  const doc = new DOMParser().parseFromString(fixture('site-promoitems.html'), 'text/html');
  document.title = doc.title;
  document.body.innerHTML = doc.body.innerHTML;
  window.history.replaceState(null, '', '/promo_items.php');
  window.shards = [];
  window.__TF_XFER = { mode: 'scan' };
  new Function(buildScript('transfer.js'))();
  const payload = JSON.parse(decodeURIComponent(window.location.hash.replace('#TF_XFER_V1_', '')));
  const items = payload.data.items;
  expect(items.length).toBeGreaterThan(5);
  const withArt = items.filter(i => localItemIcon(i.name));
  expect(withArt.length).toBe(items.length - 2);
  expect(items.filter(i => !localItemIcon(i.name)).map(i => i.name)).toEqual([
    'Осколок сумеречной души',
    'Серебряная карта героя'
  ]);
  expect(localItemIcon('Тайная пилюля: Покой')).toContain('secret-pill-tranquility.webp');
  window.__TF_XFER = undefined;
});
