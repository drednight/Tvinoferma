// js/modules/dashboard/todayView.js
// Экран «Сегодня» (Issue #39): стартовый вид раздела «Персонажи».
//
// Три блока: что требует внимания (со кнопкой действия в строке), что делать в марафонах
// и запасы фермы. Данные собирает today.js, здесь — только показ и кнопки.
//
// Экран показывается над списком персонажей и не заменяет его: список остаётся ниже, потому что
// работать с карточками по-прежнему нужно. Свернуть экран можно — это запоминается в настройках.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins } from '../../core/coins.js';
import { todayData, daysWord } from './today.js';

/** Свёрнут ли экран «Сегодня» (настройка в state.settings.ui). */
export function todayCollapsed(appState = state) {
  return appState?.settings?.ui?.todayCollapsed === true;
}

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
  const collapsed = todayCollapsed(appState);

  return `
    <section class="today" data-today>
      <div class="today-head">
        <div>
          <h3>Сегодня</h3>
          <p class="muted">Что требует внимания, что делать в марафонах и что в запасе.</p>
        </div>
        <button type="button" class="btn ghost small" data-today-toggle
                title="${collapsed ? 'Развернуть экран «Сегодня»' : 'Свернуть экран «Сегодня»'}">
          ${collapsed ? '▸ Развернуть' : '▾ Свернуть'}
        </button>
      </div>
      ${collapsed ? '' : `
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
          ${attention.length > 12 ? `<p class="muted today-more">Показаны первые 12. Остальные — в списке персонажей ниже.</p>` : ''}`
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
          <h4 class="today-title"><span aria-hidden="true">📦</span> Запасы</h4>
          <div class="today-supplies">
            <div class="today-supply">
              <span class="muted">Древние монеты</span>
              <b class="is-gold">${formatCoins(supplies.coins)} 🪙</b>
            </div>
            <div class="today-supply">
              <span class="muted">Проходки в данжи</span>
              <b>${supplies.passes}</b>
              <small class="muted">оружие ${supplies.passesByType.weapon} · броня ${supplies.passesByType.armor} · реликвии ${supplies.passesByType.relic}</small>
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
      </div>`}
    </section>`;
}

/**
 * Рисует экран «Сегодня» над списком персонажей.
 *
 * Экран вставляется перед сеткой карточек и перерисовывается вместе с ней: отдельного контейнера
 * в разметке нет, поэтому список остаётся на месте, а экран всегда соответствует данным.
 *
 * @param {HTMLElement} grid сетка карточек персонажей
 * @param {{ run?: (action: string, payload?: any) => void }} deps
 */
export function renderToday(grid, deps = {}) {
  if (!grid || !grid.parentElement) return;
  const existing = grid.parentElement.querySelector('[data-today]');
  const html = todayHtml(deps);
  if (!html) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.outerHTML = html;
  } else {
    grid.insertAdjacentHTML('beforebegin', html);
  }
  bindToday(grid.parentElement, deps);
}

/** Кнопки экрана: действия в строках, переходы и сворачивание. */
function bindToday(root, deps = {}) {
  const section = root.querySelector('[data-today]');
  if (!section || section.dataset.bound) return;
  section.dataset.bound = 'true';

  section.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-today-act], [data-today-toggle]'));
    if (!btn) return;

    // Сворачивание экрана: запоминаем, чтобы вид не сбрасывался при каждом запуске
    if (btn.hasAttribute('data-today-toggle')) {
      state.settings.ui = { ...(state.settings.ui || {}), todayCollapsed: !todayCollapsed() };
      await persist();
      const grid = root.querySelector('#character-grid');
      renderToday(grid, deps);
      return;
    }

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
