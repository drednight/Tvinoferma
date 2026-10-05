// js/modules/launcher/windowPicker.js
// Окно «Запущенные окна игры»: список клиентов с ником, PID, временем работы и галочками,
// плюс кнопки «Закрыть выбранные», «Закрыть пати…» и «Закрыть все».
//
// Зачем: закрывать все окна разом нужно редко — чаще надо закрыть одно зависшее или окна одной пати.
// Список берётся из Rust (`launcher_running_details`), сопоставление с персонажами — в windowList.js.

import { state } from '../../core/state.js';
import { isTauri } from '../../core/storage.js';
import { toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { getClassIconSrc, CLASSES } from '../../core/constants.js';
import { runningClientDetails, closeClientsByPid, closeAllClients, applyWindowStyle, applyStyleText } from './launch.js';
import { windowRows, rowLabel, formatUptime, closeSelectedText } from './windowList.js';
import { showCloseReport } from './partyLaunch.js';

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/**
 * Открывает окно со списком запущенных клиентов игры.
 * @param {{ onClosed?: (report: any) => void }} [opts]
 */
export async function openWindowPicker(opts = {}) {
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return null; }

  const ov = openOverlay({ title: '🎮 Запущенные окна игры', wide: true, onClose: () => opts.onClosed?.(null) });
  /** @type {Set<number>} */
  const selected = new Set();
  /** @type {Array<any>} */
  let rows = [];
  let busy = false;

  const draw = () => {
    const known = rows.filter(r => r.known).length;
    ov.sub.innerHTML = `<span class="muted">Окон запущено: <b>${rows.length}</b>${known ? ` · из них с ником: ${known}` : ''}</span>
      <button type="button" class="btn ghost small" data-act="refresh">🔄 Обновить список</button>`;

    ov.body.innerHTML = rows.length
      ? `<div class="winp-list">${rows.map(rowHtml).join('')}</div>`
      : `<div class="empty-state">Запущенных окон игры нет.${known === 0 && rows.length ? '' : ''}</div>`;

    const count = selected.size;
    ov.foot.innerHTML = `
      <span class="winp-count muted">Выбрано: <b>${count}</b></span>
      <span class="winp-spacer"></span>
      <button type="button" class="btn ghost" data-act="close">Отмена</button>
      <button type="button" class="btn secondary" data-act="party" ${count ? '' : 'disabled'}>🛡 Закрыть пати…</button>
      <button type="button" class="btn secondary" data-act="selected" ${count ? '' : 'disabled'}>Закрыть выбранные (${count})</button>
      <button type="button" class="btn danger" data-act="all" ${rows.length ? '' : 'disabled'}>Закрыть все (${rows.length})</button>`;
  };

  const rowHtml = (row) => {
    const icon = row.known ? getClassIconSrc(row.cls) : null;
    const checked = selected.has(row.pid) ? ' checked' : '';
    const uptime = row.uptimeMs == null ? '—' : formatUptime(row.uptimeMs);
    return `
      <div class="winp-row${row.known ? '' : ' is-unknown'}">
        <label class="winp-pick-main">
          <input type="checkbox" data-pid="${row.pid}"${checked} />
          <span class="winp-ava">${icon ? `<img src="${escapeHtml(icon)}" alt="" />` : (row.known && row.nick ? escapeHtml(row.nick[0]) : '?')}</span>
          <span class="winp-who">
            <b>${escapeHtml(row.nick || `PID ${row.pid}`)}</b>
            ${row.cls ? `<small class="muted">${escapeHtml(row.cls)}</small>` : '<small class="muted">окно запущено не из Твинофермы</small>'}
          </span>
        </label>
        <span class="winp-meta muted" title="Идентификатор процесса">PID ${row.pid}</span>
        <span class="winp-meta muted" title="Сколько работает окно">${uptime}</span>
        ${row.elevated ? '<span class="winp-flag" title="Игра запущена от имени администратора">админ</span>' : ''}
        <button type="button" class="btn ghost small winp-style" data-style="${row.pid}"
                title="Задать своё название окна и поставить значок класса">✏️ Вид…</button>
      </div>`;
  };

  const reload = async () => {
    try {
      const clients = await runningClientDetails();
      rows = windowRows(clients, state.characters);
      // Выбор не должен «помнить» закрытые окна
      const live = new Set(rows.map(r => r.pid));
      [...selected].forEach(pid => { if (!live.has(pid)) selected.delete(pid); });
    } catch (e) {
      rows = [];
      toast(`Не удалось получить список окон: ${errText(e)}`, 'error');
    }
    draw();
  };

  /** Закрывает указанные PID и показывает итог. */
  const closePids = async (pids) => {
    if (busy || !pids.length) return;
    busy = true;
    try {
      const report = await closeClientsByPid(pids);
      toast(closeSelectedText(report), report?.failed || report?.error ? 'error' : 'success');
      // Игра от администратора: обычное закрытие не сработало — предложим закрыть с правами
      if (report?.denied && !report?.elevated) showCloseReport(report);
      selected.clear();
      await reload();
      opts.onClosed?.(report);
    } catch (e) {
      toast(`Не удалось закрыть окна: ${errText(e)}`, 'error');
    } finally {
      busy = false;
    }
  };

  ov.body.addEventListener('click', async (e) => {
    // Кнопка «Вид…»: своё название окна и значок класса для конкретного окна
    const styleBtn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-style]'));
    if (!styleBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const row = rows.find(r => r.pid === Number(styleBtn.dataset.style));
    if (row) await openStyleDialog(row, reload);
  });

  ov.body.addEventListener('change', (e) => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    if (box?.type !== 'checkbox') return;
    const pid = Number(box.dataset.pid);
    if (!pid) return;
    if (box.checked) selected.add(pid); else selected.delete(pid);
    draw();
  });

  ov.el.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'refresh') { await reload(); return; }
    if (act === 'close') { ov.close(); return; }
    if (act === 'selected') {
      const pids = [...selected];
      const nick = (pid) => rowLabel(rows.find(r => r.pid === pid)) || `PID ${pid}`;
      const ok = await confirmModal({
        title: `Закрыть окна: ${pids.length}?`,
        text: `${pids.map(nick).join(', ')}. Всё, что не сохранено в игре, будет потеряно.`,
        okText: `Закрыть (${pids.length})`,
        danger: true
      });
      if (ok) await closePids(pids);
      return;
    }

    if (act === 'party') {
      await closeByParty(selected, rows, closePids);
      return;
    }

    if (act === 'all') {
      const ok = await confirmModal({
        title: 'Закрыть все окна игры?',
        text: `Будет закрыто окон: ${rows.length}. Всё, что не сохранено в игре, будет потеряно.`,
        okText: `Закрыть (${rows.length})`,
        danger: true
      });
      if (!ok) return;
      busy = true;
      try {
        const report = await closeAllClients();
        showCloseReport(report);
        selected.clear();
        await reload();
        opts.onClosed?.(report);
      } catch (err) {
        toast(`Не удалось закрыть окна: ${errText(err)}`, 'error');
      } finally {
        busy = false;
      }
    }
  });

  await reload();
  return ov;
}

