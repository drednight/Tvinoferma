// js/modules/automation/shopCore.js
// 🪙 Активация подарков (покупка за Древние монеты) (магазин подарков, chests2.php): чистая логика без интерфейса —
// список закреплённых предметов, разбор ответа сайта, расчёт количества и остатка, лимиты и срок их обновления,
// статусы итогов. Хранение: shopStore.js. Запуск: shopRunner.js. Диалог: shop.js. Правила: docs/COMPLIANCE.md.

import { roundCoins } from '../../core/coins.js';
import { mskDateTime, mskStamp } from '../../core/msk.js';
import { isTransient as isPromoTransient } from './promoCore.js';

/**
 * Закреплённые предметы в нужном порядке. `name` — как предмет называется на сайте (поиск по названию);
 * `event` — ивентовый предмет: если его нет в магазине, показывается заблокированным; `oldPrice` — только подсказка
 * для такого заблокированного вида (настоящая цена всегда берётся с сайта).
 */
export const SHOP_ITEMS = Object.freeze([
  { key: 'light', name: 'Камень светлого духа', icon: '💎' },
  { key: 'asura', name: 'Камень асуров', icon: '💎' },
  { key: 'camp', name: 'Камень лагеря', icon: '💎' },
  { key: 'sovereign', name: 'Камень государя', icon: '💎' },
  { key: 'valor', name: 'Знак доблести (25 штук)', icon: '🎖️', chest: true },
  { key: 'unity', name: 'Знак единства (25 штук)', icon: '🎖️', chest: true },
  { key: 'focus', name: 'Сундук средоточия', icon: '🎁', event: true, oldPrice: 30 },
  { key: 'guide', name: 'Ключ от Книги наставлений', icon: '🗝️', event: true, oldPrice: 50 }
]);

export const itemByKey = (key) => SHOP_ITEMS.find(i => i.key === key) || null;
export const wantedNames = () => SHOP_ITEMS.map(i => i.name);

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lower = (s) => squash(s).toLowerCase().replace(/ё/g, 'е');
const baseName = (s) => squash(String(s).replace(/\s*\([^)]*\)\s*$/, ''));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* ------------------------------------------------------------------ */
/*  Ответ сайта                                                         */
/* ------------------------------------------------------------------ */

/** Описание с сайта: без служебной подписи «Описание:», по строкам. */
export function cleanDesc(text) {
  return String(text ?? '').split('\n').map(l => squash(l).replace(/^Описание:\s*/i, '')).filter(Boolean).join('\n').slice(0, 700);
}

/**
 * Предмет из ответа `read_shop` в рабочий вид.
 * `available` — сколько ещё можно купить (null — у предмета нет лимита); `buyable` — кнопку «Купить» можно нажать.
 */
