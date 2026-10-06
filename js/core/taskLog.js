// js/core/taskLog.js
// Вид логов «Скрипты» (автоматические задачи: проверка входа, балансы, поиск и сверка марафонов); общий список — core/logHub.js.
// Ручные действия пользователя сюда не пишутся. Открывается из «Настроек».
// Каждая задача показывает процент, текущий шаг и раскрывающийся список действий;
// после завершения лог можно открыть и скопировать. Последние задачи сохраняются.

import { listen } from '@tauri-apps/api/event';
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

let tasks = loadJournal();
const subscribers = new Set();
let listenerReady = false;

function loadJournal() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    // записи ручных операций (kind: 'operation') из промежуточной версии в логи скриптов не входят
    return Array.isArray(raw) ? raw.filter(t => t.kind !== 'operation').map(t => Object.assign(new Task(), t)) : [];
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
    this._onCancel = null;
  }
  get percent() {
    if (this.status !== 'running') return 100;
    return this.total ? Math.min(100, Math.round(this.done / this.total * 100)) : 0;
  }
  log(message, level = 'info') {
    this.entries.push({ at: nowIso(), level, message: String(message) });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (level === 'warn') this.warnings++;
    if (level === 'error') this.errors++;
    if (level === 'step') this.step = String(message);
    notify(this);
    return this;
  }
  setStep(message) { return this.log(message, 'step'); }
  /** Что сделать при нажатии «Отмена» (обычно — поднять флаг для очереди). */
  onCancel(fn) { this._onCancel = fn; return this; }
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

export function startTask(title, opts = {}) {
  ensureRustListener();
  const t = new Task(title, opts);
  tasks.unshift(t);
  if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
  t.log(`Начато: ${title}`, 'info');
  return t;
}

export function onTaskChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/** Записать строку во все идущие задачи, которые следят за scope. */
export function logScope(scope, message, level = 'info') {
  const text = withNick(scope, message);
  const nick = nickOfScope(scope);
  tasks.filter(t => t.status === 'running' && t.scopes.includes(scope)).forEach(t => {
    if (nick) t.actor = { nick, text: text.slice(nick.length + 2) };
    t.log(text, level);
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
    const closable = !!el.querySelector('[data-task-close]');
    el.outerHTML = taskCardHtml(t, { closable });
  });
  if (t.dock) renderDock();
  subscribers.forEach(fn => { try { fn(t); } catch (_) {} });
}

export function renderDock() {
  let dock = document.getElementById('tf-task-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'tf-task-dock';
    document.body.appendChild(dock);
  }
  // Задачи, карточка которых уже видна на странице (мастер, марафон), в доке не дублируем
  const embedded = new Set([...document.querySelectorAll('[data-task-card]')]
    .filter(el => !dock.contains(el)).map(el => el.dataset.taskCard));
  const visible = tasks.filter(t => t.dock && !t._hidden && !embedded.has(t.id) && (t.status === 'running' || t.finishedAt)).slice(0, 4);
  dock.innerHTML = visible.map(t => taskCardHtml(t, { closable: t.status !== 'running' })).join('');
}

/** Полный лог задачи в отдельном окне. */
export function openTaskLog(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const ov = openOverlay({ title: `📄 ${t.title}`, wide: true });
  const dur = t.finishedAt ? Math.round((new Date(t.finishedAt) - new Date(t.startedAt)) / 1000) : null;
  const draw = () => {
    ov.body.innerHTML = `
      <div class="tl-summary">
        <span>${STATUS_ICON[t.status]} ${t.status === 'running' ? 'Выполняется' : 'Завершено'}</span>
        <span class="muted">${new Date(t.startedAt).toLocaleString('ru-RU')}${dur != null ? ` · ${dur} с` : ''}</span>
        ${t.summary ? `<strong>${escapeHtml(t.summary)}</strong>` : ''}
      </div>
      <div class="tl-filter row gap">
        <label class="tf-radio"><input type="checkbox" data-only-problems/> Только ошибки и предупреждения</label>
      </div>
      <div class="tl-entries tl-full">${t.entries.map(entryHtml).join('')}</div>`;
    ov.body.querySelector('[data-only-problems]').onchange = (e) => {
      ov.body.querySelector('.tl-full').innerHTML = t.entries
        .filter(x => !e.target.checked || x.level === 'warn' || x.level === 'error').map(entryHtml).join('');
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
  const unsub = onTaskChange(x => { if (x.id === t.id && document.body.contains(ov.el)) draw(); });
  const origClose = ov.close; ov.close = () => { unsub(); origClose(); };
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
