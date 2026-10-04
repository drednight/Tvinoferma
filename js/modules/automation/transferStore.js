// js/modules/automation/transferStore.js
// Локальное хранилище передачи предметов (Issue #26). Только на этом компьютере (localStorage):
//  - списки серверов и персонажей для каждого браузера (чтобы не читать сайт при каждом открытии окна);
//  - настройки окна: последний сервер и выбранные получатели;
//  - журнал передач: когда, откуда, куда, что и чем закончилось.

import { normalizeRoster } from './transferCore.js';

export const ROSTER_KEY = 'tf_transfer_roster_v1';
export const PREFS_KEY = 'tf_transfer_prefs_v1';
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

/** Записывает прочитанное со страницы сайта. */
export function setRoster(charId, data, now = new Date()) {
  const all = loadRosters();
  all[charId] = normalizeRoster(data, now);
  saveRosters(all);
  return all[charId];
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

/* ------------------------------ настройки ------------------------------ */

/** { server: id последнего сервера, picks: { [id браузера]: { [id сервера]: ключ получателя } } } */
export function loadPrefs() {
  const raw = readJson(PREFS_KEY, {});
  return { server: typeof raw?.server === 'string' ? raw.server : '', picks: isObj(raw?.picks) ? raw.picks : {} };
}
export const savePrefs = (prefs) => writeJson(PREFS_KEY, prefs);

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
