// js/modules/automation/transferStore.js
// Локальное хранилище передачи предметов (Issue #26). Только на этом компьютере (localStorage):
//  - списки серверов и персонажей для каждого браузера (чтобы не читать сайт при каждом открытии окна);
//  - настройки окна: сервер и получатель каждого браузера;
//  - журнал передач: когда, откуда, куда, что и чем закончилось.

import { normalizeRoster, normalizeStatus, normKey } from './transferCore.js';

export const ROSTER_KEY = 'tf_transfer_roster_v1';
export const PREFS_KEY = 'tf_transfer_prefs_v1';
export const STATUS_KEY = 'tf_transfer_servers_v1';
export const LIMITS_KEY = 'tf_transfer_limits_v1';
export const LIMITS_TTL_DAYS = 60;
export const LOG_KEY = 'tf_transfer_log_v1';
export const LOG_MAX = 300;

const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (key, fallback) => { try { const v = JSON.parse(store()?.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* квота: данные не критичны */ } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/* ------------------------- серверы и персонажи ------------------------- */

/** { [id браузера]: список } — списки, которые есть. */
export function loadRosters() {
  const raw = readJson(ROSTER_KEY, {});
  return isObj(raw) ? Object.fromEntries(Object.entries(raw).filter(([, r]) => isObj(r) && Array.isArray(r.shards))) : {};
}
export const saveRosters = (rosters) => writeJson(ROSTER_KEY, rosters);

/**
 * Записывает прочитанное со страницы сайта.
 *
 * Пустая страница («У Вас нет подарков, которые можно перевести в игру») не содержит ни
 * серверов, ни персонажей: сайт объявляет `shards` только когда есть что передавать. Если
 * записать её как есть, один пустой заход стёр бы всё, что нашли раньше, — и персонаж
 * «потерял» бы серверы. Поэтому при пустом чтении сохраняем прежние серверы и персонажей,
 * а список «что ждёт передачи» обновляем: сейчас там действительно пусто, и перенос
 * персонажа пропускается (см. `planTransfer`, статус `nothing_to_transfer`).
 */
export function setRoster(charId, data, now = new Date()) {
  const all = loadRosters();
  const next = normalizeRoster(data, now);
  const prev = all[charId];
  if (next.shards.length === 0 && prev?.shards?.length) {
    next.shards = prev.shards;
    next.siteId = next.siteId || prev.siteId;
    next.accountName = next.accountName || prev.accountName;
  }
  all[charId] = next;
  saveRosters(all);
  return all[charId];
}

/**
 * Сверка сохранённого с тем, что показал сайт.
 *
 * Персонажи на аккаунте меняются: кого-то переименовали, кого-то удалили. Старые записи
 * в этом случае вредны — приложение предлагало бы получателя, которого уже нет. Поэтому:
 *  - выборы получателей, которых на сайте больше нет, удаляем;
 *  - если наш персонаж был виден в прошлом чтении (`prev`), а теперь его нет — считаем,
 *    что его переименовали или удалили, и сбрасываем его сервер и выборы.
 *
 * Важно: одиночное несовпадение ников ничего не значит. Ник в карточке и список на сайте
 * могут расходиться с первого чтения (аккаунт ведёт другой персонаж, ник сменился до нас),
 * и сбрасывать настройки по такому признаку — вредно. Поэтому сверяем только «было → стало».
 *
 * @param {string} charId
 * @param {string} [charNick] ник персонажа из карточки
 * @param {object} [prev] снимок до этого чтения (без него сверка ников не выполняется)
 * @returns {{ gone: string[], missingChar: boolean }} что именно разошлось со снимком сайта
 */
export function reconcileRoster(charId, charNick, prev) {
  const roster = loadRosters()[charId];
  if (!roster) return { gone: [], missingChar: false };
  const prefs = loadPrefs();
  const keys = new Set((roster.shards || []).flatMap(s => (s.chars || []).map(c => c.key)));
  const gone = Object.entries(prefs.picks?.[charId] || {})
    .filter(([, key]) => !keys.has(key))
    .map(([sid]) => sid);
  const hasNick = (list) => !!charNick && (list || []).some(n => n && normKey(n) === normKey(charNick));
  const names = (roster.shards || []).flatMap(s => (s.chars || []).map(c => c.name));
  const missingChar = hasNick(prev?.shards?.flatMap(s => (s.chars || []).map(c => c.name))) && !hasNick(names);
  if (gone.length) {
    for (const sid of gone) delete prefs.picks[charId][sid];
    if (!Object.keys(prefs.picks[charId]).length) delete prefs.picks[charId];
  }
  if (missingChar) delete prefs.servers[charId];
  if (gone.length || missingChar) savePrefs(prefs);
  return { gone, missingChar };
}

/** После передачи список «что ждёт» устарел: он помечается неизвестным, пока список не обновят. */
export function clearPending(charId) {
  const all = loadRosters();
  if (!all[charId]) return;
  all[charId].pending = { items: [], chests: all[charId].pending?.chests || 0, locked: all[charId].pending?.locked || 0, stale: true };
  saveRosters(all);
}

/** Убирает списки удалённых браузеров. */
export function pruneRosters(knownIds) {
  const all = loadRosters();
  const keep = Object.fromEntries(Object.entries(all).filter(([id]) => knownIds.includes(id)));
  if (Object.keys(keep).length !== Object.keys(all).length) saveRosters(keep);
}

/* ------------------------- список серверов сайта ------------------------ */

/** Последнее чтение страницы «Статус серверов»: { at, servers: [{ name, online }], recommended } или null. */
export function loadStatus() {
  const raw = readJson(STATUS_KEY, null);
  return isObj(raw) && Array.isArray(raw.servers) ? raw : null;
}
export function saveStatus(data, now = new Date()) {
  const status = normalizeStatus(data, now);
  if (status.servers.length) writeJson(STATUS_KEY, status);
  return status;
}

/* ------------------------------ настройки ------------------------------ */

/** { servers: { [id браузера]: id сервера }, picks: { [id браузера]: { [id сервера]: ключ получателя } } } */
export function loadPrefs() {
  const raw = readJson(PREFS_KEY, {});
  return { servers: isObj(raw?.servers) ? raw.servers : {}, picks: isObj(raw?.picks) ? raw.picks : {} };
}
export const savePrefs = (prefs) => writeJson(PREFS_KEY, prefs);

/* ------------------- акции, привязанные к серверу ------------------- */

/**
 * Акции, которые сайт принимает только на один сервер («данные предметы можно перевести только на сервер «Мицар»»).
 * Выясняется по предупреждению сайта после передачи; такие предметы потом не отмечаются на других серверах.
 * Запись живёт LIMITS_TTL_DAYS дней: если правила сайта изменятся, ограничение само исчезнет.
 * @returns {Record<string, { source: string, server: string, at: string }>} ключ — normKey(акции)
 */
export function loadLimits(now = new Date()) {
  const raw = readJson(LIMITS_KEY, {});
  if (!isObj(raw)) return {};
  const maxAge = LIMITS_TTL_DAYS * 86400000;
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => isObj(v) && v.source && v.server && now.getTime() - Date.parse(v.at) <= maxAge));
}
/** Простой вид для планирования: ключ акции → название сервера. */
export function limitsMap(now = new Date()) {
  return Object.fromEntries(Object.entries(loadLimits(now)).map(([k, v]) => [k, v.server]));
}
/** Запоминает: акции `sources` принимаются только на сервер `server`. */
export function saveLimits({ server, sources }, now = new Date()) {
  const all = loadLimits(now);
  (sources || []).forEach(s => { if (String(s).trim()) all[normKey(s)] = { source: String(s).trim().slice(0, 120), server: String(server).trim().slice(0, 40), at: now.toISOString() }; });
  writeJson(LIMITS_KEY, all);
  return all;
}
export function clearLimits() { store()?.removeItem(LIMITS_KEY); }

