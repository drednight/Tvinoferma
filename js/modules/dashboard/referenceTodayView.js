// Today 12 composes production data helpers. Destructive/native actions go only
// through todayRuntime; the browser catalog cannot launch imaginary clients.
import { escapeHtml as esc, copyToClipboard } from '../../core/utils.js';
import { mskAddDays } from '../../core/msk.js';
import { dungeonInfoForDate, dungeonStrip } from '../dungeons/schedule.js';
import { plannerEventsForDate, monthMatrix, setEntryStatusForDate } from './planner.js';
import { siteFeedSnapshot } from './siteFeed.js';
import { connectedTodayState, runTodayAction, nativeToday } from './todayRuntime.js';
import { promoDeadlineState } from '../automation/promoDeadlineLabel.js';
import { getClassIconSrcByStem } from '../../core/constants.js';
import { partyNicks } from '../guild/core.js';
const assets = import.meta.env?.BASE_URL
  ? import.meta.env.BASE_URL + 'assets/'
  : new URL('../../../assets/', import.meta.url).href;
const dateLabel = d =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    timeZone: 'Europe/Moscow'
  });
const selectedDate = s => mskAddDays(s.day.date, s.day.chosenDay);
const button = (title, action, extra = '') =>
  `<button type="button" class="lg-button ${extra}" data-today-action="${action}">${title}</button>`;
const pass = (key, alt = '') => `<img src="${assets}icons/dungeons/pass-${key}.webp" alt="${esc(alt)}">`;
const refreshIcon =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>';
const clanResponseNote = (s, id) => {
  const pending = s.guild?.pendingResponses?.find(row => row.eventId === id);
  return pending
    ? `<span class="rt-vote-note" role="status">${pending.failed ? 'Не подтверждено · нажмите ответ для повтора' : 'Ожидает переноса на сайт'}</span>`
    : '';
};
const member = c => {
  const icon = c.icon || c.cls || '';
  return `<span class="rt-member">${/^[a-z0-9_-]+$/i.test(icon) ? `<img src="${esc(getClassIconSrcByStem(icon))}" alt="${esc(c.className || c.title || '')}">` : ''}${esc(c.nick)}</span>`;
};
const stamp = at =>
  at
    ? new Date(at)
        .toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Moscow'
        })
        .replace(' г.,', ' в')
    : 'ещё не выполнялось';
