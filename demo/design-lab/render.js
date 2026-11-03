import { escapeHtml as esc } from '../../js/core/utils.js';
import { entriesFor, visibleEntries, featureList, demoDays, marathonRisk, selectedDay } from './model.js';
const assets = new URL('../../assets/', import.meta.url).href;
const shapes = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 5a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5"/>',
  flag: '<path d="M5 22V3c6-4 8 4 15 0v11c-7 4-9-4-15 0"/>',
  rune: '<path d="m12 2 9 10-9 10L3 12 12 2Zm0 0v20M3 12h18"/>',
  wallet: '<rect x="3" y="6" width="19" height="15" rx="3"/><path d="M3 9V5l14-3v4m0 6h5v5h-5z"/>',
  tools: '<path d="M14 3a7 7 0 0 0-8 8L2 17l5 5 6-5a7 7 0 0 0 8-8l-5 5-5-5 3-6Z"/>',
  settings:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  pulse: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  check: '<path d="m4 12 5 5L21 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'
};
export const icon = name =>
  `<svg class="lg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.grid}</svg>`;
export const button = (text, action, cls = '') =>
  `<button class="lg-button ${cls}" data-action="${esc(action)}">${text}</button>`;
const avatar = e =>
  e.icon
    ? `<img class="lg-avatar" src="${assets}icons/classes/${esc(e.icon)}.webp" alt="${esc(e.entity?.className || '')}"/>`
    : '';
const tone = e =>
  ['Внимание', 'Нужен вход', 'Расход', 'Подтверждение'].includes(e.status)
    ? 'amber'
    : e.status === 'Готово' || e.status === 'Доход'
      ? 'green'
      : 'neutral';
const badge = e => `<span class="lg-status ${tone(e)}">${esc(e.status)}</span>`;
const progress = e =>
  Number.isFinite(e.progress)
    ? `<div class="lg-progress" role="progressbar" aria-label="Прогресс: ${esc(e.title)}" aria-valuenow="${e.progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, e.progress))}%"></span></div>`
    : '';
const face = e =>
  `<span class="lg-face">${avatar(e)}<span><b>${esc(e.title)}</b><small>${esc(e.subtitle || e.group)}</small></span></span>`;
const open = e =>
  `<button class="lg-open" data-open="${esc(e.id)}" aria-label="Открыть ${esc(e.title)}">${icon('arrow')}</button>`;
const facets = e =>
  `<dl class="lg-facets">${Object.entries(e.facets || {})
    .map(([key, val]) => `<div><dt>${esc(key)}</dt><dd>${esc(val)}</dd></div>`)
    .join('')}</dl>`;
const itemAction = (e, source) =>
  `<button class="lg-button primary" data-open="${esc(e.id)}">${source === 'tools' ? 'Настроить' : source === 'parties' ? 'Состав и запуск' : source === 'runes' ? 'Открыть схему' : 'Подробнее'} ${icon('arrow')}</button>`;
