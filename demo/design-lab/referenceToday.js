// Variant 12: the user's annotated composition. Demo state only, no app writes,
// website calls, credentials, real launcher or inferred official reward rules.
import { escapeHtml as esc } from '../../js/core/utils.js';
import { mskAddDays } from '../../js/core/msk.js';
import { dungeonInfoForDate } from '../../js/modules/dungeons/schedule.js';
import { recurringEventsForDate } from '../../js/modules/dashboard/recurringEvents.js';
import { demoDays } from './model.js';
const assets = new URL('../../assets/', import.meta.url).href;
const dateLabel = date =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    timeZone: 'Europe/Moscow'
  });
const button = (text, action, extra = '') =>
  `<button type="button" class="lg-button ${extra}" data-today-action="${action}">${text}</button>`;
const pass = (key, alt = '') => `<img src="${assets}icons/dungeons/pass-${key}.webp" alt="${esc(alt)}"/>`;
const member = c =>
  `<span class="rt-member"><img src="${assets}icons/classes/${esc(c.icon)}.webp" alt="${esc(c.className)}"/>${esc(c.nick)}</span>`;
export function referenceDayEvents(s) {
  const date = mskAddDays(s.day.date, s.day.chosenDay);
  return [
    ...recurringEventsForDate(date).map(e => ({
      ...e,
      time: `${e.time}–${e.endTime || e.end || '…'}`,
      detail: 'Постоянное событие календаря'
    })),
    ...s.calendarEvents.filter(e => e.date === date).map(e => ({ ...e, detail: 'Личная запись · пример' }))
  ];
}
export function referenceGameEvents(s) {
  let dynasty = null;
  for (let offset = 0; offset < 7 && !dynasty; offset++)
    dynasty =
      recurringEventsForDate(mskAddDays(mskAddDays(s.day.date, s.day.chosenDay), offset)).find(
        e => e.recurringId === 'dynasty-battle'
      ) || null;
  return [
    {
      title: 'Битва Династий',
      time: dynasty ? `${dynasty.time}–${dynasty.endTime}` : 'По календарю',
      detail: dynasty ? `Ближайшая: ${dateLabel(dynasty.date)}` : 'Автоматическое событие календаря'
    },
    { title: 'Императорская битва', time: 'Время уточняется', detail: 'Нет подтверждённых часов в примере' },
    { title: 'Арена Авроры', time: 'По календарю', detail: 'Равная / своя экипировка' },
    { title: 'ГвГ · клановые бои', time: 'По расписанию клана', detail: 'Время задаётся для конкретного сбора' },
    { title: 'Башня', time: 'До конца периода', detail: 'Фарм метеоритов · срок не прочитан' }
  ];
}
export function referencePromoStatus(p, today) {
  const days = Math.round((Date.parse(p.expiresOn) - Date.parse(today)) / 86400000);
  return {
    tone: days < 0 ? 'expired' : days <= 3 ? 'soon' : 'active',
    text: days < 0 ? 'Срок истёк' : days <= 3 ? `Скоро истечет, осталось: ${days} дней` : `Действует ещё ${days} дн.`
  };
}
export function renderReferenceToday(s) {
  const date = mskAddDays(s.day.date, s.day.chosenDay),
    dungeon = dungeonInfoForDate(date);
  const events = referenceDayEvents(s),
    party = s.parties.find(p => p.id === s.day.favoriteParty),
    members = s.characters.filter(c => c.party === party?.id && !c.archived);
  const promos = s.scenarios.promo ? s.day.promos.filter(p => !p.hidden) : [];
  const clanRows = [
    {
      id: 'training',
      title: 'Совместный поход',
      time: 'Сегодня, 20:00',
      note: 'Сбор за 20 минут до начала',
      party: party?.name
    },
    {
      id: 'defence',
      title: 'ГвГ · защита',
      time: 'Ближайший сбор, 20:00',
      note: 'Учебная запись, не расписание сервера'
    },
    { id: 'attack', title: 'ГвГ · атака', time: 'Ближайший сбор, 22:00', note: 'Отпись хранится только в примере' }
  ];
  return `<section class="rt-reference" data-composition="reference"><div class="rt-intro"><div><span class="lg-eyebrow">Вариант по вашему эскизу · 12</span><h3>Всё, что нужно сегодня</h3><p>Ближайшие дела — рядом. Остальные разделы открываются по одному клику.</p><dl class="rt-balances" aria-label="Три отдельные валюты · пример">${[
    ['Золото', s.day.gold],
    ['Голд', s.day.bank],
    ['Древние монеты', s.characters.reduce((n, c) => n + c.coins, 0)]
  ]
    .map(([name, value]) => `<div><dt>${name}</dt><dd>${value.toLocaleString('ru-RU')}</dd></div>`)
    .join(
      ''
    )}</dl></div><label class="rt-clan-toggle"><input type="checkbox" data-scenario="clan" ${s.scenarios.clan ? 'checked' : ''}/>Показать подключённый клан</label></div>
  <div class="rt-board"><div class="rt-left">
    <section class="lg-panel rt-news" data-entry="news"><div class="rt-heading"><span class="rt-dot"></span><h3>Новости Perfect World</h3><a href="https://pwonline.ru/news.php" target="_blank" rel="noopener noreferrer">Все новости ↗</a></div><article><small>Сохранённый пример · 24 сентября 2026</small><a href="https://pwonline.ru/news.php?article=9124" target="_blank" rel="noopener noreferrer">День середины осени в Идеальном Мире ↗</a><p>События и объявления с сайта — с переходом к оригинальной публикации.</p></article><details><summary>Ещё одна публикация</summary><a href="https://pwonline.ru/news.php?article=9111" target="_blank" rel="noopener noreferrer">Изменение наград «Летних бонусов Арены Авроры» ↗</a></details><small class="rt-footnote">Сохранённые новости, не свежая онлайн-лента.</small></section>
    <section class="lg-panel rt-today" data-entry="daily"><div class="rt-heading"><span>✦</span><h3>Сегодня</h3><small>${esc(dateLabel(date))}</small></div><div class="rt-dungeon is-${dungeon.key}">${pass(dungeon.key, dungeon.name)}<div><small>${s.day.chosenDay ? 'ВЫБРАННЫЙ ДЕНЬ' : 'ДАНЖ ДНЯ'}</small><strong>${esc(dungeon.name)}</strong><span>Цикл данжей из календаря приложения</span></div></div>
      <div class="rt-pass-legend" aria-label="Оригинальные иконки проходок">${[
        ['weapon', 'Оружие'],
        ['armor', 'Доспех'],
        ['relic', 'Реликвия']
      ]
        .map(([key, name]) => `<span class="is-${key}">${pass(key, name)}<small>${name}</small></span>`)
        .join('')}</div>
      <div class="rt-week" aria-label="Вчера и пять дней вперёд">${demoDays(s.day.date)
        .map(
          d =>
            `<button type="button" data-day="${d.offset}" aria-pressed="${s.day.chosenDay === d.offset}"><small>${d.offset === 0 ? 'Сегодня' : d.offset === -1 ? 'Вчера' : new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'Europe/Moscow' })}</small>${pass(d.key, d.name)}<span>${d.date.slice(8)}.${d.date.slice(5, 7)}</span></button>`
        )
        .join('')}</div>
      <div class="rt-heading rt-events-heading"><h3>События дня</h3><small>Время по Москве</small></div><div class="rt-events">${events.length ? events.map((e, i) => `<div class="rt-event"><div><b>${esc(e.title)}</b><small>${esc(e.detail)}</small></div><time>${esc(e.time)}</time><button class="lg-text" data-today-event="${i}" aria-label="Подробнее: ${esc(e.title)}">Подробнее ↗</button></div>`).join('') : '<p class="lg-muted">На эту дату событий нет. Выберите другой день или добавьте личную запись.</p>'}</div>
      <section class="rt-other-events"><h4>Игровые события</h4><p>Ближайшие события рядом с личными записями. Неподтверждённые часы не подставляем.</p>${referenceGameEvents(
        s
      )
        .map(
          (e, i) =>
            `<div class="rt-game-event"><div><b>${esc(e.title)}</b><small>${esc(e.detail)}</small></div><span>${esc(e.time)}</span><button class="lg-text" data-today-game-event="${i}" aria-label="Подробнее: ${esc(e.title)}">Подробнее ↗</button></div>`
        )
        .join('')}</section>
      <div class="rt-calendar-actions">${button('+ Добавить', 'event-add')}${button('Открыть день в календаре ↗', 'calendar', 'primary')}</div>
    </section></div>
  <div class="rt-right"><div class="rt-top">
    <section class="lg-panel rt-promos" data-entry="promo"><div class="rt-heading"><span class="rt-dot mint"></span><h3>Промокоды</h3><small>Кодов: ${promos.length}</small></div><div class="rt-promo-list">${
      promos
        .map((p, i) => {
          const status = referencePromoStatus(p, s.day.date);
          return `<article class="rt-promo ${status.tone}"><div><span>${esc(status.text)}</span><button class="lg-icon-button" data-today-hide="${i}" aria-label="Скрыть промокод ${esc(p.code)}">×</button></div><strong>${esc(p.code)}</strong><small>До ${esc(p.expiresOn.split('-').reverse().join('.'))} включительно</small><details><summary>Награды и активация</summary><p>${esc(p.reward || 'Состав награды не указан в этом примере.')}</p>${button('Выбрать получателей', 'promo-preview')}</details></article>`;
        })
        .join('') ||
      '<div class="rt-promo-empty"><span>◇</span><b>Пока нет промокодов</b><p>Добавьте код из Telegram или другой публикации вручную.</p></div>'
    }</div><footer>${button('+ Добавить промокод', 'promo-add', 'primary')}${button('Скрытые / восстановить', 'promo-restore')}</footer></section>
    <section class="lg-panel rt-marathon" data-entry="marathon"><div class="rt-heading"><span class="rt-dot amber"></span><h3>Марафон</h3>${s.scenarios.marathon ? '<span class="rt-pill">Пример</span>' : ''}</div>${s.scenarios.marathon ? `<h4>Путь героя</h4><p class="rt-period">${mskAddDays(s.day.date, 1).split('-').reverse().join('.')} — ${mskAddDays(s.day.date, 31).split('-').reverse().join('.')}</p><div class="rt-reward-heading"><span>Задачи</span><small>Максимальная награда · демо</small></div>${s.day.marathonTasks.map((task, i) => `<details class="rt-marathon-task"><summary><span>${esc(task.title)}</span><b>${[30, 10, 3][i]} × ${['монет', 'припасов', 'награды'][i]}</b></summary><p>${esc(task.description)}. Числа иллюстративные; настоящие пороги определяются правилами события.</p></details>`).join('')}<button type="button" class="rt-progress-link" data-go-source="marathons"><span>Прогресс выполнения <b>Открыть раздел ↗</b></span><span class="rt-progress-track"><i style="width:${s.day.marathon.percent}%"></i></span><small>${s.day.marathon.percent}% · участники, задания и награды</small></button>` : '<div class="rt-empty"><p>Сейчас нет выбранного марафона.</p><button class="lg-button" data-go-source="marathons">Выбрать марафон ↗</button></div>'}</section>
    </div>
    <section class="lg-panel rt-launch" data-entry="party"><div class="rt-heading"><span class="rt-dot"></span><h3>Быстрый запуск</h3><small>Только имитация</small></div><div class="rt-launch-main"><div><small>ВЫБРАННЫЙ ОТРЯД</small><h3>${esc(party?.label || party?.name || 'Нет пати')}</h3><p>${members.length} персонажей · ${members.filter(c => s.activeWindows.some(w => w.charId === c.id)).length} уже запущено в демо</p></div><div class="rt-people">${members.map(member).join('')}</div></div><details class="rt-party-select"><summary>Выбрать другой отряд</summary><label>Отряд<select class="lg-input" data-party-select>${s.parties.map(p => `<option value="${esc(p.id)}" ${party?.id === p.id ? 'selected' : ''}>${esc(p.label || p.name)}</option>`).join('')}</select></label></details><div class="rt-launch-actions">${button('▷ Запустить весь отряд', 'launch-all', 'primary')}${button('▷ Только ещё не запущенных', 'launch-missing')}</div><small class="rt-footnote">Сначала предпросмотр состава. Настоящие игровые окна не запускаются.</small></section>
    <section class="lg-panel rt-clan" data-entry="clan"><div class="rt-heading"><span class="rt-dot mint"></span><h3>${s.scenarios.clan ? 'Клан Eternals' : 'Ваш клан — в одном месте'}</h3><small>${s.scenarios.clan ? 'Совместные события · демо' : 'Не подключён'}</small>${s.scenarios.clan ? button('⟳ Обновить', 'clan-refresh') + button('Кланнер ↗', 'clan-open') : ''}</div>${s.scenarios.clan ? `<div class="rt-clan-body"><div class="rt-clan-events">${clanRows.map(e => `<article><div><b>${esc(e.title)}</b><small>${esc(e.time)} · ${esc(e.note)}</small></div><div class="rt-attendance">${['Пойду', 'Не пойду'].map(v => `<button type="button" class="lg-button ${s.referenceVotes?.[e.id] === v ? 'primary' : ''}" data-today-vote="${e.id}" data-value="${v}" aria-pressed="${s.referenceVotes?.[e.id] === v}">${v}</button>`).join('')}</div></article>`).join('')}</div><aside><small>СОВМЕСТНЫЕ ПАТИ</small><b>${esc(party?.label || 'Пати не выбрана')}</b><div class="rt-people">${members.map(member).join('')}</div><button class="lg-text" data-go-source="parties">Составы и пати ↗</button></aside></div>` : `<div class="rt-clan-empty"><div><h4>Планы, совместные пати и отпись</h4><p>Даже без подключённого клана место блока сохраняется — важные события не потеряются среди других карточек.</p></div>${button('Зайти в кланнер ↗', 'clan-open', 'primary')}</div>`}</section>
  </div></div><details class="lg-coverage"><summary>Как устроен этот вариант</summary><p>Композиция по эскизу: новости над делами дня слева, промокоды и марафон сверху справа, затем запуск и клан. Полного календаря на главной нет. Иконки проходок — существующие игровые assets проекта. Данные, награды, клан и запуск — демонстрация; OAuth и сайт не вызываются.</p></details></section>`;
}

