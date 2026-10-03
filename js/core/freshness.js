// js/core/freshness.js
// @ts-check
// Свежесть данных: «Обновлено 3 ч назад» у баланса, статуса входа и прогресса марафона,
// подсветка устаревших (порог в настройках), сортировка и фильтр «давно не обновлялись».
// Время берётся из уже сохранённых полей: char.lastCoinUpdate, char.lastLoginCheck, cell.syncedAt в марафонах.

import { DEFAULT_SETTINGS } from './constants.js';
import { escapeHtml } from './utils.js';

const HOUR = 3600 * 1000;

/** Виды данных: значок, подпись и ключ порога в settings.freshness. */
export const FRESHNESS_KINDS = {
  balance: { icon: '🪙', label: 'Баланс', settingKey: 'balanceHours' },
  login: { icon: '🔐', label: 'Вход', settingKey: 'loginHours' },
  marathon: { icon: '🏆', label: 'Марафон', settingKey: 'marathonHours' }
};

/** @typedef {'balance'|'login'|'marathon'} FreshnessKind */
/** @typedef {{ kind: FreshnessKind, at: string|null, ageMs: number, stale: boolean, never: boolean, text: string, title: string }} FreshnessItem */

/** Порог устаревания в часах (из настроек; при мусоре — значение по умолчанию). */
export function thresholdHours(settings, kind) {
  const key = FRESHNESS_KINDS[kind].settingKey;
  const v = Number(settings?.freshness?.[key]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTINGS.freshness[key];
}

/** ISO-строка → миллисекунды или null. */
function toMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** «только что» / «5 мин назад» / «3 ч назад» / «2 дн. назад». Время из будущего (сбитые часы) считается «только что». */
export function formatAge(ageMs) {
  const min = Math.floor(Math.max(0, ageMs) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн. назад`;
}

const fmtDateTime = (ms) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Свежесть одного вида данных.
 * @param {FreshnessKind} kind
 * @param {string|null|undefined} iso время последнего обновления
 * @returns {FreshnessItem}
 */
export function freshnessOf(kind, iso, settings, now = Date.now()) {
  const info = FRESHNESS_KINDS[kind];
  const limit = thresholdHours(settings, kind);
  const at = toMs(iso);
  if (at === null) {
    return { kind, at: null, ageMs: Infinity, stale: true, never: true, text: 'нет данных', title: `${info.label}: ещё не обновлялся` };
  }
  const ageMs = Math.max(0, now - at);
  const stale = ageMs > limit * HOUR;
  return {
    kind, at: /** @type {string} */ (iso), ageMs, stale, never: false, text: formatAge(ageMs),
    title: `${info.label}: обновлено ${fmtDateTime(at)}${stale ? ` — устарело (порог ${limit} ч)` : ` (порог устаревания ${limit} ч)`}`
  };
}

/** Марафон можно сверить с сайтом, если у него (или у серии) есть адрес страницы. */
function hasSiteUrl(m, all) {
  if (m.source?.url) return true;
  const series = m.seriesId ? all.find(s => s.id === m.seriesId) : null;
  return !!series?.source?.url;
}

/**
 * Когда последний раз прогресс персонажа обновлялся с сайта по его идущим марафонам.
 * Берётся самая старая сверка среди марафонов (устарел один — устарело всё).
 * @returns {string|null|undefined} ISO-время; null — хотя бы один марафон ещё не сверялся; undefined — сверять нечего
 */
export function marathonSyncAt(charId, marathons = []) {
  let oldest = null;
  let count = 0;
  for (const m of marathons) {
    if (m.kind === 'series' || m.status === 'completed' || !m.participantIds?.includes(charId) || !hasSiteUrl(m, marathons)) continue;
    count++;
    const cells = Object.values(m.progress?.[charId] || {});
    const latest = cells.map(c => toMs(c?.syncedAt)).filter(t => t !== null).sort((a, b) => b - a)[0];
    if (latest === undefined) return null;
    if (oldest === null || latest < oldest) oldest = latest;
  }
  return count ? new Date(/** @type {number} */ (oldest)).toISOString() : undefined;
}

/**
 * Свежесть данных персонажа: баланс, вход и (если есть идущие марафоны с сайтом) прогресс марафонов.
 * @param {{ id: string, lastCoinUpdate?: string|null, lastLoginCheck?: string|null }} char
 * @param {{ settings?: any, marathons?: any[], now?: number }} [ctx]
 * @returns {FreshnessItem[]}
 */
export function charFreshness(char, { settings, marathons = [], now = Date.now() } = {}) {
  const items = [
    freshnessOf('balance', char.lastCoinUpdate, settings, now),
    freshnessOf('login', char.lastLoginCheck, settings, now)
  ];
  const sync = marathonSyncAt(char.id, marathons);
  if (sync !== undefined) items.push(freshnessOf('marathon', sync, settings, now));
  return items;
}

/** Хотя бы один вид данных устарел или ни разу не обновлялся. */
export const isStale = (char, ctx) => charFreshness(char, ctx).some(i => i.stale);

/** Насколько давно обновлялись данные: возраст самых старых (никогда не обновлялись — бесконечность). */
export const staleness = (char, ctx) => Math.max(...charFreshness(char, ctx).map(i => i.ageMs));

/* ------------------------------------------------------------------ */
/*  Разметка и обновление подписей на странице                         */
/* ------------------------------------------------------------------ */

/** Метка «🪙 3 ч назад»; подпись пересчитывается раз в минуту (refreshFreshnessLabels). */
export function freshnessChipHtml(item, { withLabel = false } = {}) {
  const info = FRESHNESS_KINDS[item.kind];
  return `<span class="fresh-chip${item.stale ? ' is-stale' : ''}" data-fresh-kind="${item.kind}" data-fresh-at="${escapeHtml(item.at || '')}" title="${escapeHtml(item.title)}">${info.icon} ${withLabel ? `${info.label}: ` : ''}<span data-fresh-text>${escapeHtml(item.text)}</span></span>`;
}

/** Строка «Обновлено: 🪙 3 ч назад · 🔐 5 мин назад · 🏆 1 дн. назад». */
export function freshnessRowHtml(items) {
  return `<div class="fresh-row"><span class="muted">Обновлено:</span> ${items.map(i => freshnessChipHtml(i)).join('')}</div>`;
}

/** Пересчитывает подписи и подсветку у всех меток на странице (без перерисовки карточек). */
export function refreshFreshnessLabels(settings, root = document, now = Date.now()) {
  root.querySelectorAll('[data-fresh-kind]').forEach(el => {
    const kind = /** @type {FreshnessKind} */ (el.getAttribute('data-fresh-kind'));
    if (!(kind in FRESHNESS_KINDS)) return;
    const item = freshnessOf(kind, el.getAttribute('data-fresh-at'), settings, now);
    el.classList.toggle('is-stale', item.stale);
    el.setAttribute('title', item.title);
    const text = el.querySelector('[data-fresh-text]');
    if (text) text.textContent = item.text;
  });
}

/** Раз в минуту обновляет подписи, чтобы «5 мин назад» не застывало. Возвращает функцию остановки. */
export function startFreshnessTicker(getSettings, intervalMs = 60000) {
  const id = setInterval(() => refreshFreshnessLabels(getSettings()), intervalMs);
  return () => clearInterval(id);
}
