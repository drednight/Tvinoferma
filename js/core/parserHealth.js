// js/core/parserHealth.js
// @ts-check
// Состояние парсеров pwonline.ru: что вернула последняя проверка каждого из них и давно ли она была успешной.
// Нужно, чтобы изменение вёрстки сайта не выглядело как «тихие нули»: после нескольких неудач подряд
// интерфейс показывает плашку «парсер устарел» (js/settings/parserHealthUi.js), а данные в базе не трогаются —
// сюда пишутся только статусы проверок, а не результаты разбора.
//
// Статусы: ok, empty, layout_changed, not_logged_in, challenge, timeout (+ error — прочие ошибки запуска).
// Подряд идущие layout_changed считаются неудачами; ok и empty обнуляют счётчик; остальные статусы
// (нет входа, проверка безопасности, таймаут) его не меняют: они не говорят о вёрстке.

import selectors from '../../src-tauri/src/scripts/selectors.json';
import { version as APP_VERSION } from '../../package.json';
import { errorText } from './errorCodes.js';

const STORAGE_KEY = 'tf-parser-health';
const STORAGE_VERSION = 1;

/** Сколько неудач подряд (layout_changed) нужно, чтобы показать плашку. Одна может быть случайной. */
export const FAIL_THRESHOLD = 2;

/** @typedef {'ok'|'empty'|'layout_changed'|'not_logged_in'|'challenge'|'timeout'|'error'} HealthStatus */
/** @typedef {{ status: HealthStatus|null, lastCheckAt: string|null, lastOkAt: string|null, lastError: string|null, failStreak: number }} HealthEntry */

/** Парсеры: ключ → подпись для таблицы, родительный падеж для плашки и страница сайта. */
export const PARSERS = {
  balance: { title: 'Баланс монет', short: 'баланса', page: 'chests2.php' },
  auth: { title: 'Проверка входа', short: 'проверки входа', page: 'usercp.php' },
  progress: { title: 'Прогресс заданий марафона', short: 'прогресса марафона', page: 'страница марафона' },
  titles: { title: 'Поиск марафонов', short: 'поиска марафонов', page: 'страницы марафонов' },
  detail: { title: 'Страница марафона', short: 'страницы марафона', page: 'страница марафона' },
  news: { title: 'Новости', short: 'новостей', page: 'news.php' }
};

/** Подписи статусов для интерфейса. */
export const STATUS_LABEL = {
  ok: '✅ работает',
  empty: '➖ на сайте пусто',
  layout_changed: '⚠️ возможно, сайт изменил вёрстку',
  not_logged_in: '🔒 нет входа на сайт',
  challenge: '🛡️ «Проверка безопасности»',
  timeout: '⏱️ сайт не ответил',
  error: '❓ ошибка запуска'
};
export const NEVER_CHECKED = '— ещё не проверялся';

const AUTH_CODES = new Set(['not_logged_in', 'zero_no_user_session_expired', 'session_lost_during_parse']);
// Ответ получен, но на сайте действительно пусто (нет марафона / нет заданий) — это не поломка
const EMPTY_CODES = new Set(['container_not_found', 'no_title_found']);
const LAYOUT_CODES = new Set([
  'pending', 'container_missing', 'no_value_tag', 'parse_nan', 'no_progress_found',
  'no_article', 'no_news_list', 'no_quests', 'no_marathon', 'config_missing'
]);

/**
 * Код ошибки парсера → статус. Без ошибки — `ok` (или `empty`, если результат пустой: `{ empty: true }`).
 * @param {string|null|undefined} error
 * @param {{ empty?: boolean }} [opts]
 * @returns {HealthStatus}
 */
export function classifyResult(error, { empty = false } = {}) {
  if (!error) return empty ? 'empty' : 'ok';
  const code = String(error);
  if (AUTH_CODES.has(code)) return 'not_logged_in';
  if (code === 'challenge') return 'challenge';
  if (code.startsWith('timeout')) return 'timeout';
  if (EMPTY_CODES.has(code)) return 'empty';
  if (LAYOUT_CODES.has(code) || code.startsWith('exception_')) return 'layout_changed';
  return 'error';
}

// Что показывать, когда у одной проверки несколько ошибок (поиск марафонов идёт по нескольким страницам)
const SEVERITY = ['layout_changed', 'not_logged_in', 'challenge', 'timeout', 'error', 'empty', 'ok'];

/**
 * Статус по списку ошибок: самый «тяжёлый» из них.
 * @param {string[]} errors
 * @returns {{ status: HealthStatus, error: string|null }}
 */
export function classifyErrors(errors) {
  const list = (errors || []).filter(Boolean);
  if (!list.length) return { status: 'empty', error: null };
  const scored = list.map(error => ({ error, status: classifyResult(error) }));
  scored.sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status));
  return scored[0];
}

