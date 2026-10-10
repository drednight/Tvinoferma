// js/modules/launcher/gcBinding.js
// Окно «Привязка GameCenter»: какие аккаунты к какому GameCenter привязаны.
//
// Зачем отдельное окно, если привязка уже есть в карточке персонажа: в карточке видно
// только своё. Здесь видно всю картину сразу — сколько GameCenter, сколько к каждому
// привязано и у кого забыт вход. Обычно это нужно ровно тогда, когда аккаунтов много,
// а список в карточках приходится обходить по одной.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { getClassIconSrc } from '../../core/constants.js';
import { openOverlay } from '../marathons/overlay.js';
import { attachGc, detachGc, setGcAccount } from './gameCenters.js';

const gameCenters = () => state.settings?.launcher?.gameCenters || [];

/** Персонажи, привязанные к GameCenter, в порядке привязки. */
const boundChars = (gcId) =>
  (state.characters || []).filter((c) => (c.launch?.gcIds || []).includes(gcId));

/** Персонажи, которых ещё нет в этом GameCenter. */
const freeChars = (gcId) =>
  (state.characters || []).filter((c) => !(c.launch?.gcIds || []).includes(gcId));

/** Подпись «3 аккаунта» / «1 аккаунт» / «пусто». */
const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

/**
 * Открывает окно привязки GameCenter к аккаунтам.
 */
