import { bindReferenceToday } from './referenceToday.js';
import { PAGES, NEXT_PAGES, variantsFor, nextVariantsFor } from './catalog.js';
import {
  createLabState,
  entriesFor,
  featureList,
  visibleEntries,
  launchParty,
  markDay,
  simulateCheck
} from './model.js';
import { icon, renderPage, queueView, marathonTable } from './render.js';
import { escapeHtml as esc } from '../../js/core/utils.js';
const $ = s => document.querySelector(s);
const mode = document.body.dataset.lab === 'next' ? 'next' : 'classic';
const pages = mode === 'next' ? NEXT_PAGES : PAGES;
const params = new URLSearchParams(location.search);
let page = pages.find(p => p.id === params.get('page'))?.id || pages[0].id;
let variant = Number(params.get('variant')) || (mode === 'next' ? 7 : 1);
let original = params.get('original') === '1';
let state = createLabState();
let toastTimer, runTimer;
const root = $('#lab-root'),
  dialog = $('#lab-dialog'),
  notice = $('#lab-notice');
const source = () => (mode === 'next' ? pages.find(p => p.id === page).source : page);
const choices = () => (mode === 'next' ? nextVariantsFor(page) : variantsFor(page));
const validVariant = () => choices().find(v => v.id === variant) || choices()[0];
const url = (target = page, n = variant) =>
  `?page=${encodeURIComponent(target)}&variant=${n}${original ? '&original=1' : ''}`;