/**
 * Диалог «Вид окна»: пользователь сам задаёт название окна и выбирает значок класса.
 *
 * Зачем: автоматическая подпись может не сработать (игра от администратора, окно открылось позже),
 * а иногда ник в игре отличается от ника в Твиноферме. Здесь можно поправить вид вручную.
 *
 * @param {any} row строка списка окон
 * @param {() => Promise<void>} after вызывается после успешного применения
 */
async function openStyleDialog(row, after) {
  const suggested = row.nick ? (row.cls ? `${row.nick} — ${row.cls}` : row.nick) : `PID ${row.pid}`;
  const ov = openOverlay({ title: `✏️ Вид окна: ${rowLabel(row)}`, wide: false });
  const classOptions = CLASSES.map(c => `<option value="${escapeHtml(c)}"${row.cls === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  ov.body.innerHTML = `
    <p class="muted">Название окна и значок меняются только у вида окна и панели задач — игра не затрагивается.</p>
    <div class="field">
      <label for="ws-title">Название окна</label>
      <input id="ws-title" class="input" value="${escapeHtml(suggested)}" maxlength="100" placeholder="Например: Ауразак — Воин" />
      <small class="muted">Оставьте пустым, чтобы не менять название.</small>
    </div>
    <div class="field">
      <label for="ws-class">Значок класса</label>
      <select id="ws-class" class="select">
        <option value="">— Не менять значок —</option>
        ${classOptions}
      </select>
      <small class="muted">Значок берётся из встроенных значков классов. Выберите класс — он появится в заголовке окна и на панели задач.</small>
    </div>
    <label class="ws-clear"><input type="checkbox" id="ws-clear" /> Вернуть значок файла игры (убрать поставленный)</label>
    <div id="ws-result"></div>`;

  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button>
    <button type="button" class="btn primary" data-x="apply">Применить</button>`;

  const resultEl = /** @type {HTMLElement} */ (ov.body.querySelector('#ws-result'));

  ov.el.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-x]'));
    if (!btn) return;
    if (btn.dataset.x === 'cancel') { ov.close(); return; }

    const title = /** @type {HTMLInputElement} */ (ov.body.querySelector('#ws-title')).value.trim();
    const cls = /** @type {HTMLSelectElement} */ (ov.body.querySelector('#ws-class')).value;
    const clearIcon = /** @type {HTMLInputElement} */ (ov.body.querySelector('#ws-clear')).checked;
    // Класс и «убрать значок» противоречат друг другу: последнее действие выигрывает
    const useClass = clearIcon ? '' : cls;

    btn.setAttribute('disabled', '');
    try {
      const result = await applyWindowStyle({
        pid: row.pid,
        title: title || null,
        class: useClass || null,
        clearIcon
      });
      const ok = result?.status === 'fixed' || result?.status === 'ok';
      resultEl.innerHTML = `<p class="${ok ? 'tf-ok' : 'tf-warn'}">${escapeHtml(applyStyleText(result))}</p>`;
      if (ok) {
        toast(applyStyleText(result), 'success');
        // Обновляем список, чтобы новые название и класс были видны
        await after?.();
        ov.close();
      }
    } catch (err) {
      resultEl.innerHTML = `<p class="tf-warn">${escapeHtml(errText(err))}</p>`;
    } finally {
      btn.removeAttribute('disabled');
    }
  });
}

