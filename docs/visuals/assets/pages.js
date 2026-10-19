/* docs/visuals/assets/pages.js
   Рендер макетов: 9 экранов × 3 дизайн-направления.
   Каждый вариант отличается не цветом, а компоновкой: разный каркас, разный порядок блоков,
   разная плотность. Функционал (кнопки, фильтры, статусы, данные) сохранён везде одинаковый. */

window.TV = window.TV || {};

/* ─────────────────────────── общие мелочи ─────────────────────────── */
const D = () => TV.data;
const esc = s =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const icon = (n, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#${n}"/></svg>`;

const ava = (cls, size) =>
  `<span class="tv-ava ${size || ''}" style="background:hsl(${TV.clsColor(cls)} 70% 62%)">${esc(TV.clsInitials(cls))}</span>`;

const chip = (text, tone) => `<span class="tv-chip ${tone || ''}">${esc(text)}</span>`;

/* Символ-кнопка вроде «▶» или «🌐» — это тот же значок, что и SVG. Раз один рисунок уже есть,
   подпись убираем, а для доступности подставляем имя из карты. */
const ICON_NAMES = {
  '▶': 'Играть',
  '🌐': 'Открыть сайт',
  '⚙': 'Настройки',
  '🔄': 'Обновить',
  '⧉': 'Скопировать',
  '✎': 'Изменить'
};

const btn = (label, o) => {
  const opts = o || {};
  const symbolOnly = label && !/\p{L}/u.test(label);
  const iconOnly = !!opts.iconOnly || (!!opts.ico && symbolOnly);
  const name = opts.title || ICON_NAMES[label] || (iconOnly ? 'Действие' : '');
  const attrs = name ? ` title="${esc(name)}" aria-label="${esc(name)}"` : '';
  return `<span class="tv-btn ${opts.tone || ''} ${opts.size || ''} ${iconOnly ? 'icon' : ''}"${attrs}>${
    opts.ico ? icon(opts.ico) : ''
  }${iconOnly ? '' : esc(label)}</span>`;
};

const stat = (label, value, sub, tone) =>
  `<div class="tv-stat ${tone || ''}"><span class="tv-label">${esc(label)}</span><span class="tv-stat-v">${esc(
    value
  )}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;

const bar = (pct, tone, thick) =>
  `<span class="tv-bar ${tone || ''} ${thick ? 'thick' : ''}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

const panel = (title, sub, body, actions, cls) => `
  <section class="tv-panel ${cls || ''}">
    ${
      title
        ? `<header class="tv-panel-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${
            actions || ''
          }</header>`
        : ''
    }
    <div class="tv-panel-body">${body}</div>
  </section>`;

