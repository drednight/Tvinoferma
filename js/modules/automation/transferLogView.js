// js/modules/automation/transferLogView.js
// Настройки → «📦 Логи переводов» (Issue #26) — по образцу «Логов промокодов».
// Список передач: время, браузер → сервер → получатель, что передано и чем закончилось. Нажатие открывает подробности.

import { escapeHtml } from '../../core/utils.js';
import { confirmDialog, toast } from '../../core/ui.js';
import { openOverlay } from '../marathons/overlay.js';
import { statusInfo } from './transferCore.js';
import { loadTransferLog, clearTransferLog, LOG_MAX } from './transferStore.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const itemsCount = (e) => (e.items || []).reduce((n, i) => n + (Number(i.qty) || 1), 0);

/** Короткая строка для заголовка свёрнутого блока. */
export function transferLogSummary(log = loadTransferLog()) {
  if (!log.length) return 'Записей пока нет: они появятся после первой передачи предметов.';
  const problems = log.filter(e => e.status !== 'success').length;
  return `Записей: ${log.length}${problems ? ` (требуют проверки: ${problems})` : ''} · последняя: ${when(log[0].at)}`;
}

const label = (e) => {
  const info = statusInfo(e.status);
  return `${info.label}${e.detail ? `: ${e.detail}` : ''}`;
};

export function detailsHtml(e) {
  return `
    <div class="tl-summary"><span>📦 <b>${escapeHtml(e.nick)}</b> → ${escapeHtml(e.server || '?')} → <b>${escapeHtml(e.recipient || '?')}</b></span><span class="muted">${escapeHtml(when(e.at))}</span></div>
    <div class="promo-log-h">${statusInfo(e.status).icon} ${escapeHtml(label(e))}</div>
    ${e.siteStatus ? `<div class="muted">Статус на сайте: ${escapeHtml(e.siteStatus)}</div>` : ''}
    <div class="promo-log-h">Предметы (${e.count || itemsCount(e)})</div>
    ${e.items?.length ? `<ul class="promo-log-list">${e.items.map(i => `<li>${escapeHtml(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</li>`).join('')}</ul>` : '<div class="muted">Список предметов не записан.</div>'}
    ${e.status === 'success' ? '' : '<p class="promo-warn">Сверьте с «Историей передачи» на сайте: приложение само ничего не повторяет, чтобы не отправить предметы дважды.</p>'}`;
}

const entryText = (e) => [
  `${when(e.at)} · ${e.nick} → ${e.server || '?'} → ${e.recipient || '?'}`,
  label(e),
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

const rowsHtml = (log) => `<div class="tl-journal">${log.map((e, i) => `
  <button type="button" class="tl-jrow tl-s-${e.status === 'success' ? 'done' : 'warn'}" data-transfer-entry="${i}">
    <span>${statusInfo(e.status).icon}</span>
    <strong>${escapeHtml(e.recipient || '?')} · ${escapeHtml(e.server || '?')}</strong>
    <span class="muted">${escapeHtml(when(e.at))}</span>
    <span class="tl-jsum">${escapeHtml(e.nick)} · ${e.count || itemsCount(e)} предм.${e.status === 'success' ? '' : ` · ${escapeHtml(statusInfo(e.status).label)}`}</span>
  </button>`).join('')}</div>`;

/** Перерисовывает список в настройках (если он есть на странице) и заголовок блока. */
export function renderTransferLog() {
  const summary = document.getElementById('transfer-log-summary');
  const log = loadTransferLog();
  if (summary) summary.textContent = transferLogSummary(log);
  const root = document.getElementById('transfer-log-root');
  if (!root) return;
  bindTransferLog();
  root.innerHTML = `
    <div class="muted" style="margin-bottom:8px;">Записей: ${log.length}. Нажмите на запись, чтобы открыть подробности.</div>
    ${log.length ? rowsHtml(log) : '<div class="empty-state">Здесь появятся передачи предметов.</div>'}
    <div class="row gap" style="margin-top: 12px;">
      <button class="btn ghost danger" data-transfer-log="clear" ${log.length ? '' : 'disabled'}>🧹 Очистить логи</button>
    </div>
    <p class="muted" style="margin-top: 6px;">В логах последние ${LOG_MAX} передач. Пробные запуски не записываются. Данные лежат только на этом компьютере.</p>`;
}

/** Окно со всем журналом (кнопка «Журнал» в диалоге передачи). */
export function openTransferLog() {
  const log = loadTransferLog();
  const ov = openOverlay({ title: '📦 Журнал передач', wide: true });
  ov.body.innerHTML = log.length ? rowsHtml(log) : '<div class="empty-state">Передач пока не было.</div>';
  ov.body.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-transfer-entry]');
    if (row) openTransferEntry(Number(row.dataset.transferEntry));
  });
  ov.foot.innerHTML = '<span></span><button type="button" class="btn primary" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

let bound = false;
/** Один раз навешивает обработчики на блок; безопасно вызывать повторно. */
export function bindTransferLog() {
  if (bound) return;
  const root = document.getElementById('transfer-log-root');
  if (!root) return;
  bound = true;
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-transfer-entry]');
    if (row) { openTransferEntry(Number(row.dataset.transferEntry)); return; }
    if (e.target.closest('[data-transfer-log]')?.dataset.transferLog === 'clear'
      && confirmDialog('Очистить логи передач? Приложение забудет, что и когда передавалось. На сайте история останется.')) {
      clearTransferLog();
      renderTransferLog();
      toast('Логи очищены', 'success');
    }
  });
  window.addEventListener('tf-transfer-log', () => renderTransferLog());
}
