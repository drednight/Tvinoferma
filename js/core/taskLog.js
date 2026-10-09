// js/core/taskLog.js
// Вид логов «Скрипты» (автоматические задачи: проверка входа, балансы, поиск и сверка марафонов); общий список — core/logHub.js.
// Ручные действия пользователя сюда не пишутся. Открывается из «Настроек».
// Каждая задача показывает процент, текущий шаг и раскрывающийся список действий;
// после завершения лог можно открыть и скопировать. Последние задачи сохраняются.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { escapeHtml } from './utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { registerLogSource, openLogHub } from './logHub.js';
import { ERROR_TEXT, errorText } from './errorCodes.js';
import { mskStampSeconds } from './msk.js';
import { state } from './state.js';

const STORAGE_KEY = 'tf_task_journal_v1';
const MAX_TASKS = 300;
const MAX_ENTRIES = 500;
const DOCK_AUTOHIDE_MS = 8000;

const LEVEL_ICON = { info: '•', step: '▶', ok: '✅', warn: '⚠️', error: '❌' };

export { ERROR_TEXT, errorText };

// Журнал читается после объявления `class Task` (см. конец класса): `loadJournal` создаёт Task,
// а до объявления класса это ReferenceError, который глотался — журнал после перезапуска был пустым
let tasks = [];
const subscribers = new Set();
let listenerReady = false;

function loadJournal() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    // записи ручных операций (kind: 'operation') из промежуточной версии в логи скриптов не входят
    // Плашки прошлых запусков при старте не показываются (они остаются только в журнале): `_hidden` до перезапуска мог не сохраниться,
    // т.к. журнал пишется в finish() раньше, чем плашка сама скрывается
    return Array.isArray(raw) ? raw.filter(t => t.kind !== 'operation').map(t => Object.assign(new Task(), t, { _hidden: true })) : [];
  } catch (_) { return []; }
}
function saveJournal() {
  let finished = tasks.filter(t => t.status !== 'running').slice(0, MAX_TASKS)
    .map(t => ({ ...t, scopes: [], open: false }));
  // При переполнении localStorage выбрасываем самые старые записи, пока журнал не поместится
  for (let i = 0; i < 6; i++) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(finished)); return; }
    catch (_) { finished = finished.slice(0, Math.floor(finished.length / 2)); }
  }
}

const nowIso = () => new Date().toISOString();
// Время в журнале задач — по Москве: по нему сверяют работу скриптов с игровыми событиями
const timeOf = (iso) => mskStampSeconds(new Date(iso));