/**
 * Закрытие окон по пати: спрашивает, какие пати закрыть, и берёт окна их участников.
 * Выбранные в списке окна учитываются: пати предлагается по ним, а чужие окна не трогаются.
 */
async function closeByParty(selected, rows, closePids) {
  const chosenRows = rows.filter(r => selected.has(r.pid));
  // Какие пати встречаются у выбранных окон
  const partyIds = [...new Set(chosenRows.flatMap(r => r.partyIds))];
  const parties = state.parties.filter(p => partyIds.includes(p.id));
  const unknown = chosenRows.filter(r => !r.known).length;

  const list = parties.length
    ? parties.map(p => `<label class="winp-pick"><input type="checkbox" value="${escapeHtml(p.id)}" checked /> ${escapeHtml(p.name)}</label>`).join('')
    : '<p class="muted">Среди выбранных окон нет персонажей с пати. Отметьте окна персонажей или закройте их кнопкой «Закрыть выбранные».</p>';

  const ov = openOverlay({ title: '🛡 Закрыть окна пати', wide: false });
  ov.body.innerHTML = `<p class="muted">Закроются окна персонажей из отмеченных пати, если они открыты сейчас.</p>
    <div class="winp-picks">${list}</div>
    ${unknown ? `<p class="muted">Окон без ника (запущены не из Твинофермы): ${unknown}. Они не закрываются по пати.</p>` : ''}`;
  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button>
    <button type="button" class="btn danger" data-x="ok" ${parties.length ? '' : 'disabled'}>Закрыть окна пати</button>`;

  const done = new Promise((resolve) => {
    ov.el.addEventListener('click', async (e) => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-x]'));
      if (!b) return;
      if (b.dataset.x === 'cancel') { ov.close(); resolve(null); return; }
      const ids = [...ov.body.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
      const pids = rows.filter(r => r.partyIds.some(id => ids.includes(id))).map(r => r.pid);
      ov.close();
      resolve(pids);
    });
  });

  const pids = await done;
  if (pids?.length) await closePids(pids);
}