/** @returns {HealthEntry} */
const blank = () => ({ status: null, lastCheckAt: null, lastOkAt: null, lastError: null, failStreak: 0 });

/** @type {Record<string, HealthEntry>} */
let store = load();
/** @type {Set<(health: Record<string, HealthEntry>) => void>} */
const subscribers = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || raw.v !== STORAGE_VERSION || typeof raw.parsers !== 'object') return {};
    /** @type {Record<string, HealthEntry>} */
    const out = {};
    for (const key of Object.keys(PARSERS)) {
      const e = raw.parsers[key];
      if (e && typeof e === 'object') out[key] = { ...blank(), ...e, failStreak: Math.max(0, Number(e.failStreak) || 0) };
    }
    return out;
  } catch (_) { return {}; }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, parsers: store })); } catch (_) { /* память переполнена — статусы не критичны */ }
}

function notify() {
  const snapshot = getParserHealth();
  subscribers.forEach(fn => { try { fn(snapshot); } catch (e) { console.error('[parserHealth]', e); } });
}

/**
 * Записать итог проверки парсера. Вызывать один раз на итоговый результат (после повторов очереди), а не на каждую попытку.
 * @param {string} parser ключ из PARSERS
 * @param {string|null|undefined} error код ошибки парсера (null — парсер отработал)
 * @param {{ empty?: boolean, status?: HealthStatus, at?: string }} [opts] `status` — готовый статус (если ошибок несколько)
 * @returns {HealthEntry|null}
 */
export function recordParserResult(parser, error, { empty = false, status, at } = {}) {
  if (!(parser in PARSERS)) return null;
  const st = status || classifyResult(error, { empty });
  const now = at || new Date().toISOString();
  const prev = store[parser] || blank();
  const next = { ...prev, status: st, lastCheckAt: now };
  if (st === 'ok' || st === 'empty') {
    next.lastOkAt = now;
    next.lastError = null;
    next.failStreak = 0;
  } else {
    next.lastError = error ? String(error) : null;
    if (st === 'layout_changed') next.failStreak = prev.failStreak + 1;
  }
  store[parser] = next;
  save();
  notify();
  return next;
}

/** Состояние всех парсеров (копия). Для ни разу не проверявшихся — пустая запись. */
export function getParserHealth() {
  /** @type {Record<string, HealthEntry>} */
  const out = {};
  for (const key of Object.keys(PARSERS)) out[key] = { ...blank(), ...(store[key] || {}) };
  return out;
}

/**
 * Парсеры, которые, судя по проверкам, перестали работать (неудач подряд не меньше порога).
 * @returns {Array<HealthEntry & { id: string }>}
 */
export function problemParsers(threshold = FAIL_THRESHOLD) {
  return Object.entries(getParserHealth())
    .filter(([, e]) => e.status === 'layout_changed' && e.failStreak >= threshold)
    .map(([id, e]) => ({ id, ...e }));
}

/** Подписка на любые изменения; сразу вызывается с текущим состоянием. Возвращает функцию отписки. */
export function subscribeHealth(fn) {
  subscribers.add(fn);
  fn(getParserHealth());
  return () => { subscribers.delete(fn); };
}

/** Сбросить все статусы (после ручной проверки или в тестах). */
export function resetParserHealth() {
  store = {};
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* нечего чистить */ }
  notify();
}

/** Версия конфига селекторов, встроенного в сборку (selectors.json). */
export const selectorsVersion = () => Number(/** @type {{ version?: number }} */ (selectors).version) || 0;

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const formatHealthTime = fmt;

/**
 * Текст диагностики для разработчика. Без паролей, почт и ников: только парсер, статус, код ошибки, времена и версии.
 * @param {string} [onlyParser] ключ парсера; без него — все
 * @param {Record<string, HealthEntry>} [health]
 */
export function buildDiagnostics(onlyParser, health = getParserHealth()) {
  const ids = onlyParser && onlyParser in PARSERS ? [onlyParser] : Object.keys(PARSERS);
  const lines = [
    'Диагностика парсеров — Твиноферма',
    `Приложение: ${APP_VERSION} · selectors.json: версия ${selectorsVersion()}`,
    `Сформировано: ${fmt(new Date().toISOString())}`,
    ''
  ];
  for (const id of ids) {
    const e = health[id] || blank();
    lines.push(
      `Парсер: ${PARSERS[id].title} (${id}) — ${PARSERS[id].page}`,
      `  Статус: ${e.status ? `${STATUS_LABEL[e.status]} [${e.status}]` : NEVER_CHECKED}`,
      `  Код ошибки: ${e.lastError ? `${e.lastError} — ${errorText(e.lastError)}` : '—'}`,
      `  Последняя проверка: ${fmt(e.lastCheckAt)}`,
      `  Последняя успешная: ${fmt(e.lastOkAt)}`,
      `  Неудач подряд: ${e.failStreak}`,
      ''
    );
  }
  return lines.join('\n').trimEnd();
}
