// js/modules/launcher/launchLog.js
// История запусков игры: что запускали, сколько окон открылось, сколько секунд ушло на каждое и у кого были ошибки.
// Локальное хранилище (localStorage, только на этом компьютере). Хранит последние LOG_MAX запусков.
// Статистика (statsOf, perCharacter, perDelay, delayAdvice) считается из этого журнала и показывается
// в «Настройки → Журналы → Запуски» (launchLogView.js). Данные не уходят в сеть.
//
// Запуск: { id, at, title, ms, delayMs, gc, requested, ok, failed, cancelled, noGc, running, items }
// Окно:   { id, nick, status: 'ok' | 'failed' | 'cancelled' | 'running' | 'nogc', ms, error, noLogin }
//   ms — сколько Твиноферма ждала появления клиента игры (без паузы между запусками);
//   running — окно уже было запущено, запуск пропущен; nogc — не указан GameCenter.

export const LOG_KEY = 'tf_launch_log_v1';
export const LOG_MAX = 100;
const ITEMS_MAX = 80;
export const ITEM_STATUSES = ['ok', 'failed', 'cancelled', 'running', 'nogc'];

/** Окно считается «нестабильным», если из не менее чем MIN попыток с ошибкой закончилось не меньше RATE. */
export const UNSTABLE_MIN_ATTEMPTS = 3;
export const UNSTABLE_RATE = 0.3;
/** Сколько окон нужно, чтобы делать выводы о паузе. */
export const ADVICE_MIN_WINDOWS = 10;

const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (key, fallback) => { try { const v = JSON.parse(store()?.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* квота: журнал не критичен */ } };

const num = (v, max = 1e9) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0));
const clean = (s) => [...String(s ?? '')].map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').trim();
const text = (v, max) => clean(v).slice(0, max);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) && t > 0 && t < 4102444800000 ? new Date(t).toISOString() : null; };

/** Окно запуска → безопасный вид. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = ITEM_STATUSES.includes(raw.status) ? raw.status : null;
  const id = text(raw.id, 60);
  if (!status || !id) return null;
  return {
    id, nick: text(raw.nick, 40) || id, status,
    ms: raw.ms == null || raw.ms === '' ? null : num(raw.ms, 3600e3),
    error: raw.error ? text(raw.error, 200) : null,
    noLogin: !!raw.noLogin
  };
}

/**
 * Запуск → запись журнала или null, если данных нет.
 * @param {any} raw
 */
export function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = iso(raw.at);
  const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem).filter(Boolean).slice(0, ITEMS_MAX);
  if (!at || !items.length) return null;
  const count = (st) => items.filter(i => i.status === st).length;
  return {
    id: text(raw.id, 40) || at,
    at,
    title: text(raw.title, 120) || 'Запуск игры',
    ms: num(raw.ms, 7 * 24 * 3600e3),
    delayMs: num(raw.delayMs, 120e3),
    gc: text(raw.gc, 60),
    requested: Math.max(num(raw.requested, 1000), items.length),
    ok: count('ok'), failed: count('failed'), cancelled: count('cancelled'), noGc: count('nogc'), running: count('running'),
    items
  };
}

/** От новых записей к старым. */
export function loadLaunchLog() {
  const raw = readJson(LOG_KEY, []);
  return (Array.isArray(raw) ? raw : []).map(normalizeRun).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
}

export function clearLaunchLog() {
  store()?.removeItem(LOG_KEY);
  notify();
}

function notify() {
  try { window.dispatchEvent(new CustomEvent('tf-launch-log')); } catch { /* вне браузера */ }
}

/** Записывает запуск. Запуски, где ничего не пытались открыть и никого не пропустили, в журнал не попадают. */
export function recordLaunchRun(run) {
  const entry = normalizeRun(run);
  if (!entry) return null;
  writeJson(LOG_KEY, [entry, ...loadLaunchLog()].slice(0, LOG_MAX));
  notify();
  return entry;
}

/* ------------------------------ статистика ------------------------------ */

const attempted = (it) => it.status === 'ok' || it.status === 'failed';
const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

/**
 * Общая статистика по журналу.
 * @param {ReturnType<typeof loadLaunchLog>} log
 */
export function statsOf(log) {
  const items = log.flatMap(r => r.items);
  const tried = items.filter(attempted);
  const okMs = items.filter(i => i.status === 'ok' && i.ms != null).map(i => i.ms);
  return {
    runs: log.length,
    attempts: tried.length,
    ok: items.filter(i => i.status === 'ok').length,
    failed: items.filter(i => i.status === 'failed').length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
    skippedRunning: items.filter(i => i.status === 'running').length,
    noGc: items.filter(i => i.status === 'nogc').length,
    failRate: tried.length ? items.filter(i => i.status === 'failed').length / tried.length : 0,
    avgMs: avg(okMs),
    maxMs: okMs.length ? Math.max(...okMs) : null,
    totalMs: log.reduce((n, r) => n + r.ms, 0),
    from: log.length ? log[log.length - 1].at : null,
    to: log.length ? log[0].at : null
  };
}