export function bindReferenceToday({ root, dialog, getState, render, modal, toast, launchParty }) {
  function click(event) {
    const s = getState(),
      el = event.target.closest('button');
    if (!el) return;
    if (el.hasAttribute('data-today-game-event')) {
      const e = referenceGameEvents(s)[Number(el.dataset.todayGameEvent)];
      if (e)
        modal(
          e.title,
          `<p>${esc(e.time)} · ${esc(e.detail)}</p><p>Это карточка события, не запуск. Подтверждённые часы берутся из календаря; остальные здесь не выдумываются.</p>`
        );
      return;
    }
    if (el.hasAttribute('data-today-event')) {
      const e = referenceDayEvents(s)[Number(el.dataset.todayEvent)];
      if (e)
        modal(
          e.title,
          `<p>${esc(e.time)} мск · ${esc(e.date)}</p><p>${esc(e.detail)}</p><p>«Подробнее» открывает карточку события. Кнопка не запускает игру и не активирует награды.</p>`
        );
      return;
    }
    if (el.hasAttribute('data-today-hide')) {
      const visible = s.day.promos.filter(p => !p.hidden);
      if (visible[Number(el.dataset.todayHide)]) visible[Number(el.dataset.todayHide)].hidden = true;
      render();
      return;
    }
    if (el.hasAttribute('data-today-vote')) {
      (s.referenceVotes ||= {})[el.dataset.todayVote] = el.dataset.value;
      render();
      toast('Отпись сохранена только в примере.');
      return;
    }
    if (el.hasAttribute('data-today-restore')) {
      const p = s.day.promos[Number(el.dataset.todayRestore)];
      if (p) p.hidden = false;
      dialog.close();
      render();
      return;
    }
    if (el.hasAttribute('data-today-confirm-launch')) {
      const ids = [...dialog.querySelectorAll('[name=rt-launch]:checked')].map(e => e.value);
      if (!ids.length) return toast('Никто не выбран — запуск не выполняется.');
      launchParty(s, s.day.favoriteParty, ids);
      dialog.close();
      render();
      toast('Созданы только вымышленные окна.');
      return;
    }
    const action = el.dataset.todayAction;
    if (!action) return;
    if (action === 'promo-add')
      return modal(
        'Добавить промокод вручную',
        `<form class="lg-editor" data-reference-promo><p>Только тестовый код. Из Telegram ничего не загружается автоматически.</p><label>Промокод<input name="code" required maxlength="64" autocomplete="off" placeholder="PWEXAMPLE"/></label><label>Действует по дату включительно<input name="expiresOn" type="date" value="${mskAddDays(s.day.date, 3)}" required/></label><label>Награды / заметка<input name="reward" maxlength="240"/></label><button type="submit" class="lg-button primary">Добавить в демо</button></form>`
      );
    if (action === 'promo-restore')
      return modal(
        'Скрытые промокоды',
        s.day.promos.some(p => p.hidden)
          ? s.day.promos
              .map((p, i) =>
                p.hidden
                  ? `<p><b>${esc(p.code)}</b> <button class="lg-button" data-today-restore="${i}">Восстановить</button></p>`
                  : ''
              )
              .join('')
          : '<p>Скрытых кодов нет.</p>'
      );
    if (action === 'promo-preview')
      return modal(
        'Активация промокода · демонстрация',
        '<p>Промокод относится к аккаунту сайта, а не к игровому окну. В рабочем сценарии сначала выбираются получатели, затем показывается подтверждение.</p><p>В этом макете промокод никуда не отправляется.</p>'
      );
    if (action === 'calendar') {
      const date = mskAddDays(s.day.date, s.day.chosenDay);
      return modal(
        `День в календаре · ${dateLabel(date)}`,
        `<p>Данж: ${esc(dungeonInfoForDate(date).name)}. Календарь открывается отдельно, не занимает главную страницу.</p><ol>${
          referenceDayEvents(s)
            .map(e => `<li>${esc(e.time)} · ${esc(e.title)}</li>`)
            .join('') || '<li>Записей пока нет</li>'
        }</ol><button class="lg-button" data-today-action="event-add">+ Личная запись на этот день</button>`
      );
    }
    if (action === 'event-add')
      return modal(
        'Добавить событие',
        `<form class="lg-editor" data-reference-event><label>Название<input name="title" required maxlength="80"/></label><label>Дата<input name="date" type="date" required value="${mskAddDays(s.day.date, s.day.chosenDay)}"/></label><label>Время по Москве<input name="time" type="time" value="20:00" required/></label><button class="lg-button primary" type="submit">Сохранить в демо</button></form>`
      );
    if (action === 'clan-refresh')
      return toast('Показан учебный пример клана. Сайт не запрашивается, расписание не выдаётся за актуальное.');
    if (action === 'clan-open')
      return modal(
        'Кланнер · точка входа',
        '<p>Здесь подключается ваш клан: события, отпись и совместные пати. В демо не запрашиваются настоящий логин, пароль или URL клана.</p><button class="lg-button primary" data-today-action="clan-demo">Показать подключённый пример</button>'
      );
    if (action === 'clan-demo') {
      s.scenarios.clan = true;
      dialog.close();
      render();
      return;
    }
    if (action === 'launch-all' || action === 'launch-missing') {
      const party = s.parties.find(p => p.id === s.day.favoriteParty),
        members = s.characters.filter(c => c.party === party?.id && !c.archived),
        available =
          action === 'launch-missing' ? members.filter(c => !s.activeWindows.some(w => w.charId === c.id)) : members;
      modal(
        `Запуск · ${party?.label || 'пати'}`,
        `<p>${action === 'launch-missing' ? 'Уже открытые вымышленные окна исключены.' : 'Уже открытые окна будут сохранены без дублирования.'} Это демонстрация, не команда GameCenter.</p><fieldset>${available.map(c => `<label class="lg-ack"><input type="checkbox" name="rt-launch" value="${esc(c.id)}" checked/>${esc(c.nick)} · ${esc(c.className)}</label>`).join('') || '<p>Все участники уже запущены.</p>'}</fieldset>`,
        available.length
          ? '<button class="lg-button primary" data-today-confirm-launch>Имитировать запуск выбранных</button>'
          : ''
      );
    }
  }
  function submit(event) {
    const form = event.target;
    if (!form.matches('[data-reference-promo],[data-reference-event]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!form.checkValidity()) return form.reportValidity();
    const data = new FormData(form),
      s = getState();
    if (form.hasAttribute('data-reference-promo')) {
      const code = String(data.get('code')).trim();
      if (!code) return;
      const old = s.day.promos.find(p => p.code.toUpperCase() === code.toUpperCase());
      if (old) {
        old.hidden = false;
        toast('Такой код уже есть — восстановили существующую запись.');
      } else
        s.day.promos.push({
          code,
          expiresOn: String(data.get('expiresOn')),
          reward: String(data.get('reward')).trim(),
          entered: []
        });
      s.scenarios.promo = true;
    } else {
      const title = String(data.get('title')).trim();
      if (!title) return;
      s.calendarEvents.push({ title, date: String(data.get('date')), time: String(data.get('time')) });
    }
    dialog.close();
    render();
  }
  for (const host of [root, dialog]) {
    host.addEventListener('click', click);
    host.addEventListener('submit', submit);
  }
}
