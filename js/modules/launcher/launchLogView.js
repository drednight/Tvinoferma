// js/modules/launcher/launchLogView.js
// История запусков игры как вид логов единого модуля (core/logHub.js, «Настройки → Журналы → Запуски»).
// Запись: время, название запуска, сколько окон открылось из скольких и за какое время; нажатие открывает подробности по окнам.
// Кнопка «📊 Статистика» — итоги по всему журналу: время запуска окон, нестабильные персонажи, ошибки при разной паузе.

import { escapeHtml } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { registerLogSource } from '../../core/logHub.js';
import { openOverlay } from '../marathons/overlay.js';
import { formatDuration } from './launch.js';
import {
  loadLaunchLog, clearLaunchLog, statsOf, perCharacter, perDelay, delayAdvice, fmtMs, UNSTABLE_MIN_ATTEMPTS, UNSTABLE_RATE
} from './launchLog.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const pct = (v) => `${Math.round(v * 100)}%`;

const STATUS_TEXT = {
  ok: '✅ запущено', failed: '❌ ошибка', cancelled: '⏹ отменено',
  running: '⏭ уже было запущено, пропущено', nogc: '🚫 не указан GameCenter'
};

/** Статус записи для общего журнала: ошибки — красный, пропуски и отмены — жёлтый. */
const runStatus = (r) => (r.failed ? 'error' : r.cancelled || r.noGc ? 'warn' : 'ok');

/** Подпись запуска: «Запущено 4 из 5 · ошибок 1 · 1 мин 12 с». */
export function runSummary(r) {
  const tried = r.ok + r.failed + r.cancelled;
  const bits = [`запущено ${r.ok} из ${tried}`];
  if (r.failed) bits.push(`ошибок ${r.failed}`);
  if (r.cancelled) bits.push(`отменено ${r.cancelled}`);
  if (r.running) bits.push(`уже было запущено ${r.running}`);
  if (r.noGc) bits.push(`без GameCenter ${r.noGc}`);
  bits.push(formatDuration(r.ms));
  return bits.join(' · ');
}

