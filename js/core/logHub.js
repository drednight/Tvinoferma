// js/core/logHub.js
// Единый модуль логов: «Настройки → 📚 Журналы». Один список для всех видов логов приложения.
//
// Как устроено: каждый вид логов («источник») сам хранит свои данные там, где хранил, и регистрируется здесь:
//   registerLogSource({ id, title, icon, list, open, clear?, clearConfirm?, subscribe?, actions? })
// Хаб ничего не копирует и не переносит: он только собирает записи источников в один список (новые сверху),
// даёт общие фильтры (вид, «только с проблемами», поиск), общие кнопки (очистить, скопировать, сохранить в файл)
// и сам перерисовывается, когда источник сообщает о новой записи. Подробности записи по-прежнему открывает
// сам источник (у каждого вида своё окно: лог задачи, награды промокода, предметы передачи).
// Новый вид логов (например, запуск игры или банк) подключается одной регистрацией, без правок интерфейса.
//
// Запись: { key, at (ISO), title, status: 'ok'|'warn'|'error'|'running', summary?, who? }.

import { escapeHtml } from './utils.js';
import { confirmModal, toast } from './ui.js';
import { openOverlay } from '../modules/marathons/overlay.js';

/** @type {Map<string, object>} */
const sources = new Map();

const STATUS_ICON = { ok: '✅', warn: '⚠️', error: '❌', running: '⏳' };
const ROW_CLASS = { ok: 'done', warn: 'warn', error: 'error', running: 'running' };
const PAGE = 100;

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const isProblem = (it) => it.status === 'warn' || it.status === 'error';

/** Подключает вид логов; повторная регистрация с тем же id заменяет прежнюю. */
export function registerLogSource(src) {
  if (!src?.id || typeof src.list !== 'function' || typeof src.open !== 'function') throw new Error('log source: id, list и open обязательны');
  sources.set(src.id, src);
}
export const getLogSources = () => [...sources.values()];

const listOf = (src) => {
  try {
    return (src.list() || [])
      .filter(it => it && it.key != null && it.at)
      .map(it => ({ ...it, key: String(it.key), source: src.id }));
  } catch (e) { console.warn('[LOG HUB]', src.id, e); return []; }
};

/**
 * Собранный список с фильтрами. `counts` считается без учёта фильтра по виду (для подписей кнопок).
 * @param {{ source?: string, onlyProblems?: boolean, query?: string }} [f]
 */