export function normalizeScanItem(raw, def) {
  const empty = { key: def.key, name: def.name, found: false, ambiguous: raw?.ambiguous === true, buyable: false, price: null, available: null, max: null, blocked: false, id: '', kind: '', desc: '', image: '', label: '' };
  if (!raw || raw.found !== true) return empty;
  const price = numOrNull(raw.price);
  const available = numOrNull(raw.available) == null ? null : Math.max(0, Math.floor(Number(raw.available)));
  const blocked = raw.blocked === true || available === 0;
  return {
    key: def.key, name: def.name, found: true, ambiguous: false,
    siteName: squash(raw.name), id: String(raw.id ?? ''), kind: raw.kind === 'chest' ? 'chest' : 'item',
    price: price != null && price > 0 ? roundCoins(price) : null,
    available,
    max: numOrNull(raw.max) != null ? Math.max(0, Math.floor(Number(raw.max))) : null,
    blocked,
    buyable: price != null && price > 0 && !blocked && raw.hasLink !== false,
    desc: cleanDesc(raw.desc),
    image: /^https:\/\/[^\s"'<>]+$/.test(String(raw.image || '')) ? String(raw.image) : '',
    label: squash(raw.label)
  };
}

/** Ответ `read_shop` → { account, balance, at, items: { [key]: предмет } } или null, если ответ не годится. */
export function normalizeScan(payload, now = new Date()) {
  if (!payload || payload.status !== 'ok') return null;
  const balance = numOrNull(payload.balance);
  if (balance == null || balance < 0) return null;
  const list = Array.isArray(payload.items) ? payload.items : [];
  const items = {};
  SHOP_ITEMS.forEach(def => { items[def.key] = normalizeScanItem(list.find(i => i?.want === def.name), def); });
  return { account: squash(payload.account).slice(0, 60), balance: roundCoins(balance), at: now.toISOString(), items };
}

/** Ключ аккаунта сайта: у персонажей одного аккаунта один баланс и общие лимиты. Пока аккаунт неизвестен — сам персонаж. */
export const siteKeyOf = (account, charId) => (squash(account) ? `acc:${squash(account)}` : `char:${charId}`);

/**
 * Персонажи → аккаунты сайта (каждый аккаунт один раз). `charSite` — известные соответствия { id персонажа: ключ }.
 * @returns {Array<{ siteKey: string, members: object[] }>} в порядке появления, персонажи внутри — в исходном порядке
 */
export function groupAccounts(chars, charSite = {}) {
  const groups = new Map();
  for (const c of chars || []) {
    const key = charSite[c.id] || siteKeyOf('', c.id);
    if (!groups.has(key)) groups.set(key, { siteKey: key, members: [] });
    groups.get(key).members.push(c);
  }
  return [...groups.values()];
}

/** Кто из персонажей аккаунта читает сайт и покупает: с известным входом, лучше из `prefer`; без входа — никто. */
export function pickRepresentative(members, prefer = new Set()) {
  const ok = (members || []).filter(c => c.isLoggedIn !== false);
  return ok.find(c => c.isLoggedIn === true && prefer.has(c.id)) || ok.find(c => prefer.has(c.id)) || ok.find(c => c.isLoggedIn === true) || ok[0] || null;
}

/* ------------------------------------------------------------------ */
/*  Расчёт                                                              */
/* ------------------------------------------------------------------ */

/** Сколько штук можно купить: не больше желаемого, остатка лимита и того, что позволяет баланс. */
export function planQty({ requested, price, balance, available = null }) {
  const want = Math.max(0, Math.floor(Number(requested) || 0));
  const bal = roundCoins(balance);
  if (!want || !(price > 0)) return { requested: want, qty: 0, cost: 0, fullCost: 0, left: bal, cap: null };
  const byFunds = Math.max(0, Math.floor((bal + 1e-6) / price + 1e-9));
  const byLimit = available == null ? Infinity : Math.max(0, Math.floor(available));
  const qty = Math.min(want, byFunds, byLimit);
  const cap = qty >= want ? null : (byLimit <= byFunds ? 'limit' : 'funds');
  const cost = roundCoins(qty * price);
  return { requested: want, qty, cost, fullCost: roundCoins(want * price), left: roundCoins(bal - cost), cap };
}

/**
 * План по аккаунту: предметы по порядку списка делят один баланс (то, что осталось после первого, достаётся следующему).
 * @param {{ balance: number, orders: Array<{ key: string, requested: number, price: number|null, available: number|null }> }} p
 */
export function planAccount({ balance, orders }) {
  let left = roundCoins(balance);
  const rows = (orders || []).map(o => {
    const plan = planQty({ requested: o.requested, price: o.price, balance: left, available: o.available });
    left = plan.left;
    return { key: o.key, price: o.price, ...plan };
  });
  return { rows, spent: roundCoins(balance - left), left, qty: rows.reduce((n, r) => n + r.qty, 0), requested: rows.reduce((n, r) => n + r.requested, 0) };
}

/** Хватит ли монет хотя бы на один предмет из списка (учитывается только то, что можно купить). */
export const canAffordAny = (balance, items) => (items || []).some(i => i?.buyable && i.price != null && roundCoins(balance) + 1e-6 >= i.price);

/**
 * Сначала те, кто может позволить хотя бы один предмет, затем остальные. Внутри групп: если передан `balance` — по убыванию
 * баланса (чем меньше монет, тем ниже), при равенстве и без `balance` — по нику.
 */
export function sortByAffordability(list, { can, nick, balance = null }) {
  const byNick = (a, b) => String(nick(a)).localeCompare(String(nick(b)), 'ru');
  const cmp = (a, b) => (balance ? (Number(balance(b)) || 0) - (Number(balance(a)) || 0) : 0) || byNick(a, b);
  const yes = list.filter(x => can(x)).sort(cmp);
  const no = list.filter(x => !can(x)).sort(cmp);
  return [...yes, ...no];
}

/* ------------------------------------------------------------------ */
/*  Лимиты и срок их обновления                                         */
/* ------------------------------------------------------------------ */

const MSK_MS = 3 * 3600 * 1000;
const DAY_MS = 86400000;

/** Через месяц по московскому календарю (31 января → 28/29 февраля). */
export function addMonthMsk(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + MSK_MS);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  const next = Date.UTC(y, m + 1, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return new Date(next - MSK_MS).toISOString();
}

/** «2026-10-07 01:11» (время сайта — московское) → ISO. */
export function siteStampToIso(at) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(at ?? ''));
  if (!m) return null;
  const d = mskDateTime(m[1], m[2]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Запись о лимите предмета у аккаунта после чтения сайта.
 * `lastBuyAt` — последняя покупка (лимит обновляется через месяц после неё, даже если куплено не всё),
 * `resetAt` — когда это произойдёт. Лимит обновился, если срок прошёл или «Доступно» выросло по сравнению с прошлым чтением.
 * @returns {object|null} null — у предмета нет лимита
 */
export function reconcileTrack(track, item, now = new Date()) {
  if (!item?.found || item.available == null) return null;
  const t = { lastBuyAt: null, resetAt: null, max: null, available: null, ...(track || {}) };
  if (t.resetAt && Date.parse(t.resetAt) <= now.getTime()) { t.lastBuyAt = null; t.resetAt = null; }
  if (t.available != null && item.available > t.available) { t.lastBuyAt = null; t.resetAt = null; }
  t.max = Math.max(t.max || 0, item.max || 0, item.available) || null;
  t.available = item.available;
  t.seenAt = now.toISOString();
  if (t.lastBuyAt && !t.resetAt) t.resetAt = addMonthMsk(t.lastBuyAt);
  return t;
}

/** После покупки: срок обновления лимита отсчитывается от неё. */
export function trackAfterPurchase(track, { at, availableBefore = null, availableAfter = null }) {
  const t = { lastBuyAt: null, resetAt: null, max: null, available: null, ...(track || {}) };
  t.lastBuyAt = at;
  t.resetAt = addMonthMsk(at);
  if (availableAfter != null) t.available = availableAfter;
  if (availableBefore != null) t.max = Math.max(t.max || 0, availableBefore);
  t.seenAt = at;
  return t;
}

/** Нужна ли «История монет»: лимит уже тронут, а когда была последняя покупка — неизвестно. */
export function needsHistory(item, track) {
  if (!item?.found || item.available == null || track?.lastBuyAt) return false;
  const max = Math.max(track?.max || 0, item.max || 0);
  return item.available === 0 || (max > 0 && item.available < max);
}

const isPurchaseOf = (row, def) => Number(row?.delta) < 0 && lower(row?.action).includes(lower(baseName(def.name)));

/** Самая новая покупка предмета в «Истории монет» (ISO) или null. */
export function historyPurchaseAt(rows, def) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isPurchaseOf(r, def)) continue;
    const iso = siteStampToIso(r.at);
    if (iso && (!best || iso > best)) best = iso;
  }
  return best;
}