export function runDetailsHtml(r) {
  const rows = r.items.map(it => `
    <tr><td><b>${escapeHtml(it.nick)}</b>${it.noLogin ? ' <span class="muted" title="Вход в GameCenter не запомнен: окно открылось под открытым аккаунтом">🔓</span>' : ''}</td>
      <td>${STATUS_TEXT[it.status] || escapeHtml(it.status)}</td>
      <td>${it.status === 'ok' || it.status === 'failed' ? escapeHtml(fmtMs(it.ms)) : '—'}</td>
      <td class="muted">${escapeHtml(it.error || '')}</td></tr>`).join('');
  return `
    <div class="tl-summary"><span>🚀 <b>${escapeHtml(r.title)}</b></span><span class="muted">${escapeHtml(when(r.at))}</span></div>
    <div class="promo-log-h">${escapeHtml(runSummary(r))}</div>
    <div class="muted">Пауза между запусками: ${r.delayMs / 1000} с${r.gc ? ` · GameCenter «${escapeHtml(r.gc)}»` : ''}. «Время» — сколько ждали появления клиента игры (без паузы).</div>
    <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Итог</th><th>Время</th><th>Ошибка</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const runText = (r) => [
  `${when(r.at)} · ${r.title} · ${runSummary(r)}`,
  `Пауза: ${r.delayMs / 1000} с`,
  ...r.items.map(it => `${it.nick}: ${STATUS_TEXT[it.status] || it.status}${it.ms != null && (it.status === 'ok' || it.status === 'failed') ? ` · ${fmtMs(it.ms)}` : ''}${it.error ? ` · ${it.error}` : ''}`)
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
export function openLaunchRun(id) {
  const r = loadLaunchLog().find(x => x.id === id);
  return r ? openWithCopy('🚀 Запуск игры', runDetailsHtml(r), runText(r)) : null;
}

/** HTML и текст статистики по журналу (отдельно от окна — для тестов). */
export function statsView(log, currentDelaySec) {
  const s = statsOf(log);
  const chars = perCharacter(log);
  const delays = perDelay(log);
  const advice = delayAdvice(delays, currentDelaySec);
  const unstable = chars.filter(c => c.unstable);

  const charRows = chars.slice(0, 60).map(c => `
    <tr class="${c.unstable ? 'promo-alert-row' : ''}"><td><b>${escapeHtml(c.nick)}</b>${c.unstable ? ' ⚠️' : ''}</td>
      <td>${c.attempts}</td><td>${c.ok}</td><td>${c.failed}${c.attempts ? ` <span class="muted">(${pct(c.failRate)})</span>` : ''}</td>
      <td>${escapeHtml(fmtMs(c.avgMs))}</td><td>${c.skipped || '—'}</td>
      <td class="muted">${c.lastError ? `${escapeHtml(c.lastError)} · ${escapeHtml(when(c.lastErrorAt))}` : ''}</td></tr>`).join('');
  const delayRows = delays.map(d => `
    <tr><td>${d.delaySec} с</td><td>${d.windows}</td><td>${d.failed} <span class="muted">(${pct(d.failRate)})</span></td><td>${escapeHtml(fmtMs(d.avgMs))}</td></tr>`).join('');

  const html = `
    <div class="tl-summary"><span>📊 <b>Статистика запусков</b></span>
      <span class="muted">${s.from ? `${escapeHtml(when(s.from))} — ${escapeHtml(when(s.to))}` : ''}</span></div>
    <div class="promo-log-h">Запусков: ${s.runs} · окон открыто: ${s.ok} из ${s.attempts}${s.failed ? ` · ошибок: ${s.failed} (${pct(s.failRate)})` : ''}${s.skippedRunning ? ` · пропущено уже запущенных: ${s.skippedRunning}` : ''}</div>
    <div class="muted">Среднее ожидание клиента игры: ${escapeHtml(fmtMs(s.avgMs))}${s.maxMs != null ? `, самое долгое: ${escapeHtml(fmtMs(s.maxMs))}` : ''} · общее время запусков: ${escapeHtml(formatDuration(s.totalMs))}.</div>
    ${unstable.length ? `<div class="promo-alert">⚠️ Нестабильные (ошибка в ${pct(UNSTABLE_RATE)}+ запусков, минимум ${UNSTABLE_MIN_ATTEMPTS} попытки): ${escapeHtml(unstable.map(c => c.nick).join(', '))}. Проверьте GameCenter и запомненный вход этих персонажей.</div>` : ''}
    <div class="promo-log-h">По персонажам</div>
    <div class="promo-scroll"><table class="promo-table"><thead><tr><th>Персонаж</th><th>Попыток</th><th>Запущено</th><th>Ошибок</th><th>Среднее время</th><th>Пропущено</th><th>Последняя ошибка</th></tr></thead><tbody>${charRows || '<tr><td colspan="7" class="muted">Данных пока нет</td></tr>'}</tbody></table></div>
    <div class="promo-log-h">Ошибки при разной паузе между запусками</div>
    ${delays.length ? `<div class="promo-scroll"><table class="promo-table"><thead><tr><th>Пауза</th><th>Окон</th><th>С ошибкой</th><th>Среднее время</th></tr></thead><tbody>${delayRows}</tbody></table></div>` : '<div class="muted">Данных пока нет</div>'}
    <div class="promo-log-h">💡 Подбор паузы</div>
    <div>${escapeHtml(advice)}</div>`;

  const text = [
    `Запуски игры: ${s.runs} запусков, окон открыто ${s.ok} из ${s.attempts}, ошибок ${s.failed}`,
    `Среднее ожидание клиента: ${fmtMs(s.avgMs)}`,
    ...(unstable.length ? [`Нестабильные: ${unstable.map(c => c.nick).join(', ')}`] : []),
    '',
    'Персонаж · попыток · запущено · ошибок · среднее время',
    ...chars.map(c => `${c.nick} · ${c.attempts} · ${c.ok} · ${c.failed} · ${fmtMs(c.avgMs)}`),
    '',
    'Пауза · окон · с ошибкой',
    ...delays.map(d => `${d.delaySec} с · ${d.windows} · ${d.failed}`),
    '',
    advice
  ].join('\n');
  return { html, text, stats: s, chars, delays, advice };
}

/** Окно со статистикой по всему журналу. */
export function openLaunchStats() {
  const v = statsView(loadLaunchLog(), Number(state.settings?.launcher?.delaySec ?? 3));
  return openWithCopy('📊 Запуски игры: статистика', v.html, v.text);
}

/** Вид логов «Запуски» в едином модуле логов (logHub.js). */
export const launchLogSource = {
  id: 'launch',
  title: 'Запуски',
  icon: '🚀',
  list: () => loadLaunchLog().map(r => ({
    key: r.id, at: r.at, title: r.title, status: runStatus(r), summary: runSummary(r)
  })),
  open: (item) => openLaunchRun(item.key),
  clear: () => clearLaunchLog(),
  clearConfirm: 'Очистить историю запусков игры? Статистика (время запуска окон, нестабильные персонажи) тоже сбросится.',
  actions: () => [{ id: 'stats', label: '📊 Статистика', disabled: !loadLaunchLog().length, run: () => openLaunchStats() }],
  subscribe: (fn) => { window.addEventListener('tf-launch-log', fn); return () => window.removeEventListener('tf-launch-log', fn); }
};
registerLogSource(launchLogSource);
