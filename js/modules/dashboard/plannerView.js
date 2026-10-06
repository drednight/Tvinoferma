import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { showModal, closeModal, confirmModal, toast } from '../../core/ui.js';
import { localDate, monthMatrix, normalizePlannerEntry, plannerEventsForDate } from './planner.js';
import { timelineBlocks, hourMarks, timeToMinutes, eventEndTime, DEFAULT_DURATION_MINUTES, DAY_MINUTES } from './timeline.js';
import { dungeonInfoForDate, DUNGEON_NAMES, DUNGEON_ICONS, DUNGEON_CYCLE } from '../dungeons/schedule.js';

let shownMonth = new Date();

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const KIND = { task: 'Задача', event: 'Событие', note: 'Заметка' };

/** Длительности для формы: шкала дня строит высоту блока по этому значению. */
const DURATION_CHOICES = [
  { minutes: 15, label: '15 минут' },
  { minutes: 30, label: '30 минут' },
  { minutes: DEFAULT_DURATION_MINUTES, label: '1 час' },
  { minutes: 90, label: '1,5 часа' },
  { minutes: 120, label: '2 часа' },
  { minutes: 180, label: '3 часа' },
  { minutes: Math.round(DAY_MINUTES / 2), label: '12 часов' }
];

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

/**
 * Мини-шкала дня в ячейке календаря: записи стоят по времени начала, высота блока — длительность.
 * Записи без времени (и марафон, который занимает весь день) идут сверху отдельной строкой.
 */
function dayCellHtml(date, events, dungeon, isToday) {
  const { allDay, blocks } = timelineBlocks(events);
  const day = Number(date.slice(-2));
  const all = [...allDay.map(x => x.event)];
  return `<button class="planner-day is-${dungeon.key}${isToday ? ' is-today' : ''}${events.length ? ' has-events' : ''}"
            type="button" data-planner-date="${date}"
            title="${dungeon.date}: данж дня — ${dungeon.name}${events.length ? ` · записей: ${events.length}` : ''}"
            aria-label="${date}, данж: ${dungeon.name}, записей: ${events.length}">
    <span class="planner-day-number">${day}</span>
    <span class="planner-day-allday">
      ${all.slice(0, 2).map(e => `<span class="planner-chip is-${escapeHtml(e.color || 'blue')}${e.source === 'marathon' ? ' is-marathon' : ''}${e.done ? ' is-done' : ''}"
        title="${escapeHtml(e.title)}${e.source === 'recurring' ? ' (постоянный ивент)' : ''}">${escapeHtml(e.title)}</span>`).join('')}
      ${all.length > 2 ? `<span class="planner-more" title="${all.slice(2).map(x => escapeHtml(x.title)).join(' • ')}">+${all.length - 2}</span>` : ''}
    </span>
    <span class="planner-day-scale" aria-hidden="true">
      ${blocks.map(b => `<span class="planner-block is-${escapeHtml(b.event.color || 'blue')}${b.event.source === 'marathon' ? ' is-marathon' : ''}${b.event.source === 'recurring' ? ' is-recurring' : ''}${b.event.done ? ' is-done' : ''}"
        style="top:${b.topPct.toFixed(3)}%;height:${b.heightPct.toFixed(3)}%;left:${b.leftPct.toFixed(2)}%;width:${b.widthPct.toFixed(2)}%"
        title="${b.startTime}–${b.endTime} · ${escapeHtml(b.event.title)}"></span>`).join('')}
    </span>
  </button>`;
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
          <p class="muted">События приложения и ваши планы. Цвет ячейки — данж дня по ежедневному заданию,
            записи стоят по времени начала (МСК), марафон занимает весь день.</p>
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
          return dayCellHtml(date, plannerEventsForDate(appState, date), dungeonInfoForDate(date), date === today);
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
  const source = event.source === 'marathon' ? 'Марафон'
    : event.source === 'recurring' ? 'Постоянный ивент'
    : KIND[event.kind] || 'Запись';
  // Диапазон времени: у постоянных ивентов окончание задано расписанием, у своих записей
  // считается из длительности — так в списке видно, сколько запись идёт
  const end = eventEndTime(event);
  const span = event.source === 'marathon' ? 'весь день'
    : event.time ? `${event.time}${end && end !== event.time ? `–${end}` : ''}` : '';
  const meta = [source, span, event.priority === 'high' ? 'Высокий приоритет' : '',
    event.recurrence && event.recurrence !== 'none' ? 'Повторяется' : ''].filter(Boolean).join(' · ');
  // Постоянный ивент приходит из расписания: его нельзя отметить «готово» или удалить
  const actions = event.source === 'manual' ? `
      <button class="btn ghost small" type="button" data-planner-done="${escapeHtml(event.id)}">${event.done ? 'Вернуть' : 'Готово'}</button>
      <button class="btn danger small" type="button" data-planner-delete="${escapeHtml(event.id)}" aria-label="Удалить">×</button>`
    : event.source === 'marathon'
      ? `<button class="btn secondary small" type="button" data-planner-marathon="${escapeHtml(event.marathonId)}">Открыть</button>`
      : `<span class="planner-lock" title="Постоянный ивент: идёт каждую неделю по расписанию">расписание</span>`;
  return `<li class="planner-day-row${event.done ? ' is-done' : ''} is-source-${escapeHtml(event.source || 'manual')}">
    <span class="planner-color is-${escapeHtml(event.color || 'blue')}"></span>
    <span class="planner-day-copy"><b>${escapeHtml(event.title)}</b><small class="muted">${escapeHtml(meta)}</small></span>
    ${actions}
  </li>`;
}

