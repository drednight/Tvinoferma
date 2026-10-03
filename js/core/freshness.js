// js/core/freshness.js
// @ts-check
// Свежесть данных: «3 ч назад» у баланса, статуса входа и прогресса марафона, подсветка устаревших
// (порог в настройках). Время берётся из уже сохранённых полей: char.lastCoinUpdate, char.lastLoginCheck,
// cell.syncedAt в марафонах. Показывается в профиле персонажа (окно «Когда что проверено») и на карточках марафонов.

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
 * Идущие марафоны персонажа, которые сверяются с сайтом, и время их последней сверки.
 * Время — самое свежее по заданиям марафона; null — марафон ещё ни разу не сверялся.
 * @returns {Array<{ marathon: any, at: string|null }>}
 */
export function marathonSyncList(charId, marathons = []) {
  const out = [];
  for (const m of marathons) {
    if (m.kind === 'series' || m.status === 'completed' || !m.participantIds?.includes(charId) || !hasSiteUrl(m, marathons)) continue;
    const times = Object.values(m.progress?.[charId] || {}).map(c => toMs(c?.syncedAt)).filter(t => t !== null);
    out.push({ marathon: m, at: times.length ? new Date(Math.max(...times)).toISOString() : null });
  }
  return out;
}

const plural = (n, [one, few, many]) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/**
 * Часы словами для настроек: 24 → «1 день», 72 → «3 дня», 30 → «1 день 6 часов», 5 → «5 часов».
 * Дробные значения округляются до целых; не число или меньше 1 → пустая строка.
 */
export function formatHoursSpan(hours) {
  const h = Math.round(Number(hours));
  if (!Number.isFinite(h) || h < 1) return '';
  const days = Math.floor(h / 24), rest = h % 24;
  const d = `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  const r = `${rest} ${plural(rest, ['час', 'часа', 'часов'])}`;
  if (!days) return r;
  return rest ? `${d} ${r}` : d;
}

/** «03.10.2026, 14:23» или «ещё не проверялось». */
export function formatWhen(iso) {
  const t = toMs(iso);
  return t === null ? 'ещё не проверялось' : fmtDateTime(t);
}

/* ------------------------------------------------------------------ */
/*  Разметка и обновление подписей на странице                         */
/* ------------------------------------------------------------------ */

/**
 * Метка «🪙 3 ч назад»; подпись пересчитывается раз в минуту (refreshFreshnessLabels).
 * bare: только «3 ч назад», без значка (когда значок и название уже есть рядом).
 */
export function freshnessChipHtml(item, { bare = false } = {}) {
  const icon = bare ? '' : `${FRESHNESS_KINDS[item.kind].icon} `;
  return `<span class="fresh-chip${item.stale ? ' is-stale' : ''}" data-fresh-kind="${item.kind}" data-fresh-at="${escapeHtml(item.at || '')}" title="${escapeHtml(item.title)}">${icon}<span data-fresh-text>${escapeHtml(item.text)}</span></span>`;
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
