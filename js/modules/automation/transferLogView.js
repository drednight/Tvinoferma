// js/modules/automation/transferLogView.js
// Логи передач (Issue #26) как вид логов единого модуля (core/logHub.js, «Настройки → Журналы»).
// Запись: время, браузер → сервер → получатель, что передано и чем закончилось; нажатие открывает подробности.

import { escapeHtml } from '../../core/utils.js';
import { registerLogSource, openLogHub } from '../../core/logHub.js';
import { openOverlay } from '../marathons/overlay.js';
import { statusInfo } from './transferCore.js';
import { loadTransferLog, clearTransferLog } from './transferStore.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const itemsCount = (e) => (e.items || []).reduce((n, i) => n + (Number(i.qty) || 1), 0);

const label = (e) => {
  const info = statusInfo(e.status);
  return `${info.label}${e.detail ? `: ${e.detail}` : ''}`;
};

export function detailsHtml(e) {
  return `
    <div class="tl-summary"><span>📦 <b>${escapeHtml(e.nick)}</b> → ${escapeHtml(e.server || '?')} → <b>${escapeHtml(e.recipient || '?')}</b></span><span class="muted">${escapeHtml(when(e.at))}</span></div>
    <div class="promo-log-h">${statusInfo(e.status).icon} ${escapeHtml(label(e))}</div>
    ${e.siteStatus ? `<div class="muted">Статус на сайте: ${escapeHtml(e.siteStatus)}</div>` : ''}
    ${e.warning ? `<div class="muted">Предупреждение сайта: ${escapeHtml(e.warning)}</div>` : ''}
    ${e.done?.length ? `<div class="promo-log-h">✅ Передано — есть в истории сайта (${e.done.length})</div><ul class="promo-log-list">${e.done.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</li>`).join('')}</ul>` : ''}
    ${e.missing?.length ? `<div class="promo-log-h">⚠ Не передано (${e.missing.length})</div><ul class="promo-log-list">${e.missing.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.source ? ` — «${escapeHtml(i.source)}»` : ''}</li>`).join('')}</ul>` : ''}
    ${e.limited?.length ? `<div class="promo-log-h">🔒 Не отмечались — сайт принимает только на другой сервер (${e.limited.length})</div><ul class="promo-log-list">${e.limited.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''} — «${escapeHtml(i.source)}»: только на «${escapeHtml(i.server)}»</li>`).join('')}</ul>` : ''}
    <div class="promo-log-h">Предметы (${e.count || itemsCount(e)})</div>
    ${e.items?.length ? `<ul class="promo-log-list">${e.items.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</li>`).join('')}</ul>` : '<div class="muted">Список предметов не записан.</div>'}
    ${e.status === 'success' ? '' : '<p class="promo-warn">Сверьте с «Историей передачи» на сайте: приложение само ничего не повторяет, чтобы не отправить предметы дважды.</p>'}`;
}

const entryText = (e) => [
  `${when(e.at)} · ${e.nick} → ${e.server || '?'} → ${e.recipient || '?'}`,
  label(e),
  ...(e.missing?.length ? [`Не передано: ${e.missing.map(i => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('; ')}`] : []),
  ...(e.items || []).map(i => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`)
].join('\n');

/** Окно с подробностями одной передачи. */
export function openTransferEntry(index) {
  const e = loadTransferLog()[index];
  if (!e) return null;
  const ov = openOverlay({ title: '📦 Передача предметов', wide: true });
  ov.body.innerHTML = detailsHtml(e);
  ov.foot.innerHTML = '<span></span><div class="row gap"><button type="button" class="btn" data-copy>📋 Скопировать</button><button type="button" class="btn primary" data-close>Закрыть</button></div>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-copy]').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(entryText(e)); ev.target.textContent = '✔ Скопировано'; }
    catch { ev.target.textContent = 'Не удалось скопировать'; }
  };
  return ov;
}

const entryKey = (e) => `${e.at}|${e.charId}`;

/** Вид логов «Передачи» в едином модуле логов (logHub.js). */
export const transferLogSource = {
  id: 'transfer',
  title: 'Передачи',
  icon: '📦',
  list: () => loadTransferLog().map(e => ({
    key: entryKey(e), at: e.at, title: `${e.recipient || '?'} · ${e.server || '?'}`,
    status: e.status === 'success' ? 'ok' : statusInfo(e.status).level === 'error' ? 'error' : 'warn',
    who: e.nick,
    summary: `${e.count || itemsCount(e)} предм.${e.status === 'success' ? '' : ` · ${statusInfo(e.status).label}`}`
  })),
  open: (item) => {
    const i = loadTransferLog().findIndex(e => entryKey(e) === item.key);
    if (i >= 0) openTransferEntry(i);
  },
  clear: () => clearTransferLog(),
  clearConfirm: 'Очистить логи передач? Приложение забудет, что и когда передавалось. На сайте история останется.',
  subscribe: (fn) => { window.addEventListener('tf-transfer-log', fn); return () => window.removeEventListener('tf-transfer-log', fn); }
};
registerLogSource(transferLogSource);

/** Окно со всеми передачами (кнопка «Журнал» в диалоге передачи): единый журнал, вид «Передачи». */
export function openTransferLog() {
  return openLogHub({ source: 'transfer', title: '📜 Журнал передач' });
}