export function currencyStrip(s) {
  return `<div class="lg-currencies" aria-label="Три разные валюты"><div><small>Золото</small><strong>${s.day.gold.toLocaleString('ru-RU')}</strong><span>Игровой баланс · пример</span></div><div><small>Голд</small><strong>${s.day.bank.toLocaleString('ru-RU')}</strong><span>Отдельная валюта · пример</span></div><div><small>Древние монеты</small><strong>${s.characters.reduce((n, c) => n + c.coins, 0).toLocaleString('ru-RU')}</strong><span>По аккаунтам · пример</span></div></div>`;
}
export function windows(s) {
  return `<div class="lg-window-list">${s.activeWindows.map(w => `<div><span><b>${esc(w.title)}</b><small>Игровое окно · имитация</small></span><button class="lg-text" data-rename-window="${esc(w.id)}">Название</button><button class="lg-icon-button" data-close-window="${esc(w.id)}" aria-label="Закрыть ${esc(w.title)}">×</button></div>`).join('') || '<p class="lg-muted">Нет вымышленных окон. Запустите пати в демо.</p>'}</div>`;
}
export function daily(s) {
  const day = selectedDay(s),
    marks = s.checkDates[day] || {};
  return `<div class="lg-day-strip" aria-label="Семь дней данжей">${demoDays(s.day.date)
    .map(
      d =>
        `<button data-day="${d.offset}" aria-pressed="${s.day.chosenDay === d.offset}" title="${esc(d.label || d.title || d.name || d.key)}"><small>${d.offset === -1 ? 'Вчера' : d.offset === 0 ? 'Сегодня' : new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'Europe/Moscow' })}</small><img src="${assets}icons/dungeons/pass-${esc(d.key)}.webp" alt="${esc(d.name || d.label || d.key)}"/><span>${d.date.slice(5).split('-').reverse().join('.')}</span></button>`
    )
    .join(
      ''
    )}</div><p class="lg-muted">Задачи на ${esc(day)} · отметки сохраняются отдельно для каждой даты</p><div class="lg-checklist">${[
    ['dungeon', 'Пройти данж дня'],
    ['marks', 'Проверить отметку события'],
    ['party', 'Подготовить состав пати']
  ]
    .map(
      ([key, title]) =>
        `<label><input type="checkbox" data-day-task="${key}" ${marks[key] ? 'checked' : ''}/><span>${title}</span></label>`
    )
    .join('')}</div>`;
}
export function marathonTable(s) {
  return `<p>Задания: победить монстров, пройти данж, выполнить поручение.</p><div class="lg-scroll"><table><caption>Участники «Путь героя» · демо-модель одной отметки в сутки</caption><thead><tr><th>Персонаж</th><th>Отметки</th><th>Запас / риск</th></tr></thead><tbody>${s.day.marathonProgress
    .map(row => {
      const c = s.characters.find(c => c.id === row.charId),
        risk = marathonRisk(row);
      return c
        ? `<tr><th scope="row">${esc(c.nick)}</th><td>${row.completed} / ${row.required}</td><td><span class="lg-status ${risk.tone === 'red' ? 'red' : risk.tone === 'amber' ? 'amber' : 'green'}">${esc(risk.label)}</span></td></tr>`
        : '';
    })
    .join(
      ''
    )}</tbody></table></div><button class="lg-button primary" data-check-marathon>Имитировать проверку всех участников</button><details><summary>Как считается риск</summary><p>Запас = дни до окончания − недостающие отметки. Это пример ежедневного события, не универсальный расчёт для всех марафонов. Повторная проверка не удваивает отметку.</p></details>`;
}
function todayBody(e, s) {
  switch (e.id) {
    case 'daily':
      return daily(s);
    case 'attention': {
      const offline = s.characters.filter(c => c.auth === 'offline').length;
      const checking = s.characters.filter(c => c.auth === 'checking').length;
      const risks = s.scenarios.marathon
        ? s.day.marathonProgress.filter(r => marathonRisk(r).tone !== 'green').length
        : 0;
      return `<div class="lg-notice"><strong>${offline} без входа · ${checking} проверяется${risks ? ` · ${risks} с риском в марафоне` : ''}</strong><p>Сначала восстановите вход, затем обновляйте данные. Игровые окна и вход на сайт — разные состояния.</p><button class="lg-button" data-go-source="characters">Посмотреть аккаунты</button></div>`;
    }
    case 'promo':
      return `<span class="lg-eyebrow">До ${s.day.promos[0].expiresOn} включительно · пример</span><h3 class="lg-promo-code">PWDEMO2026</h3><p>Осталось 6 персонажей. Активация только после выбора.</p><button class="lg-button primary" data-feature="Активация промокода">Предпросмотр активации</button>`;
    case 'party':
      return `<label class="lg-field">Пати<select data-party-select>${s.parties.map(p => `<option value="${esc(p.id)}" ${s.day.favoriteParty === p.id ? 'selected' : ''}>${esc(p.label || p.name)}</option>`).join('')}</select></label><div class="lg-people">${s.characters
        .filter(c => c.party === s.day.favoriteParty)
        .map(c => `<span>${avatar({ icon: c.icon, entity: c })}${esc(c.nick)}</span>`)
        .join(
          ''
        )}</div><button class="lg-button primary" data-launch-party="${esc(s.day.favoriteParty)}">${icon('play')} Выбрать и запустить</button>`;
    case 'marathon':
      return marathonTable(s);
    case 'clan':
      return `<p><b>Сегодня, 19:30 · сбор клана</b></p><div class="lg-choice">${['Буду', 'Не смогу'].map(v => `<button class="lg-button" data-vote="${v}" aria-pressed="${s.vote === v}">${v}</button>`).join('')}</div><label class="lg-field">Опрос: время следующего сбора<select data-clan-time><option>20:00</option><option>21:00</option></select></label><button class="lg-button" data-demo-poll>Сохранить голос в примере</button><button class="lg-text" data-go-source="parties">К совместным пати →</button>`;
    case 'calendar':
      return `<div class="lg-agenda"><button data-calendar-offset="-1">← День назад</button><b>${selectedDay(s)}</b><button data-calendar-offset="1">День вперёд →</button></div>${
        s.calendarEvents.filter(event => event.date === selectedDay(s)).length
          ? `<ol class="lg-events">${s.calendarEvents
              .filter(event => event.date === selectedDay(s))
              .sort((a, b) => a.time.localeCompare(b.time))
              .map(
                event =>
                  `<li><time>${esc(event.time)}</time><span>${esc(event.title)}<small>Личное событие · пример</small></span></li>`
              )
              .join('')}</ol>`
          : '<p class="lg-muted">На выбранную дату событий нет.</p>'
      }${monthCalendar(s)}<button class="lg-button" data-feature="Календарь событий">Добавить событие</button>`;
    case 'windows':
      return windows(s);
    default:
      return '';
  }
}
function body(e, source, s) {
  if (source === 'today') return todayBody(e, s);
  if (source === 'characters')
    return `${facets(e)}<div class="lg-account-line"><span>Сайт: <b>${esc(e.entity.site)}</b></span><span>Игра: <b>${esc(e.entity.game)}</b></span></div>${progress(e)}${itemAction(e, source)}`;
  if (source === 'parties')
    return `<div class="lg-people">${s.characters
      .filter(c => c.party === e.id)
      .map(c => `<span>${avatar({ icon: c.icon, entity: c })}${esc(c.nick)}</span>`)
      .join(
        ''
      )}</div>${facets(e)}<button class="lg-button primary" data-launch-party="${esc(e.id)}">${icon('play')} Запустить выбранных</button>`;
  if (source === 'marathons')
    return e.id === 'hero' ? marathonTable(s) : `${facets(e)}${progress(e)}${itemAction(e, source)}`;
  if (source === 'runes')
    return `<div class="lg-rune-build"><div><small>PvE</small><b>${esc(e.entity.pve)}</b></div><div><small>PvP</small><b>${esc(e.entity.pvp)}</b></div></div><p>${esc(e.description)}</p>${itemAction(e, source)}`;
  if (source === 'bank')
    return `${facets(e)}<p class="lg-amount ${e.entity.amount > 0 ? 'green' : 'amber'}">${esc(e.metric)}</p>${itemAction(e, source)}`;
  if (source === 'tools')
    return `<p>${esc(e.description)}</p><div class="lg-safety">${e.group === 'Чтение' ? 'Только чтение данных · можно поставить в очередь' : 'Изменяет данные сайта · пробный запуск и подтверждение'}</div>${itemAction(e, source)}`;
  if (source === 'settings') return `${facets(e)}<p>${esc(e.description)}</p>${itemAction(e, source)}`;
  return `${facets(e)}${progress(e)}<p>${esc(e.description)}</p>${itemAction(e, source)}`;
}
const card = (e, source, s, large = false) =>
  `<article class="lg-card ${large ? 'lg-featured' : ''}" data-entry="${esc(e.id)}"><header>${face(e)}${badge(e)}</header><p class="lg-description">${esc(e.description)}</p>${body(e, source, s)}</article>`;
