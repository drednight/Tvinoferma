// js/modules/automation/promoLogView.js
// Настройки → «🎁 История промокодов» (Issue #25).
// Свёрнутый блок — название и описание. Раскрытый — список «Промокод — дата первого ввода».
// Нажатие на промокод: награда, персонажи, у которых он введён (и когда), и отдельно те, кому он не введён (и почему).

import { escapeHtml } from '../../core/utils.js';
import { confirmDialog, toast } from '../../core/ui.js';
import { errorText } from '../../core/errorCodes.js';
import { statusInfo, rewardLine } from './promoCore.js';
import { loadLog, clearLog, loadArchive, archiveCsv, enteredList, missedList, LOG_MAX } from './promoLog.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const openCodes = new Set();   // какие коды раскрыты: сохраняем при обновлении списка

function reasonText(reason) {
  if (!reason) return 'не запускался (персонаж не был выбран)';
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

export function recordHtml(rec) {
  const entered = enteredList(rec);
  const missed = missedList(rec);
  return `
    <details class="promo-log-item" data-code="${escapeHtml(rec.code)}" ${openCodes.has(rec.code) ? 'open' : ''}>
      <summary><code>${escapeHtml(rec.code)}</code> <span class="muted">— введён ${escapeHtml(when(rec.firstAt))}</span></summary>
      <div class="promo-log-body">
        ${rec.reward?.length ? `<div class="promo-log-h">🎁 Награда</div><ul class="promo-log-list">${rec.reward.map(r => `<li>${escapeHtml(rewardLine(r))}${r.bound ? ' <span class="muted">(привязанный)</span>' : ''}</li>`).join('')}</ul>` : '<div class="muted">Награда не записана.</div>'}
        <div class="promo-log-h">✅ Введён (${entered.length})</div>
        ${entered.length ? `<table class="promo-table"><tbody>${entered.map(e =>
          `<tr><td><b>${escapeHtml(e.nick)}</b></td><td>${escapeHtml(when(e.at))}</td><td class="muted">${e.status === 'already_used' ? 'сайт: уже был введён' : 'введён приложением'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Никому.</div>'}
        ${missed.length ? `<div class="promo-log-h">⚠ Не введён (${missed.length}) — можно ввести вручную</div>
          <table class="promo-table"><tbody>${missed.map(m =>
            `<tr><td><b>${escapeHtml(m.nick)}</b></td><td class="muted">${escapeHtml(reasonText(m.reason))}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </details>`;
}

/** Перерисовывает блок в настройках (если он есть на странице). */
export function renderPromoLog() {
  const root = document.getElementById('promo-log-root');
  if (!root) return;
  bindPromoLog();
  const log = loadLog().sort((a, b) => String(b.firstAt).localeCompare(String(a.firstAt)));
  const archive = loadArchive();
  root.innerHTML = `
    ${log.length ? log.map(recordHtml).join('') : '<div class="empty-state">Пока ни один промокод не введён.</div>'}
    <div class="row gap" style="margin-top: 12px;">
      <button class="btn ghost" data-promo-log="archive" ${archive.length ? '' : 'disabled'} title="Все коды за всё время: код, дата, награда">⬇ Весь архив (${archive.length}), CSV</button>
      <button class="btn ghost danger" data-promo-log="clear" ${log.length ? '' : 'disabled'}>🗑 Очистить журнал</button>
    </div>
    <p class="muted" style="margin-top: 6px;">В журнале последние ${LOG_MAX} кодов. Архив (код, дата, награда) хранится без ограничения.</p>`;
}

let bound = false;
/** Один раз навешивает обработчики на блок; безопасно вызывать повторно. */
export function bindPromoLog() {
  if (bound) return;
  const root = document.getElementById('promo-log-root');
  if (!root) return;
  bound = true;
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d?.classList?.contains('promo-log-item')) { if (d.open) openCodes.add(d.dataset.code); else openCodes.delete(d.dataset.code); }
  }, true);
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-promo-log]')?.dataset.promoLog;
    if (act === 'archive') {
      downloadText(archiveCsv(loadArchive()), `promo-archive-${new Date().toISOString().slice(0, 10)}.csv`);
    }
    if (act === 'clear' && confirmDialog('Очистить журнал промокодов? Архив (код, дата, награда) останется. Приложение забудет, кому коды уже введены, и при повторном вводе откроет страницы заново.')) {
      clearLog();
      renderPromoLog();
      toast('Журнал очищен', 'success');
    }
  });
  window.addEventListener('tf-promo-log', () => renderPromoLog());
}
