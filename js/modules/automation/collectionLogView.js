// js/modules/automation/collectionLogView.js
// Логи запусков «Коллекции» (Issue #72) как вид логов единого модуля (core/logHub.js, «Настройки → Журналы»).
// Запись: время, ник, цель, сколько карт открыто и какие категории выпали; нажатие открывает подробности запуска.
// Кнопка «Итоги по всем запускам» показывает суммарную статистику по журналу (с фильтром по персонажу).

import { escapeHtml } from '../../core/utils.js';
import { registerLogSource } from '../../core/logHub.js';
import { openOverlay } from '../marathons/overlay.js';
import { loadCollectionLog, clearCollectionLog, totalsOf, share, DROP_CATS, ALL_CATS } from './collectionStore.js';

const COLORS = { 1: '#9aa0ad', 2: '#6fcf97', 3: '#56b6f7', 4: '#b48cf2', 5: '#f0b84a', 6: '#f06a6a' };
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const pad = (n) => (n < 10 ? '0' : '') + n;
export const fmtDuration = (ms) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const aboveText = (a) => (a === 'stop' ? 'остановиться' : `забрать до ${a}-й`);
const dropsLine = (e) => DROP_CATS.filter(c => e.drops[c]).map(c => `${c}×${e.drops[c]}`).join(' · ') || 'без выпадений';
const prizes = (claimed) => ALL_CATS.filter(c => claimed[c]).map(c => `${c}-я ×${claimed[c]}`);

/** Таблица «категория → сколько, доля» с полосками; 6-я категория с карточек не падает — только обмен. */
export function tableHtml(t) {
  const rows = DROP_CATS.map(c => `
    <tr>
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COLORS[c]};margin-right:6px"></span>${c}</td>
      <td style="text-align:right">${t.drops[c]}</td>
      <td style="text-align:right">${share(t.drops[c], t.opened)}%</td>
      <td style="width:40%"><div style="height:7px;border-radius:4px;background:${COLORS[c]};width:${Math.min(100, Number(share(t.drops[c], t.opened)))}%"></div></td>
      <td style="text-align:right">${t.promoted[c] ? `обмен ${c}→${c + 1} ×${t.promoted[c]}` : ''}</td>
    </tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse"><thead><tr class="muted"><th style="text-align:left">Категория</th><th style="text-align:right">Выпало</th><th style="text-align:right">Доля</th><th></th><th></th></tr></thead><tbody>${rows}
    <tr><td>6</td><td colspan="4" class="muted">с карточек не падает: даётся только обменом 5 карт пятой категории (получено ${t.promoted[5] || 0})</td></tr></tbody></table>`;
}

export function detailsHtml(e) {
  const t = totalsOf([e]);
  const claimed = prizes(e.claimed);
  return `
    <div class="tl-summary"><span>🃏 <b>${escapeHtml(e.nick || 'окно персонажа')}</b></span><span class="muted">${escapeHtml(when(e.at))} · ${escapeHtml(fmtDuration(e.ms))}</span></div>
    <div class="promo-log-h">${e.kind === 'ok' ? '✅' : e.kind === 'warn' ? '⚠️' : '❌'} ${escapeHtml(e.message || 'Запуск завершён')}</div>
    <div class="muted">Цель — категория ${e.target}; выше цели: ${escapeHtml(aboveText(e.above))}; лимит запуска: ${e.maxCards ? `${e.maxCards} карт` : 'до конца'}.</div>
    <div class="promo-log-h">Открыто карточек: ${e.opened}${t.perMinute ? ` · ~${t.perMinute} карт/мин` : ''}${e.left != null ? ` · осталось: ${e.left}` : ''}</div>
    ${tableHtml(t)}
    <div class="promo-log-h">🏆 Призы: ${claimed.length ? escapeHtml(claimed.join(', ')) : 'не забирались'}</div>
    ${e.unknown ? `<div class="muted">Карточек без определённой категории: ${e.unknown}</div>` : ''}`;
}

const entryText = (e) => [
  `${when(e.at)} · ${e.nick || 'окно персонажа'} · цель ${e.target} · ${fmtDuration(e.ms)}`,
  e.message,
  `Открыто карточек: ${e.opened}${e.left != null ? ` (осталось ${e.left})` : ''}`,
  ...DROP_CATS.map(c => `${c} категория: ${e.drops[c]} | ${share(e.drops[c], e.opened)}%`),
  `Призы: ${prizes(e.claimed).join(', ') || 'нет'}`,
  `Обменов: ${DROP_CATS.reduce((n, c) => n + e.promoted[c], 0)}`
].join('\n');

function openWithCopy(title, body, copyText) {
  const ov = openOverlay({ title, wide: true });
  ov.body.innerHTML = body;
  ov.foot.innerHTML = '<span></span><div class="row gap"><button type="button" class="btn" data-copy>📋 Скопировать</button><button type="button" class="btn primary" data-close>Закрыть</button></div>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-copy]').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(copyText); ev.target.textContent = '✔ Скопировано'; }
    catch { ev.target.textContent = 'Не удалось скопировать'; }
  };
  return ov;
}

