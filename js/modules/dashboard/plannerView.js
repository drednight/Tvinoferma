import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { showModal, closeModal, confirmModal, toast } from '../../core/ui.js';
import { localDate, monthMatrix, normalizePlannerEntry, plannerEventsForDate } from './planner.js';
import { dungeonInfoForDate, DUNGEON_NAMES, DUNGEON_ICONS, DUNGEON_CYCLE } from '../dungeons/schedule.js';

let shownMonth = new Date();

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const KIND = { task: 'Задача', event: 'Событие', note: 'Заметка' };

/**
 * Легенда над сеткой: цвет ячейки — категория данжа дня; заодно раскрывает цвета полосок,
 * чтобы их смысл читался без наведения.
 */
export function plannerLegendHtml() {
  return `<div class="planner-legend">
    <span class="planner-legend-label">Данж дня:</span>
    ${DUNGEON_CYCLE.map(key => `<span class="planner-legend-item is-${key}" title="Ежедневное задание этого дня"><b aria-hidden="true">${DUNGEON_ICONS[key]}</b> <span class="dng-name is-${key}">${DUNGEON_NAMES[key]}</span></span>`).join('')}
  </div>`;
}

export function plannerHtml(appState = state) {
  const year = shownMonth.getFullYear();
  const month = shownMonth.getMonth();
  const today = localDate();
  const cells = monthMatrix(year, month);
  return `
    <section class="planner" data-planner>
      <div class="planner-head">
        <div>
          <h3>Календарь</h3>
          <p class="muted">События приложения и ваши планы. Цвет ячейки — данж дня по ежедневному заданию.</p>
        </div>
        <div class="planner-nav">
          <button class="btn ghost small" type="button" data-planner-nav="-1" aria-label="Предыдущий месяц">←</button>
          <strong>${MONTHS[month]} ${year}</strong>
          <button class="btn ghost small" type="button" data-planner-nav="1" aria-label="Следующий месяц">→</button>
          <button class="btn secondary small" type="button" data-planner-today>Сегодня</button>
        </div>
      </div>
      ${plannerLegendHtml()}
      <div class="planner-weekdays">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="planner-grid">
        ${cells.map(date => {
          if (!date) return '<span class="planner-day is-empty" aria-hidden="true"></span>';
          const events = plannerEventsForDate(appState, date);
          const day = Number(date.slice(-2));
          const dungeon = dungeonInfoForDate(date);
          return `<button class="planner-day is-${dungeon.color}${date === today ? ' is-today' : ''}${events.length ? ' has-events' : ''}"
                    type="button" data-planner-date="${date}"
                    title="${dungeon.date}: данж дня — ${dungeon.name}"
                    aria-label="${date}, данж: ${dungeon.name}, записей: ${events.length}">
            <span class="planner-day-number">${day}</span>
            <span class="planner-day-events">
              ${events.slice(0, 3).map(e => `<span class="planner-event is-${escapeHtml(e.color || 'blue')}${e.done ? ' is-done' : ''}"
                title="${e.title}">${escapeHtml(e.title)}</span>`).join('')}
              ${events.length > 3 ? `<span class="planner-more" title="${events.slice(3).map(x => x.title).join(' • ')}">ещё ${events.length - 3}</span>` : ''}
            </span>
          </button>`;
        }).join('')}
      </div>
    </section>`;
}

export function bindPlanner(root, deps = {}) {
  const planner = root?.querySelector?.('[data-planner]');
  if (!planner || planner.dataset.bound) return;
  planner.dataset.bound = 'true';
  planner.addEventListener('click', (event) => {
    const target = event.target.closest('[data-planner-nav], [data-planner-today], [data-planner-date]');
    if (!target) return;
    if (target.dataset.plannerNav) {
      shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + Number(target.dataset.plannerNav), 1);
      deps.render?.();
      return;
    }
    if (target.hasAttribute('data-planner-today')) {
      shownMonth = new Date();
      deps.render?.();
      return;
    }
    openPlannerDay(target.dataset.plannerDate, deps);
  });
}

function eventRow(event) {
  const source = event.source === 'marathon' ? 'Марафон' : KIND[event.kind] || 'Запись';
  const meta = [source, event.time, event.priority === 'high' ? 'Высокий приоритет' : '',
    event.recurrence && event.recurrence !== 'none' ? 'Повторяется' : ''].filter(Boolean).join(' · ');
  return `<li class="planner-day-row${event.done ? ' is-done' : ''}">
    <span class="planner-color is-${escapeHtml(event.color || 'blue')}"></span>
    <span class="planner-day-copy"><b>${escapeHtml(event.title)}</b><small class="muted">${escapeHtml(meta)}</small></span>
    ${event.source === 'manual' ? `
      <button class="btn ghost small" type="button" data-planner-done="${escapeHtml(event.id)}">${event.done ? 'Вернуть' : 'Готово'}</button>
      <button class="btn danger small" type="button" data-planner-delete="${escapeHtml(event.id)}" aria-label="Удалить">×</button>` :
      `<button class="btn secondary small" type="button" data-planner-marathon="${escapeHtml(event.marathonId)}">Открыть</button>`}
  </li>`;
}

