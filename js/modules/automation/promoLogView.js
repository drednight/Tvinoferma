// js/modules/automation/promoLogView.js
// Настройки → «🎁 Логи промокодов» (Issue #25) — по образцу «Логов скриптов».
// Список «Промокод — дата первого ввода — итог». Нажатие на промокод открывает окно: награда, персонажи,
// у которых он введён (и когда), и отдельно те, кому он не введён (и почему).

import { escapeHtml } from '../../core/utils.js';
import { confirmDialog, toast } from '../../core/ui.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import { statusInfo, rewardLine } from './promoCore.js';
import { loadLog, clearLog, loadArchive, archiveCsv, enteredList, missedList, findRecord, LOG_MAX } from './promoLog.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/** Понятная причина, по которой код не введён. */
export function reasonText(reason) {
  if (!reason) return 'не запускался (персонаж не был выбран)';
  if (reason.status === 'not_run') return reason.detail || 'пропущен';
  if (reason.status === 'cancelled') return 'ввод остановлен кнопкой «Стоп»';
  const label = statusInfo(reason.status).label;
  return reason.status === 'error' && reason.error ? `${label}: ${errorText(reason.error)}` : label;
}

function downloadText(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Короткая строка для заголовка свёрнутого блока. */
export function promoLogSummary(log = loadLog()) {
  if (!log.length) return 'Записей пока нет: они появятся после первого введённого промокода.';
  const last = [...log].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0];
  const problems = log.filter(r => missedList(r).length).length;
  return `Записей: ${log.length}${problems ? ` (не у всех введён: ${problems})` : ''} · последний: ${last.code}`;
}

const recordText = (rec) => {
  const entered = enteredList(rec);
  const missed = missedList(rec);
  return [
    `Промокод ${rec.code} — первый ввод ${when(rec.firstAt)}`,
    rec.reward?.length ? `Награда: ${rec.reward.map(rewardLine).join('; ')}` : 'Награда не записана',
    '', `Введён (${entered.length}):`, ...entered.map(e => `${e.nick} — ${when(e.at)}`),
    '', `Не введён (${missed.length}):`, ...missed.map(m => `${m.nick} — ${reasonText(m.reason)}`)
  ].join('\n');
};

export function detailsHtml(rec) {
  const entered = enteredList(rec);
  const missed = missedList(rec);
  return `
    <div class="tl-summary"><span>🎁 <code>${escapeHtml(rec.code)}</code></span><span class="muted">первый ввод: ${escapeHtml(when(rec.firstAt))}</span></div>
    ${rec.reward?.length ? `<div class="promo-log-h">🎁 Награда</div><ul class="promo-log-list">${rec.reward.map(r => `<li>${escapeHtml(rewardLine(r))}${r.bound ? ' <span class="muted">(привязанный)</span>' : ''}</li>`).join('')}</ul>` : '<div class="muted">Награда не записана.</div>'}
    <div class="promo-log-h">✅ Введён (${entered.length})</div>
    ${entered.length ? `<table class="promo-table"><tbody>${entered.map(e =>
      `<tr><td><b>${escapeHtml(e.nick)}</b></td><td>${escapeHtml(when(e.at))}</td><td class="muted">${e.status === 'already_used' ? 'сайт: уже был введён' : 'введён приложением'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Никому.</div>'}
    ${missed.length ? `<div class="promo-log-h">⚠ Не введён (${missed.length}) — можно ввести вручную</div>
      <table class="promo-table"><tbody>${missed.map(m =>
        `<tr><td><b>${escapeHtml(m.nick)}</b></td><td class="muted">${escapeHtml(reasonText(m.reason))}</td></tr>`).join('')}</tbody></table>` : ''}`;
}

/** Окно с подробностями по одному промокоду. */
export function openPromoRecord(code) {
  const rec = findRecord(loadLog(), code);
  if (!rec) return null;
  const ov = openOverlay({ title: `🎁 Промокод ${rec.code}`, wide: true });
  ov.body.innerHTML = detailsHtml(rec);
  ov.foot.innerHTML = `<span></span><div class="row gap"><button type="button" class="btn" data-copy>📋 Скопировать</button><button type="button" class="btn primary" data-close>Закрыть</button></div>`;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-copy]').onclick = async (e) => {
    try { await navigator.clipboard.writeText(recordText(rec)); e.target.textContent = '✔ Скопировано'; }
    catch { e.target.textContent = 'Не удалось скопировать'; }
  };
  return ov;
}

/** Перерисовывает список в настройках (если он есть на странице) и заголовок блока. */
export function renderPromoLog() {
  const summary = document.getElementById('promo-log-summary');
  const log = loadLog();
  if (summary) summary.textContent = promoLogSummary(log);
  const root = document.getElementById('promo-log-root');
  if (!root) return;
  bindPromoLog();
  const rows = [...log].sort((a, b) => String(b.firstAt).localeCompare(String(a.firstAt)));
  const archive = loadArchive();
  root.innerHTML = `
    <div class="muted" style="margin-bottom:8px;">Записей: ${rows.length}. Нажмите на промокод, чтобы открыть подробности.</div>
    ${rows.length ? `<div class="tl-journal">${rows.map(rec => {
      const missed = missedList(rec).length;
      const entered = Object.keys(rec.entered).length;
      return `<button type="button" class="tl-jrow tl-s-${missed ? 'warn' : 'done'}" data-promo-code="${escapeHtml(rec.code)}">
        <span>${missed ? '⚠️' : '✅'}</span>
        <strong>${escapeHtml(rec.code)}</strong>
        <span class="muted">${escapeHtml(when(rec.firstAt))}</span>
        <span class="tl-jsum">Введён: ${entered}${missed ? `, не введён: ${missed}` : ''}${rec.reward?.length ? ` · 🎁 ${rec.reward.length}` : ''}</span>
      </button>`;
    }).join('')}</div>` : '<div class="empty-state">Ничего не найдено. Здесь появятся введённые промокоды.</div>'}
    <div class="row gap" style="margin-top: 12px;">
      <button class="btn ghost" data-promo-log="archive" ${archive.length ? '' : 'disabled'} title="Все коды за всё время: код, дата, награда">⬇ Весь архив (${archive.length}), CSV</button>
      <button class="btn ghost danger" data-promo-log="clear" ${rows.length ? '' : 'disabled'}>🧹 Очистить логи</button>
    </div>
    <p class="muted" style="margin-top: 6px;">В логах последние ${LOG_MAX} кодов. Архив (код, дата, награда) хранится без ограничения.</p>`;
}

let bound = false;
/** Один раз навешивает обработчики на блок; безопасно вызывать повторно. */
export function bindPromoLog() {
  if (bound) return;
  const root = document.getElementById('promo-log-root');
  if (!root) return;
  bound = true;
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-promo-code]');
    if (row) { openPromoRecord(row.dataset.promoCode); return; }
    const act = e.target.closest('[data-promo-log]')?.dataset.promoLog;
    if (act === 'archive') {
      downloadText(archiveCsv(loadArchive()), `promo-archive-${new Date().toISOString().slice(0, 10)}.csv`);
    }
    if (act === 'clear' && confirmDialog('Очистить логи промокодов? Архив (код, дата, награда) останется. Приложение забудет, кому коды уже введены, и при повторном вводе откроет страницы заново.')) {
      clearLog();
      renderPromoLog();
      toast('Логи очищены', 'success');
    }
  });
  window.addEventListener('tf-promo-log', () => renderPromoLog());
}