export function collectLogs({ source = 'all', onlyProblems = false, query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const byFilter = (it) => (!onlyProblems || isProblem(it)) && (!q || [it.title, it.summary, it.who].join(' ').toLowerCase().includes(q));
  const counts = { all: 0 };
  const all = [];
  getLogSources().forEach(src => {
    const rows = listOf(src).filter(byFilter);
    counts[src.id] = rows.length;
    counts.all += rows.length;
    all.push(...rows);
  });
  const items = (source === 'all' ? all : all.filter(it => it.source === source))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { items, counts };
}

/** Короткая строка для заголовка панели. */
export function logHubSummary() {
  const { items } = collectLogs();
  if (!items.length) return 'Записей пока нет: они появятся после первых проверок, промокодов и передач.';
  const problems = items.filter(isProblem).length;
  const last = items[0];
  const src = sources.get(last.source);
  return `Записей: ${items.length}${problems ? ` (с проблемами: ${problems})` : ''} · последняя: ${src?.icon || ''} ${last.title}`;
}

/** Любое изменение любого источника (для заголовка панели). Возвращает функцию отписки. */
export function onLogsChange(fn) {
  const offs = getLogSources().map(src => src.subscribe?.(fn)).filter(Boolean);
  return () => offs.forEach(off => { try { off(); } catch { /* уже отписан */ } });
}

export function logsToText(items) {
  return items.map(it => {
    const src = sources.get(it.source);
    return `${when(it.at)} · ${src?.title || it.source} · ${STATUS_ICON[it.status] || ''} ${it.title}${it.summary ? ` — ${it.summary}` : ''}`;
  }).join('\n');
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Рисует журнал в контейнер (Настройки или отдельное окно).
 * @param {HTMLElement} root
 * @param {{ source?: string }} [opts] source — вид, выбранный сразу
 * @returns {() => void} отписка
 */
export function mountLogHub(root, { source = 'all' } = {}) {
  const st = { source: sources.has(source) ? source : 'all', onlyProblems: false, query: '', limit: PAGE };

  root.innerHTML = `
    <div class="lh-chips" data-lh-chips></div>
    <div class="lh-filters">
      <input class="input" type="search" data-lh-query placeholder="Поиск: ник, код, предмет, задача" />
      <label class="tf-radio"><input type="checkbox" data-lh-problems /> Только с ошибками и предупреждениями</label>
    </div>
    <div class="muted lh-count" data-lh-count></div>
    <div class="tl-journal lh-list" data-lh-list></div>
    <div class="row gap lh-actions" data-lh-actions></div>`;
  const $ = (sel) => root.querySelector(sel);

  const draw = () => {
    const { items, counts } = collectLogs(st);
    const srcs = getLogSources();
    $('[data-lh-chips]').innerHTML = [{ id: 'all', title: 'Все', icon: '📚' }, ...srcs].map(s =>
      `<button type="button" class="lh-chip ${st.source === s.id ? 'active' : ''}" data-lh-source="${escapeHtml(s.id)}">${s.icon || ''} ${escapeHtml(s.title)} <span class="muted">${counts[s.id] ?? 0}</span></button>`).join('');

    const shown = items.slice(0, st.limit);
    $('[data-lh-count]').textContent = items.length
      ? `Показано ${shown.length} из ${items.length}. Нажмите на запись, чтобы открыть подробности.`
      : '';
    $('[data-lh-list]').innerHTML = items.length
      ? shown.map(it => `
        <button type="button" class="tl-jrow tl-s-${ROW_CLASS[it.status] || 'done'}" data-lh-key="${escapeHtml(it.key)}" data-lh-from="${escapeHtml(it.source)}">
          <span>${STATUS_ICON[it.status] || '•'}</span>
          <strong>${sources.get(it.source)?.icon || ''} ${escapeHtml(it.title)}</strong>
          <span class="muted">${escapeHtml(when(it.at))}</span>
          <span class="tl-jsum">${escapeHtml([it.who, it.summary].filter(Boolean).join(' · '))}</span>
        </button>`).join('') + (items.length > shown.length ? `<button type="button" class="btn ghost lh-more" data-lh-more>Показать ещё ${Math.min(PAGE, items.length - shown.length)}</button>` : '')
      : '<div class="empty-state">Ничего не найдено. Здесь появятся логи проверок входа, промокодов и передач предметов.</div>';

    const cur = sources.get(st.source);
    const extra = cur?.actions?.() || [];
    const canClear = !!cur?.clear && listOf(cur).length > 0;
    $('[data-lh-actions]').innerHTML = `
      <button type="button" class="btn ghost danger" data-lh-clear ${canClear ? '' : 'disabled'} title="${cur?.clear ? '' : 'Выберите вид логов, чтобы очистить именно его'}">🧹 Очистить${cur ? `: ${escapeHtml(cur.title)}` : ''}</button>
      ${extra.map(a => `<button type="button" class="btn ghost" data-lh-action="${escapeHtml(a.id)}" ${a.disabled ? 'disabled' : ''}>${escapeHtml(a.label)}</button>`).join('')}
      <span style="flex:1"></span>
      <button type="button" class="btn" data-lh-copy ${items.length ? '' : 'disabled'}>📋 Скопировать список</button>
      <button type="button" class="btn" data-lh-save ${items.length ? '' : 'disabled'}>💾 Сохранить в файл</button>`;
  };

  root.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-lh-source]');
    if (chip) { st.source = chip.dataset.lhSource; st.limit = PAGE; draw(); return; }
    if (e.target.closest('[data-lh-more]')) { st.limit += PAGE; draw(); return; }
    const row = e.target.closest('[data-lh-key]');
    if (row) {
      const src = sources.get(row.dataset.lhFrom);
      const item = listOf(src).find(it => it.key === row.dataset.lhKey);
      if (src && item) src.open(item);
      return;
    }
    const cur = sources.get(st.source);
    if (e.target.closest('[data-lh-clear]') && cur?.clear) {
      const ok = await confirmModal({
        title: 'Очистить логи?',
        text: cur.clearConfirm || `Все записи журнала «${cur.title}» будут удалены. Данные персонажей и марафонов не меняются.`,
        okText: 'Очистить',
        danger: true
      });
      if (!ok) return;
      cur.clear();
      draw();
      toast('Логи очищены', 'success');
      return;
    }
    const act = e.target.closest('[data-lh-action]');
    if (act && cur) { cur.actions?.().find(a => a.id === act.dataset.lhAction)?.run(); return; }
    const text = () => logsToText(collectLogs(st).items);
    if (e.target.closest('[data-lh-copy]')) {
      const btn = e.target.closest('[data-lh-copy]');
      try { await navigator.clipboard.writeText(text()); btn.textContent = '✔ Скопировано'; }
      catch { btn.textContent = 'Не удалось скопировать'; }
      return;
    }
    if (e.target.closest('[data-lh-save]')) download(text(), `tvinoferma-logs-${new Date().toISOString().slice(0, 10)}.txt`);
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-lh-query]')) { st.query = e.target.value; st.limit = PAGE; draw(); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-lh-problems]')) { st.onlyProblems = e.target.checked; st.limit = PAGE; draw(); }
  });

  // Источники сообщают о новых записях часто (задачи — на каждую строку): перерисовываем не чаще раза в 250 мс
  // и только пока контейнер на странице и панель не свёрнута; поле поиска при этом не пересоздаётся.
  let timer = null;
  let offs = [];
  const unsub = () => { clearTimeout(timer); offs.forEach(off => off()); offs = []; };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!root.isConnected) { unsub(); return; }
      const fold = root.closest('details');
      if (!fold || fold.open) draw();
    }, 250);
  };
  offs = getLogSources().map(src => src.subscribe?.(schedule)).filter(Boolean);

  draw();
  return unsub;
}

/** Все логи в отдельном окне; `source` — сразу открыть нужный вид (например, 'transfer'). */
export function openLogHub({ source = 'all', title = '📚 Журналы' } = {}) {
  const ov = openOverlay({ title, wide: true });
  const unsub = mountLogHub(ov.body, { source });
  ov.foot.innerHTML = '<span></span><button type="button" class="btn primary" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  const origClose = ov.close;
  ov.close = () => { unsub(); origClose(); };
  return ov;
}