class Task {
  constructor(title = '', opts = {}) {
    this.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    this.title = title;
    this.kind = opts.kind || 'task';
    this.dock = opts.dock !== false;
    this.startedAt = nowIso();
    this.finishedAt = null;
    this.status = 'running';     // running | done | warn | error (ожидание — по флагу waiting)
    this.done = 0;
    this.total = opts.total || 0;
    this.step = '';
    this.summary = '';
    this.entries = [];
    this.scopes = [];
    this.open = false;
    this.actor = null;           // кто и что делается сейчас: { nick, text }
    this.warnings = 0;
    this.errors = 0;
    this.cancelable = !!opts.cancelable;   // показывать кнопку «Отмена»
    this.cancelled = false;
    this.paused = false;                    // пауза по кнопке в доке
    this._onCancel = null;
    this._onPause = null;
    this._onStop = null;
    this._waiters = [];          // ждут очереди: сработают, когда скрипт дойдёт до работы
    this.waiting = false;        // стоит в очереди за другим скриптом
  }
  get percent() {
    if (this.status !== 'running') return 100;
    return this.total ? Math.min(100, Math.round(this.done / this.total * 100)) : 0;
  }
  /**
   * Ждать очереди, если она есть.
   *
   * Скрипты выполняются по одному: пока в доке идёт другой, новый не начинает работу и
   * ждёт. Возвращает промис, который разрешится, когда скрипт встанет выполняться
   * (или немедленно, если очередь была свободна). Если скрипт отменили, пока он ждал,
   * промис всё равно разрешается — вызывающий код сам увидит `signal.cancelled` и выйдет.
   */
  waitTurn() {
    if (!this.waiting) return Promise.resolve();
    return new Promise(resolve => this._waiters.push(resolve));
  }
  /** Отпустить ожидающих: скрипт встал в работу. */
  _releaseWaiters() {
    const list = this._waiters;
    this._waiters = [];
    list.forEach(fn => { try { fn(); } catch (_) {} });
  }
  log(message, level = 'info', scope = '') {
    this.entries.push({ at: nowIso(), level, message: String(message), scope: scope || '' });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (level === 'warn') this.warnings++;
    if (level === 'error') this.errors++;
    if (level === 'step') this.step = String(message);
    notify(this);
    return this;
  }
  /**
   * Снять ошибки и предупреждения scope, если тот же scope позже отработал успешно.
   *
   * Нужна для повторов: первая попытка проверки входа могла написать в журнал «таймаут» или
   * «ошибка разбора», а повтор прошёл — и без этого в логе оставалось впечатление поломки.
   * Ошибки других персонажей и общие строки задачи не трогаем: снимаем только то, что
   * относится к этому scope. Счётчики на плашке пересчитываются, иначе она продолжала бы
   * показывать «ошибок: 1» при пустом логе.
   *
   * @param {string} scope например `char:<id>`
   * @param {string} [note] что заменило ошибку; по умолчанию — «проверка прошла»
   */
  resolveProblems(scope, note) {
    const bad = this.entries.filter(e => e.scope === scope && (e.level === 'warn' || e.level === 'error'));
    if (!bad.length) return this;
    this.entries = this.entries.filter(e => !bad.includes(e));
    this.errors = Math.max(0, this.errors - bad.filter(e => e.level === 'error').length);
    this.warnings = Math.max(0, this.warnings - bad.filter(e => e.level === 'warn').length);
    // `finish` берёт статус из счётчиков, поэтому итог тоже должен быть зелёным
    if (this.status === 'warn' && !this.errors && !this.warnings) this.status = 'done';
    this.log(withNick(scope, note || 'ошибки сняты — проверка прошла'), 'info', scope);
    return this;
  }
  setStep(message) { return this.log(message, 'step'); }
  /** Что сделать при нажатии «Отмена» (обычно — поднять флаг для очереди). */
  onCancel(fn) { this._onCancel = fn; return this; }
  /** Что делать при паузе и продолжении. */
  onPause(fn) { this._onPause = fn; return this; }
  /** Что делать при мгновенной остановке (обрыв выполняющегося скрипта). */
  onStop(fn) { this._onStop = fn; return this; }

  /** Пауза: очередь не берёт следующих персонажей, текущий доводится. */
  togglePause() {
    if (this.status !== 'running' || this.cancelled) return this;
    this.paused = !this.paused;
    this.log(this.paused ? 'Пауза: очередь остановлена, текущий скрипт дойдёт до конца' : 'Продолжаю', 'info');
    try { this._onPause?.(this.paused); } catch (_) {}
    return this;
  }

  /**
   * Остановка сразу: текущий скрипт обрывается на следующей проверке, а не доводится до конца.
   * В отличие от `cancel`, который лишь перестаёт выдавать работу очереди.
   */
  stop() {
    if (this.status !== 'running' || this.cancelled) return this;
    this.cancelled = true;
    this.paused = false;
    const wasWaiting = this.waiting;
    this.waiting = false;
    this._releaseWaiters();      // ждущий отпускается сразу: работать ему уже не о чем
    this.log('Остановлено: работа прервана на середине', 'warn');
    try { this._onCancel?.(); } catch (_) {}
    try { this._onStop?.(); } catch (_) {}
    if (wasWaiting) startNextQueued();
    return this;
  }