/**
 * Статистика по персонажам: сколько раз запускали, сколько ошибок, сколько в среднем ждали клиента.
 * Строки с ошибками и «нестабильные» — выше.
 * @param {ReturnType<typeof loadLaunchLog>} log
 */
export function perCharacter(log) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const run of log) {   // от новых к старым: первый встреченный ник — самый свежий
    for (const it of run.items) {
      let row = map.get(it.id);
      if (!row) { row = { id: it.id, nick: it.nick, attempts: 0, ok: 0, failed: 0, skipped: 0, msList: [], lastAt: run.at, lastError: null, lastErrorAt: null }; map.set(it.id, row); }
      if (attempted(it)) row.attempts++;
      if (it.status === 'ok') { row.ok++; if (it.ms != null) row.msList.push(it.ms); }
      if (it.status === 'failed') { row.failed++; if (!row.lastError) { row.lastError = it.error || 'ошибка'; row.lastErrorAt = run.at; } }
      if (it.status === 'running') row.skipped++;
    }
  }
  return [...map.values()].map(r => ({
    id: r.id, nick: r.nick, attempts: r.attempts, ok: r.ok, failed: r.failed, skipped: r.skipped,
    avgMs: avg(r.msList), lastAt: r.lastAt, lastError: r.lastError, lastErrorAt: r.lastErrorAt,
    failRate: r.attempts ? r.failed / r.attempts : 0,
    unstable: r.attempts >= UNSTABLE_MIN_ATTEMPTS && r.failed / r.attempts >= UNSTABLE_RATE
  })).sort((a, b) => Number(b.unstable) - Number(a.unstable) || b.failRate - a.failRate || b.failed - a.failed || a.nick.localeCompare(b.nick, 'ru'));
}

/**
 * Ошибки в зависимости от паузы между запусками: «при паузе 3 с — 12 окон, 2 с ошибкой».
 * @param {ReturnType<typeof loadLaunchLog>} log
 */
export function perDelay(log) {
  /** @type {Map<number, { delaySec: number, windows: number, failed: number, msList: number[] }>} */
  const map = new Map();
  for (const run of log) {
    const key = Math.round(run.delayMs / 100) / 10;   // секунды с точностью до 0,1
    const row = map.get(key) || { delaySec: key, windows: 0, failed: 0, msList: [] };
    run.items.filter(attempted).forEach(it => {
      row.windows++;
      if (it.status === 'failed') row.failed++;
      if (it.status === 'ok' && it.ms != null) row.msList.push(it.ms);
    });
    map.set(key, row);
  }
  return [...map.values()].filter(r => r.windows > 0)
    .map(r => ({ delaySec: r.delaySec, windows: r.windows, failed: r.failed, failRate: r.failed / r.windows, avgMs: avg(r.msList) }))
    .sort((a, b) => a.delaySec - b.delaySec);
}

/**
 * Совет по паузе между запусками. Только по фактам журнала: если данных мало, так и говорит.
 * @param {ReturnType<typeof perDelay>} rows
 * @param {number} currentSec текущая пауза из настроек
 * @returns {string}
 */
export function delayAdvice(rows, currentSec) {
  const total = rows.reduce((n, r) => n + r.windows, 0);
  if (total < ADVICE_MIN_WINDOWS) return `Пока мало данных: нужно хотя бы ${ADVICE_MIN_WINDOWS} запущенных окон, сейчас ${total}.`;
  const solid = rows.filter(r => r.windows >= ADVICE_MIN_WINDOWS);
  const cur = rows.find(r => r.delaySec === currentSec);
  const percent = (r) => `${Math.round(r.failRate * 100)}%`;
  if (solid.length >= 2) {
    const best = [...solid].sort((a, b) => a.failRate - b.failRate || a.delaySec - b.delaySec)[0];
    const worst = [...solid].sort((a, b) => b.failRate - a.failRate)[0];
    if (worst.failRate > best.failRate) {
      return `Меньше всего ошибок при паузе ${best.delaySec} с (${percent(best)} из ${best.windows} окон), больше всего — при ${worst.delaySec} с (${percent(worst)} из ${worst.windows}).`
        + (best.delaySec !== currentSec ? ` Сейчас в настройках ${currentSec} с.` : '');
    }
    return 'Ошибок при разных паузах примерно поровну: пауза на них, похоже, не влияет — смотрите на нестабильные окна в таблице выше.';
  }
  const all = rows.reduce((n, r) => n + r.failed, 0) / total;
  if (all === 0) return `Ошибок нет: пауза ${cur ? cur.delaySec : currentSec} с достаточна. Если хотите запускать быстрее, уменьшите её на 1 с и понаблюдайте.`;
  if (all >= 0.1) return `Ошибок ${Math.round(all * 100)}% из ${total} окон при паузе ${cur ? cur.delaySec : currentSec} с: попробуйте увеличить паузу на 1–2 с и сравните.`;
  return `Ошибок немного (${Math.round(all * 100)}% из ${total} окон). Пауза ${cur ? cur.delaySec : currentSec} с в целом подходит.`;
}

/** «12,3 с» / «1 мин 5 с» для таблиц. */
export function fmtMs(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace('.', ',') : Math.round(s)} с`;
  return `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`;
}
