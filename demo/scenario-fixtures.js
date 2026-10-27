// demo/scenario-fixtures.js
// Только вымышленные данные для интерактивного макета. Здесь нет доступа к сайту,
// Rust-команд и хранилища приложения. Изменения живут только до закрытия окна.
//
// Каталог и расчёт плана берутся из настоящего shopCore.js. Тексты шести
// предметов и примерные цены ниже взяты из tests/fixtures/site-shop.html;
// это снимок страницы, а не обещание актуальной цены/наличия в игре.

import { SHOP_ITEMS } from '../js/modules/automation/shopCore.js';
import { CHARS } from './lab-data.js';

const DESCRIPTIONS = {
  light: 'Камень души для инкрустации экипировки 13-го уровня и выше; повышает показатель атаки на 2.',
  asura: 'Камень души для инкрустации бижутерии 13-го уровня и выше; повышает показатель атаки на 2.',
  camp: 'Камень души для инкрустации экипировки 13-го уровня и выше; повышает показатель защиты на 2.',
  sovereign: 'Камень души для инкрустации бижутерии 13-го уровня и выше; повышает показатель защиты на 2.',
  valor:
    'Набор из 25 знаков доблести. По описанию сайта: награда за ежедневные задания гильдии, используется для синтеза карт.',
  unity:
    'Набор из 25 знаков единства. По описанию сайта: награда за испытания Тайной обители гильдии, используется для синтеза магических карт.'
};

const ACCOUNTS = {
  'site-1': {
    balance: 1250,
    limit: 4,
    pending: [
      { name: 'Камень светлого духа', qty: 2 },
      { name: 'Подарок акции', qty: 1 }
    ],
    chests: 2
  },
  'site-2': { balance: 90, limit: 1, pending: [{ name: 'Знак доблести', qty: 25 }], chests: 0 },
  'site-3': { balance: 295, limit: 3, pending: [{ name: 'Камень лагеря', qty: 3 }], chests: 1 },
  'site-4': { balance: 15, limit: 2, pending: [{ name: 'Знак единства', qty: 25 }], chests: 3 },
  'site-5': { balance: 420, limit: 2, pending: [], chests: 0 }
};

export const demoAccountName = key => `Аккаунт ${String(key).replace('site-', '')} (пример)`;

/** Отдельная копия «сайта» на окно: после имитации покупки/передачи её можно обновить. */
export function createDemoSite() {
  return Object.fromEntries(
    Object.entries(ACCOUNTS).map(([account, source]) => {
      const items = Object.fromEntries(
        SHOP_ITEMS.map(item => {
          if (item.event) return [item.key, { found: false, buyable: false, price: null, available: null, desc: '' }];
          return [
            item.key,
            {
              found: true,
              buyable: true,
              price: item.chest ? 10 : 40,
              available: item.chest ? null : source.limit,
              desc: DESCRIPTIONS[item.key] || ''
            }
          ];
        })
      );
      return [
        account,
        { balance: source.balance, items, pending: source.pending.map(i => ({ ...i })), chests: source.chests }
      ];
    })
  );
}

/** Фиктивные серверы и получатели в том же формате, что читает transferCore. */
export function demoRoster(char, site) {
  const n = Number(char.account.replace('site-', ''));
  const members = CHARS.filter(c => c.account === char.account);
  const chars = members.map((c, index) => ({
    key: `${n}_1_${index + 1}`,
    name: c.nick,
    cls: c.cls,
    level: 100
  }));
  return {
    siteId: char.account,
    accountName: demoAccountName(char.account),
    shards: [
      { id: '1', name: 'Сервер 1 (пример)', chars },
      { id: '2', name: 'Сервер 2 (пример)', chars: [{ key: `${n}_2_1`, name: char.nick, cls: char.cls, level: 100 }] }
    ],
    pending: { items: site.pending.map(i => ({ ...i })), chests: site.chests, locked: 0 }
  };
}