  cancel() {
    if (this.status !== 'running' || this.cancelled) return this;
    this.cancelled = true;
    const wasWaiting = this.waiting;
    this.waiting = false;
    this._releaseWaiters();
    this.log('Отмена: уже запущенные проверки завершатся, остальные будут пропущены', 'warn');
    try { this._onCancel?.(); } catch (_) {}
    if (wasWaiting) startNextQueued();
    return this;
  }
  progress(done, total, step) {
    this.done = done; if (total != null) this.total = total;
    if (step) this.step = step;
    notify(this);
    return this;
  }
  /** Привязать события Rust с этим scope (например `char:<id>` или `scan`). */
  watch(...scopes) { scopes.forEach(s => { if (!this.scopes.includes(s)) this.scopes.push(s); }); return this; }
  unwatch(...scopes) { this.scopes = this.scopes.filter(s => !scopes.includes(s)); return this; }
  finish(summary = '', status) {
    if (this.status !== 'running') return this;
    this.status = status || (this.errors ? 'warn' : 'done');
    this.summary = summary;
    this.finishedAt = nowIso();
    this.step = summary || 'Готово';
    this.scopes = [];
    this.actor = null;
    this.log(summary || 'Завершено', this.status === 'error' ? 'error' : this.status === 'warn' ? 'warn' : 'ok');
    saveJournal();
    if (this.dock) setTimeout(() => { this._hidden = true; renderDock(); }, DOCK_AUTOHIDE_MS);
    if (this.dock) startNextQueued();
    return this;
  }
}

tasks = loadJournal();

/**
 * Очередь запуска: скрипты выполняются по одному.
 *
 * Раньше новый скрипт начинался сразу, даже если предыдущий ещё шёл: плашка показывала
 * один скрипт, а второй молча работал в фоне, и его нельзя было остановить — кнопки
 * пауза и стоп относятся к текущему. Теперь новый док-скрипт встаёт в очередь и ждёт:
 * сверху плашка и список показывают идущий скрипт, ниже — «в очереди» с тем, что он ждёт.
 *
 * Очередь касается только док-задач (`dock: true`) — они и есть «скрипты» в плашке.
 * Вложенные задачи и задачи вне дока (например, мастер марафона) очередь не занимают.
 *
 * @returns {boolean} встал ли скрипт в очередь
 */
function enqueueIfBusy(task) {
  if (!task.dock || task.waiting) return false;
  const busy = tasks.some(t => t !== task && t.dock && t.status === 'running' && !t._hidden);
  if (!busy) return false;
  task.waiting = true;
  task.log('В очереди: жду завершения текущего скрипта', 'info');
  notify(task);
  return true;
}

/** Пустить следующий скрипт из очереди, если очередь не пуста. */
function startNextQueued() {
  // `tasks.unshift`, поэтому индекс 0 — самый новый. Очередь идёт по порядку запуска:
  // первым встаёт тот, кто ждёт дольше всех, — он и последний в списке.
  const next = [...tasks].reverse().find(t => t.waiting);
  if (!next) return;
  next.waiting = false;
  next.log('Начато: освободилось место, запускаюсь', 'info');
  next._releaseWaiters();
  notify(next);
}

export function startTask(title, opts = {}) {
  ensureRustListener();
  const t = new Task(title, opts);
  tasks.unshift(t);
  if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
  t.log(`Начато: ${title}`, 'info');
  enqueueIfBusy(t);
  return t;
}

export function onTaskChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/**
 * Сигнал отмены для очереди скриптов: остановка, пауза и продолжение одним объектом.
 *
 * «Стоп» дополнительно просит Rust прервать уже выполняющийся вызов по каждому scope
 * задачи — иначе кнопка лишь переставала бы выдавать работу, а текущий скрипт крутился
 * бы до своего таймаута (до 12 секунд на персонажа).
 *
 * @param {Task} task задача, у которой кнопки «пауза» и «стоп» в доке
 * @returns {{ cancelled: boolean, paused: boolean }}
 */
export function taskSignal(task) {
  const signal = { cancelled: false, paused: false };
  task.onCancel(() => { signal.cancelled = true; });
  task.onPause?.((paused) => { signal.paused = paused; });
  task.onStop?.(() => {
    signal.cancelled = true;
    // Scope'ы снимаем с отмены перед новым запуском: тот же персонаж должен снова проверяться
    task.scopes.forEach(s => invoke('resume_scope_command', { scope: s }).catch(() => {}));
    task.scopes.forEach(s => invoke('cancel_scope_command', { scope: s }).catch(() => {}));
  });
  return signal;
}

/** Записать строку во все идущие задачи, которые следят за scope. */
export function logScope(scope, message, level = 'info') {
  const text = withNick(scope, message);
  const nick = nickOfScope(scope);
  tasks.filter(t => t.status === 'running' && t.scopes.includes(scope)).forEach(t => {
    if (nick) t.actor = { nick, text: text.slice(nick.length + 2) };
    t.log(text, level, scope);
  });
}