const originalSection = () => (source() === 'bank' ? 'finance' : source() === 'activity' ? 'settings' : source());
function toast(text) {
  notice.textContent = text;
  notice.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => notice.classList.remove('visible'), 4500);
}
function syncURL() {
  history.replaceState(null, '', url());
}
function navigate(id) {
  if (!pages.some(p => p.id === id)) return;
  page = id;
  state.query = '';
  state.filter = 'all';
  state.detail = '';
  original = false;
  render();
  syncURL();
}
function goSource(id) {
  const target = mode === 'next' ? pages.find(p => p.source === id)?.id : id;
  if (target) navigate(target);
}
function frameContent() {
  const base = new URL('../', import.meta.url);
  const legacy = source() === 'today' && variant <= 3 && !original;
  const src = legacy
    ? new URL(`today/index.html?embed=1&variant=${['overview', 'day', 'workspace'][variant - 1]}`, base).href
    : new URL('app/index.html', base).href;
  return `<div class="lg-frame-heading"><p>${legacy ? 'Сохранённый вариант из первой лаборатории. Интерактивные сценарии — внутри окна.' : 'Исходный адаптированный снимок приложения. Не входит в число новых вариантов.'}</p><a href="${esc(src)}" target="_blank" rel="noopener">Открыть отдельно ↗</a></div><iframe id="lg-original-frame" title="${legacy ? 'Первоначальный концепт' : 'Исходный снимок'}" src="${esc(src)}" sandbox="allow-scripts allow-forms allow-modals"></iframe>`;
}
function render() {
  const v = validVariant();
  variant = v.id;
  const meta = pages.find(p => p.id === page),
    src = source(),
    list = choices();
  document.body.className = `lg-body theme-${v.theme} ${mode === 'next' ? 'is-next' : 'is-classic'} ${state.compact ? 'is-compact' : ''} palette-${state.palette}`;
  root.innerHTML = `<header class="lg-lab-header"><a class="lg-lab-brand" href="${mode === 'next' ? '../demo/variants/index.html' : '../../demo2/index.html'}"><span>ТФ</span><div>Твиноферма <small>${mode === 'next' ? 'DEMO 2 / ПЕРЕОСМЫСЛЕНИЕ' : 'DESIGN LAB / 80 ВАРИАНТОВ'}</small></div></a><div class="lg-lab-links"><span class="lg-demo-badge">Изолированный прототип</span><a href="${mode === 'next' ? '../demo/variants/index.html' : '../../demo2/index.html'}">${mode === 'next' ? '80 вариантов страниц' : 'Новая программа · demo2'} ↗</a><button class="lg-text" data-map>Карта функций</button><button class="lg-text" data-reset>Сбросить пример</button></div></header>
 <section class="lg-variant-picker" aria-label="Сравнение дизайн-концептов"><div class="lg-picker-heading"><div><span class="lg-eyebrow">${mode === 'next' ? (source() === 'today' ? 'Новый 12 — по вашему эскизу · прежние 01–11 сохранены' : '5 новых «Атлас» (07–11) + 6 прежних концептов') : '10 вариантов на страницу · исходный отдельно'}</span><h1>${esc(meta.label)} <span>${original ? 'Исходная' : String(variant).padStart(2, '0') + ' / ' + list.length}</span></h1></div><div class="lg-picker-actions"><button class="lg-icon-button" data-previous aria-label="Предыдущий вариант">←</button><button class="lg-icon-button" data-next aria-label="Следующий вариант">→</button><label>Палитра<select data-palette aria-label="Цветовая палитра">${[
   ['concept', 'Авторская'],
   ['dark', 'Тёмная'],
   ['light', 'Светлая']
 ]
   .map(([id, text]) => `<option value="${id}" ${state.palette === id ? 'selected' : ''}>${text}</option>`)
   .join(
     ''
   )}</select></label><label class="lg-compact"><input type="checkbox" data-compact ${state.compact ? 'checked' : ''}/>Компактно</label></div></div><div class="lg-variant-buttons">${list.map(v => `<button data-variant="${v.id}" aria-pressed="${!original && variant === v.id}"><span>${String(v.id).padStart(2, '0')}</span><b>${esc(v.name)}</b><small>${esc(v.kind)}</small></button>`).join('')}<button class="lg-original-button" data-original aria-pressed="${original}"><span>↗</span><b>Исходная</b><small>Не считается</small></button></div><p class="lg-design-note">${original ? 'Адаптированный снимок приложения, а не новый дизайн.' : esc(v.principle)} ${mode === 'next' ? esc(meta.why) : ''}</p></section>
 <p class="lg-safety-banner">${v.reference ? 'В браузерном предпросмотре персонажи и суммы — примеры, записи остаются в памяти. Новости и промокоды — из общего источника приложения, не выдуманная свежая лента. Рабочие действия требуют десктопного приложения и используют его штатные проверки. Настоящие пароли, ключи и контакты сюда вводить нельзя.' : 'Все аккаунты, суммы, задания и результаты вымышлены. Нет обращения к сайту, Rust или лаунчеру. Вводите только тестовые названия; изменения живут в памяти вкладки. Настоящие пароли, ключи и контакты вводить нельзя.'}</p>
 <div class="lg-shell"><aside class="lg-sidebar"><div class="lg-product-mark">${icon('rune')}<b>Твиноферма</b><small>${mode === 'next' ? 'YOUR PERFECT WORKSPACE' : 'PERFECT WORLD COMPANION'}</small></div><nav aria-label="Страницы приложения">${pages.map(p => `<button data-page="${p.id}" aria-label="${esc(p.label)}" aria-current="${p.id === page ? 'page' : 'false'}" title="${esc(p.label)}">${icon(p.icon)}<span>${esc(p.label)}</span>${p.id === page ? '<i></i>' : ''}</button>`).join('')}</nav><div class="lg-sidebar-bottom"><span class="lg-local-dot"></span><span>Только демонстрация<br/><small>Аккаунты не подключены</small></span></div></aside>
 <main class="lg-main" id="content"><header class="lg-page-header"><div><span class="lg-eyebrow">${mode === 'next' ? 'Личное рабочее пространство' : 'Управление аккаунтами'} / ${esc(v.name)}</span><h2>${esc(meta.label)}</h2><p>${esc(meta.description || meta.why)}</p></div><div class="lg-page-actions"><button class="lg-button" data-command>${icon('search')} Команды <kbd>Ctrl K</kbd></button><button class="lg-button primary" data-primary>${primaryLabel(src)}</button></div></header>${state.running ? `<div class="lg-running-bar">${queueView(state)}<button class="lg-icon-button danger" data-stop aria-label="Немедленно остановить">■</button></div>` : ''}
 <div id="lg-content">${original || (mode === 'classic' && src === 'today' && variant <= 3) ? frameContent() : renderPage(src, v, state)}</div><footer class="lg-page-footer"><span>${mode === 'next' ? 'Переосмысление · 100 сочетаний, включая Сегодня 12' : 'Лаборатория · 8 страниц × 10 вариантов'}</span><span>Perfect World · менеджер аккаунтов, не чит</span></footer></main></div>`;
}
function primaryLabel(src) {
  return {
    today: 'План на день',
    characters: '+ Персонаж',
    parties: '+ Пати',
    marathons: '+ Марафон',
    runes: '+ Схема',
    bank: '+ Операция',
    tools: 'Выбрать операцию',
    settings: 'Проверить настройки',
    activity: 'Отчёт сессии'
  }[src];
}
function modal(title, body, footer = '') {
  dialog.innerHTML = `<form method="dialog" class="lg-dialog-close"><button aria-label="Закрыть окно">×</button></form><header><span class="lg-eyebrow">Только вымышленные данные</span><h2 id="lg-dialog-title">${esc(title)}</h2></header><div class="lg-dialog-body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}`;
  if (!dialog.open) dialog.showModal();
}
function close() {
  dialog.close();
}
function accountChoices() {
  const chosen = state.characters.filter(c => state.selected.has(c.id));
  return `<fieldset class="lg-account-choices"><legend>Персонажи для имитации</legend>${state.characters.map(c => `<label><input type="checkbox" name="target" value="${esc(c.id)}" ${!chosen.length || state.selected.has(c.id) ? 'checked' : ''}/> ${esc(c.nick)} <small>${esc(c.server)}</small></label>`).join('')}</fieldset>`;
}
function startSimulation(title, detail = 'Проверен выбранный план · имитация') {
  if (state.running) {
    toast('Сначала остановите или завершите текущую демонстрацию.');
    return;
  }
  const generation = ++state.runGeneration;
  state.running = { title };
  close();
  render();
  runTimer = setTimeout(() => {
    if (generation !== state.runGeneration) return;
    state.jobs.unshift({ id: `job-${++state.created}`, title, state: 'Готово', progress: 100, time: 'Сейчас', detail });
    state.running = null;
    render();
    toast('Имитация завершена. Сайт и лаунчер не вызывались.');
  }, 900);
}
function operation(title, kind = 'read') {
  const transfer = /набор|Передач/i.test(title),
    shop = /подар|Покуп/i.test(title),
    launch = /запуск|лаунчер|Раскладка/i.test(title),
    irreversible = kind === 'action' || transfer || shop || /Активация|промокод|Сундук|Закрытие/i.test(title);
  modal(
    title,
    `<p>Это демонстрационный сценарий. Никакие учётные данные не запрашиваются; реальные команды не выполняются.</p>${accountChoices()}${transfer ? `<div class="lg-transfer-plan"><h3>Небесная пилюля</h3><p>В наборе ×25 штук · доступен 21 набор</p><label class="lg-field">Выбрано наборов<input type="number" min="0" max="21" step="1" value="${state.transferSets}" data-transfer-sets/></label><output data-transfer-total>${state.transferSets * 25} предметов</output><p>Фенрир → Звеномир · сначала ближайшие сроки. Наборы неделимы.</p></div>` : ''}${shop ? `<div class="lg-notice">Древние монеты · баланс аккаунта общий. Цена 120, доступно 2 из 4, дата обновления неизвестна.</div><button class="lg-button" data-limits>Лимиты всех персонажей</button>` : ''}${launch ? `<label class="lg-field">Раскладка окон<select><option>2 × 2 · основной экран</option><option>Каскад</option><option>Запомненные позиции · пример</option></select></label>` : ''}<div class="lg-preview-box"><b>1. Выбор → 2. Предпросмотр → 3. Подтверждение</b><p>В реальном приложении здесь проверяется актуальное состояние сайта. В демо все результаты явно вымышлены.</p></div>${irreversible ? '<label class="lg-ack"><input type="checkbox" data-ack/> Понимаю необратимость реальной операции. Здесь выполняется только имитация.</label>' : ''}`,
    `<button class="lg-button" data-dry="${esc(title)}">Пробный запуск</button><button class="lg-button primary" data-execute="${esc(title)}" ${irreversible ? 'disabled' : ''}>${irreversible ? 'Подтвердить имитацию' : 'Имитировать проверку'}</button>`
  );
}
function limits() {
  modal(
    'Лимиты и сроки подарков',
    `<p>Read-only пример. Общие лимиты аккаунта не суммируются по персонажам.</p><div class="lg-scroll"><table><thead><tr><th>Персонаж</th><th>Предмет</th><th>Доступно</th><th>Обновится</th></tr></thead><tbody>${state.characters.flatMap((c, i) => ['Камень светлого духа', 'Знак доблести', 'Сундук средоточия'].map((item, j) => `<tr><th>${esc(c.nick)}</th><td>${item}</td><td>${j === 2 ? 'Не проверено' : `${2 + (i % 2)} из 4 · пример`}</td><td>${j === 0 ? 'Дата неизвестна' : j === 1 ? 'Через 14 дней · пример' : '—'}</td></tr>`)).join('')}</tbody></table></div>`
  );
}
function editForm(type, entity) {
  const item = entity || {};
  let fields;
  if (type === 'characters')
    fields = `<label>Ник<input name="title" required maxlength="60" value="${esc(item.nick || '')}" placeholder="Тестовый персонаж"/></label><label>Класс<select name="className">${['Воин', 'Маг', 'Лучник', 'Жрец', 'Паладин'].map(c => `<option ${c === item.className ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label>Сервер<select name="server"><option>Фенрир</option><option ${item.server === 'Мицар' ? 'selected' : ''}>Мицар</option></select></label><p>Логины и пароли здесь не вводятся. В рабочем приложении секреты открываются отдельно.</p>`;
  else if (type === 'runes')
    fields = `<label>Класс / название<input name="title" required maxlength="60" value="${esc(item.class || '')}"/></label><label>PvE<input name="pve" required maxlength="120" value="${esc(item.pve || '1 · 2 · 3')}"/></label><label>PvP<input name="pvp" required maxlength="120" value="${esc(item.pvp || '3 · 2 · 1')}"/></label><label>Заметка<textarea name="note" maxlength="300">${esc(item.note || '')}</textarea></label>`;
  else if (type === 'bank')
    fields = `<label>Название<input name="title" required maxlength="80" value="${esc(item.title || '')}"/></label><label>Сумма<input name="amount" type="number" required min="1" max="999999999" value="${Math.abs(item.amount || 100)}"/></label><label>Тип<select name="sign"><option value="1">Доход</option><option value="-1" ${item.amount < 0 ? 'selected' : ''}>Расход</option></select></label><label>Валюта<select name="currency">${['Золото', 'Голд', 'Древние монеты'].map(c => `<option ${item.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`;
  else
    fields = `<label>Название<input name="title" required maxlength="80" value="${esc(item.name || item.title || '')}"/></label>${type === 'marathons' ? '<label>Задание<input name=task required maxlength=120 value="Ежедневная отметка"/></label><label>Целевых отметок<input type=number name=target min=1 max=100 required value="7"/></label>' : ''}${type === 'parties' || type === 'marathons' ? accountChoices() : '<label>Описание<textarea name="note" maxlength="300" placeholder="Учебная запись"></textarea></label>'}`;
  modal(
    item.id ? 'Редактировать пример' : 'Добавить учебную запись',
    `<form class="lg-editor" data-edit="${type}" data-id="${esc(item.id || '')}">${fields}<button class="lg-button primary" type="submit">Сохранить в примере</button></form>`
  );
}
function settingsDetail(id) {
  if (id === 'cloud')
    return `<div class="lg-cloud-grid">${['Google Drive', 'Яндекс Диск'].map(name => `<section class="lg-panel"><h3>${name}</h3><span class="lg-status neutral">Не подключён · демо</span><p>Последняя версия: учебный снимок, сегодня 09:40. Подключения независимы.</p><button class="lg-button" data-feature="Проверка различий до применения">Проверить различия</button><button class="lg-text" data-simulated="Скачивание примера версии">Предыдущая версия</button></section>`).join('')}</div><p>Никаких настоящих OAuth-переходов, токенов, ключей или паролей. Контакты и пароли — только отдельный opt-in в рабочей программе.</p>`;
  if (id === 'application' || id === 'automation')
    return `<div class="lg-setting-switches">${[
      ['notifications', 'Уведомления'],
      ['tray', 'Сворачивать в трей'],
      ['checks', 'Фоновые проверки']
    ]
      .map(
        ([key, label]) =>
          `<label>${label}<input type="checkbox" data-pref="${key}" ${state.preferences[key] ? 'checked' : ''}/></label>`
      )
      .join(
        ''
      )}</div><label class="lg-field">Периодичность<select><option>15 минут</option><option>30 минут</option><option>60 минут</option><option>Вручную</option></select></label><p>Параметры только в памяти демо. Реальные таймеры, трей и программы не включаются.</p>`;
  return `<p>Данные и доступ не сбрасываются без явного согласия. Резервная копия и сравнение изменений предшествуют применению.</p><button class="lg-button" data-simulated="Создание локальной резервной копии">Имитировать резервную копию</button><button class="lg-button" data-feature="Проверка различий до применения">Предпросмотр изменений</button><details><summary>Диагностика и парсеры</summary><p>Нет реального подключения; состояние неизвестно. Ошибки и время последней проверки должны быть видны отдельно от версии приложения.</p></details>`;
}
function entry(id) {
  const src = source(),
    e = entriesFor(src, state).find(e => e.id === id);
  if (!e) return;
  state.detail = id;
  if (
    mode === 'next' &&
    validVariant().preferred &&
    ['characters', 'tools', 'settings', 'marathons', 'runes'].includes(src)
  ) {
    render();
    return;
  }
  if (src === 'today') {
    render();
    $('.lg-matrix-detail')?.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  if (src === 'characters') {
    modal(
      e.title,
      `<p>${esc(e.description)}</p><dl class="lg-facets">${Object.entries(e.facets)
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
        .join(
          ''
        )}</dl><p>Аккаунт сайта: ${esc(e.entity.site)}<br/>Игровой аккаунт: ${esc(e.entity.game)}<br/>Пароли скрыты и не используются в демо.</p><button class="lg-button" data-edit-entry="${esc(id)}">Редактировать</button><button class="lg-button primary" data-feature="Вход на сайт">Войти на сайт · имитация</button>`
    );
  } else if (src === 'parties') launchDialog(id);
  else if (src === 'runes' || src === 'bank') editForm(src, e.entity);
  else if (src === 'tools') operation(e.title, e.group === 'Действие' ? 'action' : 'read');
  else if (src === 'settings') modal(e.title, settingsDetail(id));
  else if (src === 'marathons')
    modal(
      e.title,
      `${e.id === 'hero' ? marathonTable(state) : `<p>${esc(e.description)}</p><p>${esc(e.subtitle)}</p>`}<button class="lg-button" data-feature="Ручная корректировка">Корректировать отметку</button><button class="lg-button" data-feature="Задания и пороги наград">Задания и награды</button>`
    );
  else if (src === 'activity')
    modal(
      e.title,
      `<p>${esc(e.description)}</p><p>Состояние: ${esc(e.status)}. Прогресс: ${e.progress}%. Источник — вымышленные данные.</p><button class="lg-button" data-feature="Отчёт скрипта">Развёрнутый отчёт</button>`
    );
  else operation(e.title);
}
function launchDialog(id) {
  const party = state.parties.find(p => p.id === id);
  if (!party) return;
  modal(
    `Запустить пати «${party.name}»`,
    `<p>Выберите персонажей. Будут добавлены только вымышленные окна; настоящий лаунчер не запускается.</p><fieldset>${state.characters
      .filter(c => c.party === id)
      .map(
        c =>
          `<label class="lg-ack"><input type="checkbox" name="launch" value="${esc(c.id)}" checked/> ${esc(c.nick)} · ${esc(c.className)}</label>`
      )
      .join(
        ''
      )}</fieldset><label class="lg-field">Раскладка<select><option>Сетка 2 × 2</option><option>Каскад</option></select></label>`,
    `<button class="lg-button primary" data-confirm-launch="${esc(id)}">Имитировать запуск выбранных</button>`
  );
}
function feature(name) {
  if (mode === 'next' && validVariant().preferred && source() === 'tools') {
    const tool = entriesFor('tools', state).find(e => e.title === name || name.includes(e.title));
    if (/журнал|отчёт|история/i.test(name)) return goSource('activity');
    state.detail = tool?.id || state.detail || 'auth';
    render();
    toast('Параметры операции открыты на странице; реальных действий нет.');
    return;
  }
  if (name === 'Календарь событий')
    return modal(
      'Добавить личное событие',
      `<form class="lg-editor" data-event><label>Название<input name="title" required maxlength="80" placeholder="Учебное событие"/></label><label>Дата<input name="date" type="date" required value="${state.day.date}"/></label><label>Время<input name="time" type="time" required value="19:30"/></label><button class="lg-button primary" type="submit">Сохранить в примере</button></form>`
    );

  if (/лимит|сроки подарков/i.test(name)) return limits();
  if (/различий|применени/i.test(name))
    return modal(
      'Предпросмотр изменений',
      `<p>Учебный снимок. Источник не выбирается автоматически.</p><div class="lg-scroll"><table><thead><tr><th>Тип</th><th>Поле</th><th>Сейчас</th><th>Во входящем снимке</th></tr></thead><tbody><tr><td>Изменение</td><td>Пати персонажа</td><td>Север</td><td>Комета</td></tr><tr><td>Добавление</td><td>Схема рун</td><td>—</td><td>Учебная схема</td></tr><tr><td>Удаление</td><td>Заметка</td><td>Учебная заметка</td><td>—</td></tr></tbody></table></div><label class="lg-ack"><input type="checkbox" data-ack/> Проверил добавления, изменения и удаления. Это только имитация.</label>`,
      `<button class="lg-button primary" data-execute="Применение учебного снимка" disabled>Применить в примере</button>`
    );
  if (/копия схемы/i.test(name)) {
    toast('Учебная схема скопирована внутри примера; системный буфер не менялся.');
    return;
  }
  if (/Ручная корректировка/i.test(name))
    return modal(
      name,
      `<p>Корректировка фиксируется отдельно от отметки сайта.</p><form class="lg-editor" data-adjust><label>Участник<select name="charId">${state.day.marathonProgress.map(r => `<option value="${r.charId}">${esc(state.characters.find(c => c.id === r.charId)?.nick || r.charId)}</option>`).join('')}</select></label><label>Отметок<input type="number" name="completed" required min="0" max="7" value="3"/></label><label>Причина<input name="reason" required maxlength="160" placeholder="Причина учебной корректировки"/></label><button class="lg-button primary" type="submit">Сохранить в демо</button></form>`
    );
  if (/поиск|Теги и поиск/i.test(name)) {
    close();
    const input = $('[data-search]');
    if (input) input.focus();
    else commands();
    return;
  }
  if (/окна|окон/i.test(name) && !/лаунчер|Раскладка/i.test(name)) {
    if (/Закрытие всех/.test(name)) {
      modal(
        name,
        '<p>Закрыть все вымышленные окна? Настоящие программы не затрагиваются.</p>',
        '<button class="lg-button danger" data-close-all-windows>Закрыть окна в примере</button>'
      );
      return;
    }
    close();
    goSource('parties');
    return;
  }
  if (/журнал|История|Отчёт|Экспорт сводки/i.test(name)) {
    modal(
      name,
      `<div class="lg-scroll"><table><thead><tr><th>Время</th><th>Операция</th><th>Результат</th></tr></thead><tbody>${state.jobs.map(j => `<tr><td>${esc(j.time)}</td><th>${esc(j.title)}</th><td>${esc(j.detail)}</td></tr>`).join('')}</tbody></table></div>`
    );
    return;
  }
  if (/Импорт|экспорт|Импорт и экспорт/i.test(name)) {
    modal(
      name,
      '<p>Перенос через файл: сначала проверка формата и различий, затем явное применение. В этом прототипе настоящий файл не читается и не скачивается.</p><div class="lg-preview-box">Учебный снимок · 8 персонажей · 3 пати · 5 схем рун. Ключи, контакты и пароли не включены.</div><button class="lg-button" data-feature="Проверка различий до применения">Показать разницу</button>'
    );
    return;
  }
  if (/Google|Яндекс|облачн|дисках|Контакты и пароли|хранилище|резервн|Безопасность|Локальные/i.test(name))
    return modal(name, settingsDetail(/Google|Яндекс|облачн|дисках/i.test(name) ? 'cloud' : 'security'));
  if (
    /Периодичность|Свежесть|Трей|уведомления|Браузеры|Проверить настройки|Парсеры|диагност|Обновления|Справка|горячие|Обратная связь/i.test(
      name
    )
  )
    return modal(name, settingsDetail('application'));
  if (source() === 'runes' && !/Добавление/.test(name)) return editForm('runes', state.runes[0]);
  if (source() === 'bank' && !/Добавление/.test(name)) {
    close();
    state.filter = 'all';
    render();
    toast('Выберите валюту, категорию или запись в фильтрах раздела. Валюты не суммируются.');
    return;
  }
  if (source() === 'characters' && !/Добавление|Вход на сайт|Проверка авторизации/.test(name))
    return entry(state.characters[0].id);
  if (source() === 'parties' && !/Создание/.test(name)) return launchDialog(state.parties[0].id);
  const next = {
    'Добавление и редактирование': 'characters',
    'Добавление схемы': 'runes',
    'Редактирование схемы': 'runes',
    'Добавление операции': 'bank',
    'Создание и редактирование пати': 'parties',
    'Создание марафона': 'marathons'
  }[name];
  if (next) return editForm(next);
  operation(name, /покуп|передач|активац|сундук|закрытие/i.test(name) ? 'action' : 'read');
}
function map() {
  modal(
    'Карта продукта и доступ ко всем функциям',
    `<p>${mode === 'next' ? 'Структура строится вокруг задач: аккаунты → игровые окна → операции сайта → прогресс. Центр активности объединяет очередь и отчёты.' : '80 вариантов: 10 на каждую из 8 страниц. Исходные снимки не входят в счёт.'}</p>${pages
      .map(
        p =>
          `<section class="lg-map-section"><button class="lg-text" data-map-page="${p.id}"><h3>${icon(p.icon)} ${esc(p.label)} →</h3></button>${p.why ? `<p>${esc(p.why)}</p>` : ''}<ul>${featureList(
            p.source || p.id
          )
            .map(f => `<li>${esc(f)}</li>`)
            .join('')}</ul></section>`
      )
      .join('')}`
  );
}
bindReferenceToday({ root, dialog, getState: () => state, render, modal, toast, launchParty });
root.addEventListener('click', event => {
  const el = event.target.closest('button,[data-action]');
  if (!el) return;
  if (el.hasAttribute('data-page')) return navigate(el.dataset.page);
  if (el.hasAttribute('data-variant')) {
    variant = Number(el.dataset.variant);
    original = false;
    render();
    syncURL();
    return;
  }
  if (el.hasAttribute('data-next') || el.hasAttribute('data-previous')) {
    variant = ((variant - 1 + (el.hasAttribute('data-next') ? 1 : -1) + choices().length) % choices().length) + 1;
    original = false;
    render();
    syncURL();
    return;
  }
  if (el.hasAttribute('data-original')) {
    original = true;
    render();
    syncURL();
    return;
  }
  if (el.hasAttribute('data-reset')) {
    clearTimeout(runTimer);
    state = createLabState();
    render();
    toast('Пример сброшен. Данные приложения не затронуты.');
    return;
  }
  if (el.hasAttribute('data-toggle-archive')) {
    state.showArchive = !state.showArchive;
    state.detail = '';
    render();
    return;
  }
  if (el.hasAttribute('data-site-login')) {
    const c = state.characters.find(c => c.id === el.dataset.siteLogin && !c.archived);
    if (c) c.auth = 'online';
    render();
    toast('Вход изменён только в учебной модели. Сайт не открывался.');
    return;
  }
  if (el.hasAttribute('data-game-launch')) {
    const c = state.characters.find(c => c.id === el.dataset.gameLaunch && !c.archived);
    if (c && !state.activeWindows.some(w => w.charId === c.id))
      state.activeWindows.push({ id: `window-${c.id}`, charId: c.id, title: c.nick });
    render();
    toast('Добавлено только вымышленное окно.');
    return;
  }
  if (el.hasAttribute('data-edit-inline'))
    return editForm(
      'characters',
      state.characters.find(c => c.id === el.dataset.editInline)
    );
  if (el.hasAttribute('data-arrange')) {
    state.arrangement = el.dataset.arrange;
    render();
    return;
  }
  if (el.hasAttribute('data-map')) return map();
  if (el.hasAttribute('data-command')) return commands();
  if (el.hasAttribute('data-open')) return entry(el.dataset.open);
  if (el.hasAttribute('data-detail')) {
    state.detail = el.dataset.detail;
    render();
    return;
  }
  if (el.hasAttribute('data-feature')) return feature(el.dataset.feature);
  if (el.hasAttribute('data-go-source')) return goSource(el.dataset.goSource);
  if (el.hasAttribute('data-clear-search')) {
    state.query = '';
    state.filter = 'all';
    render();
    return;
  }
  if (el.hasAttribute('data-select-all')) {
    visibleEntries(source(), state)
      .filter(e => !e.entity?.archived)
      .forEach(e => state.selected.add(e.id));
    render();
    return;
  }
  if (el.hasAttribute('data-clear-selection')) {
    state.selected.clear();
    render();
    return;
  }
  if (el.hasAttribute('data-launch-party')) return launchDialog(el.dataset.launchParty);
  if (el.hasAttribute('data-close-window')) {
    state.activeWindows = state.activeWindows.filter(w => w.id !== el.dataset.closeWindow);
    render();
    return;
  }
  if (el.hasAttribute('data-rename-window')) {
    const w = state.activeWindows.find(w => w.id === el.dataset.renameWindow);
    if (w)
      modal(
        'Название вымышленного окна',
        `<form class="lg-editor" data-rename="${esc(w.id)}"><label>Название<input name="title" required maxlength="80" value="${esc(w.title)}"/></label><button class="lg-button primary" type="submit">Сохранить</button></form>`
      );
    return;
  }
  if (el.hasAttribute('data-day')) {
    state.day.chosenDay = Number(el.dataset.day);
    render();
    return;
  }
  if (el.hasAttribute('data-month')) {
    state.calendarOffset += Number(el.dataset.month);
    render();
    const month = $('.lg-month');
    if (month) month.open = true;
    return;
  }
  if (el.hasAttribute('data-date')) {
    state.day.chosenDay = Math.round((Date.parse(el.dataset.date) - Date.parse(state.day.date)) / 86400000);
    render();
    const month = $('.lg-month');
    if (month) month.open = true;
    return;
  }
  if (el.hasAttribute('data-calendar-offset')) {
    state.day.chosenDay += Number(el.dataset.calendarOffset);
    render();
    return;
  }
  if (el.hasAttribute('data-vote')) {
    state.vote = el.dataset.vote;
    render();
    toast('Отпись сохранена только в примере.');
    return;
  }
  if (el.hasAttribute('data-demo-poll')) return toast('Голос учтён только в демо. На сайт ничего не отправлено.');
  if (el.hasAttribute('data-check-marathon')) {
    simulateCheck(state);
    render();
    toast('Проверены только участники марафона · имитация. Повтор не удваивает отметки.');
    return;
  }
  if (el.hasAttribute('data-stop')) return stop();
  if (el.hasAttribute('data-primary')) {
    const src = source();
    if (['characters', 'parties', 'runes', 'bank', 'marathons'].includes(src)) editForm(src);
    else if (src === 'settings') entry('application');
    else if (src === 'today') {
      if (validVariant().reference) {
        root.querySelector('[data-today-action=calendar]')?.click();
        return;
      }
      state.detail = 'daily';
      if (mode === 'classic' && variant <= 3) variant = 2;
      render();
      syncURL();
      $('[data-entry=daily]')?.scrollIntoView?.({ block: 'nearest' });
    } else commands();
  }
});
root.addEventListener('submit', event => {
  const form = event.target;
  if (!form.matches('[data-party-editor],[data-operation-editor]')) return;
  event.preventDefault();
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form);
  if (form.hasAttribute('data-party-editor')) {
    const party = state.parties.find(p => p.id === form.dataset.partyEditor);
    if (!party) return;
    party.name = String(data.get('name')).trim();
    party.label = party.name;
    state.detail = party.id;
    const ids = new Set(data.getAll('member'));
    state.characters.forEach(c => {
      if (ids.has(c.id) && !c.archived) c.party = party.id;
      else if (c.party === party.id) c.party = '';
    });
    render();
    toast('Состав сохранён только в демо.');
    return;
  }
  const ids = data.getAll('target').filter(id => state.characters.some(c => c.id === id && !c.archived));
  if (!ids.length) return toast('Выберите хотя бы одного действующего персонажа.');
  if (form.dataset.operationEditor === 'transfer' && Number(data.get('sets')) === 0)
    return toast('Ноль наборов — ничего не передаётся.');
  state.selected = new Set(ids);
  const tool = entriesFor('tools', state).find(e => e.id === form.dataset.operationEditor);
  if (tool.group === 'Действие' && event.submitter?.value !== 'dry' && !data.has('ack'))
    return toast('Подтвердите предметы, количество и получателей.');
  startSimulation(`${tool.title}${event.submitter?.value === 'dry' ? ' · пробный запуск' : ''}`);
});
root.addEventListener('input', event => {
  if (!event.target.matches('[data-search]')) return;
  state.query = event.target.value;
  const cursor = event.target.selectionStart;
  render();
  const input = $('[data-search]');
  input.focus();
  input.setSelectionRange(cursor, cursor);
});
root.addEventListener('change', event => {
  const e = event.target;
  if (e.matches('[data-filter]')) state.filter = e.value;
  else if (e.matches('[data-sort]')) state.sort = e.value;
  else if (e.matches('[data-palette]')) state.palette = e.value;
  else if (e.matches('[data-compact]')) state.compact = e.checked;
  else if (e.matches('[data-select]')) {
    e.checked ? state.selected.add(e.dataset.select) : state.selected.delete(e.dataset.select);
  } else if (e.matches('[data-day-task]')) markDay(state, e.dataset.dayTask, e.checked);
  else if (e.matches('[data-party-select]')) state.day.favoriteParty = e.value;
  else if (e.matches('[data-window-icon]')) {
    const w = state.activeWindows.find(w => w.id === e.dataset.windowIcon);
    if (w) w.icon = e.value;
  } else if (e.matches('[data-pref]')) state.preferences[e.dataset.pref] = e.checked;
  else if (e.matches('[data-setting-text]')) state.preferences[e.dataset.settingText] = e.value;
  else if (e.matches('[data-scenario]')) state.scenarios[e.dataset.scenario] = e.checked;
  else return;
  render();
});
function stop() {
  clearTimeout(runTimer);
  state.runGeneration++;
  if (state.running)
    state.jobs.unshift({
      id: `job-${++state.created}`,
      title: state.running.title,
      state: 'Остановлено',
      progress: 0,
      time: 'Сейчас',
      detail: 'Остановлено пользователем · результат сохранён'
    });
  state.running = null;
  render();
  toast('Имитация остановлена. Отчёт сохранён в памяти примера.');
}
function commands() {
  modal(
    'Быстрые команды',
    `<label class="lg-search">${icon('search')}<input data-command-search placeholder="Найти страницу или действие…" aria-label="Найти команду"/></label><div class="lg-command-list">${pages.map(p => `<button data-map-page="${p.id}">${icon(p.icon)} ${esc(p.label)}<small>Страница</small></button>`).join('')}${featureList(
      source()
    )
      .map(f => `<button data-feature="${esc(f)}">${esc(f)}<small>Действие в демо</small></button>`)
      .join('')}</div>`
  );
  setTimeout(() => dialog.querySelector('[data-command-search]')?.focus(), 0);
}
dialog.addEventListener('click', event => {
  const el = event.target.closest('button');
  if (event.target === dialog) return close();
  if (!el) return;
  if (el.hasAttribute('data-feature')) return feature(el.dataset.feature);
  if (el.hasAttribute('data-map-page')) {
    close();
    return navigate(el.dataset.mapPage);
  }
  if (el.hasAttribute('data-edit-entry'))
    return editForm(source(), entriesFor(source(), state).find(e => e.id === el.dataset.editEntry)?.entity);
  if (el.hasAttribute('data-simulated'))
    return toast(`${el.dataset.simulated}: только имитация, файлы и данные не менялись.`);
  if (el.hasAttribute('data-limits')) return limits();
  if (el.hasAttribute('data-close-all-windows')) {
    state.activeWindows = [];
    close();
    render();
    toast('Закрыты только вымышленные окна.');
    return;
  }
  if (
    el.hasAttribute('data-dry') &&
    dialog.querySelector('[name=target]') &&
    !dialog.querySelector('[name=target]:checked')
  )
    return toast('Пустой выбор — ничего не запускается.');
  if (el.hasAttribute('data-dry'))
    return startSimulation(`${el.dataset.dry} · пробный запуск`, 'Ничего не изменено · имитация');
  if (el.hasAttribute('data-execute')) {
    if (el.disabled) return;
    const sets = dialog.querySelector('[data-transfer-sets]');
    if (sets && Number(sets.value) === 0) return toast('Ноль наборов — ничего не передаётся.');
    if (sets && !sets.checkValidity()) {
      sets.reportValidity();
      return;
    }
    if (dialog.querySelector('[name=target]') && !dialog.querySelector('[name=target]:checked'))
      return toast('Выберите хотя бы одного персонажа.');
    return startSimulation(el.dataset.execute);
  }
  if (el.hasAttribute('data-confirm-launch')) {
    const ids = [...dialog.querySelectorAll('[name=launch]:checked')].map(e => e.value);
    if (!ids.length) return toast('Пустой выбор — ничего не запускается.');
    launchParty(state, el.dataset.confirmLaunch, ids);
    close();
    render();
    toast('Добавлены только вымышленные окна.');
  }
  if (el.hasAttribute('data-check-marathon')) {
    simulateCheck(state);
    dialog.querySelector('.lg-dialog-body').innerHTML = marathonTable(state);
    render();
    toast('Сверка участников имитирована.');
  }
});
dialog.addEventListener('change', event => {
  const el = event.target;
  if (el.matches('[data-ack]')) {
    const b = dialog.querySelector('[data-execute]');
    if (b) b.disabled = !el.checked;
  }
  if (el.matches('[data-pref]')) {
    state.preferences[el.dataset.pref] = el.checked;
    toast('Параметр изменён только в памяти демо.');
  }
});
dialog.addEventListener('input', event => {
  const el = event.target;
  if (el.matches('[data-command-search]')) {
    const q = el.value.toLocaleLowerCase('ru-RU');
    dialog
      .querySelectorAll('.lg-command-list button')
      .forEach(b => (b.hidden = !b.textContent.toLocaleLowerCase('ru-RU').includes(q)));
  }
  if (el.matches('[data-transfer-sets]')) {
    const n = Number(el.value);
    dialog.querySelector('[data-transfer-total]').textContent =
      el.value && Number.isInteger(n) && n >= 0 && n <= 21
        ? `${n * 25} предметов`
        : 'Укажите целое число наборов от 0 до 21';
    if (el.checkValidity()) state.transferSets = n;
  }
});
dialog.addEventListener('submit', event => {
  const form = event.target;
  if (form.matches('[method=dialog]')) return;
  event.preventDefault();
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form),
    title = String(data.get('title') || '').trim();
  if (form.hasAttribute('data-event')) {
    if (!title) return;
    state.calendarEvents.push({ title, date: String(data.get('date')), time: String(data.get('time')) });
    state.day.chosenDay = Math.round((Date.parse(String(data.get('date'))) - Date.parse(state.day.date)) / 86400000);
  } else if (form.hasAttribute('data-rename')) {
    const w = state.activeWindows.find(w => w.id === form.dataset.rename);
    if (w && title) w.title = title;
  } else if (form.hasAttribute('data-adjust')) {
    const row = state.day.marathonProgress.find(r => r.charId === data.get('charId'));
    if (row) row.completed = Number(data.get('completed'));
  } else if (form.hasAttribute('data-edit')) {
    const type = form.dataset.edit,
      id = form.dataset.id || `new-${++state.created}`;
    if (!title) return;
    if (type === 'characters') {
      const old = state.characters.find(c => c.id === id);
      const item = {
        ...(old || state.characters[0]),
        id,
        nick: title,
        className: String(data.get('className')),
        server: String(data.get('server')),
        auth: old?.auth || 'offline'
      };
      if (old) Object.assign(old, item);
      else state.characters.push(item);
    }
    if (type === 'runes') {
      const item = {
        id,
        class: title,
        author: 'Автор демо',
        pve: String(data.get('pve')),
        pvp: String(data.get('pvp')),
        note: String(data.get('note')),
        additional: ''
      };
      const old = state.runes.find(r => r.id === id);
      if (old) Object.assign(old, item);
      else state.runes.push(item);
    }
    if (type === 'bank') {
      const item = {
        id,
        title,
        amount: Number(data.get('amount')) * Number(data.get('sign')),
        currency: String(data.get('currency')),
        category: 'Учебная запись',
        time: 'Сейчас'
      };
      const old = state.ledger.find(r => r.id === id);
      if (old) Object.assign(old, item);
      else state.ledger.unshift(item);
    }
    if (type === 'parties') {
      state.parties.push({ id, name: title, label: `Пати «${title}»` });
      const ids = [...form.querySelectorAll('[name=target]:checked')].map(e => e.value);
      state.characters.filter(c => ids.includes(c.id)).forEach(c => (c.party = id));
    }
    if (type === 'marathons') {
      const count = form.querySelectorAll('[name=target]:checked').length;
      state.extraMarathons.push({
        id,
        title,
        subtitle: `${count} участников · учебное событие`,
        description: String(data.get('task')),
        group: 'Черновики',
        status: 'Черновик',
        metric: 'Заданы участники и цель',
        progress: 0,
        facets: {
          Участники: count,
          Задание: String(data.get('task')),
          Цель: Number(data.get('target')),
          Срок: 'Не задан'
        }
      });
    }
  }
  close();
  render();
  toast('Сохранено только в памяти демонстрации.');
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    commands();
  }
});
window.addEventListener('message', event => {
  const marathon = [...root.querySelectorAll('[data-marathon-original]')].find(f => f.contentWindow === event.source);
  if (marathon && event.origin === 'null' && event.data?.type === 'tf-demo:ready') {
    marathon.contentWindow.postMessage({ type: 'tf-demo:navigate', section: 'marathons' }, '*');
    return;
  }
  const frame = $('#lg-original-frame');
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== 'null' ||
    event.data?.type !== 'tf-demo:ready' ||
    !original
  )
    return;
  frame.contentWindow.postMessage({ type: 'tf-demo:navigate', section: originalSection() }, '*');
});
window.addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search);
  page = pages.find(p => p.id === q.get('page'))?.id || pages[0].id;
  variant = Number(q.get('variant')) || 1;
  original = q.get('original') === '1';
  render();
});
render();
syncURL();
