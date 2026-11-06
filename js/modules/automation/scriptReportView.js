import { classIconHtml } from './characterPicker.js';
import { state } from '../../core/state.js';
// Таблица подробностей результата и статистика из сохранённых отчётов журнала задач.
import { escapeHtml } from '../../core/utils.js';
import { mskStamp } from '../../core/msk.js';
import { openOverlay } from '../marathons/overlay.js';

const when = value => (value ? mskStamp(value) : '');

/** Строки разных запусков группируются по id, не по отображаемому нику. */
export function groupScriptReports(reports, query = '') {
  const needle = String(query).trim().toLocaleLowerCase('ru');
  const groups = new Map();
  for (const report of reports || []) {
    for (const row of Array.isArray(report?.rows) ? report.rows : []) {
      if (!row || !row.nick) continue;
      const key = row.charId ? `id:${row.charId}` : `name:${row.nick}`;
      const haystack = [row.nick, row.context, row.action, report.title].join(' ').toLocaleLowerCase('ru');
      if (needle && !haystack.includes(needle)) continue;
      if (!groups.has(key)) groups.set(key, { key, charId: row.charId, nick: row.nick, entries: [] });
      groups
        .get(key)
        .entries.push({ ...row, script: report.title || 'Скрипт', dryRun: !!report.dryRun, at: report.at });
    }
  }
  return [...groups.values()].sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
}

/** Все строки экранируются: имена и ответы сайта — недоверенные данные. */
export function scriptStatisticsHtml(reports, query = '') {
  const groups = groupScriptReports(reports, query);
  if (!groups.length)
    return '<div class="empty-state">Подробных результатов пока нет или по поиску ничего не найдено.</div>';
  const validTone = new Set(['ok', 'info', 'warn', 'error']);
  const rows = groups.flatMap(group => group.entries.map(row => ({ group, row })));
  return `<div class="tl-summary-table"><div class="tl-summary-title">Итоги по персонажам</div><div class="sr-table-wrap"><table class="sr-table"><thead><tr><th>Персонаж</th><th>Результат</th><th>Действие / скрипт</th><th>Подробности</th></tr></thead><tbody>${rows.map(({ group, row }) => `<tr><td>${classIconHtml(state.characters.find(c => c.id === group.charId) || {})} <b>${escapeHtml(group.nick)}</b></td><td><span class="sr-status is-${validTone.has(row.tone) ? row.tone : 'info'}">${escapeHtml(row.status || '—')}</span></td><td>${escapeHtml(row.action || '—')}<div class="muted">${escapeHtml(row.script)} · ${escapeHtml(when(row.at))}${row.dryRun ? ' · Пробный запуск' : ''}</div>${row.context ? `<div>${escapeHtml(row.context)}</div>` : ''}</td><td>${Array.isArray(row.details) && row.details.length ? row.details.map(line => escapeHtml(line)).join('<br>') : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/** Отдельное окно используют итоги скрипта и журнал: данные передаются уже безопасным снимком. */
export function openScriptStatistics(
  reports,
  {
    title = '📊 Статистика по персонажам',
    note = 'Показаны сохранённые подробные отчёты скриптов. Старые записи без такого отчёта остаются в обычном журнале.'
  } = {}
) {
  const list = Array.isArray(reports) ? reports : [];
  const ov = openOverlay({ title, wide: true });
  const dialog = ov.el.querySelector('.tf-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  ov.sub.textContent = note;
  ov.body.innerHTML = `<div class="sr-controls"><label>Поиск по персонажу или действию <input class="input" type="search" data-sr-search placeholder="Ник, получатель или скрипт"></label></div><div data-sr-results></div>`;
  const input = ov.body.querySelector('[data-sr-search]');
  const results = ov.body.querySelector('[data-sr-results]');
  const draw = () => {
    results.innerHTML = scriptStatisticsHtml(list, input.value);
  };
  input.addEventListener('input', draw);
  draw();
  ov.foot.innerHTML = '<span></span><button type="button" class="btn primary" data-sr-close>Закрыть</button>';
  ov.foot.querySelector('[data-sr-close]').addEventListener('click', () => ov.close());
  return ov;
}
