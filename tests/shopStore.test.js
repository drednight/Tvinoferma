// Хранилище покупок за Древние монеты: аккаунты, лимиты, каталог, журнал на 300 записей.
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeScan, itemByKey, wantedNames } from '../js/modules/automation/shopCore.js';
import * as store from '../js/modules/automation/shopStore.js';
import { runPageScript, fixture } from './helpers/pageScript.js';

const NOW = new Date('2026-10-08T09:00:00Z');
const scan = () => {
  window.__TF_SHOP = { mode: 'scan', wanted: wantedNames() };
  const r = runPageScript('shop.js', fixture('site-shop.html'), 'TF_SHOP_V1_');
  return normalizeScan({ status: 'ok', ...r.data }, NOW);
};
const history = () => {
  window.__TF_SHOP = { mode: 'history', wanted: [] };
  return runPageScript('shop.js', fixture('site-shop-history.html'), 'TF_SHOP_V1_').data.rows;
};
const row = (i, extra = {}) => ({ at: new Date(NOW.getTime() + i * 1000).toISOString(), charId: 'a', nick: 'А', members: ['А'], itemKey: 'valor', item: 'Знак доблести (25 штук)', requested: 1, bought: 1, price: 10, spent: 10, status: 'done', ...extra });

beforeEach(() => { window.localStorage.clear(); });

describe('состояние', () => {
  it('запись чтения: персонажи привязываются к аккаунту, баланс и предметы сохраняются', () => {
    const { siteKey } = store.saveScan(['a', 'b'], scan(), NOW);
    expect(siteKey).toBe('acc:u_1000000001');
    expect(store.charSiteMap()).toEqual({ a: siteKey, b: siteKey });
    const acc = store.getAccount(siteKey);
    expect(acc.balance).toBe(54);
    expect(acc.items.light).toMatchObject({ found: true, price: 40, available: 4 });
    expect(acc.items.focus.found).toBe(false);
    expect(store.loadCatalog().valor).toMatchObject({ price: 10, kind: 'chest' });
    expect(store.loadCatalog().light.desc).toContain('Камень души');
  });

  it('история заполняет дату последней покупки лимитного предмета; срок — месяц от неё', () => {
    const { siteKey } = store.saveScan(['a'], scan(), NOW);
    expect(store.accountNeedsHistory(siteKey)).toBe(true);
    expect(store.applyHistory(siteKey, history(), NOW)).toBe(true);
    const t = store.getAccount(siteKey).tracks.asura;
    expect(t.lastBuyAt).toBe('2026-09-15T17:07:00.000Z');
    expect(t.resetAt).toBe('2026-10-15T17:07:00.000Z');
    expect(store.accountNeedsHistory(siteKey)).toBe(false);
  });

  it('покупка старше месяца запоминать не нужно: лимит уже обновился', () => {
    const { siteKey } = store.saveScan(['a'], scan(), NOW);
    store.applyHistory(siteKey, history(), new Date('2026-12-01T00:00:00Z'));
    expect(store.getAccount(siteKey).tracks.asura?.lastBuyAt).toBeFalsy();
  });

  it('покупка: баланс, остаток лимита и срок обновления от неё', () => {
    const { siteKey } = store.saveScan(['a'], scan(), NOW);
    store.recordPurchase(siteKey, 'light', { at: '2026-10-08T10:00:00.000Z', balanceAfter: 14, availableBefore: 4, availableAfter: 3 });
    const acc = store.getAccount(siteKey);
    expect(acc.balance).toBe(14);
    expect(acc.items.light.available).toBe(3);
    expect(acc.tracks.light).toMatchObject({ lastBuyAt: '2026-10-08T10:00:00.000Z', resetAt: '2026-11-08T10:00:00.000Z', max: 4 });
    store.recordPurchase(siteKey, 'light', { at: '2026-10-08T10:05:00.000Z', availableAfter: 0 });
    expect(store.getAccount(siteKey).items.light).toMatchObject({ available: 0, blocked: true, buyable: false });
    expect(store.getAccount(siteKey).tracks.light.resetAt).toBe('2026-11-08T10:05:00.000Z');
  });

  it('новое чтение не стирает срок, пока лимит не выросло', () => {
    const { siteKey } = store.saveScan(['a'], scan(), NOW);
    store.recordPurchase(siteKey, 'light', { at: '2026-10-08T10:00:00.000Z', availableBefore: 4, availableAfter: 4 });
    store.saveScan(['a'], scan(), new Date('2026-10-09T09:00:00Z'));
    expect(store.getAccount(siteKey).tracks.light.resetAt).toBe('2026-11-08T10:00:00.000Z');
  });

  it('баланс аккаунта после проверки; забытые персонажи убираются', () => {
    const { siteKey } = store.saveScan(['a', 'b'], scan(), NOW);
    store.setAccountBalance(siteKey, 12.5);
    expect(store.getAccount(siteKey).balance).toBe(12.5);
    store.pruneShopState(['b']);
    expect(store.charSiteMap()).toEqual({ b: siteKey });
    store.pruneShopState([]);
    expect(store.getAccount(siteKey)).toBeNull();
  });

  it('предмет нужен для каталога по названию', () => {
    expect(itemByKey('valor').chest).toBe(true);
  });
});

describe('журнал', () => {
  it('пишутся покупки и нажатые неясные исходы; пробные запуски и отказы до нажатия — нет', () => {
    expect(store.recordShopRow(row(1, { dryRun: true }))).toBeNull();
    expect(store.recordShopRow(row(2, { bought: 0, clicked: false, status: 'no_funds' }))).toBeNull();
    expect(store.recordShopRow(row(3, { bought: 0, clicked: true, status: 'unknown' }))).toBeTruthy();
    expect(store.recordShopRow(row(4))).toBeTruthy();
    const log = store.loadShopLog();
    expect(log).toHaveLength(2);
    expect(log[0].at > log[1].at).toBe(true);        // новые сверху
  });

  it('общий журнал хранит последние 300 записей', () => {
    for (let i = 0; i < store.LOG_MAX + 25; i++) store.recordShopRow(row(i, { charId: `c${i % 7}` }));
    const log = store.loadShopLog();
    expect(store.LOG_MAX).toBe(300);
    expect(log).toHaveLength(300);
    expect(log[0].at).toBe(row(324).at);
    expect(log.at(-1).at).toBe(row(25).at);
  });

  it('запись сообщает подписчикам и очищается', () => {
    let n = 0;
    const fn = () => { n++; };
    window.addEventListener('tf-shop-log', fn);
    store.recordShopRow(row(1));
    window.removeEventListener('tf-shop-log', fn);
    expect(n).toBe(1);
    store.clearShopLog();
    expect(store.loadShopLog()).toEqual([]);
  });
});