/** Окно с подробностями одного запуска. */
export function openCollectionEntry(id) {
  const e = loadCollectionLog().find(x => x.id === id);
  return e ? openWithCopy('🃏 Запуск «Коллекции»', detailsHtml(e), entryText(e)) : null;
}

/** Итоги по всему журналу. */
export function openCollectionTotals() {
  const log = loadCollectionLog();
  const t = totalsOf(log);
  const claimed = prizes(t.claimed);
  const body = `
    <div class="tl-summary"><span>📊 <b>Итоги по всем запускам</b></span><span class="muted">запусков: ${t.runs}</span></div>
    <div class="promo-log-h">Открыто карточек: ${t.opened}${t.perMinute ? ` · ~${t.perMinute} карт/мин` : ''} · время: ${escapeHtml(fmtDuration(t.ms))}</div>
    ${tableHtml(t)}
    <div class="promo-log-h">🏆 Призы: ${claimed.length ? escapeHtml(claimed.join(', ')) : 'не забирались'}</div>
    ${log.length ? `<div class="muted">Период: ${escapeHtml(when(log[log.length - 1].at))} — ${escapeHtml(when(log[0].at))}</div>` : ''}`;
  const copy = [
    `Коллекция — итоги по ${t.runs} запускам`,
    `Открыто карточек: ${t.opened}`,
    ...DROP_CATS.map(c => `${c} категория: ${t.drops[c]} | ${share(t.drops[c], t.opened)}%`),
    `Призы: ${claimed.join(', ') || 'нет'}`,
    `Время: ${fmtDuration(t.ms)}`
  ].join('\n');
  return openWithCopy('📊 Коллекция: итоги', body, copy);
}

/** Вид логов «Коллекция» в едином модуле логов (logHub.js). */
export const collectionLogSource = {
  id: 'collection',
  title: 'Коллекция',
  icon: '🃏',
  list: () => loadCollectionLog().map(e => ({
    key: e.id, at: e.at, title: `Цель ${e.target} · ${e.opened} карт`,
    status: e.kind === 'error' ? 'error' : e.kind === 'warn' ? 'warn' : 'ok',
    who: e.nick,
    summary: `${dropsLine(e)}${prizes(e.claimed).length ? ` · 🏆 ${prizes(e.claimed).join(', ')}` : ''}`
  })),
  open: (item) => openCollectionEntry(item.key),
  clear: () => clearCollectionLog(),
  clearConfirm: 'Очистить логи «Коллекции»? Приложение забудет прошлые запуски и итоговую статистику. Статистика текущего окна персонажа не меняется.',
  actions: () => [{ id: 'totals', label: '📊 Итоги по всем запускам', disabled: !loadCollectionLog().length, run: () => openCollectionTotals() }],
  subscribe: (fn) => { window.addEventListener('tf-collection-log', fn); return () => window.removeEventListener('tf-collection-log', fn); }
};
registerLogSource(collectionLogSource);
