// Мини-игра «Коллекция» (/minigames.php?game=collection&doo=display) в ВИДИМОМ окне персонажа (Issue #72).
// Слева под панелью «Помощник входа» рисуется сворачиваемая панель «Коллекция»:
//  1) «Проверить» — только читает состояние (карточки, прогресс категорий) и показывает, что сделает запуск; ничего не нажимает;
//  2) «Старт» — после подтверждения открывает карточки, обменивает собранные категории ниже цели на следующую,
//     забирает приз целевой категории (и, по выбору, выше неё) и останавливается, когда карточки закончились,
//     достигнут лимит запуска, собрана категория выше цели или сайт показал проверку безопасности;
//  3) после каждого запуска отчёт уходит в журнал приложения («Настройки → Журналы → Коллекция») через hash `#TFCOL1_<json>`:
//     приложение само забирает его и убирает hash; пока отчёт не принят, он лежит в localStorage профиля и отправляется снова;
//  4) статистика: сколько карточек какой категории выпало за запуск и за сессию окна (sessionStorage), доли, призы, обмены, скорость.
// Это четвёртый «скрипт действия»: запуск только по кнопке пользователя, есть пробная проверка и «Стоп», расписаний нет,
// «Проверка безопасности» не решается, наружу ничего не отправляется (запросы идут только на тот же сайт, как у самой игры).
// Скрипт вшит как initialization_script, срабатывает в каждом документе окна и сам проверяет адрес.
// Панель — closed shadow DOM, как у «Помощника входа» и панели «Типы предметов».
(function () {
  if (window.top !== window || window.__tfCollection) return;
  const params = new URLSearchParams(String(location.search || ''));
  if (!/\/minigames\.php$/i.test(String(location.pathname || '')) || params.get('game') !== 'collection') return;
  if (params.get('doo') && params.get('doo') !== 'display') return;
  try {
    Object.defineProperty(window, '__tfCollection', { value: true, configurable: true });
  } catch (e) {
    window.__tfCollection = true;
  }

  const HOST_ID = '__tf_collection_panel__';
  const LOGIN_ID = '__tf_login_panel__';
  const PREFS_KEY = '__tf_col_prefs';
  const STATS_KEY = '__tf_col_stats';
  const COLLAPSED_KEY = '__tf_col_collapsed';
  const OUTBOX_KEY = '__tf_col_outbox';       // отчёты, которые приложение ещё не забрало
  const HASH_PREFIX = 'TFCOL1_';              // не «TF_»: окно с такой страницей приложение не считает служебной
  const OUTBOX_MAX = 20;
  const BATCH = 5;                            // сколько отчётов за раз кладём в адрес
  const CATS = [1, 2, 3, 4, 5, 6];
  // Сколько карточек нужно для завершения категории: 5 для 1–5, 10 фрагментов для 6-й (правила на странице акции)
  // С неоткрытых карточек падают только категории 1–5; 6-я (фрагменты) даётся лишь обменом 5 карт пятой категории
  const DROP_CATS = [1, 2, 3, 4, 5];
  const LIMITS = { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 10 };
  const COLORS = { 1: '#9aa0ad', 2: '#6fcf97', 3: '#56b6f7', 4: '#b48cf2', 5: '#f0b84a', 6: '#f06a6a' };
  const PAUSE_TURN = [350, 800];     // пауза перед каждой карточкой, мс (щадящая нагрузка на сайт)
  const PAUSE_ACTION = [250, 500];   // пауза перед обменом/получением приза, мс
  const MAX_TURNS = 5000;            // страховка от бесконечного цикла за один запуск
  const MAX_FAILS = 3;               // подряд неудачных чтений/открытий до остановки
  const LOG_LIMIT = 8;
  const doc = document;
  const create = Document.prototype.createElement;
  const attach = Element.prototype.attachShadow;
  const later = window.setTimeout.bind(window);
  const every = window.setInterval.bind(window);
  const doFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const sleep = (ms) => new Promise((resolve) => later(resolve, ms));
  const jitter = (range) => range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  const zeros = () => CATS.reduce((o, c) => { o[c] = 0; return o; }, {});

  /* ---------------------------- хранилище ---------------------------- */

  function load(storage, key, fallback) {
    try {
      const raw = window[storage].getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(storage, key, value) {
    try { window[storage].setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) { /* не критично */ }
  }

  const clampCat = (n) => (CATS.indexOf(Number(n)) >= 0 ? Number(n) : 5);
  function normPrefs(p) {
    const above = p && p.above != null && p.above !== 'stop' ? Number(p.above) : 'stop';
    const max = Math.max(0, Math.floor(Number(p && p.maxCards) || 0));
    return {
      target: clampCat(p && p.target),
      above: CATS.indexOf(above) >= 0 ? above : 'stop',
      maxCards: Math.min(max, 100000),
      anim: !(p && p.anim === false)
    };
  }
  let prefs = normPrefs(load('localStorage', PREFS_KEY, null));
  const savePrefs = () => save('localStorage', PREFS_KEY, prefs);

  function newStats() {
    return { opened: 0, unknown: 0, drops: zeros(), claimed: zeros(), promoted: zeros(), ms: 0, runs: 0 };
  }
  function normStats(s) {
    const base = newStats();
    if (!s || typeof s !== 'object') return base;
    CATS.forEach((c) => {
      ['drops', 'claimed', 'promoted'].forEach((k) => { base[k][c] = Math.max(0, Number(s[k] && s[k][c]) || 0); });
    });
    ['opened', 'unknown', 'ms', 'runs'].forEach((k) => { base[k] = Math.max(0, Number(s[k]) || 0); });
    return base;
  }
  let session = normStats(load('sessionStorage', STATS_KEY, null));   // за всё время жизни окна
  let run = newStats();                                               // за последний запуск
  const saveSession = () => save('sessionStorage', STATS_KEY, session);

  /* ------------------------------- сайт ------------------------------- */

  /** Остановка запуска с понятной причиной: kind — 'ok' (штатно), 'warn' (решение за пользователем), 'error'. */
  class Stop extends Error {
    constructor(code, message, kind) {
      super(message);
      this.code = code;
      this.kind = kind || 'error';
    }
  }

  let urls = null;
  function resolveUrls() {
    const root = doc.getElementById('collection');
    if (!root) return null;
    const info = new URL(root.getAttribute('data-info') || '/minigames.php?game=collection&doo=info', location.href);
    const turn = new URL(root.getAttribute('data-turn') || '/minigames.php?game=collection&doo=turn', location.href);
    if (info.origin !== location.origin || turn.origin !== location.origin) return null;
    return { info: info.href, turn: turn.href, base: info };
  }
  function actionUrl(doo, category) {
    const u = new URL(urls.base.href);
    u.searchParams.set('doo', doo);
    if (category) u.searchParams.set('category', String(category));
    return u.href;
  }

  async function fetchText(url) {
    if (!doFetch) throw new Stop('no_fetch', 'Окно не поддерживает запросы страницы.');
    const res = await doFetch(url, { credentials: 'same-origin', cache: 'no-store' });
    return String(await res.text());
  }

  /** Страница вместо JSON: вход потерян или сайт показывает проверку. Проверку мы не решаем. */
  function explainHtml(text) {
    if (/проверк[аи] безопасности|captcha|капч/i.test(text)) {
      return new Stop('challenge', 'Сайт показал проверку безопасности. Пройдите её сами и запустите снова.', 'warn');
    }
    if (/не авторизованы|Предупреждение/i.test(text)) {
      return new Stop('logged_out', 'Вы не вошли на сайт. Войдите в окне персонажа и запустите снова.', 'warn');
    }
    return null;
  }

  /** Состояние игры: { rows: {1..6}, quantity }. Любое отклонение формата — ошибка, а не «ноль карточек». */
  function parseState(text) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') {
      throw explainHtml(text) || new Stop('layout', 'Сайт ответил не так, как ожидалось: возможно, игра изменилась.');
    }
    const rows = data.rows;
    const quantity = parseInt(data.quantity, 10);
    if (!rows || typeof rows !== 'object' || !isFinite(quantity)) {
      throw new Stop('layout', 'В ответе сайта нет карточек или счётчика: возможно, игра изменилась.');
    }
    const out = {};
    CATS.forEach((c) => {
      const n = Number(rows['row' + c]);
      if (!isFinite(n) || n < 0) throw new Stop('layout', 'В ответе сайта нет данных категории ' + c + '.');
      out[c] = n;
    });
    return { rows: out, quantity: quantity };
  }

  /** Чтение состояния с повторами: читать можно безопасно. */
  async function readState() {
    let last = null;
    for (let i = 0; i < MAX_FAILS; i++) {
      try {
        return parseState(await fetchText(urls.info));
      } catch (e) {
        if (e instanceof Stop && e.code !== 'layout') throw e;
        last = e;
        if (e instanceof Stop) break;          // формат изменился: повтор не поможет
        await sleep(400 * (i + 1));
      }
    }
    throw last instanceof Stop ? last : new Stop('network', 'Не удалось прочитать состояние игры: проверьте соединение.');
  }

  /** Действие, меняющее игру. Повторов нет: результат проверяется по новому состоянию. */
  async function act(doo, category) {
    try {
      const text = await fetchText(doo === 'turn' ? urls.turn : actionUrl(doo, category));
      if (/^\s*</.test(text)) {
        const why = explainHtml(text);
        if (why) throw why;
      }
    } catch (e) {
      if (e instanceof Stop) throw e;
      /* сетевая ошибка: возможно, действие дошло до сайта; решит новое состояние */
    }
  }

  /* ------------------------------ движок ------------------------------ */

  /** Что делать с завершённой категорией: 'promote' | 'claim' | 'stop'. */
  function decide(category, plan) {
    if (category < plan.target) return 'promote';
    if (category === plan.target) return 'claim';
    if (plan.above !== 'stop' && category <= plan.above) return 'claim';
    return 'stop';
  }
  const isDone = (rows, c) => rows[c] >= LIMITS[c];

  /** Ход пробной проверки: какие действия ждут уже сейчас (без нажатий). */
  function describePlan(state, plan) {
    const lines = [];
    CATS.forEach((c) => {
      if (!isDone(state.rows, c)) return;
      const d = decide(c, plan);
      if (d === 'promote') lines.push('Категория ' + c + ' собрана: будет обмен на ' + (c + 1) + '-ю.');
      else if (d === 'claim') lines.push('Категория ' + c + ' собрана: будет получен приз.');
      else lines.push('Категория ' + c + ' собрана выше цели: запуск остановится.');
    });
    return lines;
  }

  function addTo(target, key, category) {
    target[key][category] += 1;
  }
  function record(key, category) {
    addTo(run, key, category);
    addTo(session, key, category);
    saveSession();
  }

  // Эффекты панели: чисто визуальные (CSS), запросы их не ждут и скорость открытия карточек не меняют
  const FEED_LIMIT = 24;
  let pending = [];        // эффекты для ближайшей перерисовки: { cat, label, kind }
  let feed = [];           // категории последних выпавших карточек (новые в конце)
  const fx = (cat, label, kind) => { if (prefs.anim) pending.push({ cat: cat, label: label, kind: kind }); };

  let ui = null;           // { update(), log(text, kind) } после монтирования
  let status = { state: 'idle', text: '', kind: 'info', game: null, stamp: null };
  let abort = false;
  let timer = null;

  const note = (text, kind) => { if (ui) ui.log(text, kind); };
  const refreshUi = () => { if (ui) ui.update(); };

  async function runLoop(plan) {
    let state = await readState();
    status.game = state;
    refreshUi();
    let turns = 0;
    let fails = 0;
    let stuck = '';
    let stuckCount = 0;
    while (!abort) {
      // 1. завершённые категории: по возрастанию, после каждого действия состояние читаем заново
      const ready = CATS.filter((c) => isDone(state.rows, c))[0];
      if (ready) {
        const action = decide(ready, plan);
        if (action === 'stop') {
          throw new Stop('above', 'Собрана категория ' + ready + ' выше цели. Решите сами: заберите приз на сайте или запустите заново с другой настройкой.', 'warn');
        }
        const key = action + ':' + ready + ':' + state.rows[ready];
        stuckCount = key === stuck ? stuckCount + 1 : 0;
        stuck = key;
        if (stuckCount >= 2) throw new Stop('stuck', 'Сайт не принимает действие для категории ' + ready + '. Проверьте страницу вручную.');
        await sleep(jitter(PAUSE_ACTION));
        if (abort) break;
        await act(action === 'claim' ? 'get_item' : 'get_next', ready);
        if (action === 'claim') {
          record('claimed', ready);
          fx(ready, '🏆', 'claim');
          note('🏆 Забран приз категории ' + ready, 'ok');
        } else {
          record('promoted', ready);
          fx(ready, '−' + LIMITS[ready], 'out');
          fx(ready + 1, '+1', 'in');
          note('🔁 Обмен: категория ' + ready + ' → ' + (ready + 1), 'info');
        }
        state = await readState();
        status.game = state;
        refreshUi();
        continue;
      }
      // 2. причины остановиться
      if (state.quantity <= 0) throw new Stop('empty', 'Карточки закончились.', 'ok');
      if (plan.maxCards > 0 && turns >= plan.maxCards) throw new Stop('limit', 'Достигнут лимит запуска: ' + plan.maxCards + ' карт.', 'ok');
      if (turns >= MAX_TURNS) throw new Stop('cap', 'Достигнут предел одного запуска: ' + MAX_TURNS + ' карт.', 'ok');
      // 3. открываем карточку
      await sleep(jitter(PAUSE_TURN));
      if (abort) break;
      await act('turn');
      turns++;
      const next = await readState();
      let dropped = 0;
      DROP_CATS.forEach((c) => { if (!dropped && next.rows[c] > state.rows[c]) dropped = c; });
      if (dropped) {
        fails = 0;
        run.opened += 1;
        session.opened += 1;
        record('drops', dropped);
        feed.push(dropped);
        if (feed.length > FEED_LIMIT) feed.shift();
        fx(dropped, '+1', 'drop');
        note('🃏 Выпала категория ' + dropped + ' (' + next.rows[dropped] + '/' + LIMITS[dropped] + ')', 'info');
      } else if (next.quantity < state.quantity) {
        fails = 0;
        run.opened += 1; run.unknown += 1;
        session.opened += 1; session.unknown += 1;
        saveSession();
        note('❔ Карточка открыта, но категория не определена', 'warn');
      } else {
        fails++;
        note('⚠️ Карточка не открылась (' + fails + '/' + MAX_FAILS + ')', 'warn');
        if (fails >= MAX_FAILS) throw new Stop('no_progress', 'Карточки не открываются. Обновите страницу и проверьте игру вручную.');
      }
      state = next;
      status.game = state;
      refreshUi();
    }
  }

  /* ----------------------- отчёт для журнала приложения ----------------------- */

  const loadOutbox = () => { const v = load('localStorage', OUTBOX_KEY, []); return Array.isArray(v) ? v : []; };
  const pick = (o, list) => list.reduce((r, c) => { r[c] = o[c] || 0; return r; }, {});

  /** Отчёт о запуске: без личных данных (ник добавляет приложение по окну). */
  function makeReport(plan, started, spent, outcome) {
    return {
      v: 1,
      id: started.toString(36) + Math.random().toString(36).slice(2, 7),
      start: new Date(started).toISOString(),
      end: new Date(started + spent).toISOString(),
      ms: spent,
      target: plan.target,
      above: plan.above,
      maxCards: plan.maxCards,
      opened: run.opened,
      unknown: run.unknown,
      drops: pick(run.drops, DROP_CATS),
      claimed: pick(run.claimed, CATS),
      promoted: pick(run.promoted, DROP_CATS),
      left: status.game ? status.game.quantity : null,
      code: outcome.code,
      kind: outcome.kind,
      message: String(outcome.message || '').slice(0, 200)
    };
  }
  /** Стоит ли писать запуск в журнал: что-то сделано или он закончился проблемой. */
  const worthLogging = (outcome) => run.opened > 0 || sum(run.claimed) > 0 || sum(run.promoted) > 0 || outcome.kind !== 'ok';

  let ackTimer = null;
  /** Кладёт непринятые отчёты в hash адреса; приложение забирает их и очищает hash — это и есть подтверждение. */
  function flush() {
    const box = loadOutbox();
    if (!box.length) return;
    const batch = box.slice(0, BATCH);
    try {
      window.location.hash = HASH_PREFIX + encodeURIComponent(JSON.stringify({ data: { reports: batch }, error: null }));
    } catch (e) {
      return;
    }
    waitAck(batch.map((r) => r.id));
  }
  function waitAck(ids) {
    if (ackTimer) window.clearInterval(ackTimer);
    let ticks = 0;
    ackTimer = every(() => {
      ticks += 1;
      if (String(window.location.hash || '').indexOf('#' + HASH_PREFIX) === 0) {
        if (ticks > 300) { window.clearInterval(ackTimer); ackTimer = null; }   // приложения рядом нет: отчёты остаются в outbox
        return;
      }
      window.clearInterval(ackTimer);
      ackTimer = null;
      const rest = loadOutbox().filter((r) => ids.indexOf(r.id) < 0);
      save('localStorage', OUTBOX_KEY, rest);
      note('📚 Запуск записан в журнал приложения', 'ok');
      refreshUi();
      if (rest.length) flush();
    }, 1000);
  }
  function emit(report) {
    const box = loadOutbox();
    box.push(report);
    save('localStorage', OUTBOX_KEY, box.slice(-OUTBOX_MAX));
    flush();
  }

  async function start(plan) {
    if (status.state === 'running' || status.state === 'stopping') return;
    if (!urls) { status = { state: 'done', text: 'Не найдено поле игры на странице.', kind: 'error', game: null, stamp: null }; refreshUi(); return; }
    run = newStats();
    feed = [];
    pending = [];
    abort = false;
    const started = Date.now();
    status = { state: 'running', text: 'Идёт сбор…', kind: 'info', game: status.game, stamp: status.stamp };
    session.runs += 1;
    saveSession();
    timer = every(() => { run.ms = Date.now() - started; refreshUi(); }, 1000);
    note('▶ Запуск: цель — категория ' + plan.target + (plan.above === 'stop' ? '' : ', выше цели — до ' + plan.above), 'info');
    let outcome = null;
    try {
      await runLoop(plan);
      outcome = abort ? new Stop('stopped', 'Остановлено вами.', 'ok') : null;
    } catch (e) {
      outcome = e instanceof Stop ? e : new Stop('error', 'Непредвиденная ошибка: ' + ((e && e.message) || e));
    }
    window.clearInterval(timer);
    timer = null;
    const spent = Date.now() - started;
    session.ms += spent;
    run.ms = spent;
    saveSession();
    outcome = outcome || new Stop('stopped', 'Остановлено.', 'ok');
    status = { state: 'done', text: outcome.message, kind: outcome.kind, game: status.game, stamp: status.stamp };
    note((outcome.kind === 'ok' ? '✅ ' : outcome.kind === 'warn' ? '⚠️ ' : '⛔ ') + outcome.message, outcome.kind);
    refreshUi();
    if (worthLogging(outcome)) emit(makeReport(plan, started, spent, outcome));
  }

  async function check(plan) {
    if (status.state === 'running' || status.state === 'stopping') return;
    if (!urls) { status = { state: 'idle', text: 'Не найдено поле игры на странице.', kind: 'error', game: null, stamp: null }; refreshUi(); return; }
    status = { state: 'checking', text: 'Читаю состояние…', kind: 'info', game: status.game, stamp: status.stamp };
    refreshUi();
    try {
      const state = await readState();
      const lines = describePlan(state, plan);
      status = {
        state: 'idle',
        text: 'Карточек: ' + state.quantity + '. ' + (lines.length ? lines.join(' ') : 'Завершённых категорий нет: запуск начнёт с открытия карточек.') + ' Ничего не нажималось.',
        kind: 'info', game: state, stamp: Date.now()
      };
    } catch (e) {
      const stop = e instanceof Stop ? e : new Stop('error', 'Не удалось проверить: ' + ((e && e.message) || e));
      status = { state: 'idle', text: stop.message, kind: stop.kind, game: status.game, stamp: status.stamp };
    }
    refreshUi();
  }

  function stop() {
    if (status.state !== 'running') return;
    abort = true;
    status.state = 'stopping';
    status.text = 'Останавливаю после текущего запроса…';
    refreshUi();
  }

  /* ----------------------------- статистика ----------------------------- */

  const pct = (n, total) => (total > 0 ? ((n * 100) / total).toFixed(1) : '0.0');
  function fmtTime(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
  }
  const rate = (s) => (s.ms >= 5000 ? Math.round((s.opened * 60000) / s.ms) : null);
  const sum = (o) => CATS.reduce((a, c) => a + o[c], 0);

  function statsText() {
    const lines = ['Коллекция — статистика окна'];
    lines.push('Открыто карточек: ' + session.opened + ' (последний запуск: ' + run.opened + ')');
    DROP_CATS.forEach((c) => {
      lines.push(c + ' категория: ' + session.drops[c] + ' | ' + pct(session.drops[c], session.opened) + '%');
    });
    lines.push('6 категория: только обмен, получено ' + session.promoted[5]);
    const claimed = CATS.filter((c) => session.claimed[c]).map((c) => c + '-я ×' + session.claimed[c]);
    lines.push('Призы: ' + (claimed.length ? claimed.join(', ') : 'нет'));
    lines.push('Обменов: ' + sum(session.promoted));
    lines.push('Время работы: ' + fmtTime(session.ms) + (rate(session) ? ' (~' + rate(session) + ' карт/мин)' : ''));
    lines.push('Запусков: ' + session.runs);
    return lines.join('\n');
  }

  /* ------------------------------- панель ------------------------------- */

  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}',
    '.card{width:300px;max-height:var(--tf-max,70vh);overflow:auto;background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 10px 10px 0;padding:10px;box-shadow:0 4px 18px rgba(0,0,0,.45);font-size:12px}',
    '.tab{background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 8px 8px 0;padding:10px 6px;cursor:pointer;font-size:12px;writing-mode:vertical-rl}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}',
    '.title{font-weight:700;color:#f0b84a;font-size:13px}',
    '.muted{color:#9aa0ad;font-size:11px}',
    '.sec{margin-top:8px;padding-top:8px;border-top:1px solid #2d323d}',
    '.lbl{color:#9aa0ad;font-size:11px;margin-bottom:3px}',
    '.seg{display:flex}',
    '.seg button{flex:1;border-radius:0;padding:3px 0}',
    '.seg button:first-child{border-radius:5px 0 0 5px}',
    '.seg button:last-child{border-radius:0 5px 5px 0}',
    '.seg button.on{background:#f0b84a;color:#1c1f26;border-color:#f0b84a;font-weight:700}',
    '.seg button:disabled{opacity:.5;cursor:default}',
    'select,input{width:100%;background:#2d323d;color:#e8e8ea;border:1px solid #444a58;border-radius:5px;padding:3px 6px;font-size:12px}',
    'select:disabled,input:disabled{opacity:.5}',
    '.btns{display:flex;gap:6px;margin-top:8px}',
    '.btns button{flex:1;padding:5px 7px}',
    'button{background:#2d323d;color:#e8e8ea;border:1px solid #444a58;border-radius:5px;cursor:pointer;padding:2px 7px;font-size:12px}',
    'button:hover:not(:disabled){border-color:#f0b84a}',
    'button:disabled{opacity:.5;cursor:default}',
    'button.go{background:#f0b84a;color:#1c1f26;border-color:#f0b84a;font-weight:700}',
    'button.stop{background:#b8453d;border-color:#b8453d;font-weight:700}',
    '.warn{margin-top:8px;padding:7px;border:1px solid #f0b84a;border-radius:6px;background:#2a2518;color:#e6c25a}',
    '.status{margin-top:8px;padding:6px 7px;border-radius:6px;background:#232733;line-height:1.35}',
    '.status.ok{color:#8fd694}.status.warn{color:#e6c25a}.status.error{color:#ff9d93}',
    '.prog{display:grid;grid-template-columns:18px 1fr 38px;gap:6px;align-items:center;margin:3px 0}',
    '.bar{height:7px;background:#2d323d;border-radius:4px;overflow:hidden}',
    '.fill{height:100%;border-radius:4px}',
    '.num{text-align:right;color:#9aa0ad;font-size:11px}',
    'table{width:100%;border-collapse:collapse;margin-top:4px}',
    'th{color:#9aa0ad;font-weight:400;font-size:11px;text-align:right;padding:2px 0}',
    'th:first-child,td:first-child{text-align:left}',
    'td{padding:3px 0;border-top:1px solid #2d323d;text-align:right}',
    'td.share{width:104px;white-space:nowrap}',
    '.share .bar{display:inline-block;width:50px;vertical-align:middle;margin-right:4px}',
    'tr.total td{font-weight:700;color:#f0b84a}',
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}',
    'details{margin-top:8px;color:#e6c25a;font-size:11px}',
    'summary{cursor:pointer}',
    'ul{margin:4px 0 0;padding-left:16px;color:#e8e8ea;font-weight:400;max-height:140px;overflow:auto}',
    'li.ok{color:#8fd694}li.warn{color:#e6c25a}li.error{color:#ff9d93}',
    '@keyframes tfglow{0%{box-shadow:0 0 0 2px var(--c),0 0 10px var(--c)}100%{box-shadow:0 0 0 2px transparent}}',
    '@keyframes tfrise{0%{transform:translateY(10px) scale(.6);opacity:0}25%{opacity:1;transform:translateY(0) scale(1.15)}100%{transform:translateY(-12px);opacity:0}}',
    '@keyframes tfpop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.3);opacity:1}100%{transform:scale(1)}}',
    '.prog{position:relative;border-radius:4px}',
    '.prog.hit{animation:tfglow .6s ease-out}',
    '.fx{position:absolute;right:44px;top:-4px;font-size:11px;font-weight:700;pointer-events:none;animation:tfrise .8s ease-out forwards}',
    '.fx.claim{font-size:14px}',
    '.feed{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}',
    '.feed i{width:16px;height:16px;border-radius:4px;font-style:normal;font-size:10px;font-weight:700;line-height:16px;text-align:center;color:#1c1f26}',
    '.feed i.new{animation:tfpop .35s ease-out}',
    '.chk{display:flex;align-items:center;gap:6px;margin-top:8px;color:#9aa0ad;font-size:11px;cursor:pointer}',
    '.chk input{width:auto;margin:0}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'
  ].join('');

  let collapsed = load('localStorage', COLLAPSED_KEY, '') === '1';
  let confirming = false;
  let host = null;
  let box = null;
  const logLines = [];
  const make = (tag, cls, text) => {
    const n = create.call(doc, tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const busy = () => status.state === 'running' || status.state === 'stopping' || status.state === 'checking';

  function place() {
    if (!host) return;
    const login = doc.getElementById(LOGIN_ID);
    let top = 90;
    if (login) {
      const r = login.getBoundingClientRect();
      if (r && r.bottom > 0) top = Math.round(r.bottom) + 10;
    }
    host.style.top = top + 'px';
    host.style.setProperty('--tf-max', Math.max(120, (window.innerHeight || 800) - top - 16) + 'px');
  }

  const planNow = () => ({ target: prefs.target, above: prefs.above, maxCards: prefs.maxCards });

  function aboveLabel(value) {
    return value === 'stop' ? 'остановиться и спросить' : 'забрать все до ' + value + '-й включительно';
  }

  function progressBlock() {
    const wrap = make('div', 'sec');
    wrap.appendChild(make('div', 'lbl', status.game
      ? 'Карточек: ' + status.game.quantity + (status.stamp ? ' · проверено ' + new Date(status.stamp).toLocaleTimeString('ru-RU') : '')
      : 'Состояние игры ещё не читалось — нажмите «Проверить»'));
    CATS.forEach((c) => {
      const have = status.game ? Math.min(status.game.rows[c], LIMITS[c]) : 0;
      const hits = pending.filter((f) => f.cat === c);
      const row = make('div', hits.length ? 'prog hit' : 'prog');
      row.style.setProperty('--c', COLORS[c]);
      hits.forEach((f) => { const chip = make('span', 'fx ' + f.kind, f.label); chip.style.color = COLORS[c]; row.appendChild(chip); });
      row.appendChild(make('span', '', String(c)));
      const bar = make('div', 'bar');
      const fill = make('div', 'fill');
      fill.style.width = Math.round((have * 100) / LIMITS[c]) + '%';
      fill.style.background = COLORS[c];
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(make('span', 'num', status.game ? status.game.rows[c] + '/' + LIMITS[c] : '—'));
      wrap.appendChild(row);
    });
    if (feed.length) {
      const strip = make('div', 'feed');
      strip.title = 'Последние выпавшие карточки: цифра — категория';
      feed.forEach((c, i) => {
        const chip = make('i', prefs.anim && i === feed.length - 1 && pending.length ? 'new' : '', String(c));
        chip.style.background = COLORS[c];
        strip.appendChild(chip);
      });
      wrap.appendChild(strip);
    }
    return wrap;
  }

  function settingsBlock() {
    const wrap = make('div', 'sec');
    wrap.appendChild(make('div', 'lbl', 'Цель — категория, приз которой нужен'));
    const seg = make('div', 'seg');
    CATS.forEach((c) => {
      const b = make('button', prefs.target === c ? 'on' : '', String(c));
      b.disabled = busy();
      b.addEventListener('click', () => {
        prefs.target = c;
        if (prefs.above !== 'stop' && prefs.above <= c) prefs.above = 'stop';
        confirming = false;
        savePrefs();
        draw();
      });
      seg.appendChild(b);
    });
    wrap.appendChild(seg);

    wrap.appendChild(make('div', 'lbl', 'Если собралась категория выше цели'));
    const sel = make('select');
    sel.disabled = busy();
    const opts = [['stop', 'Остановиться и спросить']];
    CATS.filter((c) => c > prefs.target).forEach((c) => opts.push([String(c), 'Забрать все до ' + c + '-й включительно']));
    opts.forEach((o) => {
      const op = make('option', '', o[1]);
      op.value = o[0];
      if (String(prefs.above) === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', () => {
      prefs.above = sel.value === 'stop' ? 'stop' : Number(sel.value);
      confirming = false;
      savePrefs();
      draw();
    });
    wrap.appendChild(sel);

    wrap.appendChild(make('div', 'lbl', 'Лимит карт за запуск (0 — до конца)'));
    const inp = make('input');
    inp.type = 'number';
    inp.min = '0';
    inp.step = '1';
    inp.value = String(prefs.maxCards);
    inp.disabled = busy();
    inp.addEventListener('change', () => {
      prefs.maxCards = normPrefs({ maxCards: inp.value }).maxCards;
      inp.value = String(prefs.maxCards);
      confirming = false;
      savePrefs();
      draw();
    });
    wrap.appendChild(inp);

    const lab = make('label', 'chk');
    const cb = make('input');
    cb.type = 'checkbox';
    cb.checked = prefs.anim;
    cb.addEventListener('change', () => { prefs.anim = cb.checked; pending = []; savePrefs(); draw(); });
    lab.appendChild(cb);
    lab.appendChild(make('span', '', '✨ Анимация выпадения (не замедляет открытие)'));
    wrap.appendChild(lab);
    return wrap;
  }

  function controlsBlock() {
    const wrap = make('div');
    if (confirming && !busy()) {
      const w = make('div', 'warn');
      w.appendChild(make('div', '', 'Карточки тратятся необратимо. Цель — категория ' + prefs.target + '; выше цели: ' + aboveLabel(prefs.above)
        + '; лимит: ' + (prefs.maxCards > 0 ? prefs.maxCards + ' карт' : 'до конца') + '.'));
      const btns = make('div', 'btns');
      const ok = make('button', 'go', '▶ Запустить');
      ok.addEventListener('click', () => { confirming = false; draw(); start(planNow()); });
      const no = make('button', '', 'Отмена');
      no.addEventListener('click', () => { confirming = false; draw(); });
      btns.appendChild(ok);
      btns.appendChild(no);
      w.appendChild(btns);
      wrap.appendChild(w);
      return wrap;
    }
    const btns = make('div', 'btns');
    if (status.state === 'running' || status.state === 'stopping') {
      const st = make('button', 'stop', status.state === 'stopping' ? '⏳ Останавливаю…' : '⏹ Стоп');
      st.disabled = status.state === 'stopping';
      st.addEventListener('click', stop);
      btns.appendChild(st);
    } else {
      const chk = make('button', '', '👁 Проверить');
      chk.title = 'Только прочитать состояние и показать, что сделает запуск. Ничего не нажимается.';
      chk.disabled = busy();
      chk.addEventListener('click', () => check(planNow()));
      const go = make('button', 'go', '▶ Старт');
      go.disabled = busy();
      go.addEventListener('click', () => { confirming = true; draw(); });
      btns.appendChild(chk);
      btns.appendChild(go);
    }
    wrap.appendChild(btns);
    return wrap;
  }

  function statsBlock() {
    const wrap = make('div', 'sec');
    wrap.appendChild(make('div', 'title', '📊 Статистика'));
    const shown = run.opened > 0 || status.state === 'running' ? run : null;
    const table = make('table');
    const head = make('tr');
    ['Категория', 'Запуск', 'Окно', 'Доля'].forEach((t) => head.appendChild(make('th', '', t)));
    table.appendChild(head);
    CATS.forEach((c) => {
      const tr = make('tr');
      const name = make('td');
      const exchangeOnly = DROP_CATS.indexOf(c) < 0;
      const dot = make('span', 'dot');
      dot.style.background = COLORS[c];
      name.appendChild(dot);
      name.appendChild(doc.createTextNode(String(c)));
      tr.appendChild(name);
      if (exchangeOnly) {
        // 6-я категория с карточек не падает: её дают только обмены 5 → 6
        tr.appendChild(make('td', 'cnt-run', '—'));
        tr.appendChild(make('td', 'cnt-ses', '—'));
        const note6 = make('td', 'share muted', 'обмен ×' + session.promoted[5]);
        note6.title = 'Шестая категория с неоткрытых карточек не падает: её дают только обмены 5 карт пятой категории';
        tr.appendChild(note6);
        table.appendChild(tr);
        return;
      }
      tr.appendChild(make('td', 'cnt-run', String(shown ? shown.drops[c] : 0)));
      tr.appendChild(make('td', 'cnt-ses', String(session.drops[c])));
      const share = make('td', 'share');
      const bar = make('span', 'bar');
      const fill = make('div', 'fill');
      fill.style.width = Math.min(100, Number(pct(session.drops[c], session.opened))) + '%';
      fill.style.background = COLORS[c];
      bar.appendChild(fill);
      share.appendChild(bar);
      share.appendChild(doc.createTextNode(pct(session.drops[c], session.opened) + '%'));
      tr.appendChild(share);
      table.appendChild(tr);
    });
    const total = make('tr', 'total');
    total.appendChild(make('td', '', 'Всего'));
    total.appendChild(make('td', 'tot-run', String(shown ? shown.opened : 0)));
    total.appendChild(make('td', 'tot-ses', String(session.opened)));
    total.appendChild(make('td', '', ''));
    table.appendChild(total);
    wrap.appendChild(table);

    const claimed = CATS.filter((c) => session.claimed[c]).map((c) => c + '-я ×' + session.claimed[c]);
    const lines = [
      'Призы: ' + (claimed.length ? claimed.join(', ') : 'пока нет') + ' · обменов: ' + sum(session.promoted),
      'Время: запуск ' + fmtTime(shown ? shown.ms : 0) + ' · окно ' + fmtTime(session.ms + (status.state === 'running' ? run.ms : 0))
        + (rate(session) ? ' · ~' + rate(session) + ' карт/мин' : ''),
      session.unknown ? 'Без категории: ' + session.unknown : ''
    ].filter(Boolean);
    lines.forEach((t) => wrap.appendChild(make('div', 'muted', t)));

    const btns = make('div', 'btns');
    const copy = make('button', '', '📋 Копировать');
    copy.title = 'Скопировать статистику окна текстом';
    copy.addEventListener('click', () => {
      const text = statsText();
      const done = () => { copy.textContent = '✅ Скопировано'; later(() => { copy.textContent = '📋 Копировать'; }, 1500); };
      try {
        window.navigator.clipboard.writeText(text).then(done, () => note('Не удалось скопировать: буфер обмена недоступен.', 'warn'));
      } catch (e) { note('Не удалось скопировать: буфер обмена недоступен.', 'warn'); }
    });
    const reset = make('button', '', '🧹 Сбросить');
    reset.title = 'Обнулить статистику окна';
    reset.disabled = busy();
    reset.addEventListener('click', () => { session = newStats(); run = newStats(); saveSession(); draw(); });
    btns.appendChild(copy);
    btns.appendChild(reset);
    wrap.appendChild(btns);
    return wrap;
  }

  function draw() {
    if (!box) return;
    box.textContent = '';
    if (collapsed) {
      pending = [];
      const tab = make('button', 'tab', '🃏 Коллекция');
      tab.title = 'Развернуть';
      tab.addEventListener('click', () => { collapsed = false; save('localStorage', COLLAPSED_KEY, '0'); draw(); later(place, 0); });
      box.appendChild(tab);
      return;
    }
    const card = make('div', 'card');
    const head = make('div', 'head');
    head.appendChild(make('span', 'title', '🃏 Коллекция'));
    const hide = make('button', '', '◀');
    hide.title = 'Свернуть';
    hide.addEventListener('click', () => { collapsed = true; save('localStorage', COLLAPSED_KEY, '1'); draw(); later(place, 0); });
    head.appendChild(hide);
    card.appendChild(head);
    card.appendChild(make('div', 'muted', 'Открывает карточки, обменивает и забирает призы. Запуск — только по вашей кнопке.'));
    card.appendChild(progressBlock());
    card.appendChild(settingsBlock());
    card.appendChild(controlsBlock());
    if (status.text) card.appendChild(make('div', 'status ' + status.kind, status.text));
    if (status.state === 'done' && run.opened > 0) {
      const reload = make('button', '', '🔄 Обновить страницу игры');
      reload.title = 'Страница игры не знает о наших действиях: перезагрузите её, чтобы увидеть актуальное поле';
      reload.style.marginTop = '8px';
      reload.addEventListener('click', () => window.location.reload());
      card.appendChild(reload);
    }
    card.appendChild(statsBlock());
    const det = make('details');
    det.appendChild(make('summary', '', '📜 Журнал запуска'));
    const ul = make('ul');
    logLines.slice().reverse().forEach((l) => ul.appendChild(make('li', l.kind, l.text)));
    if (!logLines.length) ul.appendChild(make('li', '', 'Пока пусто'));
    det.appendChild(ul);
    det.open = detailsOpen;
    det.addEventListener('toggle', () => { detailsOpen = det.open; });
    card.appendChild(det);
    box.appendChild(card);
    pending = [];
    place();
  }
  let detailsOpen = false;

  function mount() {
    urls = resolveUrls();
    if (!urls) return false;
    const old = doc.getElementById(HOST_ID);
    if (old) old.remove();
    host = make('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:90px;left:0;z-index:2147483646;';
    const root = attach.call(host, { mode: 'closed' });
    const style = make('style');
    style.textContent = CSS;
    root.appendChild(style);
    box = make('div');
    root.appendChild(box);
    ui = {
      update: draw,
      log(text, kind) {
        logLines.push({ text: text, kind: kind || 'info' });
        if (logLines.length > LOG_LIMIT * 4) logLines.splice(0, logLines.length - LOG_LIMIT * 4);
      }
    };
    draw();
    (doc.body || doc.documentElement).appendChild(host);
    place();
    // «Помощник входа» может появиться позже и менять размер: следим за ним
    const watch = () => {
      const login = doc.getElementById(LOGIN_ID);
      if (login && window.ResizeObserver && !watch.done) {
        watch.done = true;
        new window.ResizeObserver(place).observe(login);
      }
      place();
    };
    let ticks = 0;
    const poll = every(() => { watch(); if (++ticks > 30) window.clearInterval(poll); }, 500);
    window.addEventListener('resize', place);
    later(flush, 1500);          // отчёты прошлого запуска, которые приложение не успело забрать
    return true;
  }

  function init() {
    if (mount()) return;
    // Игру рисует скрипт сайта: ждём, пока появится её контейнер
    if (window.MutationObserver) {
      const mo = new window.MutationObserver(() => { if (mount()) mo.disconnect(); });
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      later(() => mo.disconnect(), 15000);
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