/** Для scope `char:<id>` добавляет к строке ник персонажа (если его там ещё нет). */
export function nickOfScope(scope) {
  const m = /^char:(.+)$/.exec(String(scope || ''));
  if (!m) return '';
  const char = (state.characters || []).find(c => c.id === m[1]);
  return char?.nick || m[1];
}

export function withNick(scope, message) {
  const nick = nickOfScope(scope);
  if (!nick) return message;
  const text = String(message);
  return text.startsWith(`${nick}:`) ? text : `${nick}: ${text}`;
}

async function ensureRustListener() {
  if (listenerReady || !window.__TAURI_INTERNALS__) return;
  listenerReady = true;
  try {
    await listen('tf-task-log', (e) => {
      const { scope, level, message } = e.payload || {};
      if (scope && message) logScope(scope, message, level || 'info');
    });
  } catch (err) { console.warn('[TASK LOG] listener failed', err); listenerReady = false; }
}
export const initTaskLog = ensureRustListener;

/* ------------------------------------------------------------------ */
/*  Отрисовка                                                          */
/* ------------------------------------------------------------------ */

const STATUS_ICON = { running: '⏳', done: '✅', warn: '⚠️', error: '❌' };

function entryHtml(e) {
  return `<div class="tl-entry tl-l-${e.level}"><span class="tl-time">${timeOf(e.at)}</span><span class="tl-icon">${LEVEL_ICON[e.level] || '•'}</span><span>${escapeHtml(e.message)}</span></div>`;
}

const RING_ICON = { done: '✓', warn: '!', error: '✕' };

/**
 * Карточка задачи: кольцо с процентом, название и текущий шаг, кнопки действий, полоса прогресса.
 * Идущая задача — с бегущим бликом на полосе, завершённая — цветная (зелёная / жёлтая / красная) и без кольца.
 * Подробности (последние строки лога) раскрываются стрелкой.
 */
export function taskCardHtml(t, { closable = false } = {}) {
  if (!t) return '';
  const running = t.status === 'running';
  const counter = t.total ? `${t.done}/${t.total}` : '';
  const last = t.entries.slice(-8);
  const ring = running
    ? `<span class="tl-ring" style="--p:${t.percent}" title="${t.percent}%"><b>${t.percent}%</b></span>`
    : `<span class="tl-ring tl-ring-end" title="${t.status === 'done' ? 'Готово' : t.status === 'warn' ? 'Есть замечания' : 'Ошибка'}"><b>${RING_ICON[t.status] || '✓'}</b></span>`;
  const chips = [
    counter ? `<span class="tl-chip">${counter}</span>` : '',
    t.errors ? `<span class="tl-chip tl-chip-err">ошибок: ${t.errors}</span>` : '',
    t.warnings ? `<span class="tl-chip tl-chip-warn">предупреждений: ${t.warnings}</span>` : ''
  ].join('');
  return `
    <div class="tl-card tl-s-${t.status}${t.open ? ' is-open' : ''}" data-task-card="${t.id}">
      <div class="tl-top">
        ${ring}
        <div class="tl-main">
          <div class="tl-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="tl-step" title="${escapeHtml(t.step || '')}">${escapeHtml(t.step || (running ? 'Начинаю…' : ''))}</div>
        </div>
        <span class="tl-head-actions">
          ${t.cancelable && running ? `<button type="button" class="tl-icon-btn tl-cancel" data-task-cancel="${t.id}" ${t.cancelled ? 'disabled' : ''} title="${t.cancelled ? 'Отменяю…' : 'Остановить задачу'}">${t.cancelled ? '…' : '■'}</button>` : ''}
          <button type="button" class="tl-icon-btn" data-task-log="${t.id}" title="Открыть полный лог">📄</button>
          <button type="button" class="tl-icon-btn" data-task-toggle="${t.id}" title="${t.open ? 'Скрыть подробности' : 'Что происходит'}">${t.open ? '▴' : '▾'}</button>
          ${closable ? `<button type="button" class="tl-icon-btn" data-task-close="${t.id}" title="Скрыть">✕</button>` : ''}
        </span>
      </div>
      <div class="tl-bar"><span style="width:${t.percent}%"></span></div>
      ${chips ? `<div class="tl-chips">${chips}</div>` : ''}
      ${running && t.actor ? `<div class="tl-actor"><span class="tl-actor-nick">${escapeHtml(t.actor.nick)}</span><span>${escapeHtml(t.actor.text)}</span></div>` : ''}
      ${t.open ? `<div class="tl-entries">${last.map(entryHtml).join('')}</div>` : ''}
    </div>`;
}