/** Сколько записей «Покупка …» этого предмета на эту цену появилось с момента `sinceIso` (минутная точность истории). */
export function countHistoryPurchases(rows, def, price, sinceIso) {
  const since = Date.parse(sinceIso) - 60000;
  return (Array.isArray(rows) ? rows : []).filter(r => {
    const iso = siteStampToIso(r?.at);
    return isPurchaseOf(r, def) && Math.abs(Math.abs(Number(r.delta)) - price) < 0.05 && iso && Date.parse(iso) >= since;
  }).length;
}

const fmtDate = (iso) => mskStamp(iso).slice(0, 10);

/** Как показать лимит: { limited, available, max, exhausted, resetAt, daysLeft, text } или null, если лимита нет. */
export function limitView(item, track, now = new Date()) {
  if (!item?.found || item.available == null) return null;
  const exhausted = item.available === 0;
  const resetAt = track?.resetAt && Date.parse(track.resetAt) > now.getTime() ? track.resetAt : null;
  const daysLeft = resetAt ? Math.max(0, Math.ceil((Date.parse(resetAt) - now.getTime()) / DAY_MS)) : null;
  const max = Math.max(track?.max || 0, item.max || 0) || null;
  const left = resetAt ? `обновится ${fmtDate(resetAt)} (${daysLeft > 0 ? `через ${daysLeft} дн.` : 'сегодня'})` : (exhausted ? 'дата обновления лимита неизвестна' : '');
  const head = exhausted ? 'лимит исчерпан' : `доступно ${item.available}${max && max >= item.available ? ` из ${max}` : ''}`;
  return { limited: true, available: item.available, max, exhausted, resetAt, daysLeft, text: left ? `${head}, ${left}` : head };
}

/* ------------------------------------------------------------------ */
/*  Результат покупки                                                   */
/* ------------------------------------------------------------------ */