const select = (label, value, opts) =>
  `<label class="tv-field"><span>${esc(label)}</span><select class="tv-select">${opts
    .map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`)
    .join('')}</select></label>`;

/* Список настроек */
const setRow = (title, desc, control) =>
  `<div class="tv-setrow"><div class="grow"><strong>${esc(title)}</strong>${
    desc ? `<p>${esc(desc)}</p>` : ''
  }</div>${control || ''}</div>`;

const onOff = on => `<span class="tv-switch ${on ? 'on' : ''}"></span>`;

/* ─────────────────────────── навигация ─────────────────────────── */
const NAV = [
  { id: 'today', ico: 'i-home', title: 'Сегодня', sub: 'Сводка и важные действия' },
  { id: 'characters', ico: 'i-users', title: 'Персонажи', sub: 'Все аккаунты', count: 8 },
  { id: 'parties', ico: 'i-shield', title: 'Пати', sub: 'Запуск и окна игры', count: 4 },
  { id: 'marathons', ico: 'i-flag', title: 'Марафоны', sub: 'Задания и прогресс', count: 3 },
  { id: 'runes', ico: 'i-rune', title: 'Руны', sub: 'Подборки игроков' },
  { id: 'finance', ico: 'i-wallet', title: 'Банк', sub: 'Деньги и магазин' },
  { id: 'tools', ico: 'i-bolt', title: 'Инструменты', sub: 'Скрипты и окна игры' },
  { id: 'profile', ico: 'i-note', title: 'Профиль', sub: 'Один персонаж подробно' },
  { id: 'settings', ico: 'i-gear', title: 'Настройки', sub: 'Данные и приложение' }
];

const PAGES = {
  today: { title: 'Сегодня', sub: 'Важные действия, события и общая сводка.' },
  characters: { title: 'Персонажи', sub: 'Вход, баланс монет, характеристики и контакты.' },
  parties: { title: 'Пати', sub: 'Состав, порядок запуска, общий баланс и окна игры.' },
  marathons: { title: 'Марафоны', sub: 'Задания, прогресс персонажей и сверка с сайтом.' },
  runes: { title: 'Руны', sub: 'PvE, PvP и дополнительные варианты для каждого класса.' },
  finance: { title: 'Банк', sub: 'Приход и расход, комиссионный магазин и голд.' },
  tools: { title: 'Инструменты', sub: 'Скрипты, окна игры и состояние парсеров.' },
  profile: { title: 'Профиль персонажа', sub: 'Характеристики, контакты, запуск и история.' },
  settings: { title: 'Настройки', sub: 'Данные и резервные копии, запуск игры, уведомления.' }
};

/* ─────────────────────────── каркас по вариантам ─────────────────────────── */

/* A — «Студия»: вертикальный сайдбар с подписями */
function shellA(pageId) {
  const p = PAGES[pageId];
  return `
    <aside class="tv-side">
      <div class="tv-brand"><span class="tv-brand-mark">ТФ</span><div><strong>Твиноферма</strong><small>Управление аккаунтами</small></div></div>
      <nav class="tv-nav">
        ${NAV.map(
          n =>
            `<div class="tv-nav-item ${n.id === pageId ? 'on' : ''}">${icon(n.ico)}<div><strong>${esc(
              n.title
            )}</strong><small>${esc(n.sub)}</small></div>${n.count ? `<span class="tv-nav-count">${n.count}</span>` : ''}</div>`
        ).join('')}
      </nav>
      <div class="tv-side-bottom">
        <div class="tv-clock">${icon('i-clock')}${esc(D().now.msk)} МСК</div>
        <div class="tv-clock">${icon('i-server')}${D().serverStatus.filter(s => s.on).length} из ${
          D().serverStatus.length
        } серверов</div>
        <div class="tv-nav-item">${icon('i-gear')}<div><strong>Настройки</strong><small>Данные и приложение</small></div></div>
      </div>
    </aside>
    <div class="tv-main">
      <header class="tv-topbar">
        <div class="tv-page-title"><h1>${esc(p.title)}</h1><p>${esc(p.sub)}</p></div>
        <div class="tv-topbar-actions">${btn('❔ Как всё работает', { tone: 'ghost' })}${btn('Обновить', {
          ico: 'i-refresh',
          tone: 'ghost'
        })}</div>
      </header>
      <main class="tv-page">`;
}

/* B — «Пульт»: верхняя плотная навигация, моноширинные числа */
function shellB(pageId) {
  const p = PAGES[pageId];
  return `
    <div class="tv-main" style="grid-column:1/-1">
      <header class="tv-topbar" style="gap:10px;align-items:center;padding:10px 14px">
        <div class="tv-brand" style="padding:0 12px 0 0;border-right:1px solid var(--border)">
          <span class="tv-brand-mark">ТФ</span><div><strong>Твиноферма</strong></div>
        </div>
        <nav class="tv-nav row">
          ${NAV.map(
            n =>
              `<div class="tv-nav-item ${n.id === pageId ? 'on' : ''}">${icon(
                n.ico
              )}<div><strong>${esc(n.title)}</strong></div>${n.count ? `<span class="tv-nav-count">${n.count}</span>` : ''}</div>`
          ).join('')}
        </nav>
        <div class="tv-spacer"></div>
        <div class="tv-topbar-actions" style="padding:0">
          ${btn('Ctrl+K', { tone: 'ghost', size: 'sm' })}${btn('Обновить', { ico: 'i-refresh', tone: 'ghost', size: 'sm' })}
        </div>
      </header>
      <div style="display:flex;align-items:baseline;gap:12px;padding:12px 14px 0">
        <h1 style="margin:0;font-size:var(--fs-title);letter-spacing:-0.02em">${esc(p.title)}</h1>
        <span class="tv-muted tv-tiny">${esc(p.sub)}</span>
        <div class="tv-spacer"></div>
        <span class="tv-tiny tv-faint">${esc(D().now.date)} · ${esc(D().now.msk)} МСК</span>
      </div>
      <main class="tv-page" style="padding:14px;gap:14px">`;
}

/* C — «Светлый»: узкий рельс с иконками, крупная типографика */
function shellC(pageId) {
  const p = PAGES[pageId];
  return `
    <aside class="tv-side" style="width:74px;padding:16px 8px;align-items:center">
      <div class="tv-brand" style="padding:0 0 16px"><span class="tv-brand-mark">ТФ</span></div>
      <nav class="tv-nav" style="align-items:center">
        ${NAV.map(
          n =>
            `<div class="tv-nav-item ${n.id === pageId ? 'on' : ''}" title="${esc(
              n.title
            )}" style="justify-content:center;padding:9px 0">${icon(n.ico)}</div>`
        ).join('')}
      </nav>
      <div class="tv-side-bottom" style="align-items:center;width:100%">
        <div class="tv-clock" style="padding:0;justify-content:center">${icon('i-clock')}</div>
      </div>
    </aside>
    <div class="tv-main">
      <header class="tv-topbar" style="padding:26px 30px 18px;align-items:flex-end">
        <div class="tv-page-title">
          <span class="tv-label" style="color:var(--accent)">${esc(D().now.date)}</span>
          <h1 style="font-size:var(--fs-title);margin-top:6px">${esc(p.title)}</h1>
          <p>${esc(p.sub)}</p>
        </div>
        <div class="tv-topbar-actions">${btn('Как всё работает', { tone: 'ghost' })}${btn('Обновить', {
          ico: 'i-refresh',
          tone: 'ghost'
        })}</div>
      </header>
      <main class="tv-page" style="padding:0 30px 30px;gap:26px">`;
}

const SHELLS = { a: shellA, b: shellB, c: shellC };

/* ═══════════════════════════ СЕГОДНЯ ═══════════════════════════ */

const todayAttention = compact => `
  <div class="tv-feed">
    ${D()
      .attention.map(
        a => `
      <div class="tv-feed-item">
        <span class="tv-feed-ico ${a.tone}">${icon(a.tone === 'bad' ? 'i-warn' : 'i-clock')}</span>
        <div class="grow"><strong>${esc(a.title)}</strong><span class="tv-muted tv-tiny">${esc(a.desc)}</span></div>
        ${compact ? '' : btn(a.action, { tone: 'primary', size: 'sm' })}
      </div>`
      )
      .join('')}
  </div>`;

const todayTasks = () => `
  <div class="tv-list">
    ${D()
      .tasks.map(
        t => `
      <div class="tv-list-item">
        <span class="tv-check ${t.done ? 'on' : ''}">${t.done ? icon('i-check') : ''}</span>
        <div class="grow"><strong>${esc(t.title)}</strong><span class="tv-muted tv-tiny">${esc(t.time)} · ${esc(
          t.kind
        )}</span></div>
        ${chip(t.state, t.done ? 'ok' : t.state === 'В работе' ? 'warn' : '')}
      </div>`
      )
      .join('')}
  </div>`;

const todaySummary = () => {
  const total = D().characters.reduce((s, c) => s + c.coins, 0);
  return `<div class="tv-stats">
    ${stat('Древние монеты', total.toLocaleString('ru-RU'), 'сумма по всем', 'gold')}
    ${stat('Персонажей', String(D().characters.length), 'авторизованы: 4', 'accent')}
    ${stat('Скоро заканчиваются', '1', 'Летний марафон — 3 дня', 'warn')}
    ${stat('Пати', '3', 'в 2 — онлайн', 'violet')}
  </div>`;
};

const todayCalendar = () => `
  <div class="tv-cal" style="grid-template-columns:repeat(7,minmax(96px,1fr))">
    ${D()
      .calendar.map(
        d => `
      <div class="tv-cal-day ${d.today ? 'today' : ''}">
        <span class="d">${esc(d.day)} ${esc(d.date)}</span>
        ${d.items.map(i => `<span class="tv-cal-ev ${i.tone}">${esc(i.t)}</span>`).join('')}
      </div>`
      )
      .join('')}
  </div>`;

const todayVariants = {
  /* A — две колонки: календарь слева, сводка справа (как сейчас, но спокойнее) */
  a: () => `
    <div class="tv-cols side">
      <div class="tv-stack">
        ${panel('Календарь', 'Пн 19 — вс 25 октября · данж дня: Доспех', todayCalendar(), btn('Открыть день', { tone: 'ghost', size: 'sm' }))}
        ${panel('Задачи на день', 'Невыполненных: 3', todayTasks(), btn('＋ Добавить', { size: 'sm' }))}
      </div>
      <div class="tv-stack">
        ${panel('Требуют внимания', '3 действия', todayAttention(false), '', 'raised')}
        ${panel('Сводка', 'Важные действия, активные события и общие показатели', todaySummary())}
        ${panel('Клан Guild', 'Обновлено 5 мин назад', `<div class="tv-row"><span class="tv-chip ok">Ритм Гильдии · ср 19:30</span><span class="tv-chip">Битва Династий · пн 20:20</span></div>`, btn('Открыть сайт', { tone: 'ghost', size: 'sm' }))}
      </div>
    </div>`,

  /* B — «лента действий»: приоритеты сверху, всё в одну колонку, плотно */
  b: () => `
    <div class="tv-cols side-l" style="grid-template-columns:minmax(0,1fr) 300px">
      <div class="tv-stack">
        ${panel(
          'Требуют внимания',
          '3 действия · показано 3 из 3',
          todayAttention(true),
          btn('Проверить всё', { tone: 'primary', size: 'sm' }),
          'raised'
        )}
        <div class="tv-cols c2" style="gap:12px">
          ${panel('Задачи на день', 'Невыполненных: 3', todayTasks())}
          ${panel(
            'Клан Guild',
            'Обновлено 5 мин назад',
            `<div class="tv-list">
            <div class="tv-list-item"><span class="tv-dot ok"></span><div class="grow"><strong>Ритм Гильдии</strong><span class="tv-tiny tv-muted">ср 19:30–19:59</span></div></div>
            <div class="tv-list-item"><span class="tv-dot bad"></span><div class="grow"><strong>Битва Династий</strong><span class="tv-tiny tv-muted">пн, пт 20:20–22:20</span></div></div>
          </div>`
          )}
        </div>
        ${panel('Календарь · неделя', 'данж дня: Доспех', todayCalendar())}
      </div>
      <div class="tv-stack">
        ${panel('Сводка', '', todaySummary())}
        <div class="tv-card accent"><span class="tv-label">Ближайшее</span><div class="tv-num-lg">3 дня</div><p class="tv-muted tv-tiny" style="margin:0">до конца Летнего марафона</p></div>
        ${panel(
          'Серверы',
          'обновлено 5 мин назад',
          `<div class="tv-list">${D()
            .serverStatus.map(
              s =>
                `<div class="tv-list-item"><span class="tv-dot ${s.on ? 'ok' : 'bad'}"></span><div class="grow">${esc(s.name)}</div><span class="tv-tiny tv-muted">${s.on ? 'работает' : 'не работает'}</span></div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`,

  /* C — «плитки»: крупные блоки, минимум линий, воздух */
  c: () => `
    <div class="tv-cols c2" style="gap:22px;align-items:start">
      <div class="tv-stack" style="gap:22px">
        ${panel(
          'Требуют внимания',
          'Три действия, которые нельзя отложить',
          todayAttention(false),
          btn('Проверить всё', { tone: 'primary' }),
          'raised'
        )}
        ${panel('Задачи на день', 'Невыполненных: 3', todayTasks(), btn('＋ Добавить', { tone: 'ghost', size: 'sm' }))}
      </div>
      <div class="tv-stack" style="gap:22px">
        <div class="tv-card" style="background:linear-gradient(140deg,var(--accent-soft),transparent 65%),var(--surface)">
          <span class="tv-label">Сейчас</span>
          <div class="tv-num-lg" style="color:var(--accent)">Доспех</div>
          <p class="tv-muted" style="margin:0">Данж дня. Ближайшая полоса — неделя вперёд, цвет дня — его данж.</p>
          <div class="tv-row" style="margin-top:6px">
            ${['Вс 18', 'Пн 19', 'Вт 20', 'Ср 21', 'Чт 22', 'Пт 23', 'Сб 24']
              .map((d, i) => `<span class="tv-chip ${i === 1 ? 'accent' : ''}">${esc(d)}</span>`)
              .join('')}
          </div>
        </div>
        ${panel(
          'Календарь',
          'На неделю',
          `<div class="tv-list">${D()
            .calendar.map(
              d => `<div class="tv-list-item" style="padding:9px 0;${d.today ? 'color:var(--accent)' : ''}">
            <span class="tv-label" style="width:52px;${d.today ? 'color:var(--accent)' : ''}">${esc(d.day)} ${esc(d.date)}</span>
            <div class="grow" style="display:flex;gap:5px;flex-wrap:wrap">
              ${d.items.length ? d.items.map(i => `<span class="tv-cal-ev ${i.tone}" style="white-space:nowrap">${esc(i.t)}</span>`).join('') : '<span class="tv-tiny tv-faint">—</span>'}
            </div>
          </div>`
            )
            .join('')}</div>`
        )}
        ${panel('Сводка', '', todaySummary())}
      </div>
    </div>`
};

/* ═══════════════════════════ ПЕРСОНАЖИ ═══════════════════════════ */

const charFilters = dense => `
  <div class="tv-toolbar">
    <span class="tv-input" style="flex:1 1 190px;display:flex;align-items:center;gap:7px;color:var(--text-faint)">${icon(
      'i-search'
    )}Поиск по нику или #тегу…</span>
    ${select('', 'Все классы', ['Все классы', 'Воин', 'Маг', 'Жрец', 'Стрелок']).replace('<span></span>', '')}
    ${select('', 'Все пати', ['Все пати', 'Основа', 'Фарм-Крипта', 'Марафон', 'Без пати'])}
    ${select('', 'Все статусы', ['Все статусы', 'Только авторизованные', 'Только не авторизованные'])}
    ${select('', 'Все теги', ['Все теги', 'Без тегов', '#дд', '#фарм'])}
    ${select('', 'Без группировки', ['Без группировки', 'По пати', 'По классу'])}
    ${dense ? btn('⇅ Порядок…', { size: 'sm' }) : ''}
  </div>`;

const charStats = () => {
  const total = D().characters.reduce((s, c) => s + c.coins, 0);
  const on = D().characters.filter(c => c.online).length;
  return `<div class="tv-stats">
    ${stat('Персонажей в выборке', String(D().characters.length), '', 'accent')}
    ${stat('Авторизованы', String(on), '', 'ok')}
    ${stat('Нужен вход', String(D().characters.length - on), '', 'bad')}
    ${stat('Древние монеты', total.toLocaleString('ru-RU'), 'сумма в выборке', 'gold')}
    ${stat('Активных пати', '3', '', 'violet')}
    ${stat('Без пати', '2', '', '')}
  </div>`;
};

const charCard = c => `
  <article class="tv-card" style="gap:9px">
    <div class="tv-row" style="flex-wrap:nowrap;align-items:flex-start">
      ${ava(c.cls, 'lg')}
      <div class="grow" style="flex:1;min-width:0">
        <div class="tv-row" style="gap:6px;flex-wrap:nowrap">
          <strong style="font-size:15px">${esc(c.nick)}</strong>
          ${c.fav ? '<span class="tv-chip gold">★</span>' : ''}
        </div>
        <div class="tv-tiny tv-muted">${esc(c.cls)} · Ур. ${c.level} · ${esc(c.sky || 'Небо не выбрано')}</div>
        <div class="tv-tiny" style="color:var(--${c.online ? 'ok' : 'bad'})">${c.online ? '🟢 Онлайн' : '🔴 Нужен вход'}</div>
      </div>
    </div>
    <div class="tv-row" style="gap:5px">
      ${c.party ? chip(c.party, 'violet') : chip('Без пати')}
      ${chip('🪙 ' + c.coins.toLocaleString('ru-RU'), 'gold')}
      ${c.tags.map(t => chip('#' + t)).join('')}
    </div>
    <div class="tv-row" style="gap:12px;font-size:12px" >
      <span class="tv-muted">HP <b class="num">${c.stats.hp ? c.stats.hp.toLocaleString('ru-RU') : '—'}</b></span>
      <span class="tv-muted">PA <b class="num">${c.stats.pa || '—'}</b></span>
      <span class="tv-muted">PZ <b class="num">${c.stats.pz || '—'}</b></span>
      <span class="tv-muted">PvE <b class="num">${c.stats.pvePa || '—'}/${c.stats.pvePz || '—'}</b></span>
    </div>
    <div class="tv-row" style="gap:6px;margin-top:2px">
      ${btn('Играть', { ico: 'i-play', tone: 'primary', size: 'sm' })}
      ${btn('Сайт', { ico: 'i-globe', tone: 'ghost', size: 'sm' })}
      ${btn('Профиль', { ico: 'i-note', tone: 'ghost', size: 'sm' })}
      ${btn('В архив', { ico: 'i-archive', tone: 'ghost', size: 'sm' })}
    </div>
  </article>`;

const charactersVariants = {
  /* A — сетка карточек */
  a: () => `
    ${charFilters(false)}
    ${charStats()}
    <div class="tv-row"><span class="tv-label">Персонажи 8</span>${btn('Архив 2', { tone: 'ghost', size: 'sm' })}${btn(
      '💡 С чего начать',
      { tone: 'ghost', size: 'sm' }
    )}</div>
    <div class="tv-cols c3" style="gap:16px">${D().characters.map(charCard).join('')}</div>`,

  /* B — плотная таблица */
  b: () => `
    ${charFilters(true)}
    ${charStats()}
    <div class="tv-row"><span class="tv-label">Персонажи 8 · сортировка: по нику</span><div class="tv-spacer"></div>${btn(
      'Архив 2',
      { tone: 'ghost', size: 'sm' }
    )}</div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr>
          <th>Ник</th><th>Класс</th><th class="num">Ур.</th><th>Пати</th><th>Статус</th>
          <th class="num">HP</th><th class="num">PA</th><th class="num">PZ</th><th class="num">PvE</th>
          <th class="num">Монеты</th><th>Проходки</th><th></th>
        </tr></thead>
        <tbody>
          ${D()
            .characters.map(
              c => `<tr>
            <td><div class="tv-row" style="gap:7px;flex-wrap:nowrap">${ava(c.cls, 'sm')}<strong>${esc(c.nick)}</strong>${c.tags
              .map(t => `<span class="tv-chip">#${esc(t)}</span>`)
              .join('')}</div></td>
            <td>${esc(c.cls)}</td>
            <td class="num">${c.level}</td>
            <td>${c.party ? esc(c.party) : '<span class="tv-faint">—</span>'}</td>
            <td><span class="tv-dot ${c.online ? 'ok' : 'bad'}"></span> <span class="tv-tiny">${
              c.online ? 'онлайн' : 'нужен вход'
            }</span></td>
            <td class="num">${c.stats.hp ? c.stats.hp.toLocaleString('ru-RU') : '—'}</td>
            <td class="num">${c.stats.pa || '—'}</td>
            <td class="num">${c.stats.pz || '—'}</td>
            <td class="num">${c.stats.pvePa || '—'}/${c.stats.pvePz || '—'}</td>
            <td class="num">${c.coins.toLocaleString('ru-RU')}</td>
            <td class="tv-tiny tv-muted">${c.passes.weapon}/${c.passes.armor}/${c.passes.relic}</td>
            <td class="rowact">${btn('▶', { ico: 'i-play', tone: 'ghost', size: 'sm' })}${btn('🌐', {
              ico: 'i-globe',
              tone: 'ghost',
              size: 'sm'
            })}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`,

  /* C — реестр-строки + инспектор справа */
  c: () => `
    ${charFilters(false)}
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 340px">
      <div class="tv-stack">
        ${charStats()}
        <div class="tv-panel"><div class="tv-panel-body tight">
          ${D()
            .characters.map(
              c => `<div class="tv-list-item" style="padding:12px 0">
                ${ava(c.cls)}
                <div class="grow">
                  <strong>${esc(c.nick)}</strong>
                  <span class="tv-tiny tv-muted">${esc(c.cls)} · Ур. ${c.level} · ${esc(c.sky || '—')}</span>
                </div>
                <span class="tv-tiny ${c.online ? '' : 'tv-faint'}" style="color:${c.online ? 'var(--ok)' : 'var(--bad)'}">${
                  c.online ? 'онлайн' : 'нужен вход'
                }</span>
                <span class="tv-chip gold">🪙 ${c.coins.toLocaleString('ru-RU')}</span>
                ${c.party ? chip(c.party) : ''}
                ${btn('', { ico: 'i-play', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Играть' })}
                ${btn('', { ico: 'i-globe', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Открыть сайт' })}
              </div>`
            )
            .join('')}
        </div></div>
      </div>
      <div class="tv-stack">
        <div class="tv-card raised">
          <div class="tv-row" style="flex-wrap:nowrap;gap:11px">${ava('Воин', 'lg')}<div>
            <strong style="font-size:16px">Ауразак</strong>
            <div class="tv-tiny tv-muted">Воин · Ур. 105 · Небо предела (10)</div>
          </div></div>
          <hr class="tv-hr"/>
          <dl class="tv-kv">
            <dt>Пати</dt><dd>Основа</dd>
            <dt>Статус</dt><dd style="color:var(--ok)">🟢 Онлайн</dd>
            <dt>Монеты</dt><dd class="num">2 850</dd>
            <dt>Проходки</dt><dd>4 / 2 / 1</dd>
          </dl>
          <div class="tv-row">${btn('Играть', { ico: 'i-play', tone: 'primary' })}${btn('Подробнее', { tone: 'ghost' })}</div>
        </div>
        ${panel(
          'Массовые действия',
          'Режим выбора',
          `<div class="tv-row">${btn('Проверить вход', { size: 'sm' })}${btn('Балансы', {
            size: 'sm'
          })}${btn('Запустить', { size: 'sm' })}</div>`
        )}
      </div>
    </div>`
};

/* ═══════════════════════════ ПАТИ ═══════════════════════════ */

const partyCard = p => {
  const members = p.members.map(n => D().characters.find(c => c.nick === n)).filter(Boolean);
  return `
  <article class="tv-card" style="gap:10px;border-left:3px solid ${p.color}">
    <div class="tv-row" style="flex-wrap:nowrap">
      <span class="tv-ava" style="background:${p.color}">${esc(p.name.slice(0, 2).toUpperCase())}</span>
      <div class="grow" style="flex:1;min-width:0">
        <h3 style="margin:0">${esc(p.name)}</h3>
        <div class="tv-tiny tv-muted">${p.members.length} чел.${p.archived ? ' · ' + p.archived + ' в архиве' : ''} · онлайн ${
          p.online
        }</div>
      </div>
      <span class="tv-chip gold">🪙 ${p.coins.toLocaleString('ru-RU')}</span>
    </div>
    <div class="tv-row" style="gap:8px">
      <div class="tv-ava-stack">${members.map(m => ava(m.cls, 'sm')).join('')}</div>
      <span class="tv-tiny tv-muted" style="flex:1">${esc(p.members.join(', '))}</span>
    </div>
    ${bar(Math.round((p.online / p.members.length) * 100), 'ok')}
    <div class="tv-row" style="gap:6px">
      ${btn(`▶ Запустить ${p.ready}/${p.members.length}`, { ico: 'i-play', tone: 'primary', size: 'sm' })}
      ${btn('', { ico: 'i-stop', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Закрыть окна' })}
      ${btn('', { ico: 'i-gear', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Настройки пати' })}
    </div>
    <hr class="tv-hr"/>
    <div class="tv-list">
      ${members
        .map(
          (m, i) => `<div class="tv-list-item" style="padding:7px 0">
        <span class="tv-tiny tv-faint num" style="width:16px">${i + 1}</span>
        ${ava(m.cls, 'sm')}
        <div class="grow"><strong>${esc(m.nick)}</strong><span class="tv-tiny tv-muted">${esc(m.cls)}</span></div>
        <span class="tv-dot ${m.online ? 'ok' : 'bad'}"></span>
      </div>`
        )
        .join('')}
    </div>
  </article>`;
};

const partiesVariants = {
  a: () => `
    <div class="tv-row">
      ${chip('👥 Персонажей 8')}${chip('🛡 Пати 3')}${chip('🪙 20 040', 'gold')}${chip('В нескольких пати: 2')}
      <div class="tv-spacer"></div>${btn('Пати 3', { tone: 'primary', size: 'sm' })}${btn('Архив 1', { tone: 'ghost', size: 'sm' })}
    </div>
    <div class="tv-cols c2" style="gap:16px">${D().parties.map(partyCard).join('')}</div>`,

  b: () => `
    <div class="tv-row" style="gap:14px">
      <span class="tv-label">Пати</span>
      ${chip('персонажей 8')}${chip('групп 3')}${chip('монет 20 040', 'gold')}${chip('в 2 пати 2')}
      <div class="tv-spacer"></div>${btn('Архив 1', { tone: 'ghost', size: 'sm' })}
    </div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr>
          <th></th><th>Пати</th><th class="num">Состав</th><th class="num">Онлайн</th>
          <th class="num">Монеты</th><th>Порядок запуска</th><th>Готовы</th><th></th>
        </tr></thead>
        <tbody>
          ${D()
            .parties.map(
              p => `<tr>
            <td style="width:4px;padding:0"><span style="display:block;width:4px;height:34px;background:${p.color};border-radius:2px"></span></td>
            <td><strong>${esc(p.name)}</strong></td>
            <td class="num">${p.members.length}</td>
            <td class="num">${p.online}</td>
            <td class="num">${p.coins.toLocaleString('ru-RU')}</td>
            <td class="tv-tiny tv-muted">${esc(p.members.join(' → '))}</td>
            <td class="num">${p.ready}/${p.members.length}</td>
            <td class="rowact">${btn('▶', { ico: 'i-play', tone: 'primary', size: 'sm' })}${btn('⚙', { ico: 'i-gear', tone: 'ghost', size: 'sm' })}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="tv-cols c2" style="gap:12px">
      ${panel(
        'Окна игры',
        'Клиенты, запущенные на этом компьютере',
        `<div class="tv-list">${D()
          .windows.map(
            w =>
              `<div class="tv-list-item"><span class="tv-dot ${w.known ? 'ok' : ''}"></span><div class="grow"><strong>${esc(
                w.label
              )}</strong><span class="tv-tiny tv-muted">работает ${esc(w.up)}${w.admin ? ' · админ' : ''}</span></div>${btn(
                'Закрыть',
                { tone: 'ghost', size: 'sm' }
              )}</div>`
          )
          .join('')}</div>`
      )}
      ${panel(
        'Состав «Основа»',
        'перетащите, чтобы изменить порядок запуска',
        `<div class="tv-list">${D()
          .parties[0].members.map(
            (n, i) =>
              `<div class="tv-list-item"><span class="tv-tiny tv-faint" style="width:14px">⠿</span><span class="tv-tiny num tv-faint" style="width:14px">${
                i + 1
              }</span><div class="grow"><strong>${esc(n)}</strong></div><span class="tv-chip">доп.</span></div>`
          )
          .join('')}</div>`
      )}
    </div>`,

  c: () => `
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 320px">
      <div class="tv-stack">
        <div class="tv-card raised" style="border-left:4px solid ${D().parties[0].color}">
          <div class="tv-row" style="flex-wrap:nowrap">
            <span class="tv-ava lg" style="background:${D().parties[0].color}">ОС</span>
            <div class="grow" style="flex:1">
              <span class="tv-label">Основная пати</span>
              <h3 style="margin:2px 0 0;font-size:20px">${esc(D().parties[0].name)}</h3>
              <p class="tv-muted tv-tiny" style="margin:2px 0 0">${D().parties[0].members.length} чел. · онлайн ${
                D().parties[0].online
              } · 🪙 ${D().parties[0].coins.toLocaleString('ru-RU')}</p>
            </div>
            ${btn('▶ Запустить 2/4', { ico: 'i-play', tone: 'primary' })}
          </div>
          <hr class="tv-hr"/>
          <div class="tv-list">
            ${D()
              .parties[0].members.map((n, i) => {
                const m = D().characters.find(c => c.nick === n);
                return `<div class="tv-list-item" style="padding:9px 0">
              <span class="tv-num" style="width:20px;color:var(--text-faint)">${i + 1}</span>
              ${ava(m.cls)}
              <div class="grow"><strong>${esc(n)}</strong><span class="tv-tiny tv-muted">${esc(m.cls)} · Ур. ${m.level}</span></div>
              <span class="tv-chip ${m.online ? 'ok' : 'bad'}">${m.online ? 'онлайн' : 'нет входа'}</span>
              ${btn('', { ico: 'i-note', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Профиль персонажа' })}
            </div>`;
              })
              .join('')}
          </div>
        </div>
        ${D()
          .parties.slice(1)
          .map(
            p => `<div class="tv-card" style="border-left:4px solid ${p.color}">
          <div class="tv-row" style="flex-wrap:nowrap">
            <span class="tv-ava" style="background:${p.color}">${esc(p.name.slice(0, 2).toUpperCase())}</span>
            <div class="grow" style="flex:1"><strong>${esc(p.name)}</strong>
            <div class="tv-tiny tv-muted">${p.members.length} чел. · онлайн ${p.online} · 🪙 ${p.coins.toLocaleString(
              'ru-RU'
            )}</div></div>
            ${btn('▶ Запустить', { ico: 'i-play', tone: 'ghost', size: 'sm' })}
            ${btn('', { ico: 'i-gear', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Настройки пати' })}
          </div>
        </div>`
          )
          .join('')}
      </div>
      <div class="tv-stack">
        ${panel(
          'Сводка',
          '',
          `<div class="tv-stats" style="grid-template-columns:1fr 1fr">
          ${stat('Персонажей', '8')}${stat('Пати', '3')}${stat('Монет', '20 040', '', 'gold')}${stat('В 2 пати', '2')}
        </div>`
        )}
        ${panel(
          'Окна игры',
          '',
          `<div class="tv-list">${D()
            .windows.map(
              w =>
                `<div class="tv-list-item"><span class="tv-dot ${w.known ? 'ok' : ''}"></span><div class="grow"><strong>${esc(
                  w.label
                )}</strong><span class="tv-tiny tv-muted">${esc(w.up)}</span></div>${btn('Закрыть', {
                  tone: 'ghost',
                  size: 'sm'
                })}</div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`
};

/* ═══════════════════════════ МАРАФОНЫ ═══════════════════════════ */

const marathonCard = m => {
  const tone = m.phase === 'active' ? 'accent' : m.phase === 'upcoming' ? '' : m.phase === 'ended' ? 'warn' : 'violet';
  const status = {
    active: 'Идёт',
    upcoming: 'Скоро',
    ended: 'Ждёт завершения',
    completed: 'Завершён',
    series: 'Папка'
  }[m.phase];
  return `
  <article class="tv-card" style="gap:9px">
    <div class="tv-row" style="flex-wrap:nowrap;align-items:flex-start">
      <div class="grow" style="flex:1;min-width:0">
        <h4>${esc(m.title)}</h4>
        <div class="tv-tiny tv-muted">📅 ${esc(m.from)} — ${esc(m.to)} · ${esc(m.hint)}</div>
      </div>
      ${chip(status, tone)}
    </div>
    ${bar(pct(m.done, m.total), m.late ? 'warn' : 'ok', true)}
    <div class="tv-kv" style="gap:2px 10px">
      <dt>Выполнено</dt><dd class="num">${m.done}/${m.total}</dd>
      ${m.late ? `<dt>Не успевают</dt><dd class="num" style="color:var(--bad)">${m.late}</dd>` : ''}
      <dt>Участники</dt><dd class="num">${m.participants}</dd>
      <dt>Заданий</dt><dd class="num">${m.tasks}</dd>
      <dt>Заработано</dt><dd class="num" style="color:var(--gold)">🪙 ${m.coins.toLocaleString('ru-RU')} / ${m.coinsTotal.toLocaleString('ru-RU')}</dd>
    </div>
    <div class="tv-row" style="gap:6px">
      ${btn('Сверить с сайтом', { ico: 'i-refresh', tone: 'primary', size: 'sm' })}
      ${btn('Открыть', { tone: 'ghost', size: 'sm' })}
      <span class="tv-spacer"></span>
      ${chip('🔄 ' + m.sync, m.stale ? 'warn' : 'ok')}
    </div>
  </article>`;
};

const marathonsVariants = {
  a: () => `
    <div class="tv-row">
      ${chip('Идут 1')}${chip('Ждут завершения 1')}${chip('Скоро 1')}${chip('Завершённые 0')}${chip('🪙 5 250 заработано', 'gold')}
      <div class="tv-spacer"></div>${btn('＋ Марафон', { tone: 'primary', size: 'sm' })}${btn('📁 Папка', { tone: 'ghost', size: 'sm' })}
    </div>
    <div class="tv-kanban">
      <div class="tv-kb-col"><div class="tv-kb-head"><span>⏳ Ждут завершения</span><span>1</span></div>${D()
        .marathons.filter(m => m.phase === 'ended')
        .map(marathonCard)
        .join('')}</div>
      <div class="tv-kb-col"><div class="tv-kb-head"><span>🏃 Идут</span><span>1</span></div>${D()
        .marathons.filter(m => m.phase === 'active')
        .map(marathonCard)
        .join('')}</div>
      <div class="tv-kb-col"><div class="tv-kb-head"><span>🕐 Скоро</span><span>1</span></div>${D()
        .marathons.filter(m => m.phase === 'upcoming')
        .map(marathonCard)
        .join('')}</div>
      <div class="tv-kb-col"><div class="tv-kb-head"><span>📁 Папки</span><span>1</span></div>${D()
        .marathons.filter(m => m.phase === 'series')
        .map(marathonCard)
        .join('')}</div>
    </div>`,

  b: () => `
    <div class="tv-row" style="gap:10px">
      <span class="tv-label">Марафоны</span>
      ${chip('все 4')}${chip('идут 1')}${chip('скоро 1')}${chip('жд��т 1')}${chip('заработано 5 250', 'gold')}
      <div class="tv-spacer"></div>${btn('Сверить все', { ico: 'i-refresh', tone: 'primary', size: 'sm' })}
    </div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr><th>Марафон</th><th>Период</th><th>Статус</th><th style="width:130px">Прогресс</th><th class="num">Готово</th><th class="num">Не успевают</th><th class="num">Участники</th><th class="num">Заработано</th><th>Свежесть</th><th></th></tr></thead>
        <tbody>${D()
          .marathons.map(m => {
            const status = { active: 'Идёт', upcoming: 'Скоро', ended: 'Ждёт завершения', series: 'Папка' }[m.phase];
            return `<tr>
            <td><strong>${esc(m.title)}</strong><div class="tv-tiny tv-muted">${esc(m.hint)}</div></td>
            <td class="tv-tiny">${esc(m.from)} — ${esc(m.to)}</td>
            <td>${chip(status, m.phase === 'active' ? 'accent' : m.phase === 'ended' ? 'warn' : '')}</td>
            <td>${bar(pct(m.done, m.total), m.late ? 'warn' : 'ok')}</td>
            <td class="num">${m.done}/${m.total}</td>
            <td class="num">${m.late || '—'}</td>
            <td class="num">${m.participants || '—'}</td>
            <td class="num">${m.coins.toLocaleString('ru-RU')}</td>
            <td class="tv-tiny">${chip(m.sync, m.stale ? 'warn' : 'ok')}</td>
            <td class="rowact">${btn('🔄', { ico: 'i-refresh', tone: 'ghost', size: 'sm' })}</td>
          </tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>
    ${panel(
      'Матрица «персонаж × задание»',
      'Летний марафон · состояние на сегодня, 08:41',
      `<div class="tv-table-wrap" style="border:0"><table class="tv-matrix">
        <thead><tr><th>Персонаж</th>${D()
          .marathonMatrix.tasks.map(t => `<th>${esc(t)}</th>`)
          .join('')}<th>Итого</th></tr></thead>
        <tbody>${D()
          .marathonMatrix.rows.map(
            r => `<tr>
          <td><div class="tv-row" style="gap:6px;flex-wrap:nowrap">${ava(r.cls, 'sm')}<strong>${esc(r.nick)}</strong></div></td>
          ${r.cells
            .map(
              (c, i) =>
                `<td><span class="tv-cell"><b class="num" style="color:var(--${
                  r.state[i] === 'ok'
                    ? 'ok'
                    : r.state[i] === 'warn'
                      ? 'warn'
                      : r.state[i] === 'bad'
                        ? 'bad'
                        : 'text-faint'
                })">${esc(c)}</b><small>${r.state[i] === 'idle' ? 'не начался' : r.state[i] === 'ok' ? 'выполнено' : r.state[i] === 'warn' ? 'запас 1 дн.' : 'не успевает'}</small></span></td>`
            )
            .join('')}
          <td class="num">${r.cells.filter(c => c !== '—').length}/3</td>
        </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      btn('Сверить с сайтом', { ico: 'i-refresh', tone: 'primary', size: 'sm' })
    )}`,

  c: () => `
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 320px">
      <div class="tv-stack">
        <div class="tv-card raised">
          <span class="tv-label">Идут сейчас</span>
          <h3 style="margin:4px 0 2px;font-size:21px">${esc(D().marathons[0].title)}</h3>
          <p class="tv-muted tv-tiny" style="margin:0">📅 ${D().marathons[0].from} — ${D().marathons[0].to} · ${
            D().marathons[0].hint
          }</p>
          ${bar(pct(D().marathons[0].done, D().marathons[0].total), 'warn', true)}
          <div class="tv-row" style="gap:16px;margin-top:4px">
            ${stat('Выполнено', D().marathons[0].done + '/' + D().marathons[0].total, '', 'ok')}
            ${stat('Не успевают', String(D().marathons[0].late), 'запас дней исчерпан', 'bad')}
            ${stat('Заработано', '🪙 ' + D().marathons[0].coins.toLocaleString('ru-RU'), 'из ' + D().marathons[0].coinsTotal.toLocaleString('ru-RU'), 'gold')}
          </div>
          <div class="tv-row" style="margin-top:4px">
            ${btn('Сверить с сайтом', { ico: 'i-refresh', tone: 'primary' })}${btn('Завершить', { tone: 'ghost' })}${btn(
              'Переместить в папку',
              {
                tone: 'ghost'
              }
            )}
          </div>
        </div>
        ${panel(
          'Кто отстаёт',
          'Летний марафон · 2 персонажа',
          `<div class="tv-list">
          <div class="tv-list-item">${ava('Маг', 'sm')}<div class="grow"><strong>Мираж_77</strong><span class="tv-tiny tv-muted">вход 3/10 · подземелья 5/10</span></div>${chip('не успевает', 'bad')}</div>
          <div class="tv-list-item">${ava('Бард', 'sm')}<div class="grow"><strong>Ночной_Бард</strong><span class="tv-tiny tv-muted">вход 5/10 · остальное не начато</span></div>${chip('запас 1 дн.', 'warn')}</div>
        </div>`
        )}
        ${panel(
          'Все марафоны',
          '',
          `<div class="tv-list">${D()
            .marathons.map(
              m =>
                `<div class="tv-list-item"><div class="grow"><strong>${esc(m.title)}</strong><span class="tv-tiny tv-muted">${esc(
                  m.from
                )} — ${esc(m.to)}</span></div>${chip(
                  { active: 'Идёт', upcoming: 'Скоро', ended: 'Ждёт', series: 'Папка' }[m.phase],
                  m.phase === 'active' ? 'accent' : ''
                )}${btn('Открыть', { tone: 'ghost', size: 'sm' })}</div>`
            )
            .join('')}</div>`
        )}
      </div>
      <div class="tv-stack">
        ${panel(
          'Сверка с сайтом',
          'Последняя — сегодня, 08:41',
          `<div class="tv-list">
          <div class="tv-list-item"><span class="tv-dot ok"></span><div class="grow"><strong>Завершено</strong><span class="tv-tiny tv-muted">18 из 30</span></div></div>
          <div class="tv-list-item"><span class="tv-dot bad"></span><div class="grow"><strong>Ошибок</strong><span class="tv-tiny tv-muted">1</span></div></div>
          <div class="tv-list-item"><span class="tv-dot warn"></span><div class="grow"><strong>Предупреждений</strong><span class="tv-tiny tv-muted">3</span></div></div>
        </div>`,
          btn('Сверить с сайтом', { ico: 'i-refresh', tone: 'primary', size: 'sm' })
        )}
        ${panel(
          'Награды',
          'За максимальный достигнутый порог',
          `<div class="tv-list">
          <div class="tv-list-item"><div class="grow"><strong>Ежедневный вход</strong><span class="tv-tiny tv-muted">порог 10</span></div>${chip('🪙 500', 'gold')}</div>
          <div class="tv-list-item"><div class="grow"><strong>Летний ларец</strong><span class="tv-tiny tv-muted">за 4 выполненных задания</span></div>${chip('бонус', 'violet')}</div>
        </div>`
        )}
      </div>
    </div>`
};

/* ═══════════════════════════ РУНЫ ═══════════════════════════ */

const runesVariants = {
  a: () => `
    <div class="tv-row">
      <span class="tv-label">Каталог сообщества</span>
      ${chip('Обновлено сегодня, 09:12', 'ok')}
      <div class="tv-spacer"></div>
      ${select('', 'Все классы', ['Все классы', 'Воин', 'Маг', 'Жрец', 'Стрелок', 'Бард', 'Призрак', 'Лучник', 'Страж'])}
      ${btn('Обновить', { ico: 'i-refresh', tone: 'ghost', size: 'sm' })}
      ${btn('Предложить раскладку', { tone: 'primary', size: 'sm' })}
    </div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr><th>Дата</th><th>Автор</th><th>Класс</th><th>PvE руны</th><th>PvP руны</th><th>Благословение</th><th>Примечание</th></tr></thead>
        <tbody>${D()
          .runes.map(
            r => `<tr>
          <td class="tv-tiny">${esc(r.date)}</td>
          <td>${esc(r.author)}</td>
          <td><div class="tv-row" style="gap:6px;flex-wrap:nowrap">${ava(r.cls, 'sm')}${esc(r.cls)}</div></td>
          <td><span class="tv-code">${esc(r.pve)} ${icon('i-copy')}</span></td>
          <td><span class="tv-code">${esc(r.pvp)} ${icon('i-copy')}</span></td>
          <td><span class="tv-code">${esc(r.extra)} ${icon('i-copy')}</span></td>
          <td class="tv-tiny tv-muted">${esc(r.note || '—')}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table>
    </div>
    <p class="tv-muted tv-tiny">Предложения попадут на проверку и появятся в каталоге после одобрения.</p>`,

  b: () => `
    <div class="tv-row" style="gap:10px">
      <span class="tv-input" style="display:flex;align-items:center;gap:7px;color:var(--text-faint);width:220px">${icon(
        'i-search'
      )}Поиск по коду</span>
      ${select('', 'Все классы', ['Все классы', 'Воин', 'Маг', 'Жрец'])}
      ${chip('6 записей')}${chip('каталог GitHub', 'ok')}
      <div class="tv-spacer"></div>${btn('Обновить', { ico: 'i-refresh', tone: 'ghost', size: 'sm' })}
    </div>
    <div class="tv-table-wrap">
      <table class="tv-table" style="font-family:var(--mono,monospace);font-size:12px">
        <thead><tr><th>Дата</th><th>Автор</th><th>Класс</th><th>PvE</th><th>PvP</th><th>Благословение</th><th></th></tr></thead>
        <tbody>${D()
          .runes.map(
            r => `<tr>
          <td style="color:var(--text-faint)">${esc(r.date)}</td>
          <td>${esc(r.author)}</td>
          <td style="color:var(--accent)">${esc(r.cls)}</td>
          <td>${esc(r.pve)}</td>
          <td>${esc(r.pvp)}</td>
          <td style="color:var(--text-faint)">${esc(r.extra)}</td>
          <td>${btn('⧉', { ico: 'i-copy', tone: 'ghost', size: 'sm' })}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table>
    </div>
    <div class="tv-row">${btn('Предложить раскладку', { tone: 'primary', size: 'sm' })}<span class="tv-tiny tv-muted">Ctrl+Enter — отправить</span></div>`,

  c: () => `
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 300px">
      <div class="tv-stack">
        <div class="tv-card raised">
          <div class="tv-row" style="flex-wrap:nowrap;gap:12px">${ava('Лучник', 'lg')}<div class="grow" style="flex:1">
            <h3 style="margin:0;font-size:19px">Лучник</h3>
            <p class="tv-muted tv-tiny" style="margin:2px 0 0">Автор Соколий_Взор · 18.10 · Проверено на боссе</p>
          </div>${btn('В избранное', { tone: 'ghost', size: 'sm' })}</div>
          <hr class="tv-hr"/>
          <div class="tv-stack" style="gap:12px">
            <div><span class="tv-label">PvE руны</span><div class="tv-code" style="margin-top:5px">${esc(
              D().runes[0].pve
            )}${btn('⧉', { ico: 'i-copy', tone: 'ghost', size: 'sm' })}</div></div>
            <div><span class="tv-label">PvP руны</span><div class="tv-code" style="margin-top:5px">${esc(
              D().runes[0].pvp
            )}${btn('⧉', { ico: 'i-copy', tone: 'ghost', size: 'sm' })}</div></div>
            <div><span class="tv-label">Благословение белой Владычицы</span><div class="tv-code" style="margin-top:5px">${esc(
              D().runes[0].extra
            )}${btn('⧉', { ico: 'i-copy', tone: 'ghost', size: 'sm' })}</div></div>
          </div>
        </div>
        ${panel(
          'Другие раскладки этого класса',
          '',
          `<div class="tv-list">
          <div class="tv-list-item"><div class="grow"><strong>Лучник · 02.10</strong><span class="tv-tiny tv-muted">Каменный_Ган · Фарм-вариант</span></div>${btn('Открыть', { tone: 'ghost', size: 'sm' })}</div>
        </div>`
        )}
      </div>
      <div class="tv-stack">
        ${panel(
          'Классы',
          '6 из 18',
          `<div class="tv-list">${D()
            .runes.map(
              r =>
                `<div class="tv-list-item" style="padding:7px 0">${ava(r.cls, 'sm')}<div class="grow">${esc(
                  r.cls
                )}</div><span class="tv-tiny tv-muted">${esc(r.date)}</span></div>`
            )
            .join('')}</div>`
        )}
        ${btn('Предложить раскладку', { tone: 'primary' })}
      </div>
    </div>`
};

/* ═══════════════════════════ БАНК ═══════════════════════════ */

const financeVariants = {
  a: () => `
    <div class="tv-row">
      ${btn('＋ Записать движение', { tone: 'primary', size: 'sm' })}${btn('💰 Голд', { tone: 'ghost', size: 'sm' })}${btn(
        '🤝 Долг',
        {
          tone: 'ghost',
          size: 'sm'
        }
      )}
      <span class="tv-spacer"></span>
      <span class="tv-input" style="display:flex;align-items:center;gap:7px;color:var(--text-faint);width:220px">${icon(
        'i-search'
      )}Поиск по источнику…</span>
    </div>
    <div class="tv-stats">${D()
      .finance.kpis.map(k => stat(k.label, k.value, k.sub, k.tone))
      .join('')}</div>
    <div class="tv-cols side" style="grid-template-columns:210px minmax(0,1fr) 280px">
      <div class="tv-stack">
        ${panel(
          'Месяцы',
          '',
          `<div class="tv-list">${D()
            .finance.months.map(
              (m, i) => `<div class="tv-list-item" style="padding:8px 0;${i ? '' : 'color:var(--accent)'}">
          <div class="grow"><strong style="${i ? '' : 'color:var(--accent)'}">${esc(m.name)}</strong><span class="tv-tiny tv-muted">${m.count} записей</span></div>
          <span class="tv-tiny num">${esc(m.gold)}</span>
        </div>`
            )
            .join('')}</div>`
        )}
      </div>
      <div class="tv-stack">
        ${panel(
          'Журнал · октябрь 2026',
          '24 записи',
          `<div class="tv-toolbar" style="margin-bottom:4px">
            ${chip('Все')}${chip('Ручные')}${chip('Комиссионка')}${chip('Голд')}${chip('Долг')}
            <div class="tv-spacer"></div>${chip('Итог ✓')}
          </div>
          <div class="tv-table-wrap" style="border:0">
            <table class="tv-table">
              <thead><tr><th>Дата</th><th>Вид</th><th>Откуда / на что</th><th class="num">Сумма</th><th class="num">Итог</th></tr></thead>
              <tbody>${D()
                .finance.entries.map(
                  e => `<tr>
                <td class="tv-tiny">${esc(e.date)}</td>
                <td>${chip(e.kind, e.kind === 'Получил' ? 'ok' : 'bad')}<span class="tv-tiny tv-muted"> ${esc(e.source)}</span></td>
                <td>${esc(e.who)}</td>
                <td class="num" style="color:${e.sum[0] === '+' ? 'var(--ok)' : 'var(--bad)'}">${esc(e.sum)}</td>
                <td class="num tv-muted">${esc(e.total)}</td>
              </tr>`
                )
                .join('')}</tbody>
            </table>
          </div>`
        )}
      </div>
      <div class="tv-stack">
        ${panel(
          'Комиссионка',
          'продаю / покупаю',
          `<div class="tv-stack" style="gap:10px">
          <div><span class="tv-label">Продажа</span><div class="tv-list">${D()
            .finance.shop.sell.map(
              s =>
                `<div class="tv-list-item" style="padding:6px 0"><div class="grow">${esc(s)}</div>${chip('×12', 'gold')}</div>`
            )
            .join('')}</div></div>
          <div><span class="tv-label">Покупка</span><div class="tv-list">${D()
            .finance.shop.buy.map(
              s =>
                `<div class="tv-list-item" style="padding:6px 0"><div class="grow">${esc(s)}</div>${chip('×1', 'violet')}</div>`
            )
            .join('')}</div></div>
        </div>`
        )}
        ${panel(
          'Долги',
          '',
          `<div class="tv-list">${D()
            .finance.loans.map(
              l => `<div class="tv-list-item" style="padding:8px 0;flex-wrap:wrap">
          <div class="grow"><strong>${esc(l.who)}</strong><span class="tv-tiny tv-muted">${esc(l.meta)}</span></div>
          ${chip(l.sum, l.dir === 'Дано' ? 'ok' : 'bad')}
        </div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`,

  b: () => `
    <div class="tv-row" style="gap:8px">
      <span class="tv-label">Журнал</span>
      ${chip('октябрь 2026')}${chip('сентябрь 2026')}${chip('август 2026')}
      <div class="tv-spacer"></div>
      ${btn('＋ Записать движение', { tone: 'primary', size: 'sm' })}${btn('Голд', { size: 'sm' })}${btn('Долг', { size: 'sm' })}
    </div>
    <div class="tv-stats" style="grid-template-columns:repeat(4,1fr)">${D()
      .finance.kpis.map(k => stat(k.label, k.value, k.sub, k.tone))
      .join('')}</div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr><th>Дата</th><th>Вид</th><th>Источник</th><th>Откуда / на что</th><th class="num">Золото</th><th class="num">Голд</th><th class="num">Итог</th><th></th></tr></thead>
        <tbody>${D()
          .finance.entries.map(
            e => `<tr>
          <td class="tv-tiny">${esc(e.date)}</td>
          <td>${chip(e.kind, e.kind === 'Получил' ? 'ok' : 'bad')}</td>
          <td class="tv-tiny tv-muted">${esc(e.source)}</td>
          <td>${esc(e.who)}</td>
          <td class="num" style="color:${e.sum[0] === '+' ? 'var(--ok)' : 'var(--bad)'}">${esc(e.sum)}</td>
          <td class="num">—</td>
          <td class="num tv-muted">${esc(e.total)}</td>
          <td class="rowact">${btn('✎', { ico: 'i-edit', tone: 'ghost', size: 'sm' })}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table>
    </div>
    <div class="tv-cols c3" style="gap:12px">
      ${panel(
        'Комиссионка · продажа',
        '',
        `<div class="tv-list">${D()
          .finance.shop.sell.map(
            s =>
              `<div class="tv-list-item" style="padding:6px 0"><div class="grow">${esc(s)}</div>${chip('×12', 'gold')}</div>`
          )
          .join('')}</div>`
      )}
      ${panel(
        'Комиссионка · покупка',
        '',
        `<div class="tv-list">${D()
          .finance.shop.buy.map(
            s =>
              `<div class="tv-list-item" style="padding:6px 0"><div class="grow">${esc(s)}</div>${chip('×1', 'violet')}</div>`
          )
          .join('')}</div>`
      )}
      ${panel(
        'Долги',
        '',
        `<div class="tv-list">${D()
          .finance.loans.map(
            l =>
              `<div class="tv-list-item" style="padding:7px 0;flex-wrap:wrap"><div class="grow"><strong>${esc(
                l.who
              )}</strong><span class="tv-tiny tv-muted">${esc(l.meta)}</span></div>${chip(l.sum, l.dir === 'Дано' ? 'ok' : 'bad')}</div>`
          )
          .join('')}</div>`
      )}
    </div>`,

  c: () => `
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 320px">
      <div class="tv-stack" style="gap:24px">
        <div class="tv-card raised" style="background:linear-gradient(140deg,var(--gold-soft),transparent 60%),var(--surface)">
          <span class="tv-label">Золото на руках</span>
          <div class="tv-num-lg" style="color:var(--gold);font-size:44px">48 320</div>
          <p class="tv-muted" style="margin:0">за октябрь +6 400 · в долгах 2 100</p>
          <div class="tv-row" style="margin-top:8px">${btn('Записать движение', { tone: 'primary' })}${btn('Голд', {
            tone: 'ghost'
          })}${btn('Долг', { tone: 'ghost' })}</div>
        </div>
        ${panel(
          'Журнал · октябрь',
          '24 записи',
          `<div class="tv-list">${D()
            .finance.entries.map(
              e => `<div class="tv-list-item" style="padding:12px 0">
          <span class="tv-ava sm" style="background:${
            e.kind === 'Получил' ? 'var(--ok-soft)' : 'var(--bad-soft)'
          };color:${e.kind === 'Получил' ? 'var(--ok)' : 'var(--bad)'}">${e.kind === 'Получил' ? '+' : '−'}</span>
          <div class="grow"><strong>${esc(e.who)}</strong><span class="tv-tiny tv-muted">${esc(e.date)} · ${esc(
            e.source
          )}</span></div>
          <strong class="num" style="color:${e.sum[0] === '+' ? 'var(--ok)' : 'var(--bad)'}">${esc(e.sum)}</strong>
        </div>`
            )
            .join('')}</div>`
        )}
      </div>
      <div class="tv-stack" style="gap:24px">
        ${panel('Голд', '1 250', `<div class="tv-tiny tv-muted">Продать голд — получить золото. Курс 1 голд = 24 золота.</div>`)}
        ${panel(
          'Комиссионка',
          '12 800 · продано на 9 400',
          `<div class="tv-list">${D()
            .finance.shop.sell.map(
              s =>
                `<div class="tv-list-item" style="padding:6px 0"><div class="grow">${esc(s)}</div>${chip('×12', 'gold')}</div>`
            )
            .join('')}</div>`
        )}
        ${panel(
          'Долги',
          '3 400',
          `<div class="tv-list">${D()
            .finance.loans.map(
              l =>
                `<div class="tv-list-item" style="padding:7px 0;flex-wrap:wrap"><div class="grow"><strong>${esc(
                  l.who
                )}</strong><span class="tv-tiny tv-muted">${esc(l.meta)}</span></div>${chip(l.sum, l.dir === 'Дано' ? 'ok' : 'bad')}</div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`
};

/* ═══════════════════════════ ИНСТРУМЕНТЫ ═══════════════════════════ */

const toolsVariants = {
  a: () => `
    <div class="tv-cols c2" style="gap:16px">
      ${D()
        .tools.map(
          t => `<div class="tv-card" style="gap:8px">
        <div class="tv-row" style="flex-wrap:nowrap;gap:10px">
          <span class="tv-feed-ico ${t.tone}">${icon(t.ico)}</span>
          <div class="grow" style="flex:1"><h4>${esc(t.title)}</h4><p class="tv-muted tv-tiny" style="margin:2px 0 0">${esc(
            t.desc
          )}</p></div>
        </div>
        <div class="tv-row" style="gap:6px">${btn('Запустить', { tone: 'primary', size: 'sm' })}${btn('Журнал', {
          tone: 'ghost',
          size: 'sm'
        })}</div>
      </div>`
        )
        .join('')}
    </div>
    <div class="tv-cols c2" style="gap:16px">
      ${panel(
        'Окна игры',
        'Клиенты, запущенные на этом компьютере',
        `<div class="tv-list">${D()
          .windows.map(
            w =>
              `<div class="tv-list-item"><span class="tv-dot ${w.known ? 'ok' : ''}"></span><div class="grow"><strong>${esc(
                w.label
              )}</strong><span class="tv-tiny tv-muted">работает ${esc(w.up)}${w.admin ? ' · админ' : ''}</span></div>${btn(
                'Закрыть',
                { tone: 'ghost', size: 'sm' }
              )}</div>`
          )
          .join('')}</div>`,
        btn('Обновить', { ico: 'i-refresh', tone: 'ghost', size: 'sm' })
      )}
      ${panel(
        'Состояние парсеров',
        'Приложение читает страницы pwonline.ru',
        `<div class="tv-table-wrap" style="border:0"><table class="tv-table">
          <thead><tr><th>Парсер</th><th>Последняя проверка</th><th>Последняя ошибка</th></tr></thead>
          <tbody>${D()
            .parsers.map(
              p =>
                `<tr><td>${esc(p.name)}</td><td class="tv-tiny">${esc(p.last)}</td><td class="tv-tiny tv-muted">${esc(p.err)}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>`,
        btn('Скопировать диагностику', { ico: 'i-copy', tone: 'ghost', size: 'sm' })
      )}
    </div>`,

  b: () => `
    <div class="tv-row" style="gap:8px">
      <span class="tv-label">Скрипты</span>
      <span class="tv-tiny tv-muted">выполняются по одному: новый встаёт в очередь</span>
      <div class="tv-spacer"></div>${btn('📋 Журналы', { tone: 'ghost', size: 'sm' })}
    </div>
    <div class="tv-table-wrap">
      <table class="tv-table">
        <thead><tr><th>Действие</th><th>Что делает</th><th>Последний запуск</th><th>Статус</th><th></th></tr></thead>
        <tbody>${D()
          .tools.map(
            (t, i) => `<tr>
          <td><div class="tv-row" style="gap:7px;flex-wrap:nowrap"><span class="tv-feed-ico ${t.tone}" style="width:24px;height:24px">${icon(
            t.ico
          )}</span><strong>${esc(t.title)}</strong></div></td>
          <td class="tv-tiny tv-muted">${esc(t.desc)}</td>
          <td class="tv-tiny">${i < 3 ? 'сегодня, 08:41' : '—'}</td>
          <td>${chip(i === 1 ? 'ошибка' : 'готово', i === 1 ? 'bad' : 'ok')}</td>
          <td class="rowact">${btn('▶', { ico: 'i-play', tone: 'primary', size: 'sm' })}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table>
    </div>
    <div class="tv-cols c2" style="gap:12px">
      ${panel(
        'Очередь задач',
        'скрипты выполняются по одному',
        `<div class="tv-list">
        <div class="tv-list-item"><span class="tv-dot busy"></span><div class="grow"><strong>Проверка входа</strong><span class="tv-tiny tv-muted">5/8 · ошибок 1</span></div>${bar(62, 'ok')}</div>
        <div class="tv-list-item"><span class="tv-dot"></span><div class="grow"><strong>Балансы</strong><span class="tv-tiny tv-muted">в очереди — ждёт завершения текущего</span></div></div>
        <div class="tv-list-item"><span class="tv-dot"></span><div class="grow"><strong>Марафоны</strong><span class="tv-tiny tv-muted">в очереди</span></div></div>
      </div>`
      )}
      ${panel(
        'Окна игры',
        '',
        `<div class="tv-list">${D()
          .windows.map(
            w =>
              `<div class="tv-list-item"><span class="tv-dot ${w.known ? 'ok' : ''}"></span><div class="grow">${esc(
                w.label
              )}<span class="tv-tiny tv-muted"> · ${esc(w.up)}</span></div>${btn('Закрыть', { tone: 'ghost', size: 'sm' })}</div>`
          )
          .join('')}</div>`
      )}
    </div>`,

  c: () => `
    <div class="tv-cols side" style="grid-template-columns:minmax(0,1fr) 320px">
      <div class="tv-stack" style="gap:22px">
        <div class="tv-card raised">
          <span class="tv-label">Что сделать</span>
          <h3 style="margin:4px 0 12px;font-size:20px">Проверка данных, потом действия</h3>
          <div class="tv-stack" style="gap:8px">
            ${D()
              .tools.map(
                (t, i) => `<div class="tv-list-item" style="padding:10px 0;border-bottom:1px solid var(--border-soft)">
              <span class="tv-num" style="width:22px;color:var(--text-faint)">${i + 1}</span>
              <span class="tv-feed-ico ${t.tone}">${icon(t.ico)}</span>
              <div class="grow" style="flex:1"><strong>${esc(t.title)}</strong><span class="tv-tiny tv-muted">${esc(
                t.desc
              )}</span></div>
              ${btn('Запустить', { tone: i < 3 ? 'primary' : 'ghost', size: 'sm' })}
            </div>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="tv-stack" style="gap:22px">
        ${panel(
          'Сейчас выполняется',
          '',
          `<div class="tv-card" style="background:var(--accent-soft);border:0">
          <span class="tv-label">Задача 1 из 8</span>
          <div class="tv-num-lg" style="color:var(--accent)">62 %</div>
          ${bar(62, 'ok', true)}
          <p class="tv-tiny tv-muted" style="margin:6px 0 0">5 из 8 персонажей · ошибок 1</p>
        </div>`
        )}
        ${panel(
          'Окна игры',
          '',
          `<div class="tv-list">${D()
            .windows.map(
              w =>
                `<div class="tv-list-item" style="padding:8px 0"><span class="tv-dot ${w.known ? 'ok' : ''}"></span><div class="grow"><strong>${esc(
                  w.label
                )}</strong><span class="tv-tiny tv-muted">${esc(w.up)}</span></div>${btn('Закрыть', { tone: 'ghost', size: 'sm' })}</div>`
            )
            .join('')}</div>`
        )}
        ${panel(
          'Состояние парсеров',
          'все исправны',
          `<div class="tv-list">${D()
            .parsers.map(
              p =>
                `<div class="tv-list-item" style="padding:6px 0"><span class="tv-dot ok"></span><div class="grow">${esc(p.name)}</div><span class="tv-tiny tv-muted">${esc(p.last)}</span></div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`
};

/* ═══════════════════════════ ПРОФИЛЬ ═══════════════════════════ */

const profileVariants = {
  a: () => {
    const p = D().profile;
    return `
    <div class="tv-cols side" style="grid-template-columns:300px minmax(0,1fr)">
      <div class="tv-stack">
        <div class="tv-card raised">
          <div class="tv-row" style="flex-wrap:nowrap;gap:12px">${ava(p.cls, 'lg')}<div class="grow" style="flex:1">
            <h3 style="margin:0;font-size:18px">${esc(p.nick)}</h3>
            <p class="tv-muted tv-tiny" style="margin:2px 0 0">${esc(p.cls)} · Ур. ${p.level} · ☁️ ${esc(p.sky)}</p>
          </div></div>
          <hr class="tv-hr"/>
          <dl class="tv-kv">
            <dt>Пати</dt><dd>${esc(p.party)}</dd>
            <dt>Доп. пати</dt><dd>1</dd>
            <dt>Статус</dt><dd style="color:var(--ok)">🔐 Онлайн</dd>
            <dt>Проверено</dt><dd>${esc(p.lastCheck)}</dd>
            <dt>Монеты</dt><dd class="num">${p.coins.toLocaleString('ru-RU')}</dd>
          </dl>
          <div class="tv-row">${p.tags.map(t => chip('#' + t)).join('')}</div>
        </div>
        ${panel(
          'Контактные данные',
          '',
          `<dl class="tv-kv">${p.contacts
            .map(c => `<dt>${esc(c[0])}</dt><dd class="num">${esc(c[1])} ${icon('i-copy')}</dd>`)
            .join('')}</dl>`
        )}
        ${panel(
          'Когда что проверено',
          '',
          `<div class="tv-list">
          <div class="tv-list-item"><div class="grow">🪙 Баланс монет</div>${chip('сегодня, 08:41', 'ok')}</div>
          <div class="tv-list-item"><div class="grow">🔐 Вход на сайт</div>${chip('сегодня, 08:40', 'ok')}</div>
          <div class="tv-list-item"><div class="grow">🏆 Марафон</div>${chip('3 ч назад', 'warn')}</div>
        </div>`
        )}
        ${panel('Примечания', '', `<div class="tv-tiny tv-muted" style="min-height:44px">Докачать седьмой ранг неба, следить за проходками.</div>`)}
      </div>
      <div class="tv-stack">
        ${panel(
          'Характеристики',
          'последние изменения характеристик',
          `<div class="tv-cols c2" style="gap:14px">${p.statGroups
            .map(
              g => `<div class="tv-card" style="gap:6px;background:var(--surface-2)">
            <span class="tv-label">${esc(g.title)}</span>
            <dl class="tv-kv">${g.rows
              .map(
                r =>
                  `<dt>${esc(r[0])}</dt><dd class="num">${esc(r[1])} ${
                    r[2] ? `<span style="color:var(--ok)">${esc(r[2])}</span>` : ''
                  }</dd>`
              )
              .join('')}</dl>
          </div>`
            )
            .join('')}</div>`
        )}
        <div class="tv-row">
          ${btn('🗑 Удалить', { ico: 'i-trash', tone: 'danger', size: 'sm' })}
          ${btn('▶ Играть', { ico: 'i-play', tone: 'primary', size: 'sm' })}
          ${btn('🌐 Сайт', { ico: 'i-globe', size: 'sm' })}
          ${btn('🪙 История', { size: 'sm' })}
          ${btn('✏️ Править', { ico: 'i-edit', size: 'sm' })}
          ${btn('Проверить ▾', { size: 'sm' })}
        </div>
      </div>
    </div>`;
  },

  b: () => {
    const p = D().profile;
    return `
    <div class="tv-panel">
      <div class="tv-panel-body" style="gap:10px">
        <div class="tv-row" style="flex-wrap:nowrap;gap:12px">
          ${ava(p.cls, 'lg')}
          <div class="grow" style="flex:1">
            <div class="tv-row" style="gap:7px"><strong style="font-size:16px">${esc(p.nick)}</strong>${chip(
              p.cls
            )}${chip('Ур. ' + p.level, 'accent')}${chip(p.sky, 'violet')}</div>
            <div class="tv-tiny tv-muted">id: c1 · ${esc(p.party)} · доп. пати 1 · ${p.tags.map(t => '#' + t).join(' ')}</div>
          </div>
          <span class="tv-chip ok">🔐 онлайн · ${esc(p.lastCheck)}</span>
          <span class="tv-chip gold">🪙 ${p.coins.toLocaleString('ru-RU')}</span>
        </div>
      </div>
    </div>
    <div class="tv-cols side-l" style="grid-template-columns:290px minmax(0,1fr)">
      <div class="tv-stack">
        ${panel(
          'Контакты',
          '',
          `<dl class="tv-kv">${p.contacts
            .map(c => `<dt>${esc(c[0])}</dt><dd class="num">${esc(c[1])}</dd>`)
            .join('')}</dl>`
        )}
        ${panel(
          'Запуск игры',
          '',
          `<div class="tv-list">
          <div class="tv-list-item"><div class="grow">GameCenter</div>${chip('основной', 'ok')}</div>
          <div class="tv-list-item"><div class="grow">Путь лаунчера</div><span class="tv-tiny tv-muted">C:\\…\\launcher.exe</span></div>
          <div class="tv-list-item"><div class="grow">Статус входа</div>${chip('запомнен', 'ok')}</div>
        </div>
        ${btn('Запомнить текущий вход', { size: 'sm' })}`
        )}
        ${panel(
          'Проходки в данжи',
          '',
          `<div class="tv-row">${chip('⚔ 4', 'accent')}${chip('🛡 2', 'accent')}${chip('💎 1', 'accent')}</div>`
        )}
        ${panel(
          'Последние изменения',
          '',
          `<div class="tv-list">
          <div class="tv-list-item"><div class="grow"><strong>Физ. атака</strong><span class="tv-tiny tv-muted">12.10</span></div><span style="color:var(--ok)">+40</span></div>
          <div class="tv-list-item"><div class="grow"><strong>Здоровье</strong><span class="tv-tiny tv-muted">05.10</span></div><span style="color:var(--ok)">+1 200</span></div>
        </div>`
        )}
      </div>
      <div class="tv-stack">
        <div class="tv-tabs">${p.statGroups
          .map((g, i) => `<span class="tv-tab ${i === 0 ? 'on' : ''}">${esc(g.title)}</span>`)
          .join('')}</div>
        ${panel(
          'Все характеристики',
          '',
          `<div class="tv-cols c2" style="gap:12px">${p.statGroups
            .map(
              g => `<div class="tv-card" style="gap:5px;background:var(--surface-2);padding:12px">
          <span class="tv-label">${esc(g.title)}</span>
          <table class="tv-table" style="font-size:12px"><tbody>${g.rows
            .map(
              r =>
                `<tr><td style="border:0;padding:3px 0">${esc(r[0])}</td><td class="num" style="border:0;padding:3px 0">${esc(
                  r[1]
                )}</td><td class="num" style="border:0;padding:3px 0;width:52px">${
                  r[2] ? `<span style="color:var(--ok)">${esc(r[2])}</span>` : ''
                }</td></tr>`
            )
            .join('')}</tbody></table>
        </div>`
            )
            .join('')}</div>`
        )}
      </div>
    </div>`;
  },

  c: () => {
    const p = D().profile;
    return `
    <div class="tv-card raised" style="padding:26px">
      <div class="tv-row" style="flex-wrap:nowrap;gap:16px;align-items:flex-start">
        ${ava(p.cls, 'lg')}
        <div class="grow" style="flex:1;min-width:0">
          <h2 style="margin:0;font-size:26px;letter-spacing:-0.02em">${esc(p.nick)}</h2>
          <p class="tv-muted" style="margin:4px 0 0">${esc(p.cls)} · Уровень ${p.level} · ${esc(p.sky)} (${p.skyLevel}) · ${esc(
            p.party
          )}</p>
          <div class="tv-row" style="margin-top:8px">${chip('🔐 онлайн', 'ok')}${p.tags
            .map(t => chip('#' + t))
            .join('')}</div>
        </div>
        <div style="text-align:right">
          <span class="tv-label">Древних монет</span>
          <div class="tv-num-lg" style="color:var(--gold)">${p.coins.toLocaleString('ru-RU')}</div>
          <span class="tv-tiny tv-muted">проверено ${esc(p.coinsChecked)}</span>
        </div>
      </div>
    </div>
    <div class="tv-cols c2" style="gap:26px;align-items:start">
      <div class="tv-stack" style="gap:22px">
        ${panel(
          'Контактные данные',
          'нажмите, чтобы скопировать',
          `<div class="tv-list">${p.contacts
            .map(
              c =>
                `<div class="tv-list-item" style="padding:9px 0"><div class="grow"><span class="tv-tiny tv-faint">${esc(
                  c[0]
                )}</span><div class="num">${esc(c[1])}</div></div>${btn('', { ico: 'i-copy', tone: 'ghost', size: 'sm', iconOnly: true, title: 'Скопировать' })}</div>`
            )
            .join('')}</div>`
        )}
        ${panel(
          'Запуск игры',
          '',
          `<div class="tv-stack" style="gap:10px">
          <div class="tv-row"><span class="tv-label" style="flex:1">GameCenter</span>${chip('основной', 'ok')}</div>
          <div class="tv-row"><span class="tv-label" style="flex:1">Статус входа</span>${chip('запомнен', 'ok')}</div>
          <div class="tv-row">${btn('🎮 Запустить игру', { ico: 'i-play', tone: 'primary' })}${btn('🌐 Сайт', {
            ico: 'i-globe',
            tone: 'ghost'
          })}</div>
        </div>`
        )}
        ${panel('Примечания', 'сохраняются автоматически', `<div class="tv-tiny tv-muted">Докачать седьмой ранг неба, следить за проходками.</div>`)}
      </div>
      <div class="tv-stack" style="gap:22px">
        ${p.statGroups
          .map(
            g => `<div class="tv-card" style="gap:8px">
          <span class="tv-label">${esc(g.title)}</span>
          <div class="tv-stats" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">${g.rows
            .map(
              r =>
                `<div class="tv-stat" style="padding:8px 10px;gap:0"><span class="tv-label" style="font-size:10px">${esc(
                  r[0]
                )}</span><span class="tv-stat-v" style="font-size:16px">${esc(r[1])} ${
                  r[2] ? `<small style="color:var(--ok)">${esc(r[2])}</small>` : ''
                }</span></div>`
            )
            .join('')}</div>
        </div>`
          )
          .join('')}
      </div>
    </div>`;
  }
};

/* ═══════════════════════════ НАСТРОЙКИ ═══════════════════════════ */

const settingsVariants = {
  a: () => `
    <div class="tv-cols side-l" style="grid-template-columns:250px minmax(0,1fr)">
      <nav class="tv-panel" style="align-self:start">
        <div class="tv-panel-body tight">
          ${D()
            .settings.groups.map(
              (g, i) => `<div class="tv-list-item" style="padding:9px 0;${i === 0 ? 'color:var(--accent)' : ''}">
            <div class="grow"><strong style="${i === 0 ? 'color:var(--accent)' : ''}">${esc(g.title)}</strong>
            <span class="tv-tiny tv-muted">${esc(g.sub)}</span></div>
          </div>`
            )
            .join('')}
        </div>
      </nav>
      <div class="tv-stack">
        ${D()
          .settings.groups.slice(0, 1)
          .map(
            g => `<div class="tv-cols c2" style="gap:16px;align-items:start">
          ${g.items
            .map(
              it => `<section class="tv-panel" style="${it.danger ? 'border-color:var(--bad)' : ''}">
            <header class="tv-panel-head"><div><h3>${esc(it.t)}</h3><p>${esc(it.d)}</p></div></header>
            <div class="tv-panel-body">
              ${(it.checks || []).map(c => setRow(c, '', onOff(true))).join('')}
              ${(it.rows || []).map(r => setRow(r, '', '<span class="tv-tiny tv-muted">изменить</span>')).join('')}
              ${(it.selects || []).map(r => setRow(r, '', '<span class="tv-chip">настроить</span>')).join('')}
              ${!it.checks && !it.rows && !it.selects ? '<span class="tv-tiny tv-muted">—</span>' : ''}
            </div>
          </section>`
            )
            .join('')}
        </div>`
          )
          .join('')}
      </div>
    </div>`,

  b: () => `
    <div class="tv-row" style="gap:8px">
      <span class="tv-input" style="display:flex;align-items:center;gap:7px;color:var(--text-faint);width:240px">${icon(
        'i-search'
      )}Поиск по настройкам…</span>
      ${chip('Приложение', 'accent')}${chip('Синхронизация')}${chip('Обновления')}${chip('Данные')}${chip('Справка')}${chip('Опасное')}
      <div class="tv-spacer"></div>${btn('💾 Сохранить', { tone: 'primary', size: 'sm' })}
    </div>
    <div class="tv-panel">
      <div class="tv-panel-body">
        ${D()
          .settings.groups.filter(g => g.id !== 'danger')
          .map(
            g => `<div style="margin-bottom:16px">
          <div class="tv-row" style="gap:8px;margin-bottom:6px"><span class="tv-label">${esc(g.title)}</span><span class="tv-tiny tv-muted">${esc(
            g.sub
          )}</span></div>
          ${g.items
            .map(
              it => `<div class="tv-setrow">
            <div class="grow"><strong>${esc(it.t)}</strong><p>${esc(it.d)}</p>
            ${(it.checks || []).map(c => `<div class="tv-row" style="gap:7px;margin-top:5px">${onOff(true)}<span class="tv-tiny">${esc(c)}</span></div>`).join('')}
            ${(it.rows || []).map(r => `<div class="tv-tiny tv-muted" style="margin-top:3px">· ${esc(r)}</div>`).join('')}
            ${(it.selects || []).map(r => `<div class="tv-tiny tv-muted" style="margin-top:3px">· ${esc(r)}</div>`).join('')}
            </div>
            <div class="tv-row">${btn('Открыть', { tone: 'ghost', size: 'sm' })}</div>
          </div>`
            )
            .join('')}
        </div>`
          )
          .join('')}
      </div>
    </div>
    <section class="tv-panel" style="border-color:var(--bad)">
      <header class="tv-panel-head"><div><h3 style="color:var(--bad)">⚠️ Опасные действия</h3><p>Массовое удаление. Перед удалением создаётся резервная копия.</p></div></header>
      <div class="tv-panel-body">
        ${D()
          .settings.groups.find(g => g.danger)
          .items.map(it => setRow(it.t, it.d, btn('Удалить', { ico: 'i-trash', tone: 'danger', size: 'sm' })))
          .join('')}
      </div>
    </section>`,

  c: () => `
    <div class="tv-cols c2" style="gap:24px;align-items:start">
      ${D()
        .settings.groups.map(
          g => `<section class="tv-card" style="gap:16px;${g.danger ? 'border-color:var(--bad)' : ''}">
        <div>
          <span class="tv-label" style="color:${g.danger ? 'var(--bad)' : 'var(--accent)'}">${esc(g.title)}</span>
          <p class="tv-muted tv-tiny" style="margin:3px 0 0">${esc(g.sub)}</p>
        </div>
        ${g.items
          .map(
            it => `<div>
          <div class="tv-row" style="gap:8px;margin-bottom:6px"><strong>${esc(it.t)}</strong></div>
          ${it.d ? `<p class="tv-muted tv-tiny" style="margin:0 0 8px">${esc(it.d)}</p>` : ''}
          ${(it.checks || []).map(c => setRow(c, '', onOff(true))).join('')}
          ${(it.rows || []).map(r => setRow(r, '', '<span class="tv-tiny tv-muted">изменить</span>')).join('')}
          ${(it.selects || []).map(r => setRow(r, '', '<span class="tv-chip">настроить</span>')).join('')}
        </div>`
          )
          .join('')}
      </section>`
        )
        .join('')}
    </div>`
};

/* ═══════════════════════════ сборка ═══════════════════════════ */

TV.VARIANTS = {
  a: {
    name: 'A · Студия',
    desc: 'Тёмная, мягкая, крупные карточки. Много воздуха, цвет только для статусов.'
  },
  b: {
    name: 'B · Пульт',
    desc: 'Плотный тёмный: таблицы, моноширинные числа, всё в один экран.'
  },
  c: {
    name: 'C · Светлый',
    desc: 'Тёплый светлый, крупная типографика, спокойные границы, минимум линий.'
  }
};

TV.PAGE_VARIANTS = {
  today: todayVariants,
  characters: charactersVariants,
  parties: partiesVariants,
  marathons: marathonsVariants,
  runes: runesVariants,
  finance: financeVariants,
  tools: toolsVariants,
  profile: profileVariants,
  settings: settingsVariants
};

/* Собирает готовый макет страницы: каркас + содержимое */
TV.render = function (pageId, variant) {
  const shell = SHELLS[variant] || shellA;
  const body = TV.PAGE_VARIANTS[pageId][variant]();
  return `<div class="tv-root" data-variant="${variant}">${shell(pageId)}${body}</main></div></div>`;
};