function notify(t) {
  // точечное обновление всех карточек этой задачи на странице
  document.querySelectorAll(`[data-task-card="${t.id}"]`).forEach(el => {
    if (el.closest('.tl-log-progress')) return; // полный журнал обновляется пачками
    // Кнопка «скрыть» — у завершённой задачи: идущую закрывать незачем. Раньше она давалась
    // только карточкам в доке, но с тех пор док — это список строк без кнопок, и закрыть
    // плашку было уже нечем. Теперь решение принимает сама карточка.
    el.outerHTML = taskCardHtml(t, { closable: t.status !== 'running' });
  });
  if (t.dock) renderDock();
  subscribers.forEach(fn => { try { fn(t); } catch (_) {} });
}

/**
 * Свёрнут ли док. По умолчанию свёрнут: в шапке остаётся только плашка текущего скрипта
 * (что идёт, сколько процентов, пауза/стоп/логи), а выпадающий список с очередью и
 * подробностями появляется только по кнопке «▾» — иначе он висит над страницей
 * без всякой просьбы. Живёт в памяти: при новом запуске док и так пуст.
 */
let dockFolded = true;

/** Док живёт в шапке рядом с кнопкой обновления, а не поверх страницы. */
function dockHost() {
  return document.querySelector('.topbar-right') || document.body;
}

/**
 * Журнал всех логов скриптов в отдельном окне.
 *
 * Раньше кнопка «📄» на плашке разворачивала лог прямо под доком. На скриншоте это выглядело
 * плохо: панель наезжала на страницу, обрезалась по высоте и путалась с самим списком задач.
 * Теперь логи живут в своём модальном окне — там есть все записи журнала, поиск, фильтр
 * «только с ошибками», копирование и сохранение в файл.
 */
function openScriptLogs() {
  openLogHub({ source: 'task', title: '📚 Логи скриптов' });
}

/**
 * Задача, которую сейчас выполняет скрипт: она одна активна, ей и управляют пауза и стоп.
 *
 * Ждущие очереди (`waiting`) исключены: у них статус тоже «running» — работа ещё не
 * началась, и плашка с кнопками должна относиться к тому, кто действительно идёт.
 */
export function dockCurrentTask() {
  return tasks.find(t => t.dock && t.status === 'running' && !t.waiting && !t._hidden) || null;
}

/**
 * Полоса дока: что делается, шкала прогресса с процентами и управление скриптом.
 * Свёрнутая и раскрытая полосы одинаковые — раскрывается только список подробностей под ней,
 * поэтому высота плашки в шапке не прыгает.
 */
/**
 * Полоса дока в шапке: шкала прогресса, название и управление.
 *
 * Пусто: «Скрипты не выполняются» и 0%. Идёт скрипт — его название, проценты и кнопки
 * пауза/стоп/логи. Раскрывается не полоса, а список под ней: он выпадает вниз отдельным
 * модулем (как квадрат «Московского времени»), поэтому высота шапки не прыгает.
 */
