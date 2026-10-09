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
import { todayData, daysWord, todayStr } from './today.js';
import { plannerHtml, bindPlanner, openPlannerDay } from './plannerView.js';
import { plannerEventsForDate } from './planner.js';
import { eventEndTime } from './timeline.js';
import { dungeonInfoForDate, dungeonStrip, shiftDate } from '../dungeons/schedule.js';
import { runningWindows, refreshRunningWindows, onRunningWindows } from '../launcher/runningWindows.js';
import { rowLabel, formatUptime } from '../launcher/windowList.js';

/**
 * Подпись времени записи для списка панели: «19:30–20:00 · ивент», «марафон · весь день»,
 * «без времени». Диапазон считает `timeline.js` — та же функция, что строит блоки шкалы,
 * поэтому список и календарь не расходятся.
 */
export function eventTimeText(event) {
  if (!event?.time) return event?.source === 'marathon' ? 'марафон · весь день' : 'без времени';
  const end = eventEndTime(event);
  const span = end && end !== event.time ? `${event.time}–${end}` : event.time;
  return event.source === 'recurring' ? `${span} · ивент` : span;
}

/**
 * Блок «Запущенные окна игры» на вкладке «Сегодня»: какие окна открыты и чем с ними можно сделать.
 *
 * Список окон живёт в Rust, а разметка здесь собирается синхронно, поэтому сначала выводится
 * пустой контейнер, а строки добавляет `fillRunningWindowsBlock` после опроса (см. runningWindows.js).
 * Когда окон нет, блок показывает короткую подсказку.
 *
 * Общих кнопок «Все окна…» и «Закрыть все» здесь намеренно нет (жалоба пользователя):
 * это место для обзора, а не для управления. Полный список окон с выбором остаётся в FAB
 * на вкладке «Пати», в меню трея, в командной палитре и в настройках.
 * @returns {string}
 */
export function runningWindowsBlockHtml() {
  return `
    <h4 class="today-title"><span aria-hidden="true">🎮</span> Окна игры
      <span class="today-count" data-running-count hidden></span>
    </h4>
    <div class="rwn" data-running-windows>
      <p class="muted today-empty">Проверяем запущенные окна…</p>
    </div>`;
}

/**
 * Наполняет блок «Запущенные окна игры» последним известным списком окон и подписывается на изменения.
 *
 * Список окон общий для приложения (`runningWindows.js`): он же нужен кнопке закрытия окна
 * в карточке персонажа, поэтому здесь не делается отдельный запрос к Rust — блок сначала
 * показывает кэш, а строки обновляются, когда список перечитают.
 *
 * @param {HTMLElement} root контейнер страницы «Сегодня»
 */
export function fillRunningWindowsBlock(root) {
  const box = root.querySelector('[data-running-windows]');
  if (!box) return;

  const draw = (rows) => {
    const counter = root.querySelector('[data-running-count]');
    if (counter) {
      counter.hidden = !rows.length;
      counter.textContent = String(rows.length);
    }
    if (!rows.length) {
      box.innerHTML = '<p class="muted today-empty">Запущенных окон игры нет.</p>';
      return;
    }
    box.innerHTML = `<ul class="today-list rwn-list">${rows.map(row => `
      <li class="today-row rwn-row">
        <span class="rwn-dot ${row.known ? 'is-known' : ''}" aria-hidden="true"></span>
        <span class="today-row-text">
          <b title="${escapeHtml(rowLabel(row))}">${escapeHtml(rowLabel(row))}</b>
          <small class="muted">${row.uptimeMs == null ? 'время работы неизвестно' : `работает ${formatUptime(row.uptimeMs)}`}${row.elevated ? ' · админ' : ''}</small>
        </span>
        <button type="button" class="btn ghost small" data-today-act="windows-close-one" data-today-pid="${row.pid}"
                title="Закрыть это окно игры">🛑 Закрыть</button>
      </li>`).join('')}</ul>`;
  };

  draw(runningWindows());
  // Блок живёт, пока открыта страница: после ухода с вкладки подписку снимаем
  const off = onRunningWindows(draw);
  const page = box.closest('.page');
  page?.addEventListener('tf-leave', off, { once: true });
}
/**
 * Боковая панель «Сегодня» рядом с календарём: данж дня, полоса на неделю и все записи на сегодня.
 * @param {any} [appState]
 */