export function openPlannerDay(date, deps = {}) {
  const events = plannerEventsForDate(state, date);
  showModal({
    title: new Date(`${date}T00:00:00`).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' }),
    content: `<div class="planner-day-modal">
      ${events.length ? `<ul class="planner-day-list">${events.map(eventRow).join('')}</ul>` : '<p class="muted planner-day-empty">На этот день записей нет.</p>'}
      <button class="btn primary" type="button" data-planner-add>+ Добавить запись</button>
    </div>`,
    submitText: null,
    cancelText: 'Закрыть'
  });
  const modal = document.getElementById('modal-root');
  modal.querySelector('[data-planner-add]')?.addEventListener('click', () => openPlannerEntryForm(date, deps));
  modal.querySelectorAll('[data-planner-done]').forEach(button => button.addEventListener('click', async () => {
    const entry = state.plannerEntries.find(item => item.id === button.dataset.plannerDone);
    if (!entry) return;
    entry.done = !entry.done;
    entry.updatedAt = new Date().toISOString();
    await persist();
    openPlannerDay(date, deps);
    deps.render?.();
  }));
  modal.querySelectorAll('[data-planner-delete]').forEach(button => button.addEventListener('click', async () => {
    const entry = state.plannerEntries.find(item => item.id === button.dataset.plannerDelete);
    if (!entry) return;
    const ok = await confirmModal({ title: 'Удалить запись?', text: entry.title, okText: 'Удалить', danger: true });
    if (!ok) return;
    state.plannerEntries = state.plannerEntries.filter(item => item.id !== entry.id);
    await persist();
    openPlannerDay(date, deps);
    deps.render?.();
  }));
  modal.querySelectorAll('[data-planner-marathon]').forEach(button => button.addEventListener('click', () => {
    closeModal();
    deps.run?.('open-marathon', button.dataset.plannerMarathon);
  }));
}

function openPlannerEntryForm(date, deps = {}) {
  showModal({
    title: 'Новая запись',
    content: `<form class="planner-form">
      <label class="field">Название *<input class="input" name="title" maxlength="160" autofocus></label>
      <div class="two-cols">
        <label class="field">Дата<input class="input" type="date" name="date" value="${date}"></label>
        <label class="field">Время<input class="input" type="time" name="time"></label>
      </div>
      <div class="two-cols">
        <label class="field">Тип<select class="select" name="kind"><option value="task">Задача</option><option value="event">Событие</option><option value="note">Заметка</option></select></label>
        <label class="field">Приоритет<select class="select" name="priority"><option value="normal">Обычный</option><option value="high">Высокий</option><option value="low">Низкий</option></select></label>
      </div>
      <div class="two-cols">
        <label class="field">Напомнить<select class="select" name="reminderMinutes"><option value="0">Не напоминать</option><option value="15">За 15 минут</option><option value="60">За час</option><option value="1440">За день</option></select></label>
        <label class="field">Повтор<select class="select" name="recurrence"><option value="none">Не повторять</option><option value="daily">Ежедневно</option><option value="weekly">Еженедельно</option><option value="monthly">Ежемесячно</option></select></label>
      </div>
      <div class="two-cols">
        <label class="field">Повторять до<input class="input" type="date" name="recurrenceEnd"></label>
        <label class="field">Цвет<select class="select" name="color"><option value="blue">Синий</option><option value="green">Зелёный</option><option value="yellow">Жёлтый</option><option value="red">Красный</option><option value="purple">Фиолетовый</option><option value="gray">Серый</option></select></label>
      </div>
    </form>`,
    submitText: 'Добавить',
    cancelText: 'Отмена',
    async onSubmit(formData, { setError }) {
      const title = String(formData.get('title') || '').trim();
      if (!title) { setError('Введите название записи.'); return false; }
      state.plannerEntries.push(normalizePlannerEntry({
        title,
        date: formData.get('date'),
        time: formData.get('time'),
        kind: formData.get('kind'),
        priority: formData.get('priority'),
        reminderMinutes: formData.get('reminderMinutes'),
        recurrence: formData.get('recurrence'),
        recurrenceEnd: formData.get('recurrenceEnd'),
        color: formData.get('color')
      }));
      await persist();
      deps.render?.();
      toast('Запись добавлена', 'success');
      return true;
    }
  });
}
