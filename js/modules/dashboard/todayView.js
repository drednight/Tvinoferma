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
import { plannerHtml, bindPlanner, openPlannerDay, openPlannerEntryForm } from './plannerView.js';
import { plannerEventsForDate } from './planner.js';
import { eventEndTime } from './timeline.js';
import { dungeonInfoForDate, dungeonStrip, shiftDate } from '../dungeons/schedule.js';
import { persist } from '../../core/storage.js';

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
 * Боковая панель «Сегодня» рядом с календарём: данж дня, полоса на неделю и туду лист.
 *
 * Раньше здесь был ещё и блок «Окна игры», но управление окнами ушло в «Инструменты»,
 * а на «Сегодня» остался обзор без пользы.
 *
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

      ${todoListHtml(events, today)}

    </aside>`;
}

/** Подпись статуса в туду листе: что видно на кнопке справа. */
const STATUS_TEXT = { todo: 'Ожидает', doing: 'В работе', done: 'Выполнено' };
/** Следующий статус по клику: ждёт → в работе → выполнено → обратно в ожидает. */
const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };

/**
 * Туду лист: записи дня как список дел.
 *
 * Это не отдельное хранилище, а те же записи календаря — просто показанные как дела:
 * чекбокс слева (снимает и ставит «выполнено»), название, справа статус. «В работе»
 * отдельным кликом: из галочки его вывести нельзя, это промежуточное состояние.
 *
 * Свои записи — с чекбоксом и статусом. Марафоны и постоянные ивенты в списке остаются
 * читаемыми строками: их нельзя отметить или удалить, они приходят из расписания.
 *
 * @param {Array<any>} events записи дня, как их отдаёт `plannerEventsForDate`
 * @param {string} today дата дня списка, МСК
 * @returns {string}
 */
export function todoListHtml(events, today) {
  const left = events.filter(e => e.source === 'manual' && e.status !== 'done').length;
  return `
    <h4 class="today-title"><span aria-hidden="true">☑</span> Туду лист
      ${left ? `<span class="today-count">${left}</span>` : ''}
    </h4>
    ${events.length ? `<ul class="today-list todo-list">
      ${events.map(e => {
        const own = e.source === 'manual';
        const status = e.status || 'todo';
        return `<li class="todo-row${own ? '' : ' is-readonly'} is-${escapeHtml(status)}" data-todo-id="${escapeHtml(e.id)}">
          ${own
            ? `<label class="todo-check" title="${status === 'done' ? 'Снять отметку' : 'Отметить выполненным'}">
                 <input type="checkbox" data-todo-toggle="${escapeHtml(e.id)}" ${status === 'done' ? 'checked' : ''} />
               </label>`
            : `<span class="todo-check is-empty" aria-hidden="true"></span>`}
          <span class="todo-text">
            <b>${escapeHtml(e.title)}</b>
            <small class="muted">${escapeHtml(eventTimeText(e))}</small>
          </span>
          ${own
            ? `<button type="button" class="todo-status is-${escapeHtml(status)}" data-todo-status="${escapeHtml(e.id)}"
                 title="Следующий статус: ${escapeHtml(STATUS_TEXT[STATUS_NEXT[status]])}">${escapeHtml(STATUS_TEXT[status])}</button>`
            : e.source === 'marathon'
              ? `<button type="button" class="btn secondary small" data-today-act="open-marathon"
                   data-today-marathon="${escapeHtml(e.marathonId)}" title="Открыть марафон «${escapeHtml(e.title)}»">Открыть</button>`
              : ''}
        </li>`;
      }).join('')}
    </ul>`
    : '<p class="muted today-empty">На этот день дел нет.</p>'}
    <div class="todo-actions">
      <button type="button" class="btn secondary small" data-todo-add="${escapeHtml(today)}">＋ Добавить</button>
      <button type="button" class="btn ghost small" data-open-day="${escapeHtml(today)}">Открыть день в календаре</button>
    </div>`;
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
    const add = e.target.closest?.('[data-todo-add]');
    if (add) { addTodoFor(add.dataset.todoAdd, { ...deps, render }); return; }
    const status = e.target.closest?.('[data-todo-status]');
    if (status) { setTodoStatus(status.dataset.todoStatus, render); return; }
  });
  // Галочка живёт в label, а не в кнопке: кликается целиком и не мешает выделению текста
  root.querySelector('[data-today-side]')?.addEventListener('change', (e) => {
    const box = e.target.closest?.('[data-todo-toggle]');
    if (box) setTodoStatus(box.dataset.todoToggle, render, box.checked ? 'done' : 'todo');
  });
}

/**
 * Отметка в туду листе: галочка ставит и снимает «выполнено», кнопка справа перебирает
 * статус по кругу. Только свои записи — марафоны и ивенты из расписания не трогаем.
 *
 * @param {string} id
 * @param {() => void} render
 * @param {string} [status] конкретный статус; без него берётся следующий по кругу
 */
async function setTodoStatus(id, render, status) {
  const entry = state.plannerEntries.find(item => item.id === id);
  if (!entry) return;
  const next = status || STATUS_NEXT[entry.status || 'todo'] || 'todo';
  if (entry.status === next) return;
  entry.status = next;
  entry.updatedAt = new Date().toISOString();
  await persist();
  render();
}

/**
 * Новое дело на день.
 *
 * Форма та же, что у записей календаря, и время в ней по умолчанию пустое — дело из
 * туду листа не привязано к часу: с временем оно рисовалось бы блоком на шкале, а
 * пользователю тут нужен просто список дел.
 *
 * @param {string} date
 * @param {{ render?: () => void }} deps
 */
function addTodoFor(date, deps = {}) {
  openPlannerEntryForm(date, deps);
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
