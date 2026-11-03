import { beforeEach, it, expect } from 'vitest';
import { saveScan, getAccount } from '../js/modules/automation/shopStore.js';
import { SHOP_ITEMS, normalizeScan, limitView } from '../js/modules/automation/shopCore.js';
import { siteItemImage } from '../js/modules/automation/siteItemIcon.js';
beforeEach(() => localStorage.clear());
const scan = (account, available, max = null) =>
  normalizeScan({
    status: 'ok',
    account,
    balance: 100,
    items: [{ want: SHOP_ITEMS[0].name, found: true, price: 40, available, max, hasLink: true }]
  });
it('remembers highest observed remainder for an item across accounts, never reduces it on a later lower scan', () => {
  const a = saveScan(['a'], scan('A', 4)),
    b = saveScan(['b'], scan('B', 2));
  saveScan(['a'], scan('A', 1));
  expect(limitView(getAccount(b.siteKey).items.light)).toMatchObject({ available: 2, max: 4, maxSource: 'observed' });
  expect(limitView(getAccount(a.siteKey).items.light)).toMatchObject({ available: 1, max: 4 });
});
it('explicit N-of-X remains authoritative and is distinguished from observation', () => {
  saveScan(['a'], scan('A', 4));
  const b = saveScan(['b'], scan('B', 1, 3));
  expect(limitView(getAccount(b.siteKey).items.light)).toMatchObject({ max: 3, maxSource: 'site' });
});
it('accepts the actual protocol-relative CDN image, rejects lookalikes and tokenized or executable URLs', () => {
  expect(siteItemImage('//cdn.pwonline.ru/img/promo_items/item_47278.png')).toBe(
    'https://cdn.pwonline.ru/img/promo_items/item_47278.png'
  );
  for (const url of [
    'javascript:alert(1)',
    'https://cdn.pwonline.ru.evil.test/x.png',
    'https://cdn.pwonline.ru/x.png?token=secret',
    'https://user:pass@cdn.pwonline.ru/x.png'
  ])
    expect(siteItemImage(url)).toBe('');
});
