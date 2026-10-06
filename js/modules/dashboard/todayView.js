// js/modules/dashboard/todayView.js
// Экран «Сегодня» (Issue #39): самостоятельная стартовая страница приложения.
//
// Три блока: что требует внимания (со кнопкой действия в строке), что делать в марафонах
// и общая сводка. Данные собирает today.js, здесь — только показ и кнопки.
//
// Список персонажей живёт в отдельном разделе: обзор не конкурирует с рабочими карточками.

import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins } from '../../core/coins.js';
import { todayData, daysWord } from './today.js';
import { plannerHtml, bindPlanner } from './plannerView.js';

/**
 * Разметка экрана «Сегодня».
 * @param {{ run?: (action: string, payload?: any) => void }} deps
 * @param {any} [appState]
 */
export function todayHtml(deps = {}, appState = state) {
  const data = todayData(appState);
  // На пустых данных экран не нужен: там своя подсказка первых шагов
  if (!data.characters) return '';

  const attention = data.attention;
  const supplies = data.supplies;
  return `
    <section class="today" data-today>
      <div class="today-head">
        <div>
          <h3>Обзор дня</h3>
          <p class="muted">Важные действия, активные события и общие показатели.</p>
        </div>
      </div>
      <div class="today-grid">
        <section class="today-card">
          <h4 class="today-title">
            <span aria-hidden="true">${attention.length ? '⚠️' : '✅'}</span>
            Требуют внимания
            ${attention.length ? `<span class="today-count is-warn">${attention.length}</span>` : ''}
          </h4>
          ${attention.length ? `<ul class="today-list">
            ${attention.slice(0, 12).map(item => `
              <li class="today-row">
                <span class="today-dot is-${escapeHtml(item.tone)}" aria-hidden="true"></span>
                <span class="today-row-text">
                  <b>${escapeHtml(item.title)}</b>
                  <small class="muted">${escapeHtml(item.text)}</small>
                </span>
                <button type="button" class="btn secondary small"
                        data-today-act="${escapeHtml(item.action)}"
                        ${item.charId ? `data-today-char="${escapeHtml(item.charId)}"` : ''}
                        ${item.marathonId ? `data-today-marathon="${escapeHtml(item.marathonId)}"` : ''}>${escapeHtml(item.actionLabel)}</button>
              </li>`).join('')}
          </ul>
          ${attention.length > 12 ? `<p class="muted today-more">Показаны первые 12. Остальные доступны в разделе «Персонажи».</p>` : ''}`
            : '<p class="muted today-empty">Всё в порядке: входы активны, балансы свежие, отстающих в марафонах нет.</p>'}
        </section>

        <section class="today-card">
          <h4 class="today-title"><span aria-hidden="true">🏃</span> Сегодня в марафонах
            ${data.marathons.length ? `<span class="today-count">${data.marathons.length}</span>` : ''}
          </h4>
          ${data.marathons.length ? `<ul class="today-list">
            ${data.marathons.map(m => `
              <li class="today-row">
                <span class="today-row-text">
                  <b>${escapeHtml(m.title)}</b>
                  <small class="muted">Заданий: ${m.tasks} · участников: ${m.participants}${m.done ? ` · всё выполнили: ${m.done}` : ''} · ${escapeHtml(m.hint)}</small>
                </span>
                ${m.behind ? `<span class="today-flag is-warn" title="Столько персонажей ещё не выполнили задания">отстают ${m.behind}</span>` : '<span class="today-flag is-ok">по плану</span>'}
                <button type="button" class="btn secondary small" data-today-act="open-marathon" data-today-marathon="${escapeHtml(m.id)}">Открыть</button>
              </li>`).join('')}
          </ul>` : '<p class="muted today-empty">Идущих марафонов нет.</p>'}
        </section>

        <section class="today-card">
          <h4 class="today-title"><span aria-hidden="true">📊</span> Сводка</h4>
          <div class="today-supplies">
            <div class="today-supply">
              <span class="muted">Древние монеты</span>
              <b class="is-gold">${formatCoins(supplies.coins)} 🪙</b>
            </div>
            <div class="today-supply">
              <span class="muted">Персонажей</span>
              <b>${data.characters}</b>
              <small class="muted">авторизованы: ${data.online} из ${data.characters}</small>
            </div>
          </div>
          ${supplies.endingSoon.length ? `
            <div class="today-soon">
              <span class="muted">Скоро заканчиваются</span>
              ${supplies.endingSoon.map(m => `<span class="today-chip">${escapeHtml(m.title)} — ${m.days === 0 ? 'сегодня' : `${m.days} ${daysWord(m.days)}`}</span>`).join('')}
            </div>` : '<p class="muted today-empty">Ближайшую неделю ничего не заканчивается.</p>'}
          ${data.parties.length ? `
            <div class="today-parties">
              <span class="muted">Пати</span>
              ${data.parties.map(p => `<button type="button" class="today-chip is-button" data-today-act="open-party" data-today-party="${escapeHtml(p.id)}"
                title="Открыть раздел «Пати»">${escapeHtml(p.name)} <b>${p.online}/${p.members}</b></button>`).join('')}
            </div>` : ''}
        </section>
      </div>
    </section>`;
}

/**
 * Рисует самостоятельную страницу «Сегодня».
 * @param {HTMLElement} root контейнер страницы
 * @param {{ run?: (action: string, payload?: any) => void }} deps
 */
export function renderToday(root, deps = {}) {
  if (!root) return;
  const render = () => renderToday(root, deps);
  const summary = todayHtml(deps) || '<div class="empty-state">Добавьте первого персонажа, чтобы здесь появилась сводка.</div>';
  root.innerHTML = `${plannerHtml(state)}${summary}`;
  bindToday(root, deps);
  bindPlanner(root, { ...deps, render });
}

/** Кнопки экрана: действия в строках, переходы и сворачивание. */
function bindToday(root, deps = {}) {
  const section = root.querySelector('[data-today]');
  if (!section || section.dataset.bound) return;
  section.dataset.bound = 'true';

  section.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-today-act]'));
    if (!btn) return;

    const action = btn.dataset.todayAct;
    const charId = btn.dataset.todayChar;
    const marathonId = btn.dataset.todayMarathon;
    if (action === 'check-auth-one' || action === 'balance-one') {
      deps.run?.(action, charId);
      return;
    }
    if (action === 'open-marathon') { deps.run?.('open-marathon', marathonId); return; }
    if (action === 'open-party') { deps.run?.('open-party', btn.dataset.todayParty); }
  });
}
