// js/core/taskLog.js
// Вид логов «Скрипты» (автоматические задачи: проверка входа, балансы, поиск и сверка марафонов); общий список — core/logHub.js.
// Ручные действия пользователя сюда не пишутся. Открывается из «Настроек».
// Каждая задача показывает процент, текущий шаг и раскрывающийся список действий;
// после завершения лог можно открыть и скопировать. Последние задачи сохраняются.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { escapeHtml } from './utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { registerLogSource } from './logHub.js';
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
    this.status = 'running';     // running | done | warn | error
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
  }
  get percent() {
    if (this.status !== 'running') return 100;
    return this.total ? Math.min(100, Math.round(this.done / this.total * 100)) : 0;
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
    this.log('Остановлено: работа прервана на середине', 'warn');
    try { this._onCancel?.(); } catch (_) {}
    try { this._onStop?.(); } catch (_) {}
    return this;
  }

  cancel() {
    if (this.status !== 'running' || this.cancelled) return this;
    this.cancelled = true;
    this.log('Отмена: уже запущенные проверки завершатся, остальные будут пропущены', 'warn');
    try { this._onCancel?.(); } catch (_) {}
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
    return this;
  }
}

tasks = loadJournal();

export function startTask(title, opts = {}) {
  ensureRustListener();
  const t = new Task(title, opts);
  tasks.unshift(t);
  if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
  t.log(`Начато: ${title}`, 'info');
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
    const closable = el.closest('#tf-task-dock') ? t.status !== 'running' : !!el.querySelector('[data-task-close]');
    el.outerHTML = taskCardHtml(t, { closable });
  });
  if (t.dock) renderDock();
  subscribers.forEach(fn => { try { fn(t); } catch (_) {} });
}

/** Свёрнут ли док. Живёт в памяти: переживать перезапуск незачем — при новом запуске док и так пуст. */
let dockFolded = false;

/** Док живёт в шапке рядом с кнопкой обновления, а не поверх страницы. */
function dockHost() {
  return document.querySelector('.topbar-right') || document.body;
}

/**
 * Очередь логов: id задач, чей полный лог просят показать. Отдельного окна на каждый запрос
 * не открывается — логи копятся в очереди, плашка показывает, сколько их ждёт.
 */
const dockLogQueue = [];
let dockLogOpen = null;

/**
 * Показать лог. Если один уже открыт, новая заявка не переключает его, а встаёт в очередь:
 * пользователь сам решает, что смотреть дальше. Пустая очередь — показываем выполняющийся
 * скрипт, а если его нет, последний завершённый.
 */
function dockOpenLog(wantedId = null) {
  if (wantedId) {
    if (wantedId === dockLogOpen) { dockLogOpen = null; renderDock(); return; }
    if (dockLogOpen) { if (!dockLogQueue.includes(wantedId)) dockLogQueue.push(wantedId); renderDock(); return; }
    dockLogOpen = wantedId;
  } else if (dockLogOpen && !wantedId) {
    dockLogOpen = null;                      // повторное нажатие кнопки — свернуть
  } else {
    dockLogOpen = (dockCurrentTask() || tasks.find(t => t.dock && t.entries.length))?.id || null;
  }
  renderDock();
}