function table(rows, source, s) {
  const keys = [...new Set(rows.flatMap(e => Object.keys(e.facets || {})))].slice(0, 3);
  return `<div class="lg-panel lg-scroll"><table class="lg-record-table"><caption>Список: ${rows.length} записей · данные вымышлены</caption><thead><tr><th>Выбор</th><th>Название</th>${keys.map(k => `<th>${esc(k)}</th>`).join('')}<th>Состояние / итог</th><th>Детали</th></tr></thead><tbody>${rows.map(e => `<tr data-entry="${esc(e.id)}"><td><input type="checkbox" data-select="${esc(e.id)}" aria-label="Выбрать ${esc(e.title)}" ${s.selected.has(e.id) ? 'checked' : ''}/></td><th scope="row">${face(e)}</th>${keys.map(k => `<td>${esc(e.facets?.[k] ?? '—')}</td>`).join('')}<td>${badge(e)}<small>${esc(e.metric)}</small></td><td>${open(e)}</td></tr>`).join('')}</tbody></table></div>`;
}
function grouped(rows, key = 'group') {
  const groups = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  return [...groups];
}
export function collection(kind, rows, source, s) {
  if (!rows.length)
    return `<div class="lg-empty"><h2>Ничего не найдено</h2><p>Измените запрос или снимите фильтр. Записи не удалены.</p><button class="lg-button" data-clear-search>Сбросить поиск</button></div>`;
  const selected = rows.find(e => e.id === s.detail) || rows[0];
  switch (kind) {
    case 'table':
      return `${table(rows, source, s)}<details class="lg-panel lg-extra"><summary>Контекст выбранной записи · ${esc(selected.title)}</summary>${body(selected, source, s)}</details>`;
    case 'cards':
      return `<div class="lg-card-grid">${rows.map(e => card(e, source, s)).join('')}</div>`;
    case 'split':
      return `<div class="lg-master-detail"><div class="lg-master" aria-label="Выбор записи">${rows.map(e => `<button data-detail="${esc(e.id)}" aria-pressed="${selected.id === e.id}">${face(e)}<small>${esc(e.metric)}</small>${badge(e)}</button>`).join('')}</div><section class="lg-detail">${card(selected, source, s, true)}<p class="lg-muted">Контекст открыт рядом. Выбор сохраняется при смене варианта.</p></section></div>`;
    case 'board':
      return `<div class="lg-board">${grouped(rows)
        .map(
          ([group, items]) =>
            `<section class="lg-lane"><header><h2>${esc(group)}</h2><span>${items.length}</span></header>${items.map(e => card(e, source, s)).join('')}</section>`
        )
        .join('')}</div>`;
    case 'editorial':
      return `<div class="lg-editorial"><div class="lg-editorial-lead"><span class="lg-eyebrow">Главная тема / ${esc(source)}</span>${card(selected, source, s, true)}</div><div class="lg-editorial-columns">${rows
        .filter(e => e !== selected)
        .map(
          (e, i) =>
            `<section><span class="lg-index">${String(i + 2).padStart(2, '0')}</span>${card(e, source, s)}</section>`
        )
        .join('')}</div></div>`;
    case 'timeline':
      return `<div class="lg-timeline">${rows.map((e, i) => `<section class="lg-time-event"><div class="lg-time-label"><span>${esc(e.time || e.subtitle || `Этап ${i + 1}`)}</span><i></i></div>${card(e, source, s)}</section>`).join('')}</div>`;
    case 'matrix':
      return `${table(rows, source, s)}<div class="lg-matrix-detail"><div><span class="lg-eyebrow">Выбранный контекст</span><h2>${esc(selected.title)}</h2>${body(selected, source, s)}</div><aside><h3>Сравнение без переключений</h3><p>Строки — сущности, столбцы — их признаки. Все действия привязаны к конкретной строке.</p><button class="lg-button" data-select-all>Выбрать видимые</button></aside></div>`;
    case 'workspace':
      return `<div class="lg-workspace"><div class="lg-work-main">${card(selected, source, s, true)}<div class="lg-card-grid">${rows
        .filter(e => e !== selected)
        .map(e => card(e, source, s))
        .join(
          ''
        )}</div></div><aside class="lg-context-rail"><span class="lg-eyebrow">Контекст всегда рядом</span><h2>Рабочая сессия</h2>${queueView(s)}${source !== 'parties' && source !== 'today' ? windows(s) : '<p>Сначала выбор, затем предпросмотр, затем запуск.</p>'}<button class="lg-button" data-feature="Пробный запуск">Проверить без изменений</button></aside></div>`;
    case 'focus':
      return `<div class="lg-focus"><div class="lg-focus-number">${String(rows.indexOf(selected) + 1).padStart(2, '0')}<small> / ${rows.length}</small></div><div class="lg-focus-content">${card(selected, source, s, true)}<div class="lg-focus-next"><h3>Следующее</h3>${rows
        .filter(e => e !== selected)
        .map(e => `<button data-detail="${esc(e.id)}">${face(e)}<span>${esc(e.metric)}</span>${icon('arrow')}</button>`)
        .join('')}</div></div></div>`;
    case 'tree':
      return `<div class="lg-tree-layout"><nav class="lg-tree" aria-label="Группы записей">${grouped(rows)
        .map(
          ([group, items]) =>
            `<details open><summary>${esc(group)} <span>${items.length}</span></summary>${items.map(e => `<button data-detail="${esc(e.id)}" aria-current="${selected.id === e.id ? 'true' : 'false'}">${face(e)}</button>`).join('')}</details>`
        )
        .join('')}</nav><div>${card(selected, source, s, true)}<div class="lg-tree-siblings">${rows
        .filter(e => e !== selected && e.group === selected.group)
        .map(e => `<button class="lg-button" data-detail="${esc(e.id)}">${esc(e.title)}</button>`)
        .join('')}</div></div>`;
    default:
      return '';
  }
}
export function queueView(s) {
  return `<div class="lg-queue" role="status"><div><span class="lg-live-dot ${s.running ? 'busy' : ''}"></span><b>${s.running ? esc(s.running.title) : 'Очередь свободна'}</b></div><p>${s.running ? 'Имитируется выполнение. Новых запросов к игре нет.' : 'Новые задачи идут последовательно. Реальных задач в демо нет.'}</p>${s.running ? '<button class="lg-button danger" data-stop>Остановить сейчас</button>' : `<small>Последняя задача: ${esc(s.jobs[0]?.title || 'нет')} · ${esc(s.jobs[0]?.state || '')}</small>`}</div>`;
}
export function toolbar(source, s) {
  const all = entriesFor(source, s),
    groups = [...new Set(all.flatMap(e => [e.group, e.status]))];
  return `<div class="lg-toolbar"><label class="lg-search">${icon('search')}<input type="search" data-search placeholder="Найти в разделе…" aria-label="Найти в разделе" value="${esc(s.query)}"/></label><select data-filter aria-label="Фильтр"><option value="all">Все записи</option>${groups.map(g => `<option ${s.filter === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select><select data-sort aria-label="Сортировка"><option value="name">По названию</option><option value="status" ${s.sort === 'status' ? 'selected' : ''}>По состоянию</option></select><button class="lg-button" data-select-all>Выбрать видимые</button><button class="lg-text" data-clear-selection>Снять выбор</button><span class="lg-selection">Выбрано: ${all.filter(e => s.selected.has(e.id)).length}</span></div>`;
}
export function coverage(source) {
  return `<details class="lg-coverage"><summary>Все возможности раздела <span>${featureList(source).length}</span></summary><p>Варианты показывают разные приоритеты. Полный набор действий остаётся доступен здесь; в демо действия только имитируются.</p><div>${featureList(
    source
  )
    .map(f => `<button data-feature="${esc(f)}">${esc(f)} ${icon('arrow')}</button>`)
    .join('')}</div></details>`;
}
export function renderPage(source, variant, s) {
  return `${['today', 'bank'].includes(source) ? currencyStrip(s) : ''}${
    source === 'today'
      ? `<div class="lg-scenarios" aria-label="Сценарии страницы Сегодня">${[
          ['clan', 'Есть клан'],
          ['marathon', 'Есть марафон'],
          ['promo', 'Есть промокод'],
          ['attention', 'Есть предупреждения']
        ]
          .map(
            ([id, label]) =>
              `<label><input type="checkbox" data-scenario="${id}" ${s.scenarios[id] ? 'checked' : ''}/> ${label}</label>`
          )
          .join('')}</div>`
      : toolbar(source, s)
  }<div class="lg-composition kind-${variant.kind}" data-composition="${variant.kind}">${collection(variant.kind, visibleEntries(source, s), source, s)}</div>${source === 'parties' ? `<section class="lg-panel lg-extra"><h2>Работающие игровые окна</h2>${windows(s)}<button class="lg-button danger" data-feature="Закрытие всех окон">Закрыть все окна…</button></section>` : ''}${coverage(source)}`;
}

function monthCalendar(s) {
  const base = new Date(`${s.day.date}T12:00:00Z`),
    first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + s.calendarOffset, 1));
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate(),
    blanks = (first.getUTCDay() + 6) % 7;
  return `<details class="lg-month"><summary>Календарь месяца</summary><header><button class="lg-icon-button" data-month="-1" aria-label="Предыдущий месяц">←</button><b>${first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b><button class="lg-icon-button" data-month="1" aria-label="Следующий месяц">→</button></header><div>${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<small>${d}</small>`).join('')}${'<span></span>'.repeat(blanks)}${Array.from(
    { length: days },
    (_, i) => {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), i + 1)).toISOString().slice(0, 10);
      return `<button data-date="${date}" aria-pressed="${date === selectedDay(s)}">${i + 1}</button>`;
    }
  ).join('')}</div></details>`;
}
