// js/core/taskLog.js
// Логи скриптов: автоматические задачи (проверка входа, балансы, поиск и сверка марафонов).
// Ручные действия пользователя сюда не пишутся. Открывается из «Настроек».
// Каждая задача показывает процент, текущий шаг и раскрывающийся список действий;
// после завершения лог можно открыть и скопировать. Последние задачи сохраняются.

import { listen } from '@tauri-apps/api/event';
import { escapeHtml } from './utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { confirmDialog } from './ui.js';

const STORAGE_KEY = 'tf_task_journal_v1';
const MAX_TASKS = 300;
const MAX_ENTRIES = 500;
const DOCK_AUTOHIDE_MS = 20000;

const LEVEL_ICON = { info: '•', step: '▶', ok: '✅', warn: '⚠️', error: '❌' };

/** Понятные описания кодов ошибок из Rust/парсеров. */
export const ERROR_TEXT = {
  not_logged_in: 'не выполнен вход на сайт',
  challenge: 'сайт показывает «Проверку безопасности»',
  timeout: 'сайт не ответил вовремя',
  timeout_parsing_marathon: 'сайт не ответил вовремя',
  timeout_parsing_details: 'сайт не ответил вовремя',
  container_not_found: 'на странице нет заданий марафона',
  no_title_found: 'на странице нет марафона',
  no_quests: 'задания не найдены',
  no_progress_found: 'на странице нет полос прогресса (возможно, сайт изменил вёрстку)',
  container_missing: 'на странице нет блока с балансом (возможно, сайт изменил вёрстку)',
  no_value_tag: 'в блоке баланса нет значения (возможно, сайт изменил вёрстку)',
  parse_nan: 'не удалось прочитать число баланса',
  zero_no_user_session_expired: 'сессия истекла',
  session_lost_during_parse: 'сессия потеряна во время чтения'
};
export const errorText = (code) => ERROR_TEXT[code] || (code ? String(code) : 'неизвестная ошибка');

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
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  tasks.filter(t => t.status === 'running' && t.scopes.includes(scope)).forEach(t => t.log(message, level));
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

/** Карточка задачи: процент, шаг, раскрывающиеся детали, кнопка лога. */
export function taskCardHtml(t, { closable = false } = {}) {
  if (!t) return '';
  const counter = t.total ? ` · ${t.done}/${t.total}` : '';
  const last = t.entries.slice(-8);
  return `
    <div class="tl-card tl-s-${t.status}" data-task-card="${t.id}">
      <div class="tl-head">
        <strong>${STATUS_ICON[t.status]} ${escapeHtml(t.title)}</strong>
        <span class="tl-head-actions">
          ${t.cancelable && t.status === 'running' ? `<button type="button" class="tl-link" data-task-cancel="${t.id}" ${t.cancelled ? 'disabled' : ''} title="Остановить задачу">${t.cancelled ? '⏳ Отменяю…' : '⛔ Отмена'}</button>` : ''}
          <button type="button" class="tl-link" data-task-log="${t.id}" title="Открыть полный лог">📄 Лог</button>
          ${closable ? `<button type="button" class="tl-link" data-task-close="${t.id}" title="Скрыть">✕</button>` : ''}
        </span>
      </div>
      <div class="tl-bar"><span style="width:${t.percent}%"></span></div>
      <div class="tl-meta"><span>${t.percent}%${counter}</span><span class="tl-step">${escapeHtml(t.step || '')}</span></div>
      ${t.warnings || t.errors ? `<div class="tl-counts">${t.errors ? `<span class="mr-red">ошибок: ${t.errors}</span>` : ''} ${t.warnings ? `<span class="tl-warn-c">предупреждений: ${t.warnings}</span>` : ''}</div>` : ''}
      <button type="button" class="tl-toggle" data-task-toggle="${t.id}">${t.open ? '▾ Скрыть подробности' : '▸ Что происходит'}</button>
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

/** Логи скриптов (открываются из «Настроек»). */
export function openTaskJournal() {
  const ov = openOverlay({ title: '📄 Логи скриптов', wide: true });
  let onlyProblems = false;
  const rowsOf = () => tasks.filter(t => !onlyProblems || t.status === 'warn' || t.status === 'error' || t.errors || t.warnings);
  const draw = () => {
    const rows = rowsOf();
    ov.body.innerHTML = `
      <div class="tl-filter row gap" style="margin-bottom:8px;">
        <label class="tf-radio"><input type="checkbox" data-only-problems ${onlyProblems ? 'checked' : ''}/> Только с ошибками и предупреждениями</label>
        <span class="muted">Записей: ${rows.length} из ${tasks.length}. Нажмите на запись, чтобы открыть подробный лог.</span>
      </div>
      ${rows.length ? `<div class="tl-journal">${rows.map(t => `
      <button type="button" class="tl-jrow tl-s-${t.status}" data-task-log="${t.id}">
        <span>${STATUS_ICON[t.status]}</span>
        <strong>${escapeHtml(t.title)}</strong>
        <span class="muted">${new Date(t.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <span class="tl-jsum">${escapeHtml(t.summary || (t.status === 'running' ? `${t.percent}% · ${t.step}` : ''))}</span>
      </button>`).join('')}</div>` : '<div class="empty-state">Ничего не найдено. Здесь появятся логи проверок входа, балансов и марафонов.</div>'}`;
    ov.body.querySelector('[data-only-problems]').onchange = (e) => { onlyProblems = e.target.checked; draw(); };
  };
  draw();
  ov.foot.innerHTML = `<div class="row gap"><button type="button" class="btn ghost" data-clear>🧹 Очистить логи</button><button type="button" class="btn" data-copy-all>📋 Скопировать всё</button></div><button type="button" class="btn primary" data-close>Закрыть</button>`;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-clear]').onclick = () => {
    if (!confirmDialog('Очистить логи скриптов? Завершённые записи будут удалены.')) return;
    tasks = tasks.filter(t => t.status === 'running'); saveJournal(); draw(); renderDock();
  };
  ov.foot.querySelector('[data-copy-all]').onclick = async (e) => {
    const text = rowsOf().map(t => [
      `=== ${t.title} — ${new Date(t.startedAt).toLocaleString('ru-RU')} — ${t.summary || t.status} ===`,
      ...t.entries.map(x => `${timeOf(x.at)} ${LEVEL_ICON[x.level] || '•'} ${x.message}`)
    ].join('\n')).join('\n\n');
    try { await navigator.clipboard.writeText(text); e.target.textContent = '✔ Скопировано'; }
    catch (_) { e.target.textContent = 'Не удалось скопировать'; }
  };
  const unsub = onTaskChange(() => { if (document.body.contains(ov.el)) draw(); });
  const origClose = ov.close; ov.close = () => { unsub(); origClose(); };
}

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
