// js/modules/launcher/launchSelection.js
// Выбор состава запуска пати: показывается ДО экрана проверок и ДО очереди запуска.
// Все отмечены по умолчанию; пустой выбор кнопку «Запустить» блокирует; отмена (null) — ничего не запускается.

import { escapeHtml } from '../../core/utils.js';
import { getClassIconSrc } from '../../core/constants.js';
import { openOverlay } from '../marathons/overlay.js';

/**
 * Фильтрует участников по списку id, сохраняя исходный порядок пати.
 * Неизвестные id отбрасываются и возвращаются в `droppedIds` для журнала.
 * @param {Array<{ id: any }>} members
 * @param {Array<any>} memberIds
 * @returns {{ selected: Array<any>, droppedIds: string[] }}
 */
export function selectMembersById(members, memberIds) {
  const list = Array.isArray(members) ? members : [];
  const rawIds = Array.isArray(memberIds) ? memberIds.map(id => String(id)) : [];
  const memberSet = new Set(list.map(m => String(m.id)));
  const wanted = new Set();
  const droppedIds = [];
  for (const id of rawIds) {
    if (memberSet.has(id)) wanted.add(id);
    else droppedIds.push(id);
  }
  const selected = list.filter(m => wanted.has(String(m.id)));
  return { selected, droppedIds };
}

/**
 * Строки выбора в порядке запуска (тот же порядок перетаскивания, что в карточке пати).
 * Чистая функция — вид строк удобно проверить тестом.
 * @param {Array<{ id: any, nick?: any, class?: any }>} members
 * @param {{ runningIds?: Set<string> | Iterable<string> }} [opts]
 * @returns {Array<{ id: string, nick: string, className: string, iconSrc: string, alreadyRunning: boolean }>}
 */
export function pickerRows(members, opts = {}) {
  const running = opts.runningIds instanceof Set ? opts.runningIds : new Set(opts.runningIds || []);
  return (members || []).map(m => {
    const id = String(m.id);
    const className = String(m.class || '');
    return {
      id,
      nick: String(m.nick || m.id),
      className,
      iconSrc: className ? getClassIconSrc(className) || '' : '',
      alreadyRunning: running.has(id)
    };
  });
}

function focusableElements(root) {
  return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(
    el => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null
  );
}

/**
 * Показывает диалог выбора состава и ждёт ответа пользователя.
 * @param {{
 *   partyName?: string,
 *   title?: string,
 *   sub?: string,
 *   members: Array<{ id: any, nick?: any, class?: any }>,
 *   runningIds?: Set<string> | Iterable<string>
 * }} opts
 * @returns {Promise<Array<object> | null>} выбранные участники (в порядке списка) или null при отмене
 */
export function openLaunchPicker({
  partyName = '',
  title = '',
  sub = 'Отметьте персонажей, которых нужно запустить.',
  members = [],
  runningIds
} = {}) {
  return new Promise(resolve => {
    const rows = pickerRows(members, { runningIds });
    let settled = false;
    /** @type {Array<object> | null} */
    let answer = null;
    let observer = null;
    // Диалог обязан отдать результат при любом закрытии — иначе задача останется
    // running и заблокирует очередь до перезапуска приложения (как у экрана проверок).
    const settle = result => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      observer = null;
      resolve(result);
    };
    const heading = partyName
      ? `🚀 Запуск пати „${partyName}“ — кого запускаем`
      : `🚀 ${title || 'Запуск пати — кого запускаем'}`;
    const dlg = openOverlay({ title: heading, onClose: () => settle(answer) });
    observer = new MutationObserver(() => {
      if (dlg.el.isConnected) return;
      dlg.close();
      settle(answer);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    dlg.sub.textContent = sub;
    dlg.body.innerHTML = `
      <p class="plp-count" role="status" aria-live="polite"></p>
      <div class="plp-list">${rows
        .map(row => {
          const initial = Array.from(row.nick)[0] || '?';
          const icon = row.iconSrc
            ? `<img class="plp-ico" src="${escapeHtml(row.iconSrc)}" alt="" />`
            : `<span class="plp-ico plp-ico-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
          return `
        <label class="plp-row" data-member-id="${escapeHtml(row.id)}">
          <input type="checkbox" class="plp-check" value="${escapeHtml(row.id)}" checked />
          ${icon}
          <span class="plp-main"><b class="plp-nick">${escapeHtml(row.nick)}</b>${
            row.className ? `<small class="plp-class muted">${escapeHtml(row.className)}</small>` : ''
          }</span>
          ${row.alreadyRunning ? '<span class="plp-badge">окно уже запущено</span>' : ''}
        </label>`;
        })
        .join('')}</div>`;
    dlg.foot.innerHTML = `
      <button type="button" class="btn ghost small" data-act="all">Выбрать всех</button>
      <button type="button" class="btn ghost small" data-act="none">Снять всех</button>
      <span style="flex:1"></span>
      <button type="button" class="btn ghost" data-act="cancel">Отмена</button>
      <button type="button" class="btn primary" data-act="launch">▶ Запустить</button>`;
    const boxes = /** @type {HTMLInputElement[]} */ ([...dlg.body.querySelectorAll('.plp-check')]);
    const count = dlg.body.querySelector('.plp-count');
    const primary = /** @type {HTMLButtonElement} */ (dlg.foot.querySelector('[data-act="launch"]'));
    const update = () => {
      const n = boxes.reduce((total, box) => total + (box.checked ? 1 : 0), 0);
      if (count) count.textContent = `Запустить: ${n} из ${rows.length}`;
      primary.textContent = `▶ Запустить (${n})`;
      primary.disabled = n === 0;
      primary.title = n === 0 ? 'Выберите хотя бы одного' : '';
    };
    dlg.body.addEventListener('change', event => {
      if (/** @type {HTMLElement} */ (event.target).classList?.contains('plp-check')) update();
    });
    dlg.foot.addEventListener('click', event => {
      const btn = /** @type {HTMLElement} */ (event.target).closest?.('[data-act]');
      const act = btn ? /** @type {HTMLElement} */ (btn).dataset.act : null;
      if (!act) return;
      if (act === 'all' || act === 'none') {
        const value = act === 'all';
        boxes.forEach(box => {
          box.checked = value;
        });
        update();
        return;
      }
      if (act === 'cancel') {
        answer = null;
        dlg.close();
        return;
      }
      if (act === 'launch') {
        const picked = new Set(boxes.filter(box => box.checked).map(box => box.value));
        answer = members.filter(member => picked.has(String(member.id)));
        dlg.close();
      }
    });
    // Focus trap (Tab / Shift+Tab) + Enter (запуск отмеченных).
    dlg.el.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        const items = focusableElements(dlg.el);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Enter') return;
      if (/** @type {HTMLElement} */ (event.target).closest?.('button, select, textarea, a')) return;
      event.preventDefault();
      if (!primary.disabled) primary.click();
    });
    update();
    /** @type {HTMLInputElement | null | undefined} */ (dlg.body.querySelector('.plp-check'))?.focus();
  });
}