function dockBarHtml(current) {
  const pct = current ? current.percent : 0;
  const label = current ? current.title : 'Скрипты не выполняются';
  const zone = current ? (current.paused ? 'пауза' : `${pct}%`) : 'простой';
  const dot = current ? (current.paused ? 'is-paused' : 'is-busy') : '';
  const controls = current ? `
    <button type="button" class="tl-icon-btn" data-dock-pause="${current.id}"
      title="${current.paused ? 'Продолжить' : 'Приостановить'}" aria-label="Пауза">${current.paused ? '▶' : '⏸'}</button>
    <button type="button" class="tl-icon-btn tl-cancel" data-dock-stop="${current.id}"
      title="Остановить сразу, не дожидаясь конца" aria-label="Стоп">■</button>` : '';
  // Плашка повторяет вид квадрата «Московского времени»: тот же заголовок с точкой,
  // подписью и плашкой-меткой, под ним — шкала прогресса и управление скриптом.
  return `
    <div class="msk-clock-head">
      <span class="msk-clock-dot tf-dock-dot ${dot}" aria-hidden="true"></span>
      <span class="msk-clock-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="msk-clock-zone">${escapeHtml(zone)}</span>
    </div>
    <div class="tf-dock-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
    <div class="tf-dock-ctrl">
      <button type="button" class="tf-dock-toggle" data-dock-fold title="${dockFolded ? 'Развернуть' : 'Свернуть'}"
        aria-expanded="${!dockFolded}"><span aria-hidden="true">${dockFolded ? '▾' : '▴'}</span></button>
      ${controls}
      <button type="button" class="tl-icon-btn" data-dock-open-log title="Все логи скриптов"
        aria-label="Открыть логи">📄</button>
    </div>`;
}

export /**
 * Список задач под плашкой: что именно делает каждый скрипт прямо сейчас.
 *
 * Раньше здесь выпадали карточки `taskCardHtml` — с кольцом, полосой и кнопками. На верхней
 * правой части окна это читалось как мешанина: карточки наезжали друг на друга, а кнопки
 * (■ 📄 ▾) конкурировали с кнопками самой плашки. Теперь это просто список строк: имя
 * скрипта, чем он занят, сколько процентов. Кнопок нет намеренно — управление скриптом
 * (пауза, стоп, логи) осталось на плашке в шапке, где для этого есть место.
 *
 * @param {Array<any>} list видимые задачи
 */
function dockListHtml(list) {
  if (!list.length) return '<p class="tf-dock-empty">Скрипты не выполняются</p>';
  return list.map(t => {
    const running = t.status === 'running';
    const pct = t.percent;
    // Что задача делает: текущий шаг, у очереди — «в очереди», у паузы — отдельная пометка
    const what = t.waiting
      ? 'в очереди — ждёт завершения текущего скрипта'
      : t.paused
        ? 'на паузе — текущий скрипт дойдёт до конца'
        : (t.step || (running ? 'начинаю…' : t.summary || ''));
    const status = t.waiting ? 'is-queued' : (t.paused ? 'is-paused' : t.status);
    // Счётчик прогресса ждущему показывать нечего: он ещё не начал считать
    const tail = [
      !t.waiting && t.total ? `${t.done}/${t.total}` : '',
      t.errors ? `ошибок ${t.errors}` : '',
      t.warnings ? `предупреждений ${t.warnings}` : ''
    ].filter(Boolean).join(' · ');
    const mark = t.waiting ? '⏳' : (running ? `${pct}%` : STATUS_ICON[t.status] || '•');
    return `<div class="tf-dock-row tl-s-${status}" data-dock-log-row="${t.id}"
      title="${escapeHtml(`${t.title}: ${what}`)}">
      <span class="tf-dock-row-dot" aria-hidden="true"></span>
      <div class="tf-dock-row-body">
        <div class="tf-dock-row-top">
          <b>${escapeHtml(t.title)}</b>
          <span class="tf-dock-row-pct">${mark}</span>
        </div>
        <div class="tf-dock-row-step">${escapeHtml(what)}</div>
        ${running && !t.waiting ? `<span class="tf-dock-row-bar"><i style="width:${pct}%"></i></span>` : ''}
      </div>
      ${tail ? `<span class="tf-dock-row-tail">${escapeHtml(tail)}</span>` : ''}
    </div>`;
  }).join('');
}

