// js/modules/automation/promoLogView.js
// Логи промокодов (Issue #25) как вид логов единого модуля (core/logHub.js, «Настройки → Журналы»).
// Нажатие на запись открывает окно: награда, персонажи, у которых код введён (и когда), и те, кому не введён (и почему).

import { escapeHtml } from '../../core/utils.js';
import { registerLogSource } from '../../core/logHub.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import { statusInfo, rewardLine } from './promoCore.js';
import { loadLog, clearLog, loadArchive, archiveCsv, enteredList, missedList, findRecord } from './promoLog.js';

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

/** Вид логов «Промокоды» в едином модуле логов (logHub.js). */
export const promoLogSource = {
  id: 'promo',
  title: 'Промокоды',
  icon: '🎁',
  list: () => loadLog().map(rec => {
    const missed = missedList(rec).length;
    const entered = Object.keys(rec.entered).length;
    return {
      key: rec.code, at: rec.lastAt || rec.firstAt, title: `Промокод ${rec.code}`, status: missed ? 'warn' : 'ok',
      summary: `Введён: ${entered}${missed ? `, не введён: ${missed}` : ''}${rec.reward?.length ? ` · награда: ${rec.reward.length}` : ''}`
    };
  }),
  open: (item) => openPromoRecord(item.key),
  clear: () => clearLog(),
  clearConfirm: 'Очистить логи промокодов? Архив (код, дата, награда) останется. Приложение забудет, кому коды уже введены, и при повторном вводе откроет страницы заново.',
  subscribe: (fn) => { window.addEventListener('tf-promo-log', fn); return () => window.removeEventListener('tf-promo-log', fn); },
  actions: () => {
    const n = loadArchive().length;
    return [{
      id: 'archive', label: `⬇ Архив промокодов (${n}), CSV`, disabled: !n,
      run: () => downloadText(archiveCsv(loadArchive()), `promo-archive-${new Date().toISOString().slice(0, 10)}.csv`)
    }];
  }
};
registerLogSource(promoLogSource);
