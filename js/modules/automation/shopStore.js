// js/modules/automation/shopStore.js
// Локальное хранилище покупок за Древние монеты (только на этом компьютере, localStorage):
//  - какой аккаунт сайта у какого персонажа, его баланс и данные предметов по последнему чтению магазина;
//  - лимиты: когда была последняя покупка и когда лимит предмета обновится;
//  - каталог: цена, описание и картинка предметов (последнее, что показал сайт);
//  - журнал последних 300 покупок (общий, по всем персонажам; фильтр по нику — поиском в «Настройки → Журналы»).

import { roundCoins } from '../../core/coins.js';
import {
  SHOP_ITEMS, itemByKey, reconcileTrack, trackAfterPurchase, needsHistory, historyPurchaseAt, addMonthMsk, siteKeyOf
} from './shopCore.js';

export const STATE_KEY = 'tf_shop_state_v1';
export const LOG_KEY = 'tf_shop_log_v1';
export const LOG_MAX = 300;

const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (key, fallback) => { try { const v = JSON.parse(store()?.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* квота: данные не критичны */ } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------ состояние ------------------------------ */

export function loadShopState() {
  const raw = readJson(STATE_KEY, {});
  return {
    charSite: isObj(raw?.charSite) ? raw.charSite : {},
    accounts: isObj(raw?.accounts) ? raw.accounts : {},
    catalog: isObj(raw?.catalog) ? raw.catalog : {}
  };
}
const saveShopState = (s) => writeJson(STATE_KEY, s);
export function clearShopState() { store()?.removeItem(STATE_KEY); }

const slim = (i) => ({ found: !!i.found, price: i.price ?? null, available: i.available ?? null, max: i.max ?? null, blocked: !!i.blocked, buyable: !!i.buyable, ambiguous: !!i.ambiguous });

/** Соответствия «персонаж → ключ аккаунта». */
export const charSiteMap = () => loadShopState().charSite;

/** Каталог: последнее известное описание, картинка и цена каждого предмета. */
export const loadCatalog = () => loadShopState().catalog;

/**
 * Записывает чтение магазина (результат `normalizeScan`) для персонажей одного аккаунта.
 * @returns {{ siteKey: string, tracks: object }} ключ аккаунта
 */
export function saveScan(charIds, scan, now = new Date()) {
  const s = loadShopState();
  const siteKey = siteKeyOf(scan.account, charIds[0]);
  charIds.forEach(id => { s.charSite[id] = siteKey; });
  const acc = s.accounts[siteKey] || { tracks: {} };
  const tracks = {};
  SHOP_ITEMS.forEach(def => {
    const item = scan.items[def.key];
    const t = reconcileTrack(acc.tracks?.[def.key], item, now);
    if (t) tracks[def.key] = t;
    if (item?.found) s.catalog[def.key] = { name: def.name, siteName: item.siteName, id: item.id, kind: item.kind, price: item.price, desc: item.desc || s.catalog[def.key]?.desc || '', image: item.image || s.catalog[def.key]?.image || '', at: scan.at };
  });
  s.accounts[siteKey] = { ...acc, account: scan.account, balance: scan.balance, at: scan.at, items: Object.fromEntries(SHOP_ITEMS.map(d => [d.key, slim(scan.items[d.key] || {})])), tracks };
  saveShopState(s);
  return { siteKey, tracks };
}

/** Последнее чтение аккаунта: { account, balance, at, items: { key: предмет с описанием из каталога }, tracks } или null. */
export function getAccount(siteKey) {
  const s = loadShopState();
  const acc = s.accounts[siteKey];
  if (!acc?.items) return null;
  const items = Object.fromEntries(SHOP_ITEMS.map(def => {
    const mine = acc.items[def.key] || { found: false };
    const cat = s.catalog[def.key] || {};
    return [def.key, { key: def.key, name: def.name, siteName: cat.siteName || '', id: cat.id || '', kind: cat.kind || '', desc: cat.desc || '', image: cat.image || '', label: '', ...mine }];
  }));
  return { siteKey, account: acc.account || '', balance: Number(acc.balance) || 0, at: acc.at || null, items, tracks: isObj(acc.tracks) ? acc.tracks : {} };
}

/** Из «Истории монет»: даты последних покупок тех лимитных предметов, у которых они неизвестны. */
export function applyHistory(siteKey, rows, now = new Date()) {
  const s = loadShopState();
  const acc = s.accounts[siteKey];
  if (!acc) return false;
  let changed = false;
  SHOP_ITEMS.forEach(def => {
    const item = acc.items?.[def.key];
    const track = acc.tracks?.[def.key];
    if (!needsHistory({ ...item, found: item?.found }, track)) return;
    const at = historyPurchaseAt(rows, def);
    if (!at) return;
    const resetAt = addMonthMsk(at);
    // Покупка старше месяца: лимит уже обновился, запоминать нечего
    if (!resetAt || Date.parse(resetAt) <= now.getTime()) return;
    acc.tracks[def.key] = { ...(track || {}), lastBuyAt: at, resetAt, max: track?.max ?? null, available: item.available ?? null, seenAt: now.toISOString() };
    changed = true;
  });
  acc.historyAt = now.toISOString();
  saveShopState(s);
  return changed;
}

/** Нужна ли «История монет» этому аккаунту (есть лимитный предмет с неизвестной последней покупкой). */
export function accountNeedsHistory(siteKey) {
  const acc = getAccount(siteKey);
  return !!acc && SHOP_ITEMS.some(def => needsHistory(acc.items[def.key], acc.tracks[def.key]));
}

/** Куплен предмет: баланс, остаток лимита и срок его обновления. */
export function recordPurchase(siteKey, key, { at, balanceAfter = null, availableBefore = null, availableAfter = null }) {
  const s = loadShopState();
  const acc = s.accounts[siteKey];
  const def = itemByKey(key);
  if (!acc || !def) return;
  if (balanceAfter != null) acc.balance = roundCoins(balanceAfter);
  const item = acc.items?.[key];
  if (item && availableAfter != null) { item.available = availableAfter; item.blocked = availableAfter === 0; item.buyable = !item.blocked && item.price != null; }
  if (availableBefore != null || availableAfter != null) acc.tracks[key] = trackAfterPurchase(acc.tracks?.[key], { at, availableBefore, availableAfter });
  saveShopState(s);
}

/** Баланс аккаунта после покупок (например, по итоговой проверке). */
export function setAccountBalance(siteKey, balance) {
  const s = loadShopState();
  if (!s.accounts[siteKey]) return;
  s.accounts[siteKey].balance = roundCoins(balance);
  saveShopState(s);
}

/** Убирает персонажей, которых больше нет в приложении. */
export function pruneShopState(knownIds) {
  const s = loadShopState();
  const before = Object.keys(s.charSite).length;
  s.charSite = Object.fromEntries(Object.entries(s.charSite).filter(([id]) => knownIds.includes(id)));
  const used = new Set(Object.values(s.charSite));
  s.accounts = Object.fromEntries(Object.entries(s.accounts).filter(([k]) => used.has(k)));
  if (before !== Object.keys(s.charSite).length) saveShopState(s);
}

/* -------------------------------- журнал ------------------------------- */

/** От новых записей к старым. */
export function loadShopLog() {
  const raw = readJson(LOG_KEY, []);
  return (Array.isArray(raw) ? raw : []).filter(r => r && r.at && r.charId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export function clearShopLog() { store()?.removeItem(LOG_KEY); }

/** Запись журнала по итогу заказа (аккаунт + предмет). */
export function logEntry(row) {
  return {
    at: row.at, charId: row.charId, nick: row.nick, members: (row.members || []).slice(0, 12), account: row.account || '',
    itemKey: row.itemKey, item: row.item, requested: row.requested || 0, bought: row.bought || 0, price: row.price ?? null,
    spent: row.spent || 0, balanceBefore: row.balanceBefore ?? null, balanceAfter: row.balanceAfter ?? null,
    status: row.status, detail: row.detail || null, code: row.code || null, viaHistory: row.viaHistory || 0
  };
}

/** В журнал попадает то, что реально ушло на сайт: покупки и неясные исходы. Пробные запуски и отказы до нажатия — нет. */
export function recordShopRow(row) {
  if (row?.dryRun || !(row?.bought > 0 || row?.clicked)) return null;
  const entry = logEntry(row);
  writeJson(LOG_KEY, [entry, ...loadShopLog()].slice(0, LOG_MAX));
  try { window.dispatchEvent(new CustomEvent('tf-shop-log')); } catch { /* вне браузера */ }
  return entry;
}
