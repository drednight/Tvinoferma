// js/settings/parserHealthUi.js
// Плашка «Парсер устарел» под шапкой и раздел «Состояние парсеров» в настройках.
// Логика статусов — в js/core/parserHealth.js.

import {
  PARSERS,
  STATUS_LABEL,
  NEVER_CHECKED,
  FAIL_THRESHOLD,
  subscribeHealth,
  getParserHealth,
  problemParsers,
  buildDiagnostics,
  formatHealthTime,
  selectorsVersion
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
  const title = problems.length === 1 ? `Парсер ${names[0]} устарел` : `Устарели парсеры: ${names.join(', ')}`;
  const lastOk = problems
    .map(p => p.lastOkAt)
    .filter(Boolean)
    .sort()
    .pop();
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

/** Компактные карточки не требуют широкой таблицы и помещаются в колонку настроек. */
export function healthCardsHtml(health) {
  const cards = Object.keys(PARSERS)
    .map(id => {
      const e = health[id];
      const parser = PARSERS[id];
      const status = e.status ? STATUS_LABEL[e.status] : NEVER_CHECKED;
      const cls = e.status === 'layout_changed' && e.failStreak >= FAIL_THRESHOLD ? ' is-problem' : '';
      return `
      <li class="health-card${cls}" data-health-parser="${escapeHtml(id)}">
        <div class="health-card-head">
          <div class="health-card-title"><strong>${escapeHtml(parser.title)}</strong><small>${escapeHtml(parser.page)}</small></div>
          <button type="button" class="btn small ghost health-card-copy" data-health-copy="${escapeHtml(id)}" aria-label="Скопировать диагностику: ${escapeHtml(parser.title)}" title="Скопировать диагностику этого парсера">📋</button>
        </div>
        <div class="health-card-status">${escapeHtml(status)}${e.failStreak ? `<small>неудач подряд: ${e.failStreak}</small>` : ''}</div>
        <div class="health-card-meta"><span>Последняя успешная:</span> ${escapeHtml(formatHealthTime(e.lastOkAt))}</div>
        ${e.lastError ? `<div class="health-card-meta"><span>Последняя ошибка:</span> ${escapeHtml(errorText(e.lastError))} <code>${escapeHtml(e.lastError)}</code></div>` : ''}
      </li>`;
    })
    .join('');
  return `<ul class="health-list">${cards}</ul>`;
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
  const list = document.getElementById('parser-health-list');
  if (list) list.innerHTML = healthCardsHtml(health);
  const cfg = document.getElementById('parser-health-config');
  if (cfg) cfg.textContent = `Версия selectors.json в этой сборке: ${selectorsVersion()}`;
}

async function copyDiagnostics(which) {
  const ok = await copyToClipboard(buildDiagnostics(which === 'all' ? undefined : which));
  toast(
    ok ? 'Диагностика скопирована. Пароли и почты в неё не попадают.' : 'Не удалось скопировать диагностику',
    ok ? 'success' : 'error'
  );
}

/** Наполнить панель состояния парсеров сейчас (панель живёт в «Настройки → Синхронизация»). */
export function refreshParserHealthPanel() {
  render(getParserHealth());
}

/** Подключает плашку и раздел настроек. Вызывать один раз при старте. Возвращает функцию отключения. */
export function initParserHealthUi() {
  const onClick = e => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const copy = target.closest('[data-health-copy]');
    if (copy) {
      copyDiagnostics(copy.getAttribute('data-health-copy') || 'all');
      return;
    }
    if (target.closest('[data-health-hide]')) {
      problemParsers().forEach(p => dismissed.set(p.id, p.failStreak));
      render(getParserHealth());
      return;
    }
    if (target.closest('[data-health-open]')) {
      // «Состояние парсеров» живёт в «Настройки → Синхронизация»: открываем вкладку настроек,
      // переключаем раздел (остальные скрыты) и раскрываем панель
      document.querySelector('.tab[data-tab="settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new CustomEvent('tf:open-section', { detail: { id: 'settings-sync' } }));
      const panel = document.getElementById('parser-health-panel');
      if (panel instanceof HTMLDetailsElement) panel.open = true; // панель свёрнута по умолчанию
      panel?.scrollIntoView({ block: 'start' });
    }
  };
  document.addEventListener('click', onClick);
  const unsubscribe = subscribeHealth(render);
  return () => {
    document.removeEventListener('click', onClick);
    unsubscribe();
  };
}
