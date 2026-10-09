// js/settings/parserHealthUi.js
// Плашка «Парсер устарел» под шапкой и раздел «Состояние парсеров» в настройках.
// Логика статусов — в js/core/parserHealth.js.

import {
  PARSERS, STATUS_LABEL, NEVER_CHECKED, FAIL_THRESHOLD,
  subscribeHealth, getParserHealth, problemParsers, buildDiagnostics, formatHealthTime, selectorsVersion
} from '../core/parserHealth.js';
import { errorText } from '../core/errorCodes.js';
import { escapeHtml, copyToClipboard } from '../core/utils.js';
import { toast } from '../core/ui.js';

/** Плашку «Скрыть» убрал пользователь: id парсера → число неудач на тот момент. Вернётся, если неудач станет больше. */
const dismissed = new Map();

/** HTML плашки; пустая строка, если проблем нет. */
export function bannerHtml(problems) {
  if (!problems.length) return '';
  const names = problems.map(p => PARSERS[p.id].short);
  const title = problems.length === 1
    ? `Парсер ${names[0]} устарел`
    : `Устарели парсеры: ${names.join(', ')}`;
  const lastOk = problems.map(p => p.lastOkAt).filter(Boolean).sort().pop();
  return `
    <div class="health-banner-text">
      <strong>⚠️ ${escapeHtml(title)}</strong>
      <span>Возможно, сайт pwonline.ru изменил вёрстку${lastOk ? `; последний раз всё работало ${escapeHtml(formatHealthTime(lastOk))}` : ''}.
      Данные в приложении не тронуты — остаются прежние значения. Скопируйте диагностику и отправьте разработчику.</span>
    </div>
    <div class="health-banner-actions">
      <button type="button" class="btn small" data-health-copy="all">📋 Скопировать диагностику</button>
      <button type="button" class="btn small ghost" data-health-open>Состояние парсеров</button>
      <button type="button" class="btn small ghost" data-health-hide>Скрыть</button>
    </div>`;
}

/** HTML таблицы «Состояние парсеров». */
export function healthTableHtml(health) {
  const rows = Object.keys(PARSERS).map(id => {
    const e = health[id];
    const status = e.status ? STATUS_LABEL[e.status] : NEVER_CHECKED;
    const cls = e.status === 'layout_changed' && e.failStreak >= FAIL_THRESHOLD ? ' is-problem' : '';
    return `
      <tr class="${cls.trim()}">
        <td><strong>${escapeHtml(PARSERS[id].title)}</strong><small class="muted">${escapeHtml(PARSERS[id].page)}</small></td>
        <td>${escapeHtml(status)}${e.failStreak ? `<small class="muted">неудач подряд: ${e.failStreak}</small>` : ''}</td>
        <td>${escapeHtml(formatHealthTime(e.lastOkAt))}</td>
        <td>${e.lastError ? escapeHtml(errorText(e.lastError)) : '—'}${e.lastError ? `<small class="muted">${escapeHtml(e.lastError)}</small>` : ''}</td>
        <td><button type="button" class="btn small ghost" data-health-copy="${id}" title="Скопировать диагностику этого парсера">📋</button></td>
      </tr>`;
  }).join('');
  return `
    <table class="health-table">
      <thead><tr><th>Парсер</th><th>Последняя проверка</th><th>Последняя успешная</th><th>Последняя ошибка</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function visibleProblems() {
  return problemParsers().filter(p => p.failStreak > (dismissed.get(p.id) ?? 0));
}

function render(health) {
  const banner = document.getElementById('parser-health-banner');
  if (banner) {
    const problems = visibleProblems();
    banner.hidden = !problems.length;
    banner.innerHTML = bannerHtml(problems);
  }
  const table = document.getElementById('parser-health-list');
  if (table) table.innerHTML = healthTableHtml(health);
  const cfg = document.getElementById('parser-health-config');
  if (cfg) cfg.textContent = `Версия selectors.json в этой сборке: ${selectorsVersion()}`;
}

async function copyDiagnostics(which) {
  const ok = await copyToClipboard(buildDiagnostics(which === 'all' ? undefined : which));
  toast(ok ? 'Диагностика скопирована. Пароли и почты в неё не попадают.' : 'Не удалось скопировать диагностику', ok ? 'success' : 'error');
}

/**
 * Наполнить панель состояния парсеров, если она есть на странице.
 *
 * Раздел «Инструменты» рисуется при переходе на вкладку, то есть позже подписки
 * на изменения: без этого вызова таблица осталась бы пустой до первого события.
 */
export function refreshParserHealthPanel() {
  render(getParserHealth());
}

/** Подключает плашку и раздел настроек. Вызывать один раз при старте. Возвращает функцию отключения. */
export function initParserHealthUi() {
  const onClick = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const copy = target.closest('[data-health-copy]');
    if (copy) { copyDiagnostics(copy.getAttribute('data-health-copy') || 'all'); return; }
    if (target.closest('[data-health-hide]')) {
      problemParsers().forEach(p => dismissed.set(p.id, p.failStreak));
      render(getParserHealth());
      return;
    }
    if (target.closest('[data-health-open]')) {
      // «Состояние парсеров» живёт в разделе «Инструменты»: это диагностика, а не настройка
      document.querySelector('.tab[data-tab="tools"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const panel = document.getElementById('parser-health-panel');
      if (panel instanceof HTMLDetailsElement) panel.open = true;   // панель свёрнута по умолчанию
      panel?.scrollIntoView({ block: 'start' });
    }
  };
  document.addEventListener('click', onClick);
  const unsubscribe = subscribeHealth(render);
  return () => { document.removeEventListener('click', onClick); unsubscribe(); };
}