/**
 * Полная шкала дня 00:00–24:00 для окна дня: блоки стоят по времени начала, высота — по длительности.
 * Марафон растянут на всю шкалу; записи без времени вынесены над ней.
 */
function dayScaleHtml(events) {
  const { allDay, blocks } = timelineBlocks(events);
  const marks = hourMarks(3);
  const allDayEvents = allDay.map(x => x.event);
  return `<div class="planner-scale-wrap">
    ${allDayEvents.length ? `<div class="planner-scale-allday">
      <span class="planner-scale-allday-label">Весь день / без времени</span>
      ${allDayEvents.map(e => `<span class="planner-chip is-${escapeHtml(e.color || 'blue')}${e.source === 'marathon' ? ' is-marathon' : ''}${e.done ? ' is-done' : ''}"
        title="${e.time ? `с ${e.time}` : 'без времени'} · ${escapeHtml(e.title)}">${e.source === 'marathon' ? '🏁 ' : ''}${escapeHtml(e.title)}</span>`).join('')}
    </div>` : ''}
    <div class="planner-scale">
      <div class="planner-scale-marks" aria-hidden="true">
        ${marks.map(m => `<span class="planner-scale-mark"><i></i>${m}</span>`).join('')}
      </div>
      <div class="planner-scale-track">
        ${blocks.map(b => `<div class="planner-scale-block is-${escapeHtml(b.event.color || 'blue')}${b.event.source === 'recurring' ? ' is-recurring' : ''}${b.event.done ? ' is-done' : ''}"
          style="top:${b.topPct.toFixed(3)}%;height:${b.heightPct.toFixed(3)}%;left:${b.leftPct.toFixed(2)}%;width:${b.widthPct.toFixed(2)}%"
          title="${b.startTime}–${b.endTime} · ${escapeHtml(b.event.title)}">
          <b>${escapeHtml(b.event.title)}</b><small>${b.startTime}–${b.endTime}</small>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

export function openPlannerDay(date, deps = {}) {
  const events = plannerEventsForDate(state, date);
  showModal({
    title: new Date(`${date}T00:00:00`).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' }),
    content: `<div class="planner-day-modal">
      ${events.length ? dayScaleHtml(events) : '<p class="muted planner-day-empty">На этот день записей нет.</p>'}
      ${events.length ? `<ul class="planner-day-list">${events.map(eventRow).join('')}</ul>` : ''}
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
        <label class="field">Время начала (МСК)<input class="input" type="time" name="time"></label>
      </div>
      <div class="two-cols">
        <label class="field">Длительность<select class="select" name="durationMinutes">
          ${DURATION_CHOICES.map(c => `<option value="${c.minutes}"${c.minutes === DEFAULT_DURATION_MINUTES ? ' selected' : ''}>${c.label}</option>`).join('')}
        </select></label>
        <label class="field">Тип<select class="select" name="kind"><option value="task">Задача</option><option value="event">Событие</option><option value="note">Заметка</option></select></label>
      </div>
      <div class="two-cols">
        <label class="field">Приоритет<select class="select" name="priority"><option value="normal">Обычный</option><option value="high">Высокий</option><option value="low">Низкий</option></select></label>
        <label class="field">Напомнить<select class="select" name="reminderMinutes"><option value="0">Не напоминать</option><option value="15">За 15 минут</option><option value="60">За час</option><option value="1440">За день</option></select></label>
      </div>
      <div class="two-cols">
        <label class="field">Повтор<select class="select" name="recurrence"><option value="none">Не повторять</option><option value="daily">Ежедневно</option><option value="weekly">Еженедельно</option><option value="monthly">Ежемесячно</option></select></label>
        <label class="field">Повторять до<input class="input" type="date" name="recurrenceEnd"></label>
      </div>
      <div class="two-cols">
        <label class="field">Цвет<select class="select" name="color"><option value="blue">Синий</option><option value="green">Зелёный</option><option value="yellow">Жёлтый</option><option value="red">Красный</option><option value="purple">Фиолетовый</option><option value="gray">Серый</option></select></label>
      </div>
    </form>`,
    submitText: 'Добавить',
    cancelText: 'Отмена',
    async onSubmit(formData, { setError }) {
      const title = String(formData.get('title') || '').trim();
      if (!title) { setError('Введите название записи.'); return false; }
      const time = String(formData.get('time') || '');
      if (time && timeToMinutes(time) === null) { setError('Время должно быть в формате ЧЧ:ММ.'); return false; }
      state.plannerEntries.push(normalizePlannerEntry({
        title,
        date: formData.get('date'),
        time,
        durationMinutes: formData.get('durationMinutes'),
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
