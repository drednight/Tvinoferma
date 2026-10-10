// @ts-check
// js/modules/launcher/gcSettingsModal.js
// Окно «Настройки → Запуск игры → GameCenter и персонажи»:
//  1. список GameCenter с названиями (путь к GameCenter.exe выбирается в проводнике);
//  2. какой GameCenter запускать в первую очередь (при запуске пати побеждает тот, которым пользуется больше участников; это — при равенстве);
//  3. персонажи: какие GameCenter к ним прикреплены (можно несколько) и запомненный вход в каждом из них.
// Изменения сохраняются сразу. Токены входа в интерфейс не попадают: их хранит ОС (см. launcher.rs).

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { showModal, toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { getClassIconSrc } from '../../core/constants.js';
import { gameCenterInfo, pickGameCenter, forgetAccount } from './launch.js';
import { captureLogin, forgetLogin } from './partyLaunch.js';
import {
  attachedGcs, attachGc, detachGc, replaceGc, accountKey, newGcId, suggestGcName, samePathKey,
  removeGameCenter, importLegacyPaths, countLaunchReady, MAX_GAME_CENTERS
} from './gameCenters.js';
import { partiesOf, NO_PARTY } from '../parties/membership.js';

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');
const launcherSettings = () => state.settings.launcher;
const gcs = () => launcherSettings().gameCenters;

/** Запомнен ли вход персонажа хотя бы в одном из прикреплённых GameCenter. */
export function hasAnySavedLogin(char) {
  const attached = attachedGcs(char, gcs());
  if (!attached.length) return false;
  return attached.some((g) => !!char?.launch?.gcAccounts?.[g.id]);
}

/**
 * Персонаж нельзя запустить, если у него нет прикреплённого GameCenter.
 * Возвращает причину или `null`, когда с персонажем всё в порядке.
 * @param {any} char
 * @returns {'no-gc' | 'no-login' | null}
 */
export function launchBlocker(char) {
  if (!attachedGcs(char, gcs()).length) return 'no-gc';
  if (!hasAnySavedLogin(char)) return 'no-login';
  return null;
}

/** Человеческое объяснение причины — для окна предупреждения при запуске пати. */
export function launchBlockerText(reason) {
  return reason === 'no-gc'
    ? 'не прикреплён GameCenter'
    : 'не запомнен вход в GameCenter';
}

/** Подпись для настроек: сколько GameCenter и сколько персонажей готовы к запуску. */
export function gcSummaryText() {
  const ctx = { gameCenters: gcs(), preferredId: launcherSettings().preferredGcId };
  const ready = countLaunchReady(state.characters, ctx);
  return `GameCenter в списке: ${gcs().length} · персонажей готово к запуску: ${ready} из ${state.characters.length}`;
}

/** Удалить токен входа из хранилища ОС (вне приложения — ничего не делаем). */
async function forgetKey(key) {
  if (!isTauri() || !key) return;
  try { await forgetAccount(key); } catch (e) { console.warn('[GC] forget', e); }
}

/**
 * Открывает окно. `onClose` вызывается при закрытии (кнопка «Закрыть» или Esc).
 * @param {{ onClose?: () => void }} [opts]
 */
export function openGameCentersModal(opts = {}) {
  /** @type {Map<string, { status: 'loading' | 'ok' | 'error', nick?: string, loggedIn?: boolean, error?: string }>} */
  const info = new Map();
  let filter = '';
  /** Фильтр по пати: '' — все, NO_PARTY — без пати, иначе id пати. */
  let partyFilter = '';
  /** Скрывать ли персонажей, у которых уже прикреплён хотя бы один GameCenter. */
  let onlyUnbound = false;
  /** Скрывать ли тех, у кого вход уже запомнен хотя бы в одном прикреплённом GameCenter. */
  let onlyNoLogin = false;

  showModal({
    title: '🎮 GameCenter и персонажи',
    content: '<div id="gcm-root" class="gcm"></div>',
    submitText: null,
    cancelText: 'Закрыть',
    onClose: () => opts.onClose?.()
  });
  const root = document.getElementById('gcm-root');
  if (!root) return;
  const container = /** @type {HTMLElement | null} */ (root.closest('.modal-container'));
  if (container) container.style.maxWidth = '980px';

  const save = async () => { await persist(); };

  // ----- Разметка -----

  const infoText = (gc) => {
    const i = info.get(gc.id);
    if (!isTauri()) return 'Проверка входа доступна только в приложении';
    if (!i || i.status === 'loading') return 'Проверяю…';
    if (i.status === 'error') return `Не удалось прочитать: ${i.error}`;
    return i.loggedIn ? `Сейчас открыт аккаунт: ${i.nick || '(ник не указан)'}` : 'Вход в GameCenter не выполнен';
  };

  const gcRowsHtml = () => {
    if (!gcs().length) return '<p class="muted gcm-empty">Пока нет ни одного GameCenter. Нажмите «Добавить GameCenter» и укажите файл GameCenter.exe.</p>';
    return gcs().map(gc => {
      const i = info.get(gc.id);
      const state = !isTauri() ? 'idle' : !i || i.status === 'loading' ? 'busy' : i.status === 'error' ? 'error' : i.loggedIn ? 'on' : 'off';
      const used = state === 'on' ? 'Вход' : state === 'error' ? 'Ошибка чтения' : state === 'busy' ? 'Проверка…' : state === 'idle' ? 'Только в приложении' : 'Вход не выполнен';
      const cls = state === 'on' ? 'is-on' : state === 'error' ? 'is-bad' : state === 'busy' ? 'is-busy' : 'is-idle';
      return `
      <div class="gcm-gc" data-gc="${escapeHtml(gc.id)}">
        <span class="gcm-gc-ico" aria-hidden="true">🎮</span>
        <input class="input gcm-gc-name" data-act="gc-name" value="${escapeHtml(gc.name)}" maxlength="60" aria-label="Название GameCenter" />
        <div class="gcm-gc-path" title="${escapeHtml(gc.path)}">${escapeHtml(gc.path)}</div>
        <div class="state ${cls} gcm-gc-who" title="${escapeHtml(infoText(gc))}"><span class="state-dot"></span><span>${escapeHtml(used)}</span></div>
        <div class="gcm-gc-btns">
          <button type="button" class="btn ghost" data-act="gc-info" title="Показать, какой аккаунт сейчас открыт в этом GameCenter">🔄</button>
          <button type="button" class="btn secondary" data-act="gc-path" title="Выбрать GameCenter.exe в проводнике заново">📂 Путь…</button>
          <button type="button" class="btn ghost" data-act="gc-del" title="Убрать из списка (у персонажей он будет откреплён)">🗑</button>
        </div>
      </div>`;
    }).join('');
  };

  const importCount = () => state.characters.filter(c =>
    String(c.launch?.gcPath || '').trim() && !attachedGcs(c, gcs()).length).length;

  const optionsHtml = (list, selectedId = '') =>
    list.map(g => `<option value="${escapeHtml(g.id)}"${g.id === selectedId ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('');

  /** Варианты фильтра по пати: «Все», «Без пати» и сами пати в их порядке. */
  const partyOptionsHtml = () => {
    const items = [...state.parties]
      .sort((a, b) => (Number(a.order) || 1e9) - (Number(b.order) || 1e9) || a.name.localeCompare(b.name, 'ru'))
      .map(p => `<option value="${escapeHtml(p.id)}"${partyFilter === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    return `<option value=""${partyFilter === '' ? ' selected' : ''}>Все пати</option>`
      + `<option value="${NO_PARTY}"${partyFilter === NO_PARTY ? ' selected' : ''}>Без пати</option>`
      + items;
  };

  const charHtml = (c) => {
    const attached = attachedGcs(c, gcs());
    const free = gcs().filter(g => !attached.some(a => a.id === g.id));
    const icon = getClassIconSrc(c.class);
    const parties = partiesOf(c, state.parties);
    // Пати показываем сразу: по ним персонажа и ищут
    const partyChips = parties.length
      ? parties.map(p => `<span class="gcm-tag${p.id === c.mainPartyId ? ' is-main' : ''}">${escapeHtml(p.name)}</span>`).join('')
      : '<span class="gcm-tag is-none">Без пати</span>';
    const rows = attached.map((g, i) => {
      const acc = c.launch?.gcAccounts?.[g.id];
      const others = gcs().filter(x => x.id === g.id || !attached.some(a => a.id === x.id));
      return `
        <div class="gcm-bind" data-gc="${escapeHtml(g.id)}" data-i="${i}">
          <select class="select" data-act="swap" aria-label="GameCenter персонажа">${optionsHtml(others, g.id)}</select>
          ${i === 0 && attached.length > 1 ? '<span class="gcm-badge" title="Первый в списке: запускается, если не выбран другой">основной</span>' : ''}
          <span class="gcm-acc ${acc ? 'is-saved' : 'muted'}">${acc ? `🔑 Вход запомнен${acc.nick ? `: ${escapeHtml(acc.nick)}` : ''}` : 'Вход не запомнен'}</span>
          <button type="button" class="btn secondary" data-act="cap" title="Сначала войдите в аккаунт этого персонажа в выбранном GameCenter, затем нажмите: токен сохранится в хранилище ОС">🔑 Запомнить вход</button>
          ${acc ? '<button type="button" class="btn ghost" data-act="forget">Забыть</button>' : ''}
          <button type="button" class="btn ghost" data-act="detach" title="Открепить этот GameCenter от персонажа">✕</button>
        </div>`;
    }).join('');
    const own = String(c.launch?.gcPath || '').trim();
    return `
      <div class="gcm-char${attached.length ? ' is-bound' : ''}" data-char="${escapeHtml(c.id)}">
        <div class="gcm-char-head">
          ${icon ? `<img class="gcm-ico" src="${escapeHtml(icon)}" alt="" />` : '<span class="gcm-ico"></span>'}
          <span class="gcm-char-name"><b>${escapeHtml(c.nick)}</b><small class="muted">${escapeHtml(c.class || '')}</small></span>
          <span class="gcm-char-parties" title="Пати персонажа">${partyChips}</span>
          ${attached.length ? `<span class="gcm-count" title="Сколько GameCenter прикреплено">${attached.length}</span>` : ''}
        </div>
        ${rows}
        ${!attached.length && own ? `<div class="muted gcm-own" title="${escapeHtml(own)}">Свой путь из карточки: ${escapeHtml(own)}</div>` : ''}
        ${free.length ? `<select class="select gcm-add" data-act="attach" aria-label="Прикрепить GameCenter">
          <option value="">${attached.length ? '➕ Ещё один GameCenter…' : '➕ Выбрать GameCenter…'}</option>${optionsHtml(free)}</select>` : ''}
      </div>`;
  };

  const charsHtml = () => {
    const q = filter.trim().toLowerCase();
    const list = state.characters.filter(c => {
      if (q && !`${c.nick} ${c.class}`.toLowerCase().includes(q)) return false;
      if (partyFilter === NO_PARTY) { if (partiesOf(c, state.parties).length) return false; }
      else if (partyFilter && !(c.partyIds || []).includes(partyFilter)) return false;
      if (onlyUnbound && attachedGcs(c, gcs()).length) return false;
      // «Нет входа» — это про запомненный вход, а не про привязку: персонаж может быть
      // прикреплён, но вход не запомнен ни в одном из них. Такой при запуске пати попадёт
      // в окно предупреждения, и фильтр помогает найти их заранее.
      if (onlyNoLogin && hasAnySavedLogin(c)) return false;
      return true;
    });
    if (!gcs().length) return '<p class="muted gcm-empty">Сначала добавьте хотя бы один GameCenter выше.</p>';
    if (!list.length) return '<p class="muted gcm-empty">Никого не найдено. Измените поиск или фильтр по пати.</p>';
    return list.map(charHtml).join('');
  };

  const renderGcs = () => {
    const el = root.querySelector('#gcm-gcs');
    if (el) el.innerHTML = gcRowsHtml();
    renderGcsPref();
    const imp = /** @type {HTMLElement | null} */ (root.querySelector('#gcm-import'));
    const n = importCount();
    if (imp) {
      imp.hidden = n === 0;
      const t = imp.querySelector('span');
      if (t) t.textContent = `В карточках персонажей найдено путей к GameCenter: ${n}. Перенести их в список (одинаковые объединятся, вход сохранится)?`;
    }
  };

  const renderChars = () => {
    const el = root.querySelector('#gcm-chars');
    if (!el) return;
    const body = root.closest('.modal-body');
    const top = body ? body.scrollTop : 0;
    el.innerHTML = charsHtml();
    if (body) body.scrollTop = top;
    const cnt = root.querySelector('#gcm-summary');
    if (cnt) cnt.textContent = gcSummaryText();
    const shown = root.querySelector('#gcm-shown');
    if (shown) {
      const total = state.characters.length;
      const visible = el.querySelectorAll('.gcm-char').length;
      shown.textContent = visible === total ? `Все персонажи: ${total}` : `Показано: ${visible} из ${total}`;
    }
  };

  const renderAll = () => { renderGcs(); renderChars(); };

  root.innerHTML = `
    <section class="gcm-sec">
      <h4>1. Мои GameCenter</h4>
      <p class="muted">Назовите каждый GameCenter так, как вам удобно (например, «Папка 1», «Папка 2»). Путь выбирается в проводнике: найдите файл GameCenter.exe.</p>
      <div id="gcm-gcs"></div>
      <div class="gcm-actions">
        <button type="button" class="btn primary" data-act="gc-add">➕ Добавить GameCenter</button>
      </div>
      <div id="gcm-import" class="gcm-import" hidden>
        <span></span>
        <button type="button" class="btn secondary" data-act="import">Перенести</button>
      </div>
    </section>
    <section class="gcm-sec">
      <h4>2. Какой GameCenter запускать</h4>
      <label class="gcm-pref">Запускать в первую очередь (при ничьей):
        <select id="gcm-pref" class="select" aria-label="Какой GameCenter запускать в первую очередь"></select>
      </label>
      <p class="muted">Пати запускается из того GameCenter, которым пользуется больше всего её участников. У кого его нет — запускается из того, что ему доступен (если их несколько — первый в его списке). Выбранный здесь GameCenter нужен для ничьей и для запуска одиночных персонажей.</p>
    </section>
    <section class="gcm-sec">
      <h4>3. Персонажи <small id="gcm-summary" class="muted"></small></h4>
      <p class="muted">К каждому персонажу можно прикрепить несколько GameCenter. «🔑 Запомнить вход» привязывает к выбранному GameCenter аккаунт, под которым вы в нём сейчас вошли: сначала войдите в нужный аккаунт в самом GameCenter.</p>
      <div class="gcm-filters">
        <input id="gcm-filter" class="input" type="search" placeholder="Найти по нику или классу…" aria-label="Найти персонажа" />
        <select id="gcm-party" class="select" aria-label="Фильтр по пати">${partyOptionsHtml()}</select>
        <label class="gcm-only"><input type="checkbox" id="gcm-unbound" /> Только без GameCenter</label>
        <label class="gcm-only" title="Персонажи, у которых вход не запомнен ни в одном прикреплённом GameCenter"><input type="checkbox" id="gcm-nologin" /> Только без запомненного входа</label>
        <span id="gcm-shown" class="muted gcm-shown"></span>
      </div>
      <div id="gcm-chars"></div>
    </section>`;
  renderAll();

  // ----- Сведения о GameCenter (кто в нём сейчас вошёл) -----

  const gcRow = (id) => [...root.querySelectorAll('.gcm-gc')].find(el => el.getAttribute('data-gc') === id) || null;

  const loadInfo = async (gc) => {
    if (!isTauri()) return;
    info.set(gc.id, { status: 'loading' });
    const setText = () => {
      const el = gcRow(gc.id)?.querySelector('.gcm-gc-who');
      if (el) el.textContent = infoText(gc);
    };
    setText();
    try {
      const r = await gameCenterInfo(gc.path);
      info.set(gc.id, { status: 'ok', nick: r?.nick || '', loggedIn: !!r?.loggedIn });
    } catch (e) {
      info.set(gc.id, { status: 'error', error: errText(e) });
    }
    setText();
  };
  const loadAllInfo = async () => { for (const gc of gcs()) await loadInfo(gc); };
  loadAllInfo();

  // ----- Действия -----

  /** Открывает проводник и возвращает путь к GameCenter.exe (или null). Ошибки показываются сразу. */
  const pickPath = async () => {
    if (!isTauri()) { toast('Выбор файла доступен только в приложении', 'error'); return null; }
    try { return await pickGameCenter(); } catch (e) { toast(errText(e), 'error'); return null; }
  };

  const findChar = (el) => state.characters.find(c => c.id === el.closest('[data-char]')?.getAttribute('data-char'));
  const touch = (c) => { c.updatedAt = new Date().toISOString(); };

  root.addEventListener('click', async (ev) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (ev.target).closest('button[data-act]'));
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const gcId = btn.closest('[data-gc]')?.getAttribute('data-gc') || '';
    const gc = gcs().find(g => g.id === gcId);
    const c = findChar(btn);

    if (act === 'gc-add') {
      if (gcs().length >= MAX_GAME_CENTERS) { toast(`Не больше ${MAX_GAME_CENTERS} GameCenter`, 'error'); return; }
      const path = await pickPath();
      if (!path) return;
      const same = gcs().find(g => samePathKey(g.path) === samePathKey(path));
      if (same) { toast(`Этот GameCenter уже в списке: «${same.name}»`, 'error'); return; }
      const created = { id: newGcId(gcs()), name: suggestGcName(path, gcs()), path };
      gcs().push(created);
      await save();
      renderAll();
      toast('GameCenter добавлен: при желании переименуйте его', 'success');
      loadInfo(created);
      /** @type {HTMLInputElement | null | undefined} */ (gcRow(created.id)?.querySelector('input'))?.select();
    } else if (act === 'gc-path' && gc) {
      const path = await pickPath();
      if (!path) return;
      gc.path = path;
      await save();
      renderGcs();
      loadInfo(gc);
    } else if (act === 'gc-info' && gc) {
      loadInfo(gc);
    } else if (act === 'gc-del' && gc) {
      const used = state.characters.filter(x => (x.launch?.gcIds || []).includes(gc.id)).length;
      const ok = await confirmModal({
        title: `Убрать «${gc.name}»?`,
        text: used ? `Он откреплён у персонажей: ${used}. Запомненные для него входы будут удалены. Сам GameCenter и файлы на диске не меняются.` : 'Файлы на диске не меняются.',
        okText: 'Убрать',
        danger: true
      });
      if (!ok) return;
      const keys = removeGameCenter(launcherSettings(), state.characters, gc.id);
      for (const k of keys) await forgetKey(k);
      await save();
      renderAll();
    } else if (act === 'import') {
      const r = importLegacyPaths(launcherSettings(), state.characters);
      await save();
      renderAll();
      loadAllInfo();
      toast(`Перенесено персонажей: ${r.attached}, новых GameCenter: ${r.created}`, 'success');
    } else if (act === 'detach' && c && gc) {
      const acc = c.launch?.gcAccounts?.[gc.id];
      if (acc && !acc.legacy) await forgetKey(accountKey(c, gc.id));
      detachGc(c, gc.id);
      touch(c);
      await save();
      renderChars();
    } else if (act === 'cap' && c && gc) {
      btn.setAttribute('disabled', '');
      await captureLogin(c, gc.id);
      renderChars();
      loadInfo(gc);
    } else if (act === 'forget' && c && gc) {
      await forgetLogin(c, gc.id);
      renderChars();
    }
  });

  root.addEventListener('change', async (ev) => {
    const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (ev.target);
    const act = el.getAttribute?.('data-act');
    if (el.id === 'gcm-pref') {
      launcherSettings().preferredGcId = el.value;
      await save();
      return;
    }
    // Фильтр по пати и «только без GameCenter»: список перерисовывается, данные не меняются
    if (el.id === 'gcm-party') {
      partyFilter = el.value;
      renderChars();
      return;
    }
    if (el.id === 'gcm-unbound') {
      onlyUnbound = /** @type {HTMLInputElement} */ (el).checked;
      renderChars();
      return;
    }
    if (el.id === 'gcm-nologin') {
      onlyNoLogin = /** @type {HTMLInputElement} */ (el).checked;
      renderChars();
      return;
    }
    const gcId = el.closest?.('[data-gc]')?.getAttribute('data-gc') || '';
    const gc = gcs().find(g => g.id === gcId);
    if (act === 'gc-name' && gc) {
      const name = el.value.trim().slice(0, 60);
      if (!name) { el.value = gc.name; return; }
      gc.name = name;
      await save();
      renderChars();
      renderGcsPref();
      return;
    }
    const c = findChar(el);
    if (!c) return;
    if (act === 'attach' && el.value) {
      attachGc(c, el.value);
      touch(c);
      await save();
      renderChars();
    } else if (act === 'swap' && gc) {
      const idx = Number(el.closest('[data-i]')?.getAttribute('data-i'));
      const acc = c.launch?.gcAccounts?.[gc.id];
      if (acc && !acc.legacy) await forgetKey(accountKey(c, gc.id));
      replaceGc(c, idx, el.value);
      touch(c);
      await save();
      renderChars();
    }
  });

  /** После переименования обновляем выпадающий список «Запускать в первую очередь». */
  function renderGcsPref() {
    const pref = /** @type {HTMLSelectElement | null} */ (root?.querySelector('#gcm-pref'));
    if (!pref) return;
    pref.innerHTML = `<option value="">первый из списка персонажа</option>${optionsHtml(gcs(), launcherSettings().preferredGcId)}`;
    pref.value = launcherSettings().preferredGcId || '';
  }

  root.addEventListener('input', (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
    if (el.id !== 'gcm-filter') return;
    filter = el.value;
    renderChars();
  });
}