export const RESULT_INFO = {
  done: { icon: '✅', label: 'Куплено', level: 'ok' },
  limit: { icon: '🔒', label: 'Куплено до лимита', level: 'warn' },
  no_funds: { icon: '🪙', label: 'Не хватило монет', level: 'warn' },
  price_changed: { icon: '💱', label: 'Цена изменилась — остановлено', level: 'warn' },
  missing: { icon: '🚫', label: 'Нет в магазине', level: 'warn' },
  no_effect: { icon: '⚠️', label: 'Сайт не провёл покупку', level: 'warn' },
  unknown: { icon: '❓', label: 'Результат не распознан — проверьте вручную', level: 'warn' },
  not_logged_in: { icon: '🔴', label: 'Нет входа', level: 'warn' },
  challenge: { icon: '🛡️', label: 'Нужна проверка безопасности', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  dry_run: { icon: '👁', label: 'Пробный запуск: кнопка найдена, не нажата', level: 'info' },
  cancelled: { icon: '⏹', label: 'Остановлено кнопкой «Стоп»', level: 'info' },
  not_run: { icon: '⏭', label: 'Не выполнялось', level: 'info' },
  skipped: { icon: '➖', label: 'Не покупалось', level: 'info' }
};
export const resultInfo = (status) => RESULT_INFO[status] || RESULT_INFO.error;

/** Подпись итога: «Куплено до лимита: 4 из 6». */
export function resultLabel(row) {
  const info = resultInfo(row?.status);
  const n = Number(row?.requested) || 0;
  if (row?.status === 'limit' && !row.bought) return 'Лимит исчерпан — не куплено';
  if (['done', 'limit', 'no_funds', 'unknown', 'no_effect', 'price_changed', 'cancelled'].includes(row?.status) && n && (row.bought || row.status !== 'cancelled')) return `${info.label}: ${row.bought || 0} из ${n}`;
  return info.label;
}

/** Ошибки, после которых имеет смысл подождать и повторить (покупка ещё не нажата). */
export const SHOP_TRANSIENT = new Set(['timeout', 'pending', 'click_failed', 'modal_missing', 'button_not_found']);
export const isTransient = (code) => !!code && (SHOP_TRANSIENT.has(code) || isPromoTransient(code));

/**
 * Что делать после ответа `buy_shop_item` (или ошибки вызова).
 * kind: `bought` — куплено, продолжаем; `stop` — этот предмет закончен, статус записан; `block` — остальное у аккаунта
 * не выполнять; `retry` — можно повторить (покупка не нажималась); `dry` — пробный запуск.
 */
export function interpretBuy(payload, error) {
  if (error || !payload) return { kind: 'retry', status: 'error', code: String(error?.message || error || 'no_response') };
  const code = payload.error || null;
  switch (payload.status) {
    case 'success': return { kind: 'bought', status: 'done' };
    case 'dry_run': return { kind: 'dry', status: 'dry_run' };
    case 'limit_reached': return { kind: 'stop', status: 'limit' };
    case 'no_funds': return { kind: 'stop', status: 'no_funds' };
    case 'price_changed': return { kind: 'stop', status: 'price_changed', price: numOrNull(payload.info?.price) };
    case 'item_missing': return { kind: 'stop', status: 'missing' };
    case 'no_effect': return { kind: 'stop', status: 'no_effect' };
    case 'unknown': return { kind: 'block', status: 'unknown', code };
    case 'not_logged_in': return { kind: 'block', status: 'not_logged_in' };
    case 'challenge': return { kind: 'block', status: 'challenge' };
    default:
      if (code === 'window_open') return { kind: 'block', status: 'error', code };
      if (!payload.clicked && isTransient(code)) return { kind: 'retry', status: 'error', code };
      return { kind: 'stop', status: 'error', code };
  }
}

/** Из ответа покупки: монеты и остаток лимита после неё (если страница их показала). */
export function afterPurchase(payload, def) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const raw = items.find(i => i?.want === def.name);
  return {
    balance: numOrNull(payload?.balanceAfter),
    item: raw ? normalizeScanItem(raw, def) : null
  };
}

/** Итог по набору строк. */
export function summarizeRows(rows) {
  const list = rows || [];
  const sum = (f) => list.reduce((n, r) => n + (f(r) || 0), 0);
  return {
    total: list.length,
    bought: sum(r => r.bought),
    spent: roundCoins(sum(r => r.spent)),
    done: list.filter(r => r.status === 'done').length,
    limited: list.filter(r => r.status === 'limit').length,
    noFunds: list.filter(r => r.status === 'no_funds').length,
    unknown: list.filter(r => r.status === 'unknown').length,
    dry: list.filter(r => r.status === 'dry_run').length,
    failed: list.filter(r => ['error', 'not_logged_in', 'challenge', 'no_effect', 'missing', 'price_changed'].includes(r.status)).length,
    notRun: list.filter(r => r.status === 'cancelled' || r.status === 'not_run').length
  };
}
