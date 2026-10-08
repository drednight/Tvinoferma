// js/modules/automation/collectionStore.js
// Журнал запусков мини-игры «Коллекция» (Issue #72): локальное хранилище (localStorage, только на этом компьютере).
// Отчёт присылает панель из окна персонажа (src-tauri/src/scripts/collection.js), а значит страница сайта — это
// недоверенный источник: каждый отчёт перепроверяется и приводится к безопасному виду (числа с пределами, короткие строки).
// Журнал хранит последние LOG_MAX запусков; показывается в «Настройки → Журналы» (collectionLogView.js).

export const LOG_KEY = 'tf_collection_log_v1';
export const LOG_MAX = 200;
export const DROP_CATS = [1, 2, 3, 4, 5];       // с неоткрытых карточек падают только категории 1–5
export const ALL_CATS = [1, 2, 3, 4, 5, 6];

const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (key, fallback) => { try { const v = JSON.parse(store()?.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* квота: журнал не критичен */ } };

const num = (v, max = 1e7) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0));
const clean = (s) => [...s].map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');   // без управляющих символов
const text = (v, max) => clean(String(v ?? '')).trim().slice(0, max);
const perCat = (obj, cats) => Object.fromEntries(cats.map(c => [c, num(obj?.[c], 1e6)]));
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) && t > 0 && t < 4102444800000 ? new Date(t).toISOString() : null; };
const KINDS = ['ok', 'warn', 'error'];

/**
 * Отчёт панели → запись журнала или null, если отчёт непригоден.
 * @param {any} raw отчёт из окна: { id, start, end, ms, target, above, maxCards, opened, drops, claimed, promoted, left, code, kind, message }
 * @param {string} [nick] ник персонажа (приложение определяет его по окну)
 */
export function normalizeReport(raw, nick = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id, 40);
  const start = iso(raw.start);
  if (!/^[a-z0-9]{4,40}$/i.test(id) || !start) return null;
  const ms = num(raw.ms, 7 * 24 * 3600 * 1000);
  const target = ALL_CATS.includes(Number(raw.target)) ? Number(raw.target) : 0;
  if (!target) return null;
  const above = ALL_CATS.includes(Number(raw.above)) ? Number(raw.above) : 'stop';
  const drops = perCat(raw.drops, DROP_CATS);
  const unknown = num(raw.unknown, 1e6);
  return {
    id,
    at: start,
    end: iso(raw.end) || new Date(Date.parse(start) + ms).toISOString(),
    ms,
    nick: text(nick, 60),
    target,
    above,
    maxCards: num(raw.maxCards, 100000),
    // opened — все открытые карточки: выпавшие по категориям и те, у которых категорию определить не удалось
    opened: Math.max(num(raw.opened, 1e6), DROP_CATS.reduce((n, c) => n + drops[c], 0)),
    unknown,
    drops,
    claimed: perCat(raw.claimed, ALL_CATS),
    promoted: perCat(raw.promoted, DROP_CATS),
    left: raw.left == null ? null : num(raw.left, 1e7),
    code: text(raw.code, 30).replace(/[^a-z_]/gi, ''),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'ok',
    message: text(raw.message, 200)
  };
}

/** От новых запусков к старым. */
export function loadCollectionLog() {
  const raw = readJson(LOG_KEY, []);
  return (Array.isArray(raw) ? raw : []).filter(e => e && e.id && e.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export function clearCollectionLog() {
  store()?.removeItem(LOG_KEY);
  try { window.dispatchEvent(new CustomEvent('tf-collection-log')); } catch { /* вне браузера */ }
}

/**
 * Добавляет присланные отчёты в журнал (без дублей по id: окно может прислать отчёт повторно).
 * @param {any[]} reports отчёты как есть из окон (у каждого может быть поле `char` — id персонажа)
 * @param {(charId: string) => string} [nickOf] ник по id персонажа
 * @returns {number} сколько новых записей добавлено
 */
export function recordCollectionReports(reports, nickOf = () => '') {
  const log = loadCollectionLog();
  const known = new Set(log.map(e => e.id));
  const fresh = [];
  (Array.isArray(reports) ? reports : []).slice(0, 50).forEach(r => {
    const entry = normalizeReport(r, nickOf(String(r?.char ?? '')) || String(r?.char ?? ''));
    if (!entry || known.has(entry.id)) return;
    known.add(entry.id);
    fresh.push(entry);
  });
  if (!fresh.length) return 0;
  writeJson(LOG_KEY, [...fresh, ...log].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LOG_MAX));
  try { window.dispatchEvent(new CustomEvent('tf-collection-log')); } catch { /* вне браузера */ }
  return fresh.length;
}

/** Итоги по набору запусков (всё в журнале или выбранный персонаж). */
export function totalsOf(entries) {
  const sum = (key, cats) => Object.fromEntries(cats.map(c => [c, entries.reduce((n, e) => n + (e[key]?.[c] || 0), 0)]));
  const opened = entries.reduce((n, e) => n + (e.opened || 0), 0);
  const ms = entries.reduce((n, e) => n + (e.ms || 0), 0);
  return {
    runs: entries.length,
    opened,
    unknown: entries.reduce((n, e) => n + (e.unknown || 0), 0),
    ms,
    perMinute: ms >= 5000 ? Math.round((opened * 60000) / ms) : null,
    drops: sum('drops', DROP_CATS),
    claimed: sum('claimed', ALL_CATS),
    promoted: sum('promoted', DROP_CATS)
  };
}
export const share = (n, total) => (total > 0 ? ((n * 100) / total).toFixed(1) : '0.0');