export function referenceDayEvents(s) {
  return plannerEventsForDate(
    s.plannerState || {
      plannerEntries: s.calendarEvents.map(e => ({ ...e, kind: e.kind || (e.time ? 'event' : 'task') })),
      marathons: []
    },
    selectedDate(s)
  ).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title, 'ru'));
}
export function referencePromoStatus(p, today, now) {
  const result = promoDeadlineState(p, now ?? Date.parse(`${today}T12:00:00+03:00`));
  return {
    tone: result.expired ? 'expired' : result.days != null && result.days <= 3 ? 'soon' : 'active',
    text: result.text
  };
}
export function renderReferenceToday(input) {
  const s = connectedTodayState(input),
    date = selectedDate(s),
    dungeon = dungeonInfoForDate(date),
    feed = siteFeedSnapshot();
  const party = s.parties.find(p => p.id === s.day.favoriteParty),
    members = s.characters.filter(c => !c.archived && (c.party === party?.id || c.partyIds?.includes(party?.id)));
  const events = referenceDayEvents(s),
    tab = s.referenceTab || 'events',
    rows = tab === 'todo' ? events.filter(e => e.kind === 'task') : events.filter(e => e.time || e.kind !== 'task');
  const clanRows = s.guild?.events || [
    { id: 'training', title: 'Совместный поход', when: 'Сегодня, 20:00', comment: 'Пример сбора' },
    { id: 'defence', title: 'ГвГ · защита', when: 'По расписанию клана' },
    { id: 'attack', title: 'ГвГ · атака', when: 'По расписанию клана' }
  ];
  const clanParties = s.guild?.parties || [{ name: party?.label || '', members }];
  const promos = s.sitePromos || [];
  return `<section class="rt-reference" data-composition="reference">${input.production ? '' : `<div class="rt-intro"><div><span class="lg-eyebrow">Вариант по вашему эскизу · 12</span><h3>Всё, что нужно сегодня</h3><p>Ближайшие дела, запуск и информация об аккаунтах.</p></div>${!nativeToday() && !input.production ? `<label class="rt-clan-toggle"><input type="checkbox" data-scenario="clan" ${s.scenarios.clan ? 'checked' : ''}>Показать подключённый клан</label>` : ''}</div>`}
 <div class="rt-board"><div class="rt-left"><section class="lg-panel rt-news"><div class="rt-heading"><h3>Новости Perfect World</h3><a href="https://pwonline.ru/news.php" target="_blank" rel="noopener noreferrer">Все новости ↗</a><button type="button" class="lg-button rt-refresh" data-today-action="news-refresh" title="Обновить новости" aria-label="Обновить новости">${refreshIcon}</button></div><small>Последнее обновление · ${esc(stamp(feed.updatedAt))}</small>${feed.articles.map(a => `<article class="rt-news-card"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></article>`).join('') || '<p class="lg-muted">Онлайн-лента ещё не получена. Чтение сайта выполняется в десктопном приложении вместе с обновлением серверов.</p>'}${feed.status === 'unavailable' ? '<p role="status">Сайт недоступен; дата успешного обновления не изменена.</p>' : ''}</section>
 <section class="lg-panel rt-today" data-entry="daily"><div class="rt-heading"><h3>Сегодня</h3><small>${esc(dateLabel(date))}</small></div><div class="rt-dungeon is-${dungeon.key}">${pass(dungeon.key, dungeon.name)}<div><small>ДАНЖ ДНЯ</small><strong>${esc(dungeon.name)}</strong><span>Цикл календаря приложения</span></div></div>
 <div class="rt-week">${dungeonStrip(mskAddDays(s.day.date, -1), mskAddDays(s.day.date, 5))
   .map(
     (d, i) =>
       `<button type="button" data-day="${i - 1}" aria-pressed="${s.day.chosenDay === i - 1}"><small>${i === 1 ? 'Сегодня' : i === 0 ? 'Вчера' : new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'Europe/Moscow' })}</small>${pass(d.key, d.name)}<span>${d.date.slice(8)}.${d.date.slice(5, 7)}</span></button>`
   )
   .join('')}</div>
 <div class="rt-tabs" role="tablist" aria-label="Дела выбранного дня"><button type="button" role="tab" aria-selected="${tab === 'events'}" data-today-tab="events">События дня</button><button type="button" role="tab" aria-selected="${tab === 'todo'}" data-today-tab="todo">Список дел</button></div><div class="rt-events" role="tabpanel" aria-label="${tab === 'todo' ? 'Список дел' : 'События дня'}">${rows.map(e => `<div class="rt-event"><div>${tab === 'todo' ? `<label><input type="checkbox" data-today-todo="${esc(e.id || '')}" ${e.status === 'done' ? 'checked' : ''}>${esc(e.title)}</label>` : `<b>${esc(e.title)}</b>`}<small>${e.source === 'recurring' ? 'Автоматическое событие календаря' : e.source === 'marathon' ? 'Марафон' : 'Запись календаря'}</small></div><time>${esc(e.time || 'В течение дня')}${e.endTime ? '–' + esc(e.endTime) : ''}</time><button class="lg-text" data-today-event="${events.indexOf(e)}">Подробнее ↗</button></div>`).join('') || '<p class="lg-muted">На этот день записей нет.</p>'}</div><div class="rt-calendar-actions">${button('+ Добавить', 'event-add')}${button('Открыть день в календаре ↗', 'calendar', 'primary')}</div></section></div>
 <div class="rt-right"><div class="rt-top"><section class="lg-panel rt-promos"><div class="rt-heading"><h3>Промокоды</h3><small>Действуют: ${promos.length}</small></div><div class="rt-promo-list">${
   promos
     .map(p => {
       const status = referencePromoStatus(p, s.day.date, nativeToday() || input.production ? Date.now() : undefined);
       return `<article class="rt-promo ${status.tone}"><strong>${esc(p.code)}</strong><small>${esc(status.text)}</small><p>${p.entered > 0 ? `Введён: ${p.entered} из ${s.characters.length} персонажей` : 'Ещё не введён по журналу'}</p><details><summary>Показать содержимое</summary><ul>${(p.rewards || []).map(r => `<li>${esc(r)}</li>`).join('') || '<li>Состав награды ещё не прочитан</li>'}</ul></details></article>`;
     })
     .join('') || '<p class="lg-muted">Действующих кодов пока не найдено.</p>'
 }</div><footer>${button('Открыть промокоды', 'promo', 'primary')}<button type="button" class="lg-button rt-refresh" data-today-action="promo-refresh" title="Проверить действующие промокоды в новостях" aria-label="Обновить промокоды">${refreshIcon}</button></footer></section>
 <section class="lg-panel rt-marathon"><div class="rt-heading"><h3>Марафон</h3>${!nativeToday() && !input.production ? '<span class="rt-pill">Пример</span>' : ''}</div>${s.scenarios.marathon ? `<h4>${esc(s.day.marathon.title)}</h4>${s.day.marathon.startDate > s.day.date ? '<span class="rt-pill">Скоро · ещё не начался</span>' : ''}<p class="rt-period">${esc(s.day.marathon.startDate || mskAddDays(s.day.date, 1))} — ${esc(s.day.marathon.endDate || mskAddDays(s.day.date, 31))}</p><div class="rt-reward-heading"><span>Задачи</span><small>Максимальная награда${!nativeToday() && !input.production ? ' · пример' : ''}</small></div>${s.day.marathonTasks.map((t, i) => `<details class="rt-marathon-task"><summary><span>${esc(t.title)}</span><b>${esc(t.maxReward || (!nativeToday() && !input.production ? ['30 монет', '10 припасов', '3 награды'][i] : 'Не указана') || '—')}</b></summary><p>${esc(t.description || 'Условия задания — в полном разделе марафона.')}</p></details>`).join('')}<button class="rt-progress-link" data-go-source="marathons"><span>Прогресс дня <b>Открыть раздел ↗</b></span><span class="rt-progress-track"><i style="width:${s.day.marathon.percent}%"></i></span><small>${s.day.marathon.percent}%</small></button>` : '<p>Нет активного марафона.</p><button type="button" class="lg-button" data-go-source="marathons">Открыть марафоны ↗</button>'}</section></div>
 <section class="lg-panel rt-launch"><div class="rt-heading"><h3>Быстрый запуск</h3></div><div class="rt-launch-main"><div><small>ВЫБРАННЫЙ ОТРЯД</small><h3>${esc(party?.label || 'Отряд не выбран')}</h3><p>Персонажей: ${members.length}</p></div><div class="rt-people">${members.map(member).join('')}</div></div><label class="rt-party-select">Выбрать отряд<select class="lg-input" data-party-select>${s.parties.map(p => `<option value="${esc(p.id)}" ${p.id === party?.id ? 'selected' : ''}>${esc(p.label || p.name)}</option>`).join('')}</select></label><div class="rt-launch-actions">${button('Запустить выбранный отряд', 'launch', 'primary')}${button('Текущие рабочие окна игры', 'windows')}</div><small>Штатный запуск: проверки GameCenter, привязок, уже открытых окон и подтверждение.</small></section>
 <section class="lg-panel rt-information"><div class="rt-heading"><h3>Информационная панель</h3></div><dl class="rt-information-grid">${[
   ['Золото', s.day.gold],
   ['Голд', s.day.bank],
   ['Древние монеты', s.characters.filter(c => !c.archived).reduce((n, c) => n + c.coins, 0)],
   ['Персонажей', s.characters.filter(c => !c.archived).length],
   ['С входом на сайт', s.characters.filter(c => !c.archived && c.auth === 'online').length],
   ['Запущено окон', s.activeWindows.length]
 ]
   .map(
     ([name, value]) =>
       `<div><dt>${name}</dt><dd>${value == null ? 'Нет данных' : Number(value).toLocaleString('ru-RU')}</dd></div>`
   )
   .join('')}</dl></section></div>
 ${
   s.scenarios.clan
     ? `<section class="lg-panel rt-clan"><div class="rt-heading"><h3>Клан</h3>${button('Обновить', 'clan-refresh')}${button('Открыть сайт', 'clan-open')}</div><div class="rt-clan-body"><div class="rt-clan-events">${
         clanRows
           .map(
             e =>
               `<article><b>${esc(e.title)}</b><small>${esc(e.when || '')} ${esc(e.comment || '')}</small>${clanResponseNote(s, e.id)}<div class="rt-attendance">${[
                 ['yes', 'Пойду'],
                 ['no', 'Не пойду']
               ]
                 .map(
                   ([value, label]) =>
                     `<button class="lg-button" data-today-vote="${esc(e.id)}" data-value="${value}" aria-pressed="${(s.guild?.pendingResponses?.find(row => row.eventId === e.id)?.response || (!(nativeToday() || input.production) && s.referenceVotes?.[e.id]) || e.response) === value}">${label}</button>`
                 )
                 .join('')}</div></article>`
           )
           .join('') || '<p>Расписание ещё не получено.</p>'
       }</div><aside><small>Моя пати</small>${clanParties.map((p, i) => `<div class="rt-party-heading"><b>${esc(p.name)}</b><button type="button" class="lg-button rt-copy-party" data-today-copy-party="${i}" title="Скопировать ники, кроме своего" aria-label="Скопировать ники, кроме своего"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></button></div><div class="rt-people">${p.members.map(member).join('')}</div>`).join('')}</aside></div></section>`
     : ''
 }</div></section>`;
}
const referenceBindings = new WeakMap();
export function bindReferenceToday({ root, dialog, getState, render, modal, toast, planner }) {
  referenceBindings.get(root)?.abort();
  const eventsController = new root.ownerDocument.defaultView.AbortController();
  referenceBindings.set(root, eventsController);
  const eventOptions = { signal: eventsController.signal };
  const execute = async (action, args) => {
    try {
      const result = await runTodayAction(action, args);
      if (!result.ok) toast(result.message);
      else render();
      return result;
    } catch {
      toast('Действие не завершено. Проверьте результат в штатном разделе приложения. Автоматического повтора нет.');
      return { ok: false };
    }
  };
  const calendar = () => {
    const raw = getState(),
      s = connectedTodayState(raw),
      date = selectedDate(s);
    const base = new Date(`${date}T12:00:00Z`);
    base.setUTCMonth(base.getUTCMonth() + (raw.referenceMonth || 0), 1);
    modal(
      'Календарь',
      `<div class="rt-calendar-nav"><button data-today-month="-1">←</button><b>${esc(base.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }))}</b><button data-today-month="1">→</button></div><div class="rt-calendar-weekdays">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<b>${d}</b>`).join('')}</div><div class="rt-calendar-grid">${monthMatrix(
        base.getUTCFullYear(),
        base.getUTCMonth()
      )
        .map(d =>
          d
            ? `<button data-today-date="${d}" aria-pressed="${d === date}"><span>${Number(d.slice(8))}</span><small>${esc(dungeonInfoForDate(d).name)}</small><small>${plannerEventsForDate(s.plannerState || { plannerEntries: s.calendarEvents, marathons: [] }, d).length} записей</small></button>`
            : '<span></span>'
        )
        .join('')}</div><h3>${esc(dateLabel(date))}</h3><ul class="rt-calendar-agenda">${
        referenceDayEvents(s)
          .map(
            e =>
              `<li class="rt-agenda-item${e.status === 'done' ? ' is-done' : ''}"><time>${esc(e.time || 'Весь день')}</time><div><strong>${esc(e.title)}</strong><small>${e.source === 'marathon' ? 'Марафон' : e.kind === 'event' ? 'Событие' : 'Задание'}${e.status === 'done' ? ' · Выполнено' : ''}</small></div></li>`
          )
          .join('') || '<li class="rt-agenda-empty">На этот день пока нет записей.</li>'
      }</ul>`,
      `${button('К текущей дате', 'calendar-today')}${s.production ? button('Редактировать записи дня', 'planner-day') : ''}${button('+ Запись на выбранную дату', 'event-add')}`
    );
  };
  async function click(event) {
    const el = event.target.closest('button');
    if (!el) return;
    const raw = getState(),
      s = connectedTodayState(raw);
    if (el.hasAttribute('data-today-tab')) {
      raw.referenceTab = el.dataset.todayTab;
      render();
      return;
    }
    if (el.dataset.todayAction === 'calendar-today') {
      raw.day.chosenDay = 0;
      raw.referenceMonth = 0;
      render();
      calendar();
      return;
    }
    if (el.hasAttribute('data-today-month')) {
      raw.referenceMonth = (raw.referenceMonth || 0) + Number(el.dataset.todayMonth);
      calendar();
      return;
    }
    if (el.hasAttribute('data-today-date')) {
      raw.day.chosenDay = Math.round((Date.parse(el.dataset.todayDate) - Date.parse(s.day.date)) / 86400000);
      raw.referenceMonth = 0;
      render();
      calendar();
      return;
    }
    if (el.dataset.todayAction === 'planner-day' && planner?.day) {
      dialog.close();
      planner.day(selectedDate(s));
      return;
    }
    if (el.hasAttribute('data-today-event')) {
      if (planner?.day) {
        dialog.close();
        planner.day(selectedDate(s));
        return;
      }
      const e = referenceDayEvents(s)[Number(el.dataset.todayEvent)];
      if (e)
        modal(
          e.title,
          `<p>${esc(e.time || 'Весь день')} · ${esc(e.date)}</p><p>Карточка календаря, не запускает игру.</p>`
        );
      return;
    }
    if (el.hasAttribute('data-today-copy-party')) {
      if (nativeToday() && s.scenarios.clan) (await import('../guild/page.js')).touchGuildResponses();
      const party = s.parties.find(p => p.id === s.day.favoriteParty),
        members = s.characters.filter(c => c.party === party?.id || c.partyIds?.includes(party?.id)),
        parties = s.guild?.parties || [{ members }],
        names = partyNicks(parties[Number(el.dataset.todayCopyParty)], s.guild?.selfNick || s.characters[0]?.nick);
      if (!names.length) return toast('Нет чужих ников для копирования.');
      const ok = await copyToClipboard(names.join(' '));
      toast(ok ? 'Ники скопированы без вашего' : 'Не удалось скопировать ники');
      return;
    }
    if (el.hasAttribute('data-today-vote')) {
      const result = await execute('clan-vote', { eventId: el.dataset.todayVote, response: el.dataset.value });
      if (result.ok) {
        if (!nativeToday()) (raw.referenceVotes ||= {})[el.dataset.todayVote] = el.dataset.value;
        render();
      }
      return;
    }
    const action = el.dataset.todayAction;
    if (action === 'calendar') {
      raw.referenceMonth = 0;
      calendar();
      return;
    }
    if (action === 'event-add') {
      if (planner?.add) {
        dialog.close();
        planner.add(selectedDate(s));
        return;
      }
      modal(
        'Добавить запись',
        `<form class="lg-editor" data-reference-event><label>Название<input name="title" required maxlength="160"></label><label>Дата<input name="date" type="date" required value="${selectedDate(s)}"></label><label>Тип<select name="kind"><option value="event">Событие</option><option value="task">Список дел · To-Do</option></select></label><label>Время по Москве<input name="time" type="time"></label><button class="lg-button primary" type="submit">Сохранить</button></form>`
      );
      return;
    }
    if (['launch', 'windows', 'promo', 'promo-refresh', 'news-refresh', 'clan-open', 'clan-refresh'].includes(action))
      await execute(action, { partyId: s.day.favoriteParty });
  }
  async function submit(event) {
    const form = event.target;
    if (!form.matches('[data-reference-event]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!form.checkValidity()) return form.reportValidity();
    const data = new FormData(form),
      entry = Object.fromEntries(['title', 'date', 'time', 'kind'].map(k => [k, String(data.get(k) || '').trim()]));
    if (!entry.title) return;
    if (nativeToday()) {
      if (!(await execute('event-add', entry)).ok) return;
    } else getState().calendarEvents.push({ ...entry, id: crypto.randomUUID(), status: 'todo' });
    dialog.close();
    render();
  }
  const change = async e => {
    if (!e.target.matches('[data-today-todo]')) return;
    const raw = getState(),
      s = connectedTodayState(raw),
      id = e.target.dataset.todayTodo,
      status = e.target.checked ? 'done' : 'todo';
    if (raw.production && planner?.todo) await planner.todo(id, selectedDate(s), status);
    else if (nativeToday()) await execute('todo', { eventId: id, date: selectedDate(s), response: status });
    else {
      const entry = raw.calendarEvents.find(r => r.id === id);
      if (entry) setEntryStatusForDate(entry, selectedDate(s), status);
      render();
    }
  };
  for (const host of [root, dialog]) {
    host.addEventListener('click', click, eventOptions);
    host.addEventListener('submit', submit, eventOptions);
    host.addEventListener('change', change, eventOptions);
  }
  for (const name of ['tf-site-feed-changed', 'tf-promo-news-changed'])
    window.addEventListener(
      name,
      () => {
        if (!root.isConnected) {
          eventsController.abort();
          return;
        }
        if (root.querySelector('.rt-reference')) render();
      },
      eventOptions
    );
  return () => eventsController.abort();
}