export function todaySideHtml(appState = state) {
  const today = todayStr();
  const dToday = dungeonInfoForDate(today);
  const strip = dungeonStrip(shiftDate(today, -1), shiftDate(today, 5));
  const events = plannerEventsForDate(appState, today);

  return `
    <aside class="today-side" data-today-side>
      <h4 class="today-title"><span aria-hidden="true">📍</span> Сегодня
        <small class="muted today-side-date">${new Date(`${today}T00:00:00`).toLocaleDateString('ru', { day: 'numeric', month: 'long', weekday: 'long' })}</small>
      </h4>

      <div class="today-dungeon is-${dToday.key}" title="Ежедневное задание меняется по циклу: Реликвия → Оружие → Доспех">
        <span class="today-dungeon-ico" aria-hidden="true">${dToday.icon}</span>
        <span class="today-dungeon-copy">
          <b>Данж дня: <span class="dng-name is-${dToday.key}">${escapeHtml(dToday.name)}</span></b>
          <small class="muted">Полоса ниже — ближайшая неделя, цвет дня — его данж</small>
        </span>
      </div>
      <div class="today-dungeon-strip" role="img" aria-label="Данжи на неделю: вчера и пять дней вперёд">
        ${strip.map(d => `
          <span class="today-strip-day is-${d.key}${d.date === today ? ' is-today' : ''}" title="${d.date}: ${d.name}">
            <small>${new Date(`${d.date}T00:00:00`).toLocaleDateString('ru', { weekday: 'narrow' })}</small>
            <b aria-hidden="true">${d.icon}</b>
            <span class="today-strip-name dng-name is-${d.key}">${escapeHtml(d.name)}</span>
          </span>`).join('')}
      </div>

      <h4 class="today-title"><span aria-hidden="true">🗓</span> Записи на день
        ${events.length ? `<span class="today-count">${events.length}</span>` : ''}
      </h4>
      ${events.length ? `<ul class="today-list today-side-list">
        ${events.slice(0, 8).map(e => `
          <li class="today-row">
            <span class="planner-color is-${escapeHtml(e.color || 'blue')}"></span>
            <span class="today-row-text">
              <b>${escapeHtml(e.title)}</b>
              <small class="muted">${escapeHtml(eventTimeText(e))}${e.done ? ' · готово' : ''}</small>
            </span>
            ${e.source === 'marathon' ? `
              <button type="button" class="btn secondary small" data-today-act="open-marathon" data-today-marathon="${escapeHtml(e.marathonId)}"
                title="Открыть марафон «${escapeHtml(e.title)}»">Открыть</button>` : ''}
          </li>`).join('')}
      </ul>
      ${events.length > 8 ? `<p class="muted today-more">Показаны первые 8 из ${events.length}.</p>` : ''}
      <button type="button" class="btn secondary small today-side-open" data-open-day="${today}">Открыть день в календаре</button>`
        : '<p class="muted today-empty">На этот день записей нет.</p>'}

      <div class="rwn-block">${runningWindowsBlockHtml()}</div>
    </aside>`;
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
  return `
    <section class="today" data-today>
      <div class="today-head">
        <div>
          <h3>Информация</h3>
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
          ${attention.length ? `<ul class="today-list today-attention-list">
            ${attention.map(item => `
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
          ${attention.length > 5 ? `<p class="muted today-more">Показано 5 из ${attention.length}: прокрутите список вниз.</p>` : ''}`
            : '<p class="muted today-empty">Всё в порядке: входы активны, балансы свежие, отстающих в марафонах нет.</p>'}
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
  root.innerHTML = `<div class="today-cols">${plannerHtml(state)}${todaySideHtml(state)}</div>${summary}`;
  bindToday(root, deps);
  bindPlanner(root, { ...deps, render });
  root.querySelector('[data-today-side]')?.addEventListener('click', (e) => {
    // Записи-марафоны открываются прямо из панели
    const act = e.target.closest?.('[data-today-act="open-marathon"]');
    if (act) { deps.run?.('open-marathon', act.dataset.todayMarathon); return; }
    const btn = e.target.closest?.('[data-open-day]');
    if (btn) { openPlannerDay(btn.dataset.openDay, { ...deps, render }); return; }
    const win = e.target.closest?.('[data-today-act^="windows-"]');
    if (win) { e.preventDefault(); runWindowsAction(win.dataset.todayAct, win.dataset.todayPid); }
  });
  fillRunningWindowsBlock(root);
}

/**
 * Действие блока «Запущенные окна игры»: закрыть одно окно.
 *
 * Списки окон и подписи уже импортированы (ими же рисуется блок), а команды закрытия
 * подгружаются по клику — они нужны только здесь.
 *
 * @param {string} action
 * @param {string} [pid]
 */
async function runWindowsAction(action, pid) {
  if (action !== 'windows-close-one') return;
  try {
    const id = Number(pid);
    if (!id) return;
    const row = runningWindows().find(r => r.pid === id);
    const { closeClientsByPid } = await import('../launcher/launch.js');
    const { showCloseReport } = await import('../launcher/partyLaunch.js');
    const { confirmModal } = await import('../../core/ui.js');

    const ok = await confirmModal({
      title: `Закрыть окно игры: ${row ? rowLabel(row) : `PID ${id}`}?`,
      text: 'Всё, что не сохранено в игре, будет потеряно.',
      okText: 'Закрыть окно',
      danger: true
    });
    if (!ok) return;
    showCloseReport(await closeClientsByPid([id]));
    await refreshRunningWindows();
  } catch (err) {
    const { toast } = await import('../../core/ui.js');
    toast(`Не удалось закрыть окно: ${String(err?.message || err)}`, 'error');
  }
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