export async function openGcBinding() {
  const ov = openOverlay({ title: '🎯 Привязка GameCenter', wide: true });
  /** id GameCenter, для которого сейчас открыт список выбора аккаунта */
  let pickingFor = '';

  const draw = () => {
    const list = gameCenters();
    const totalChars = (state.characters || []).length;

    ov.sub.innerHTML = `
      <span class="muted">GameCenter: <b>${list.length}</b> · аккаунтов: <b>${totalChars}</b></span>
      <button type="button" class="btn ghost small" data-act="go-settings">⚙ Список GameCenter в настройках</button>`;

    if (!list.length) {
      ov.body.innerHTML = `<div class="empty-state">
        GameCenter ещё не заведены. Добавьте их в настройках: «Настройки» → «Запуск игры» → «GameCenter и персонажи».
      </div>`;
      ov.foot.innerHTML = `<span class="winp-spacer"></span><button type="button" class="btn ghost" data-act="close">Закрыть</button>`;
      return;
    }

    const ready = list.filter((g) => boundChars(g.id).length).length;
    ov.body.innerHTML = `
      <p class="muted gcb-lead">
        Аккаунт привязывается к GameCenter, чтобы запускаться из него. Один аккаунт можно
        привязать к нескольким GameCenter — тогда для запуска выбирается «Запускать в первую очередь»
        или первый из списка. Вход в GameCenter запоминается отдельно для каждого.
      </p>
      <p class="muted gcb-lead">Привязан хотя бы один аккаунт: <b>${ready}</b> из ${list.length}.</p>
      ${list.map(gcCard).join('')}`;

    ov.foot.innerHTML = `<span class="winp-spacer"></span><button type="button" class="btn ghost" data-act="close">Закрыть</button>`;
  };

  /** Карточка одного GameCenter со списком привязанных аккаунтов. */
  const gcCard = (gc) => {
    const chars = boundChars(gc.id);
    const picking = pickingFor === gc.id;
    const free = picking ? freeChars(gc.id) : [];
    return `<section class="gcb-card" data-gc="${escapeHtml(gc.id)}">
      <header class="gcb-head">
        <div class="gcb-title">
          <b>${escapeHtml(gc.name || 'GameCenter')}</b>
          <small class="muted" title="${escapeHtml(gc.path || '')}">${escapeHtml(gc.path || 'путь не задан')}</small>
        </div>
        <div class="gcb-actions">
          <span class="muted gcb-count">${chars.length ? plural(chars.length, 'аккаунт', 'аккаунта', 'аккаунтов') : 'пусто'}</span>
          <button type="button" class="btn ghost small" data-act="toggle-pick" data-gc="${escapeHtml(gc.id)}">
            ${picking ? '✕ Отмена' : '＋ Привязать аккаунт'}
          </button>
        </div>
      </header>
      ${picking ? pickerHtml(gc, free) : ''}
      ${chars.length ? `<ul class="gcb-list">${chars.map(c => charRow(gc, c)).join('')}</ul>`
                    : '<p class="muted gcb-empty">Ни один аккаунт не привязан.</p>'}
    </section>`;
  };

  /** Разворачивающийся список аккаунтов, которых ещё нет в этом GameCenter. */
  const pickerHtml = (gc, free) => {
    if (!free.length) {
      return '<p class="muted gcb-pick-empty">Все аккаунты уже привязаны к этому GameCenter.</p>';
    }
    return `<ul class="gcb-list gcb-pick">${free.map(c => `
      <li class="gcb-row gcb-row-pick">
        ${avatar(c)}
        <span class="gcb-who"><b>${escapeHtml(c.nick || c.id)}</b><small class="muted">${escapeHtml(c.cls || 'класс не указан')}</small></span>
        <button type="button" class="btn ghost small" data-act="attach" data-gc="${escapeHtml(gc.id)}" data-char="${escapeHtml(c.id)}">Привязать</button>
      </li>`).join('')}</ul>`;
  };

  /** Строка привязанного аккаунта: ник, класс и запомненный вход в этот GameCenter. */
  const charRow = (gc, c) => {
    const acc = c.launch?.gcAccounts?.[gc.id];
    const nick = acc?.nick || '';
    return `<li class="gcb-row">
      ${avatar(c)}
      <span class="gcb-who">
        <b>${escapeHtml(c.nick || c.id)}</b>
        <small class="muted">${escapeHtml(c.cls || 'класс не указан')}</small>
      </span>
      <span class="gcb-acc" title="Запомненный вход в этом GameCenter">
        ${nick ? `🔑 ${escapeHtml(nick)}` : '<span class="muted">вход не запомнен</span>'}
        ${nick ? `<button type="button" class="icon-btn gcb-forget" data-act="forget" data-gc="${escapeHtml(gc.id)}" data-char="${escapeHtml(c.id)}" title="Забыть вход в этом GameCenter">✕</button>` : ''}
      </span>
      <button type="button" class="btn ghost small" data-act="detach" data-gc="${escapeHtml(gc.id)}" data-char="${escapeHtml(c.id)}">Отвязать</button>
    </li>`;
  };

  const avatar = (c) => {
    const icon = getClassIconSrc(c.cls);
    return `<span class="gcb-ava">${icon ? `<img src="${escapeHtml(icon)}" alt="" />` : escapeHtml((c.nick || c.id || '?')[0])}</span>`;
  };

  const charById = (id) => (state.characters || []).find((c) => c.id === id);
  const gcById = (id) => gameCenters().find((g) => g.id === id);

  ov.el.addEventListener('click', async (event) => {
    const btn = /** @type {HTMLElement} */ (event.target).closest?.('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const gc = gcById(btn.dataset.gc);
    const char = charById(btn.dataset.char);

    if (act === 'close') { ov.close(); return; }
    if (act === 'go-settings') {
      ov.close();
      location.hash = '#/settings';
      return;
    }
    if (act === 'toggle-pick') {
      pickingFor = pickingFor === btn.dataset.gc ? '' : btn.dataset.gc;
      draw();
      return;
    }
    if (act === 'attach' && gc && char) {
      attachGc(char, gc.id);
      await persist();
      draw();
      return;
    }
    if (act === 'detach' && gc && char) {
      detachGc(char, gc.id);
      await persist();
      toast(`${char.nick || char.id}: отвязан от «${gc.name || 'GameCenter'}»`, 'success');
      draw();
      return;
    }
    if (act === 'forget' && gc && char) {
      setGcAccount(char, gc.id, null);
      await persist();
      draw();
    }
  });

  draw();
  return ov;
}