export function renderDock() {
  let dock = document.getElementById('tf-task-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'tf-task-dock';
    dock.innerHTML = '<div class="msk-clock tf-dock-slot-bar"></div><div class="tf-dock-slot-list"></div>';
    dockHost().appendChild(dock);
  }
  // Задачи, карточка которых уже видна на странице (мастер, марафон), в списке не дублируем
  const embedded = new Set([...document.querySelectorAll('[data-task-card]')]
    .filter(el => !dock.contains(el)).map(el => el.dataset.taskCard));
  // Порядок в списке: сверху идущий скрипт, под ним очередь (по порядку запуска),
  // потом завершённые (свежие сверху). `tasks.unshift`, поэтому новее — левее.
  const visible = tasks.filter(t => t.dock && !t._hidden && !embedded.has(t.id) && (t.status === 'running' || t.finishedAt));
  const rank = (t) => (t.status === 'running' && !t.waiting ? 0 : t.waiting ? 1 : 2);
  visible.sort((a, b) => rank(a) - rank(b));
  visible.length = Math.min(visible.length, 4);
  const current = dockCurrentTask();
  dock.classList.toggle('is-open', !dockFolded);
  dock.classList.toggle('is-idle', !current);

  // Полоса перерисовывается целиком (в ней проценты и кнопки) — сравнением строк, а не всегда.
  const barSlot = /** @type {HTMLElement} */ (dock.querySelector('.tf-dock-slot-bar'));
  const bar = dockBarHtml(current);
  if (barSlot && barSlot.innerHTML !== bar) barSlot.innerHTML = bar;

  // Список под плашкой пересобирается всегда: в нём видно текущий шаг каждого скрипта,
  // а шаг меняется на каждой строке лога — пересборка по составу задач его бы пропускала.
  const listSlot = /** @type {HTMLElement} */ (dock.querySelector('.tf-dock-slot-list'));
  if (listSlot) {
    const key = `${dockFolded ? '1' : '0'}|${visible.map(t => `${t.id}:${t.status}:${t.step}:${t.percent}:${t.paused ? 1 : 0}:${t.waiting ? 1 : 0}:${t.done}`).join(',')}`;
    if (listSlot.dataset.key !== key) {
      listSlot.dataset.key = key;
      listSlot.innerHTML = dockListHtml(visible);
    }
  }

  }

/** Полный лог задачи в отдельном окне. */
export function openTaskLog(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const ov = openOverlay({ title: `📄 ${t.title}`, wide: true });
  ov.sub.classList.add('tl-log-progress');
  let renderTimer = null;
  let onlyProblems = false;
  const dur = t.finishedAt ? Math.round((new Date(t.finishedAt) - new Date(t.startedAt)) / 1000) : null;
  const draw = () => {
    ov.sub.innerHTML = taskCardHtml(t);
    // Полный лог уже открыт: не предлагаем открыть ещё одну копию или свернуть те же строки.
    ov.sub.querySelector('[data-task-log]')?.remove();
    ov.sub.querySelector('[data-task-toggle]')?.remove();
    ov.body.innerHTML = `
      <div class="tl-summary">
        <span>${STATUS_ICON[t.status]} ${t.status === 'running' ? 'Выполняется' : 'Завершено'}</span>
        <span class="muted">${new Date(t.startedAt).toLocaleString('ru-RU')}${dur != null ? ` · ${dur} с` : ''}</span>
        ${t.summary ? `<strong>${escapeHtml(t.summary)}</strong>` : ''}
      </div>
      <div class="tl-filter row gap">
        <label class="tf-radio"><input type="checkbox" data-only-problems${onlyProblems ? ' checked' : ''}/> Только ошибки и предупреждения</label>
      </div>
      <div class="tl-entries tl-full">${t.entries.filter(x => !onlyProblems || x.level === 'warn' || x.level === 'error').map(entryHtml).join('')}</div>`;
    ov.body.querySelector('[data-only-problems]').onchange = (e) => {
      onlyProblems = e.target.checked;
      ov.body.querySelector('.tl-full').innerHTML = t.entries
        .filter(x => !onlyProblems || x.level === 'warn' || x.level === 'error').map(entryHtml).join('');
    };
  };
  draw();
  ov.foot.innerHTML = `<span></span><div class="row gap"><button type="button" class="btn" data-copy>📋 Скопировать лог</button><button type="button" class="btn primary" data-close>Закрыть</button></div>`;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-copy]').onclick = async () => {
    const text = [`${t.title} — ${new Date(t.startedAt).toLocaleString('ru-RU')}`, ...t.entries.map(e => `${timeOf(e.at)} ${LEVEL_ICON[e.level] || '•'} ${e.message}`)].join('\n');
    try { await navigator.clipboard.writeText(text); ov.foot.querySelector('[data-copy]').textContent = '✔ Скопировано'; }
    catch (_) { ov.foot.querySelector('[data-copy]').textContent = 'Не удалось скопировать'; }
  };
  const unsub = onTaskChange(x => {
    if (x.id !== t.id || !ov.el.isConnected) return;
    if (t.status !== 'running') { clearTimeout(renderTimer); renderTimer = null; draw(); return; }
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => { renderTimer = null; if (ov.el.isConnected) draw(); }, 100);
  });
  const origClose = ov.close; ov.close = () => { clearTimeout(renderTimer); unsub(); origClose(); };
}

