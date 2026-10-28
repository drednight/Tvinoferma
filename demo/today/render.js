// Макеты одной страницы: разные компоновки используют общие вымышленные данные.
import { escapeHtml as esc } from '../../js/core/utils.js';
import { guildPollHtml } from '../../js/modules/guild/poll.js';
import { TASKS, demoDays, partyInfo, summary } from './data.js';

export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const num = value => new Intl.NumberFormat('ru-RU').format(value);
const signed = value => `${value > 0 ? '+' : ''}${num(value)}`;
const shortDate = date =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`)
  );
const weekday = date =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const doneCount = state => TASKS.filter(t => (state.marathonActive || t.id !== 'marathon') && state.tasks[t.id]).length;
const shownTasks = state => TASKS.filter(t => state.marathonActive || t.id !== 'marathon');
const dungeonImage = day => `<img src="../../assets/icons/dungeons/pass-${esc(day.key)}.webp" alt="" />`;

function heading(title, detail, action = '') {
  return `<div class="t-section-head"><div><h3>${title}</h3>${detail ? `<p>${detail}</p>` : ''}</div>${action}</div>`;
}

function subtleAction(label, section) {
  return `<button type="button" class="t-link" data-open-section="${section}">${label} ${icon('arrow-right')}</button>`;
}

function metric(title, value, detail, image, tone, section) {
  return `<button type="button" class="t-metric t-tone-${tone}" data-open-section="${section}">
    <span class="t-metric-top"><span class="t-icon-box">${icon(image)}</span><span class="t-metric-arrow">${icon('arrow-up-right')}</span></span>
    <span class="t-metric-label">${title}</span><strong>${value}</strong><span class="t-metric-detail">${detail}</span>
  </button>`;
}

function overviewMetrics(state) {
  const data = summary(state);
  return `<div class="t-metrics" aria-label="Общая сводка">
    ${metric('Персонажи', data.characters, `<span class="t-dot green"></span>${data.online} с подтверждённым входом`, 'user', 'blue', 'characters')}
    ${metric('Древние монеты', num(data.coins), 'Сумма по персонажам', 'coin', 'gold', 'coins')}
    ${metric('Пати', data.parties, 'Можно выбрать избранную', 'users', 'violet', 'parties')}
    ${metric('Марафон', state.marathonActive ? 'Активен' : 'Нет', state.marathonActive ? `${esc(state.marathon?.title || 'Марафон')} · ${state.marathon?.days ?? 0} дн.` : 'Активных марафонов нет', 'flag', 'green', 'marathons')}
  </div>`;
}

function eventRows(state) {
  if (!state.events.length) return '<p class="t-work-empty">Событий в примере пока нет</p>';
  return state.events
    .map(
      event => `<div class="t-event-row"><div class="t-event-time">${esc(event.time || '—')}</div><span class="t-event-dot is-${event.color}"></span>
      <div class="t-event-copy"><strong>${esc(event.title)}</strong><small>${esc(event.detail)}</small></div>
      <span class="t-event-type">Событие</span></div>`
    )
    .join('');
}

function eventsCard(state) {
  return `<section class="t-card t-events">${heading('События сегодня', 'Что запланировано на этот день', subtleAction('Календарь', 'calendar'))}
    <div class="t-event-list">${eventRows(state)}</div>
    <div class="t-card-foot">${icon('calendar')} <span>Время указано по Москве</span><span class="t-foot-spacer"></span><span>${state.events.length} событий</span></div>
  </section>`;
}

function daysStrip(state) {
  return `<div class="t-days" aria-label="Данжи на ближайшие дни">${demoDays(state.date)
    .map(
      day => `<button type="button" class="t-day ${day.offset === state.chosenDay ? 'is-selected' : ''}" data-day="${day.offset}" aria-pressed="${day.offset === state.chosenDay}">
        <span>${day.offset === 0 ? 'сегодня' : day.offset === 1 ? 'завтра' : esc(weekday(day.date))}</span>${dungeonImage(day)}<small>${esc(day.name)}</small></button>`
    )
    .join('')}</div>`;
}

function dungeonCard(state, withWeek = false) {
  const selected = demoDays(state.date)[withWeek ? state.chosenDay : 0];
  const when = selected.offset === 0 ? 'Сегодня' : selected.offset === 1 ? 'Завтра' : shortDate(selected.date);
  return `<section class="t-card t-dungeon">
    ${heading('Ежедневное задание', 'Цикл данжей', `<span class="t-badge t-badge-blue">${esc(when)}</span>`)}
    <div class="t-dungeon-body"><div class="t-dungeon-icon is-${selected.key}">${dungeonImage(selected)}</div><div><small>${selected.offset === 0 ? 'ДАНЖ ДНЯ' : 'ВЫБРАННЫЙ ДЕНЬ'}</small><strong>${esc(selected.name)}</strong><span>Смена задания каждый день</span></div>
      ${withWeek ? '' : `<div class="t-dungeon-next"><small>ЗАВТРА</small><b>${dungeonImage(demoDays(state.date)[1])} ${esc(demoDays(state.date)[1].name)}</b></div>`}</div>
    ${withWeek ? daysStrip(state) : ''}
  </section>`;
}

function avatar(character, withName = false) {
  return `<span class="t-avatar is-${character.auth}" title="${esc(character.nick)} · ${character.auth === 'online' ? 'вход подтверждён' : character.auth === 'checking' ? 'проверка' : 'нет входа'}">
    ${character.icon ? `<img src="../../assets/icons/classes/${esc(character.icon)}.webp" alt="" />` : esc(Array.from(character.nick || '?')[0])}</span>${withName ? `<span>${esc(character.nick)}</span>` : ''}`;
}

function partySelect(state, id = 'party-select') {
  return `<label class="t-party-select"><span>Избранная пати</span><select id="${id}" data-party-select aria-label="Выбрать избранную пати">${
    state.parties.length
      ? state.parties
          .map(
            party =>
              `<option value="${esc(party.id)}"${state.favoriteParty === party.id ? ' selected' : ''}>${esc(party.label)}</option>`
          )
          .join('')
      : '<option value="">Пока нет пати</option>'
  }</select>${icon('chevron-down')}</label>`;
}

function partyCard(state, compact = false) {
  const party = partyInfo(state.favoriteParty, state);
  return `<section class="t-card t-party ${compact ? 'is-compact' : ''}">
    ${heading('Быстрый запуск', 'Выбранная пати всегда под рукой', `<span class="t-icon-box t-party-icon">${icon('users')}</span>`)}
    ${partySelect(state, compact ? 'party-select-compact' : 'party-select-main')}
    <div class="t-party-members"><div class="t-avatars">${party.members.map(c => avatar(c)).join('')}</div><div><strong>${party.members.length} участника</strong><span>${party.online} из ${party.members.length} с подтверждённым входом</span></div></div>
    <button type="button" class="t-btn t-btn-primary t-launch" data-open-section="launch"${party.id ? '' : ' disabled'}>${icon('play')} Имитировать запуск <span>${icon('arrow-right')}</span></button>
    <small class="t-party-note">${party.id && state.lastLaunch === party.id ? 'Имитация запуска выполнена' : 'Демо: игровые окна не запускаются'}</small>
  </section>`;
}

function miniSections(state) {
  const data = summary(state);
  const rows = [
    ['bank', 'Банк', `${signed(data.bank)} голда`, 'wallet', 'gold'],
    ['runes', 'Руны', `${data.runes} сборок`, 'diamond', 'violet'],
    ['tools', 'Инструменты', 'Нет активных задач', 'tool', 'blue']
  ];
  return `<section class="t-card t-other">${heading('Ещё в приложении', 'Коротко о других разделах')}
    <div class="t-other-list">${rows.map(([id, title, detail, image, tone]) => `<button type="button" data-open-section="${id}"><span class="t-small-icon t-tone-${tone}">${icon(image)}</span><span><strong>${title}</strong><small>${detail}</small></span>${icon('chevron-right')}</button>`).join('')}</div>
  </section>`;
}

function taskList(state) {
  return `<div class="t-task-list">${shownTasks(state)
    .map(
      task => `<label class="t-task${state.tasks[task.id] ? ' is-done' : ''}"><input type="checkbox" data-task="${task.id}"${state.tasks[task.id] ? ' checked' : ''} />
      <span class="t-task-check">${icon('check')}</span><span><strong>${esc(task.title)}</strong><small>${esc(task.detail)}</small></span></label>`
    )
    .join('')}</div>`;
}

function compactOverview(state) {
  const data = summary(state);
  const cards = [
    ['characters', 'Персонажи', String(data.characters), `${data.online} вошли`, 'user', 'blue'],
    ['coins', 'Монеты', num(data.coins), 'Древние монеты', 'coin', 'gold'],
    ['parties', 'Пати', String(data.parties), 'группы', 'users', 'violet'],
    [
      'marathons',
      'Марафон',
      state.marathonActive ? 'Есть' : 'Нет',
      state.marathonActive ? `${state.marathon?.days ?? 0} дн. осталось` : 'нет активных',
      'flag',
      'green'
    ]
  ];
  return `<section class="t-card t-compact-summary">${heading('Ваши разделы', 'Важное в одном месте')}
    <div class="t-compact-grid">${cards.map(([section, title, value, detail, image, tone]) => `<button type="button" data-open-section="${section}"><span class="t-small-icon t-tone-${tone}">${icon(image)}</span><span><small>${title}</small><strong>${value}</strong><em>${detail}</em></span>${icon('chevron-right')}</button>`).join('')}</div>
  </section>`;
}

function clan(state) {
  if (!state.clanEnabled) return '';
  const response = (
    id,
    title,
    time,
    note
  ) => `<div class="t-clan-event"><div class="t-clan-event-copy"><small>${time}</small><strong>${title}</strong><span>${note}</span></div>
    <div class="t-clan-response" aria-label="Ответ на событие ${title}"><button type="button" data-clan-event="${id}" data-response="yes" aria-pressed="${state.clanResponses[id] === 'yes'}">Пойду</button><button type="button" data-clan-event="${id}" data-response="no" aria-pressed="${state.clanResponses[id] === 'no'}">Не пойду</button></div></div>`;
  return `<section class="t-card t-clan" data-clan-panel>
    <div class="t-clan-head"><div class="t-clan-brand"><span class="t-clan-shield">${icon('shield')}</span><span><small>КЛАН</small><h3>Eternals</h3></span><span class="t-badge t-badge-violet">Пример</span></div>
      <div class="t-clan-actions"><button type="button" class="t-btn t-btn-quiet" data-open-section="clan-refresh">${icon('refresh')} Обновить</button><button type="button" class="t-btn t-btn-quiet" data-open-section="clan-site">Открыть сайт ${icon('arrow-up-right')}</button></div></div>
    <div class="t-clan-grid"><div><div class="t-clan-subhead"><h4>События клана</h4><span>2 события</span></div>
      ${response('clan-1', 'Сбор клана', 'СЕГОДНЯ · 20:30', 'Общий сбор перед походом')}
      ${response('clan-2', 'Выход в цитадель', 'ЗАВТРА · 19:00', 'Возьмите расходники')}
    </div><div class="t-clan-party"><div class="t-clan-subhead"><h4>Мои пати</h4><span>1 пати</span></div><div class="t-clan-party-box"><span class="t-small-icon t-tone-violet">${icon('users')}</span><div><strong>Пати «Север»</strong><small>Звеномир, Тихомир и Радовика</small></div></div><button type="button" class="t-link" data-open-section="clan-copy">${icon('copy')} Скопировать ники</button></div></div>
    ${state.pollEnabled ? guildPollHtml(state.poll) : ''}
  </section>`;
}

export function renderOverview(state) {
  const data = summary(state);
  return `<div class="t-variant t-overview" data-view="overview">
    <div class="t-page-title"><div><p class="t-kicker">${esc(shortDate(state.date))} · ПО МОСКВЕ</p><h2>Сегодня</h2><p>Обзор всего важного — без лишних переходов.</p></div><button type="button" class="t-btn t-btn-quiet" data-open-section="refresh">${icon('refresh')} Обновить сводку</button></div>
    <section class="t-hero"><div class="t-hero-copy"><span class="t-eyebrow">${icon('sparkle')} ВАША СВОДКА</span><h3>Всё под рукой.<br/><span>Хорошего дня!</span></h3><p>${data.characters} персонажей, ${data.parties} пати${state.marathonActive ? ' и активный марафон' : ''} — всё на одном экране.</p><button type="button" class="t-hero-alert" data-open-section="characters"><span class="t-dot amber"></span>${data.offline} персонажам нужен вход ${icon('arrow-right')}</button></div><div class="t-hero-art" aria-hidden="true"><div class="t-hero-orbit orbit-one"></div><div class="t-hero-orbit orbit-two"></div><div class="t-hero-core">${icon('sparkle')}</div><span class="t-hero-star one">✦</span><span class="t-hero-star two">✧</span><span class="t-hero-star three">✦</span></div></section>
    ${overviewMetrics(state)}
    <div class="t-overview-layout"><div class="t-stack">${eventsCard(state)}${dungeonCard(state)}</div><div class="t-stack">${partyCard(state)}${miniSections(state)}</div></div>
    ${clan(state)}
  </div>`;
}

export function renderDay(state) {
  const tasks = shownTasks(state);
  return `<div class="t-variant t-day-view" data-view="day">
    <div class="t-page-title"><div><p class="t-kicker">${esc(shortDate(state.date))} · ПО МОСКВЕ</p><h2>План на сегодня</h2><p>Сначала день, затем всё остальное.</p></div><span class="t-badge t-badge-violet">${icon('sparkle')} ${doneCount(state)} из ${tasks.length} дел готово</span></div>
    <div class="t-day-layout"><div class="t-stack"><section class="t-card t-agenda"><div class="t-agenda-title"><div><span class="t-eyebrow">ПЛАН НА ДЕНЬ</span><h3>День в деталях</h3><p>События и личные дела на одной ленте</p></div><span class="t-date-tile"><b>${state.date.slice(-2)}</b><small>${esc(weekday(state.date))}</small></span></div>
    <div class="t-agenda-label"><span>СОБЫТИЯ</span><button type="button" class="t-link" data-open-section="calendar">Календарь ${icon('arrow-right')}</button></div>
    <div class="t-agenda-events">${eventRows(state)}</div>
    <div class="t-agenda-label"><span>МОИ ДЕЛА</span><small>${doneCount(state)} / ${tasks.length}</small></div>${taskList(state)}
    <p class="t-task-hint">Отметки меняются только в этом примере.</p></section>${dungeonCard(state, true)}</div>
    <div class="t-stack">${compactOverview(state)}${partyCard(state, true)}${miniSections(state)}</div></div>
    ${clan(state)}
  </div>`;
}

function workspaceTile({ id, title, iconName, tone, eyebrow, value, detail, extra = '' }) {
  return `<section class="t-card t-work-tile t-tone-${tone}"><div class="t-work-head"><span class="t-icon-box">${icon(iconName)}</span><button type="button" class="t-icon-btn" data-open-section="${id}" aria-label="Открыть пример раздела ${title}">${icon('arrow-up-right')}</button></div>
    <span class="t-work-eyebrow">${eyebrow}</span><h3>${title}</h3><div class="t-work-value">${value}</div><p>${detail}</p>${extra}
  </section>`;
}

export function renderWorkspace(state) {
  const data = summary(state);
  const party = partyInfo(state.favoriteParty, state);
  const active = state.marathonActive;
  const dungeon = demoDays(state.date)[0];
  return `<div class="t-variant t-workspace" data-view="workspace">
    <div class="t-page-title"><div><p class="t-kicker">${esc(shortDate(state.date))} · ПО МОСКВЕ</p><h2>Пульт управления</h2><p>Разделы, состояние и быстрые действия.</p></div><button type="button" class="t-btn t-btn-quiet" data-open-section="refresh">${icon('refresh')} Обновить</button></div>
    <div class="t-work-notice"><span class="t-work-notice-icon">${icon('alert')}</span><div><strong>Обратите внимание на вход</strong><p>Без входа: ${data.offline} · проверяется: ${data.checking}</p></div><button type="button" class="t-link" data-open-section="characters">Посмотреть ${icon('arrow-right')}</button></div>
    <div class="t-work-grid">
      ${workspaceTile({
        id: 'characters',
        title: 'Персонажи',
        iconName: 'user',
        tone: 'blue',
        eyebrow: 'АККАУНТЫ',
        value: String(data.characters),
        detail: `${data.online} из ${data.characters} с подтверждённым входом`,
        extra: `<div class="t-avatars">${state.characters
          .slice(0, 5)
          .map(c => avatar(c))
          .join('')}${data.characters > 5 ? `<span class="t-avatar-more">+${data.characters - 5}</span>` : ''}</div>`
      })}
      ${workspaceTile({ id: 'parties', title: 'Пати', iconName: 'users', tone: 'violet', eyebrow: 'ГРУППЫ', value: `${data.parties} пати`, detail: `${esc(party.label)} · ${party.members.length} участника`, extra: `${partySelect(state, 'party-select-workspace')}<button type="button" class="t-work-action" data-open-section="launch"${party.id ? '' : ' disabled'}>${icon('play')} Имитировать запуск</button>` })}
      ${workspaceTile({ id: 'marathons', title: 'Марафон', iconName: 'flag', tone: 'green', eyebrow: 'ПРОГРЕСС', value: active ? 'Активен' : 'Нет активного', detail: active ? `${esc(state.marathon?.title || 'Марафон')} · осталось ${state.marathon?.days ?? 0} дн.` : 'Сейчас марафонов нет', extra: active ? `<div class="t-progress"><span style="width: ${Math.max(0, Math.min(100, Number(state.marathon?.percent) || 0))}%"></span></div><small class="t-progress-label">Прогресс · ${Math.max(0, Math.min(100, Number(state.marathon?.percent) || 0))}%</small>` : '<span class="t-work-empty">Новые марафоны появятся здесь</span>' })}
      ${workspaceTile({ id: 'coins', title: 'Древние монеты', iconName: 'coin', tone: 'gold', eyebrow: 'ПО ПЕРСОНАЖАМ', value: num(data.coins), detail: 'Общая сумма монет в примере' })}
      ${workspaceTile({ id: 'bank', title: 'Банк', iconName: 'wallet', tone: 'gold', eyebrow: 'ФИНАНСЫ', value: signed(data.bank), detail: 'Голда за месяц · пример' })}
      ${workspaceTile({ id: 'runes', title: 'Руны и инструменты', iconName: 'diamond', tone: 'violet', eyebrow: 'ЕЩЁ В ПРИЛОЖЕНИИ', value: `${data.runes} сборок`, detail: 'Нет активных задач в инструментах', extra: '<button type="button" class="t-work-action" data-open-section="tools">Открыть инструменты →</button>' })}
    </div>
    <div class="t-work-bottom"><section class="t-card t-work-events">${heading('События сегодня', 'Пример расписания', subtleAction('Календарь', 'calendar'))}${eventRows(state)}</section><section class="t-card t-work-daily">${heading('Ежа сегодня', 'Цикл ежедневных заданий')}<div class="t-work-dungeon"><span class="t-dungeon-icon is-${dungeon.key}">${dungeonImage(dungeon)}</span><div><small>ДАНЖ ДНЯ</small><strong>${esc(dungeon.name)}</strong></div></div><span class="t-work-empty">Завтра: ${esc(demoDays(state.date)[1].name)}</span></section></div>
    ${clan(state)}
  </div>`;
}

export function renderVariant(state) {
  return state.variant === 'day'
    ? renderDay(state)
    : state.variant === 'workspace'
      ? renderWorkspace(state)
      : renderOverview(state);
}
