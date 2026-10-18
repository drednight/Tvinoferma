// Панель «Разделы приложения» в настройках: какие разделы видны и в каком порядке.
//
// Список строится кодом из общего описания разделов (`js/core/sections.js`), а не разбирается
// из разметки меню: тогда панель и меню описываются одним списком, и выключенный раздел нельзя
// случайно забыть.

import { state } from '../core/state.js';
import { persist } from '../core/storage.js';
import { toast } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';
import {
  SECTIONS, canHideSection, normalizeSectionsSettings, sectionOrder, sectionById
} from '../core/sections.js';

/**
 * Текущая настройка разделов в виде, пригодном для записи.
 * @param {any} [settings]
 * @returns {{ hidden: string[], order: string[] }}
 */
export function readSections(settings = state.settings) {
  return normalizeSectionsSettings(settings?.ui?.sections);
}

/** Сохраняет настройку разделов целиком: порядок и список выключенных меняются вместе. */
async function writeSections(next, deps = {}) {
  const settings = deps.settings || state.settings;
  settings.ui.sections = normalizeSectionsSettings(next);
  await (deps.persist || persist)();
}

/**
 * Подсказка «почему нельзя» — одна и та же для подписи в панели и для отказа в действии,
 * чтобы интерфейс не объяснял одно, а отвечал другое.
 *
 * @returns {string} пусто, если выключать можно
 */
export function sectionHint(sectionId, settings = state.settings) {
  const section = SECTIONS.find((s) => s.id === String(sectionId));
  if (section?.required) return section.required;
  if (!canHideSection(sectionId, settings)) return 'Это последний видимый раздел: убрать его будет некуда.';
  return '';
}

/**
 * Передвигает раздел на одну позицию среди видимых переставляемых.
 *
 * @returns {{ hidden: string[], order: string[] } | null} новая настройка или `null`, если двигать некуда
 */
export function moveSection(sectionId, direction, settings = state.settings) {
  const { hidden, order } = readSections(settings);
  const movable = order.filter((id) => !sectionById(id)?.pin && !hidden.includes(id));
  const at = movable.indexOf(String(sectionId));
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= movable.length) return null;
  movable.splice(to, 0, ...movable.splice(at, 1));
  // Выключенные оставляем на своих местах: их в меню нет, и на порядок видимых они не влияют.
  // Зато каждый вернётся на своё место, когда его включат.
  let cursor = 0;
  const next = order.map((id) => (movable.includes(id) ? movable[cursor++] : id));
  return { hidden, order: next };
}

/**
 * Включает или выключает раздел.
 *
 * Отказ молча проглатывать нельзя: человек нажал галочку и ждёт результата. Поэтому при
 * отказе показываем, чем он вызван.
 *
 * @returns {Promise<boolean>} применилось ли изменение
 */
export async function setSectionHidden(sectionId, hide, deps = {}) {
  const settings = deps.settings || state.settings;
  const current = readSections(settings);
  if (current.hidden.includes(String(sectionId)) === !!hide) return false;
  if (hide) {
    const hint = sectionHint(sectionId, settings);
    if (hint) { toast(hint, 'warning', 5000); return false; }
  }
  const hidden = hide
    ? [...new Set([...current.hidden, String(sectionId)])]
    : current.hidden.filter((id) => id !== String(sectionId));
  await writeSections({ hidden, order: current.order }, deps);
  return true;
}

/**
 * Список разделов для панели: переключатель видимости, название, кнопки порядка и — для
 * невыключаемых — причина, почему нельзя. Без причины заблокированный переключатель
 * выглядит как «сломано».
 *
 * Строка — это `div`, а не `label`: внутри `label` нажатие на любую кнопку (в том числе
 * на стрелку) включает ещё и переключатель, и порядок менялся бы вместе с видимостью.
 * Подпись поэтому только вокруг переключателя с названием.
 *
 * @param {any} [settings]
 * @returns {string}
 */
export function sectionsListHtml(settings = state.settings) {
  const { hidden } = readSections(settings);
  const ordered = sectionOrder(settings);
  // Стрелки двигают раздел только по видимым: у скрытого в меню нет ни строки, ни «места выше».
  const movable = ordered.filter((s) => !s.pin && !hidden.includes(s.id));
  // Рисуем именно сохранённый порядок. Раньше здесь был `SECTIONS.map(...)`, и список
  // всегда показывал порядок по умолчанию: стрелки считали позицию по сохранённому, а строки
  // стояли по каноническому — перестановка выглядела как «ничего не происходит».
  return ordered.map((section) => {
    const isHidden = hidden.includes(section.id);
    const required = !!section.required;
    const pinned = !!section.pin;
    // Закреплённый раздел не двигается: у него нет «места выше/ниже», и стрелки у него
    // не работали бы вхолостую — вместо них показываем, где он стоит
    const at = required || pinned ? -1 : movable.indexOf(section);
    const canMoveUp = at > 0;
    const canMoveDown = at >= 0 && at < movable.length - 1;
    const pinNote = section.pin === 'top' ? 'закреплён сверху' : section.pin === 'bottom' ? 'закреплён снизу' : '';
    const hint = required ? section.required : (!isHidden ? sectionHint(section.id, settings) : '');
    return `
      <div class="sections-row${isHidden ? ' is-off' : ''}${required ? ' is-required' : ''}${pinned ? ' is-pinned' : ''}">
        <label class="sections-toggle" title="${escapeHtml(hint)}">
          <input type="checkbox" data-sections-id="${escapeHtml(section.id)}" ${isHidden ? '' : 'checked'}
                 ${required ? 'disabled' : ''} />
          <span class="switch" aria-hidden="true"></span>
          <span class="sections-copy">
            <b>${escapeHtml(section.title)}</b>
            ${hint ? `<small class="muted">${escapeHtml(hint)}</small>` : ''}
          </span>
        </label>
        <span class="sections-order">
          ${pinned ? `<small class="muted sections-pin">${escapeHtml(pinNote)}</small>` : `
          <button type="button" class="btn ghost small" data-sections-move="up" data-sections-id="${escapeHtml(section.id)}"
                  title="${canMoveUp ? 'Выше' : 'Уже первый'}" ${canMoveUp ? '' : 'disabled'}>↑</button>
          <button type="button" class="btn ghost small" data-sections-move="down" data-sections-id="${escapeHtml(section.id)}"
                  title="${canMoveDown ? 'Ниже' : 'Уже последний'}" ${canMoveDown ? '' : 'disabled'}>↓</button>`}
        </span>
      </div>`;
  }).join('');
}

/**
 * Подключает панель. Возвращает функцию перерисовки — её зовёт и сам список,
 * и внешние места (например, перезагрузка настроек).
 *
 * @param {{ settings?: any, persist?: () => Promise<void>, onChange?: () => void }} [deps]
 * @returns {null | { render: () => void }}
 */
export function bindSectionsPanel(deps = {}) {
  const box = document.getElementById('sections-list');
  if (!box) return null;
  const settings = deps.settings || state.settings;
  const render = () => { box.innerHTML = sectionsListHtml(settings); };
  const changed = () => { deps.onChange?.(); render(); };

  box.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-sections-id]');
    if (!input) return;
    if (input.disabled) { render(); return; }
    const applied = await setSectionHidden(input.dataset.sectionsId, !input.checked, { ...deps, settings });
    if (!applied) render();
    else changed();
  });

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sections-move]');
    if (!btn || btn.disabled) return;
    const next = moveSection(btn.dataset.sectionsId, btn.dataset.sectionsMove, settings);
    if (!next) return;
    await writeSections(next, deps);
    changed();
  });

  render();
  return { render };
}