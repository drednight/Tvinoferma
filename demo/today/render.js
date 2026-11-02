// Three compositions, one set of fictional data and interactions. No native calls.
import { escapeHtml as esc } from '../../js/core/utils.js';
import { mskAddDays } from '../../js/core/msk.js';
import { dungeonInfoForDate } from '../../js/modules/dungeons/schedule.js';
import { guildPollHtml } from '../../js/modules/guild/poll.js';
import { TASKS, demoDays, partyInfo, summary, marathonRisk, selectedTasks, activePromos } from './data.js';

export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const num = value => new Intl.NumberFormat('ru-RU').format(value);
const shortDate = date =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`)
  );
const weekday = date =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const heading = (title, detail = '', action = '') =>
  `<div class="t-section-head"><div><h3>${title}</h3>${detail ? `<p>${detail}</p>` : ''}</div>${action}</div>`;
const dungeonImage = day => `<img src="../../assets/icons/dungeons/pass-${esc(day.key)}.webp" alt="" />`;
const avatar = c =>
  `<span class="t-avatar" title="${esc(c.className)}"><img src="../../assets/icons/classes/${esc(c.icon || 'var')}.webp" alt="${esc(c.className)}" /></span>`;
const shownTasks = state => TASKS.filter(t => state.marathonActive || t.id !== 'marathon');

function finance(state) {
  return `<section class="t-finance" aria-label="Информационная панель валют"><div><span>${icon('wallet')} Золото</span><strong>${num(state.gold)}</strong><small>Игровая валюта</small></div><div><span>${icon('diamond')} Голд</span><strong>${num(state.bank)}</strong><small>Баланс примера</small></div><div><span>${icon('coin')} Древние монеты</span><strong>${num(summary(state).coins)}</strong><small>По персонажам демо</small></div></section>`;
}
function attention(state) {
  const data = summary(state);
  const risky = state.marathonActive
    ? state.marathonProgress.filter(
        row => marathonRisk(row).tone !== 'green' && state.characters.some(c => c.id === row.charId)
      )
    : [];
  if (!state.attentionEnabled || !(data.offline || data.checking || risky.length)) return '';
  return `<section class="t-card t-attention" data-attention-panel>${heading('Требует внимания', 'Только то, что мешает плану', icon('alert'))}<div class="t-attention-items">${data.offline ? `<button data-open-section="characters"><span class="t-dot red"></span>Нет входа: ${data.offline} персонажа ${icon('arrow-right')}</button>` : ''}${data.checking ? `<p><span class="t-dot amber"></span>Вход проверяется: ${data.checking}</p>` : ''}${risky.length ? `<p><span class="t-dot amber"></span>Марафон: ${risky.length} с малым запасом или отставанием</p>` : ''}</div></section>`;
}
function promos(state) {
  const rows = activePromos(state);
  if (!rows.length) return '';
  return `<section class="t-card t-promos" data-promo-panel>${heading('Не забудьте промокод', 'Активен, но введён не у всех', icon('sparkle'))}${rows.map(p => `<div><b class="t-promo-code">${esc(p.code)}</b><p>До ${esc(shortDate(p.expiresOn))} включительно · осталось ${state.characters.filter(c => !p.entered.includes(c.id)).length} персонажей</p><button class="t-btn t-btn-primary" data-demo-promo="${esc(p.code)}">Имитировать активацию ${icon('arrow-right')}</button></div>`).join('')}</section>`;
}
function calendar(state) {
  const base = new Date(`${state.date}T00:00:00Z`);
  const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + state.calendarMonth, 1));
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const start = (first.getUTCDay() + 6) % 7;
  const selected = mskAddDays(state.date, state.chosenDay);
  const title = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  return `<details class="t-month-calendar"><summary>${icon('calendar')} Календарь месяца</summary><div class="t-month-head"><button class="t-icon-btn" data-calendar-month="-1" aria-label="Предыдущий месяц">←</button><b>${esc(title)}</b><button class="t-icon-btn" data-calendar-month="1" aria-label="Следующий месяц">→</button></div><div class="t-month-grid">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<small>${d}</small>`).join('')}${'<span></span>'.repeat(start)}${Array.from(
    { length: count },
    (_, i) => {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), i + 1)).toISOString().slice(0, 10);
      return `<button data-calendar-date="${date}" class="${date === selected ? 'is-selected' : ''}" aria-pressed="${date === selected}" ${date === state.date ? 'aria-current="date"' : ''}>${i + 1}${state.dayTasks[date] || date === state.date ? '<span class="t-dot green"></span>' : ''}</button>`;
    }
  ).join('')}</div><small>Точки — дни с отметками. Выбор даты открывает её данж и задачи.</small></details>`;
}
function daily(state) {
  const selected = dungeonInfoForDate(mskAddDays(state.date, state.chosenDay));
  const marks = selectedTasks(state);
  const tasks = shownTasks(state);
  const completed = tasks.filter(t => marks[t.id]).length;
  return `<section class="t-card t-daily-panel">${heading('Данж и задачи на день', shortDate(selected.date), `<button class="t-link" data-day="0">Сегодня</button>`)}
    <div class="t-days" aria-label="Вчера, сегодня и пять следующих дней">${demoDays(state.date)
      .map(
        day =>
          `<button class="t-day ${day.offset === state.chosenDay ? 'is-selected' : ''}" data-day="${day.offset}" aria-pressed="${day.offset === state.chosenDay}"><span>${day.offset === -1 ? 'вчера' : day.offset === 0 ? 'сегодня' : weekday(day.date)}</span>${dungeonImage(day)}<small>${esc(day.name)}</small></button>`
      )
      .join('')}</div>
    <div class="t-dungeon-body"><div class="t-dungeon-icon is-${selected.key}">${dungeonImage(selected)}</div><div><small>${state.chosenDay ? 'ВЫБРАННЫЙ ДЕНЬ' : 'ДАНЖ ДНЯ'}</small><strong>${esc(selected.name)}</strong><span>${esc(shortDate(selected.date))}</span></div><span class="t-badge">${completed} из ${tasks.length}</span></div>
    <div class="t-task-list">${tasks.map(t => `<label class="t-task ${marks[t.id] ? 'is-done' : ''}"><input type="checkbox" data-task="${t.id}" ${marks[t.id] ? 'checked' : ''}><span class="t-task-check">${icon('check')}</span><span><strong>${esc(t.title)}</strong><small>${t.id === 'daily' ? esc(selected.name) : esc(t.detail)}</small></span></label>`).join('')}</div>${calendar(state)}</section>`;
}
function events(state) {
  return `<section class="t-card t-events">${heading('События', 'Расписание на сегодня', `<button class="t-link" data-open-section="calendar">Календарь →</button>`)}${state.events.map(e => `<div class="t-event-row"><div class="t-event-time">${esc(e.time)}</div><span class="t-event-dot is-${e.color === 'violet' ? 'violet' : 'blue'}"></span><div class="t-event-copy"><strong>${esc(e.title)}</strong><small>${esc(e.detail)}</small></div></div>`).join('') || '<p>Событий в примере пока нет</p>'}</section>`;
}
function party(state) {
  const group = partyInfo(state.favoriteParty, state);
  return `<section class="t-card t-party">${heading('Быстрый запуск пати', 'Игровые окна ≠ вход на сайт', icon('users'))}<label class="t-party-select"><span>Пати</span><select data-party-select aria-label="Выбрать пати">${state.parties.map(p => `<option value="${esc(p.id)}" ${p.id === state.favoriteParty ? 'selected' : ''}>${esc(p.label)}</option>`).join('') || '<option value="">Пока нет пати</option>'}</select></label><div class="t-party-members"><small>${group.members.length} участника</small></div><div class="t-avatars">${group.members.map(c => avatar(c)).join('')}</div><button class="t-btn t-btn-primary t-launch" data-open-section="launch" ${group.id ? '' : 'disabled'}>${icon('play')} Имитировать запуск</button><small class="t-party-note">${state.lastLaunch === group.id ? 'Имитация запуска выполнена' : 'Окна игры не запускаются'}</small>
    <div class="t-window-head"><b>Запущенные окна · ${state.windows.length}</b><button class="t-link" data-open-section="parties">Все пати →</button></div><div class="t-window-list">${
      state.windows
        .map(w => {
          const c = state.characters.find(c => c.id === w.charId);
          return `<div class="t-window-row" data-demo-window="${esc(w.id)}"><span>${c ? avatar(c) : icon('user')}</span><div><strong>${esc(w.title)}</strong><small>${state.activeWindow === w.id ? 'На переднем плане · пример' : 'Работает · пример'}</small></div><div class="t-window-actions"><button class="t-icon-btn" data-window-focus="${esc(w.id)}" title="Вывести окно на передний план" aria-label="Показать ${esc(w.title)}">↗</button><button class="t-icon-btn" data-window-rename="${esc(w.id)}" title="Переименовать" aria-label="Переименовать ${esc(w.title)}">✎</button><button class="t-icon-btn" data-window-close="${esc(w.id)}" title="Закрыть это окно" aria-label="Закрыть ${esc(w.title)}">×</button></div></div>`;
        })
        .join('') || '<p class="t-empty-note">Нет запущенных окон</p>'
    }</div></section>`;
}
function marathon(state) {
  if (!state.marathonActive) return '';
  const rows = state.marathonProgress.filter(row => state.characters.some(c => c.id === row.charId));
  return `<section class="t-card t-marathon-panel" data-marathon-panel>${heading('Марафон · ' + esc(state.marathon?.title || 'Путь героя'), 'Участники и задания, а не только проценты', `<span class="t-badge t-badge-violet">${rows.length} перс.</span>`)}<div class="t-marathon-task"><span class="t-small-icon t-tone-violet">${icon('flag')}</span><div><strong>Задания марафона</strong><ul>${state.marathonTasks.map(task => `<li><b>${esc(task.title)}</b>${task.description ? ` — ${esc(task.description)}` : ''}</li>`).join('')}</ul><p>Подневный контроль ниже — пример ежедневной отметки: открыть страницу события → получить награду → проверить отметку.</p></div></div><div class="t-marathon-rows">${rows
    .map(row => {
      const c = state.characters.find(c => c.id === row.charId);
      const risk = marathonRisk(row);
      return `<div class="t-marathon-person is-${risk.tone}" data-marathon-participant="${esc(c.id)}">${avatar(c)}<div><strong>${esc(c.nick)}</strong><small>${row.completed} / ${row.required} отметок · осталось ${row.daysLeft} дн.</small></div><span class="t-risk ${risk.tone}">${esc(risk.label)}</span><small>${row.checkedToday ? 'Сегодня: ' + (row.siteTodayDone ? 'подтверждено' : 'не отмечено') : 'Сегодня не проверено'}</small></div>`;
    })
    .join(
      ''
    )}</div><div class="t-marathon-refresh"><button class="t-btn t-btn-primary" data-marathon-refresh ${state.marathonChecking ? 'disabled' : ''}>${icon('refresh')} ${state.marathonChecking ? 'Проверяю отметки…' : 'Обновить всех участников'}</button><small role="status">${state.marathonChecking ? 'Имитация скрипта: только участники этого марафона' : state.marathonCheckedAt ? `Проверено ${rows.length} перс. · ${esc(state.marathonCheckedAt)} мск` : 'Демо: на сайт запросы не отправляются'}</small></div><details class="t-risk-help"><summary>Как определён риск?</summary>Запас = оставшиеся дни − недостающие отметки. Отрицательный запас — отставание, ноль — нельзя пропустить ни дня, один день — малый запас. Формула для этого примера: одна отметка в сутки. Для других марафонов нужны их реальные правила.</details></section>`;
}
function clan(state) {
  if (!state.clanEnabled) return '';
  const response = (id, title, time) =>
    `<div class="t-clan-event"><div class="t-clan-event-copy"><small>${time}</small><strong>${title}</strong><span>Отпись на событие</span></div><div class="t-clan-response"><button data-clan-event="${id}" data-response="yes" aria-pressed="${state.clanResponses[id] === 'yes'}">Пойду</button><button data-clan-event="${id}" data-response="no" aria-pressed="${state.clanResponses[id] === 'no'}">Не пойду</button></div></div>`;
  return `<section class="t-card t-clan" data-clan-panel>${heading('Клан Eternals', 'Модуль активирован промокодом · пример', icon('shield'))}<div class="t-clan-grid"><div>${response('clan-1', 'Сбор клана', 'СЕГОДНЯ · 20:30')}${response('clan-2', 'Выход в цитадель', 'ЗАВТРА · 19:00')}</div><div class="t-clan-party">${heading('Мои пати')}<strong>Пати «Север»</strong><p>${state.characters
    .filter(c => c.party === 'p1')
    .map(c => esc(c.nick))
    .join(
      ', '
    )}</p><button class="t-link" data-open-section="clan-copy">Скопировать ники</button></div></div>${state.pollEnabled ? guildPollHtml(state.poll) : ''}</section>`;
}
function pageHeading(state, title, subtitle) {
  const marks = selectedTasks(state);
  const tasks = shownTasks(state);
  return `<div class="t-page-title"><div><p class="t-kicker">${esc(shortDate(state.date))} · ПО МОСКВЕ</p><h2>${title}</h2><p>${subtitle}</p><small>${state.characters.length} персонажей · ${state.parties.length} пати</small></div><button class="t-link" data-open-section="refresh">Обновить сводку</button><span class="t-badge t-badge-violet">${tasks.filter(t => marks[t.id]).length} из ${tasks.length} дел готово</span></div>`;
}
export function renderOverview(state) {
  return `<div class="t-variant t-overview" data-view="overview">${pageHeading(state, 'Сегодня', 'Сводка дня. Важное — первым, остальное — по контексту.')}${finance(state)}<div class="t-concept-overview"><div class="t-stack t-primary-column">${daily(state)}${marathon(state)}${clan(state)}</div><div class="t-stack t-secondary-column">${attention(state)}${promos(state)}${party(state)}${events(state)}</div></div></div>`;
}
export function renderDay(state) {
  return `<div class="t-variant t-day-view" data-view="day">${pageHeading(state, 'План на сегодня', 'День в центре: дата → данж → отметки → совместные дела.')}${finance(state)}<div class="t-day-alerts">${attention(state)}${promos(state)}</div><div class="t-concept-agenda"><div class="t-stack">${daily(state)}${events(state)}${clan(state)}</div><div class="t-stack">${marathon(state)}${party(state)}</div></div></div>`;
}
export function renderWorkspace(state) {
  return `<div class="t-variant t-workspace" data-view="workspace">${pageHeading(state, 'Пульт управления', 'Запуск, контроль и ближайшие действия. Без декоративных блоков.')}${finance(state)}<div class="t-command-alerts">${attention(state)}${promos(state)}</div><div class="t-concept-command"><div class="t-stack">${party(state)}${events(state)}</div><div class="t-stack">${daily(state)}${marathon(state)}</div></div>${clan(state)}</div>`;
}
export function renderVariant(state) {
  return state.variant === 'day'
    ? renderDay(state)
    : state.variant === 'workspace'
      ? renderWorkspace(state)
      : renderOverview(state);
}