/* -------------------------------- журнал ------------------------------- */

/** От новых записей к старым. */
export function loadTransferLog() {
  const raw = readJson(LOG_KEY, []);
  return (Array.isArray(raw) ? raw : []).filter(r => r && r.at && r.charId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export function clearTransferLog() { store()?.removeItem(LOG_KEY); }

/**
 * Запись журнала по строке результата. Пробные запуски и строки без нажатия «Передать» не записываются:
 * журнал — про то, что реально ушло на сайт (или могло уйти: «результат не распознан»).
 */
export function logEntry(row) {
  return {
    at: row.at, charId: row.charId, nick: row.nick, shardId: row.shardId, server: row.server, recipient: row.recipient,
    status: row.status, detail: row.detail || null, count: row.count || 0,
    items: (row.items || []).map(i => ({ name: i.name, qty: i.qty })),
    done: (row.done || []).map(i => ({ name: i.name, qty: i.qty })),
    missing: (row.missing || []).map(i => ({ name: i.name, qty: i.qty, source: i.source || '' })),
    limited: (row.limited || []).map(i => ({ name: i.name, qty: i.qty, source: i.source || '', server: i.server || '' })),
    warning: row.warning ? row.warning.message : null,
    siteStatus: [...new Set((row.history || []).map(h => h.status).filter(Boolean))].join(', ')
  };
}

export function recordTransfer(row) {
  if (!row?.clicked || row.dryRun) return null;
  const entry = logEntry(row);
  writeJson(LOG_KEY, [entry, ...loadTransferLog()].slice(0, LOG_MAX));
  try { window.dispatchEvent(new CustomEvent('tf-transfer-log')); } catch { /* вне браузера */ }
  return entry;
}