/** Задача, которую сейчас выполняет скрипт: она одна активна, ей и управляют пауза и стоп. */
function dockCurrentTask() {
  return tasks.find(t => t.dock && t.status === 'running' && !t._hidden) || null;
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
function dockBarHtml(current, queued) {
  const pct = current ? current.percent : 0;
  const label = current ? current.title : 'Скрипты не выполняются';
  const zone = current ? (current.paused ? 'пауза' : `${pct}%`) : 'простой';
  const dot = current ? (current.paused ? 'is-paused' : 'is-busy') : '';
  const controls = current ? `
    <button type="button" class="tl-icon-btn" data-dock-pause="${current.id}"
      title="${current.paused ? 'Продолжить' : 'Приостановить'}" aria-label="Пауза">${current.paused ? '▶' : '⏸'}</button>
    <button type="button" class="tl-icon-btn tl-cancel" data-dock-stop="${current.id}"
      title="Остановить сразу, не дожидаясь конца" aria-label="Стоп">■</button>` : '';
  const queueNote = queued
    ? `<button type="button" class="tf-dock-queue" data-dock-open-log title="Показать следующий лог">📄 ${queued}</button>` : '';
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
      ${queueNote}${controls}
      <button type="button" class="tl-icon-btn" data-dock-open-log title="Показать логи"
        aria-label="Открыть логи">📄</button>
    </div>`;
}

export function renderDock() {
  let dock = document.getElementById('tf-task-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'tf-task-dock';
    dock.innerHTML = '<div class="msk-clock tf-dock-slot-bar"></div><div class="tf-dock-slot-list"></div><div class="tf-dock-slot-log"></div>';
    dock.addEventListener('click', (e) => {
      const fold = e.target.closest('[data-dock-fold]');
      if (fold) { dockFolded = !dockFolded; renderDock(); return; }
      const pause = e.target.closest('[data-dock-pause]');
      if (pause) { const t = tasks.find(x => x.id === pause.dataset.dockPause); if (t) { t.togglePause(); notify(t); renderDock(); } return; }
      const stop = e.target.closest('[data-dock-stop]');
      if (stop) { const t = tasks.find(x => x.id === stop.dataset.dockStop); if (t) { t.stop(); notify(t); renderDock(); } return; }
      // «Открыть лог» не открывает новое окно: логи показываются в самом доке, по очереди.
      const log = e.target.closest('[data-task-log]');
      if (log) { dockOpenLog(log.dataset.taskLog); return; }
      if (e.target.closest('[data-dock-open-log]')) { dockOpenLog(); return; }
      if (e.target.closest('[data-dock-log-close]')) { dockOpenLog(); return; }
    });
    dockHost().appendChild(dock);
  }
  // Задачи, карточка которых уже видна на странице (мастер, марафон), в доке не дублируем
  const embedded = new Set([...document.querySelectorAll('[data-task-card]')]
    .filter(el => !dock.contains(el)).map(el => el.dataset.taskCard));
  const visible = tasks.filter(t => t.dock && !t._hidden && !embedded.has(t.id) && (t.status === 'running' || t.finishedAt)).slice(0, 4);
  const current = dockCurrentTask();
  dock.classList.toggle('is-open', !dockFolded);
  dock.classList.toggle('is-idle', !current);

  // Полоса перерисовывается целиком (в ней проценты и кнопки), карточки — точечно, из notify.
  const barSlot = /** @type {HTMLElement} */ (dock.querySelector('.tf-dock-slot-bar'));
  const bar = dockBarHtml(current, dockLogQueue.length);
  if (barSlot && barSlot.innerHTML !== bar) barSlot.innerHTML = bar;

  // Выпадающий список карточек: пересобирается только когда изменился сам состав задач.
  const listSlot = /** @type {HTMLElement} */ (dock.querySelector('.tf-dock-slot-list'));
  const key = visible.map(t => t.id).join(',');
  if (listSlot && listSlot.dataset.key !== key) {
    listSlot.dataset.key = key;
    listSlot.innerHTML = visible.map(t => taskCardHtml(t, { closable: t.status !== 'running' })).join('');
  }

  // Раскрытый лог — по одному, из очереди запросов.
  const logSlot = /** @type {HTMLElement} */ (dock.querySelector('.tf-dock-slot-log'));
  if (logSlot && logSlot.dataset.task !== (dockLogOpen || '')) {
    logSlot.dataset.task = dockLogOpen || '';
    const t = dockLogOpen ? tasks.find(x => x.id === dockLogOpen) : null;
    logSlot.innerHTML = t ? `
      <div class="tf-dock-log-head"><b>${escapeHtml(t.title)}</b>
        <button type="button" class="tl-icon-btn" data-dock-log-close title="Свернуть лог">✕</button>
      </div>
      <div class="tl-entries tl-full">${t.entries.slice(-40).map(entryHtml).join('')}</div>` : '';
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

// Делегирование кликов для всех карточек задач (док, мастер, страницы)
document.addEventListener('click', (e) => {
  const tg = e.target.closest?.('[data-task-toggle]');
  if (tg) { const t = tasks.find(x => x.id === tg.dataset.taskToggle); if (t) { t.open = !t.open; notify(t); } return; }
  const cn = e.target.closest?.('[data-task-cancel]');
  if (cn) { const t = tasks.find(x => x.id === cn.dataset.taskCancel); if (t) { t.cancel(); notify(t); } return; }
  const lg = e.target.closest?.('[data-task-log]');
  if (lg) { openTaskLog(lg.dataset.taskLog); return; }
  const cl = e.target.closest?.('[data-task-close]');
  if (cl) { const t = tasks.find(x => x.id === cl.dataset.taskClose); if (t) { t._hidden = true; renderDock(); } }
});
