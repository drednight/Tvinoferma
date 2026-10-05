// js/core/commandPalette.js
// Командная палитра (Ctrl+K, Issue #40): одна строка поиска для всего приложения.
//
// Зачем: горячие клавиши требуют запоминать сочетания, а список команд — нет. Набрал часть ника —
// видишь «открыть профиль», «проверить вход», «запустить игру». Один и тот же список обслуживает
// и мышь, и клавиатуру (↑↓, Enter, Esc), поэтому он заменяет собой часть меню.
//
// Данные команд — в commandPaletteData.js (там же поиск, покрытый тестами). Здесь только показ.

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { toast } from './ui.js';
import { buildCommands, filterCommands, isHeading } from './commandPaletteData.js';

let dialog = null;
let closeHandler = null;

export const isPaletteOpen = () => !!dialog;

/**
 * Открывает палитру. Если она уже открыта — ничего не делает.
 * @param {{ switchTab?: (tab: string) => void, run?: (action: string, payload?: any) => void, onClose?: () => void }} [deps]
 */
export function openCommandPalette(deps = {}) {
  if (dialog) return dialog;

  const commands = buildCommands(state, deps);
  let visible = commands;
  let activeIndex = 0;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cp-overlay';
  overlay.innerHTML = `
    <div class="cp-dialog" role="dialog" aria-modal="true" aria-label="Командная палитра">
      <div class="cp-head">
        <span class="cp-ico" aria-hidden="true">⌘</span>
        <input class="cp-input" type="text" placeholder="Команда, ник персонажа, пати…" aria-label="Поиск команды" autocomplete="off" />
        <kbd class="cp-esc">Esc</kbd>
      </div>
      <div class="cp-list" role="listbox" aria-label="Команды"></div>
      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> выбор</span>
        <span><kbd>Enter</kbd> выполнить</span>
        <span><kbd>Esc</kbd> закрыть</span>
      </div>
    </div>`;

  const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.cp-input'));
  const listEl = /** @type {HTMLElement} */ (overlay.querySelector('.cp-list'));

  /** Строки, по которым можно перемещаться стрелками (разделители пропускаются). */
  const selectable = () => visible.filter(c => !isHeading(c));

  const draw = () => {
    const items = selectable();
    if (!items.length) {
      listEl.innerHTML = '<div class="cp-empty">Ничего не найдено. Попробуйте другое слово или часть ника.</div>';
      return;
    }
    if (activeIndex >= items.length) activeIndex = items.length - 1;
    if (activeIndex < 0) activeIndex = 0;
    const activeId = items[activeIndex]?.id;
    let lastGroup = '';
    listEl.innerHTML = visible.map(c => {
      if (isHeading(c)) {
        lastGroup = c.group;
        return `<div class="cp-group">${escapeHtml(c.title)}</div>`;
      }
      if (c.group !== lastGroup) lastGroup = c.group;
      const isActive = c.id === activeId;
      return `<button type="button" class="cp-item${isActive ? ' is-active' : ''}" role="option"
        aria-selected="${isActive}" data-cmd="${escapeHtml(c.id)}">
        <span class="cp-item-title">${escapeHtml(c.title)}</span>
        ${c.subtitle ? `<span class="cp-item-sub muted">${escapeHtml(c.subtitle)}</span>` : ''}
      </button>`;
    }).join('');
    // Активная строка должна быть видна при переходе стрелками.
    // scrollIntoView есть не везде (нет в jsdom и в старых движках), поэтому вызываем осторожно.
    const active = /** @type {HTMLElement | undefined} */ (listEl.querySelector('.cp-item.is-active'));
    if (typeof active?.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  };

  const applyQuery = (value) => {
    visible = filterCommands(commands, value);
    activeIndex = 0;
    draw();
  };

  /** Выполняет команду и закрывает палитру. */
  const runCommand = (id) => {
    const command = commands.find(c => c.id === id);
    if (!command || isHeading(command)) return;
    close();
    // Действие запускаем после закрытия, чтобы окно не осталось поверх открывшегося диалога
    setTimeout(() => {
      try {
        command.run();
      } catch (e) {
        console.error('[CMD]', e);
        toast(`Не удалось выполнить команду: ${e?.message || e}`, 'error');
      }
    }, 0);
  };

  const onKey = (e) => {
    const items = selectable();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) { activeIndex = (activeIndex + 1) % items.length; draw(); }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) { activeIndex = (activeIndex - 1 + items.length) % items.length; draw(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) runCommand(item.id);
      return;
    }
    if (e.key === 'Home' || (e.key === 'PageUp' && !e.altKey)) {
      e.preventDefault();
      activeIndex = 0;
      draw();
      return;
    }
    if (e.key === 'End' || e.key === 'PageDown') {
      e.preventDefault();
      activeIndex = Math.max(0, items.length - 1);
      draw();
    }
  };

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    dialog = null;
    closeHandler = null;
    deps.onClose?.();
  };
  closeHandler = close;

  input.addEventListener('input', () => applyQuery(input.value));
  // Клик мимо окна закрывает палитру: она лёгкая и вызывается одной клавишей
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  listEl.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-cmd]'));
    if (item?.dataset.cmd) runCommand(item.dataset.cmd);
  });
  listEl.addEventListener('mousemove', (e) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-cmd]'));
    if (!item?.dataset.cmd) return;
    const items = selectable();
    const idx = items.findIndex(c => c.id === item.dataset.cmd);
    if (idx >= 0 && idx !== activeIndex) { activeIndex = idx; draw(); }
  });

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  dialog = overlay;
  applyQuery('');
  input.focus();
  return overlay;
}

/** Закрывает палитру, если она открыта. */
export function closeCommandPalette() {
  closeHandler?.();
}