/* ------------------------------------------------------------------ */
/*  Подключение к единому модулю логов (logHub.js, «Настройки → Журналы») */
/* ------------------------------------------------------------------ */

function logStatus(t) {
  if (t.status === 'running') return 'running';
  if (t.status === 'error') return 'error';
  return t.status === 'warn' || t.errors || t.warnings ? 'warn' : 'ok';
}

/** Удаляет завершённые записи (идущие задачи остаются). */
export function clearTaskJournal() {
  tasks = tasks.filter(t => t.status === 'running');
  saveJournal();
  renderDock();
}

registerLogSource({
  id: 'task',
  title: 'Скрипты',
  icon: '📄',
  list: () => tasks.map(t => ({
    key: t.id, at: t.startedAt, title: t.title, status: logStatus(t),
    summary: t.summary || (t.status === 'running' ? `${t.percent}% · ${t.step}` : '')
  })),
  open: (item) => openTaskLog(item.key),
  clear: clearTaskJournal,
  clearConfirm: 'Очистить логи скриптов? Завершённые записи будут удалены.',
  subscribe: onTaskChange
});

// Делегирование кликов для всех карточек задач (док, мастер, страницы).
// Слушатель висит на document, а не на узле дока: док переиспользует уже созданный
// элемент, и слушатель на самом узле однажды остался бы с замыканием на старый модуль.
// При пересоздании модуля (тесты, горячая перезагрузка) прежний слушатель снимается —
// иначе один клик обрабатывался бы столько раз, сколько раз модуль импортировали.
function onTaskLogClick(e) {
  const fold = e.target.closest?.('[data-dock-fold]');
  if (fold) { dockFolded = !dockFolded; renderDock(); return; }
  const pause = e.target.closest?.('[data-dock-pause]');
  if (pause) { const t = tasks.find(x => x.id === pause.dataset.dockPause); if (t) { t.togglePause(); notify(t); renderDock(); } return; }
  const stop = e.target.closest?.('[data-dock-stop]');
  if (stop) { const t = tasks.find(x => x.id === stop.dataset.dockStop); if (t) { t.stop(); notify(t); renderDock(); } return; }
  // Клик по строке списка — открыть лог этой задачи. Кнопок в списке нет намеренно,
  // поэтому строка сама и есть управление.
  const row = e.target.closest?.('[data-dock-log-row]');
  if (row) { openTaskLog(row.dataset.dockLogRow); return; }
  // Кнопка «📄» на плашке: все логи скриптов из журнала в отдельном окне
  if (e.target.closest?.('[data-dock-open-log]')) { openScriptLogs(); return; }
  const tg = e.target.closest?.('[data-task-toggle]');
  if (tg) { const t = tasks.find(x => x.id === tg.dataset.taskToggle); if (t) { t.open = !t.open; notify(t); } return; }
  const cn = e.target.closest?.('[data-task-cancel]');
  if (cn) { const t = tasks.find(x => x.id === cn.dataset.taskCancel); if (t) { t.cancel(); notify(t); } return; }
  const lg = e.target.closest?.('[data-task-log]');
  if (lg) { openTaskLog(lg.dataset.taskLog); return; }
  const cl = e.target.closest?.('[data-task-close]');
  if (cl) { const t = tasks.find(x => x.id === cl.dataset.taskClose); if (t) { t._hidden = true; renderDock(); } }
}

const DELEGATE_KEY = '__tfTaskLogClickDelegate';
if (document[DELEGATE_KEY]) document.removeEventListener('click', document[DELEGATE_KEY]);
document[DELEGATE_KEY] = onTaskLogClick;
document.addEventListener('click', onTaskLogClick);
