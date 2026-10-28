// demo/character-picker.js
// Выбор персонажей для всех окон варианта B. Данные и выбор остаются только в демо.

import { escapeHtml } from '../js/core/utils.js';
import { getClassIconSrc } from '../js/core/constants.js';
import { openOverlay } from '../js/modules/marathons/overlay.js';

/** Состояние входа на сайт; «проверяется» важнее сохранённого признака входа. */
export const loginStatus = c => (c.checking ? 'checking' : c.isLoggedIn === true ? 'online' : 'offline');
export const stripeCls = c => `st-${loginStatus(c)}`;
export const statusTitle = c =>
  ({ checking: 'Проверка входа на сайт', online: 'Есть вход на сайт', offline: 'Нет входа на сайт' })[loginStatus(c)];

export function classIconHtml(c) {
  const src = getClassIconSrc(c.cls);
  return src
    ? `<img class="char-class-ico" src="../${escapeHtml(src)}" alt="${escapeHtml(c.cls)}" title="${escapeHtml(c.cls)}">`
    : `<span class="char-class-ico char-class-letter" title="${escapeHtml(c.cls)}">${escapeHtml(c.cls?.[0] || '?')}</span>`;
}

let pickerSequence = 0;

/**
 * Отдельное окно с черновиком выбора. Фильтры только скрывают строки и не снимают
 * их отметки; массовые действия относятся исключительно к показанным строкам.
 * onClose получает Set только после «Сохранить», при отмене — null.
 */
export function openCharacterPicker({ characters, selected, parent, returnFocus, onClose }) {
  const knownIds = new Set(characters.map(c => c.id));
  const draft = new Set([...selected].filter(id => knownIds.has(id)));
  const wasInert = !!parent?.inert;
  if (parent) parent.inert = true;
  let result = null;
  const dlg = openOverlay({
    title: 'Выбор персонажей',
    onClose: () => {
      if (parent?.isConnected) parent.inert = wasInert;
      onClose?.(result);
      if (parent?.isConnected && returnFocus?.isConnected) returnFocus.focus();
    }
  });
  const title = dlg.el.querySelector('.tf-dialog-title');
  title.id = `character-picker-title-${++pickerSequence}`;
  const container = dlg.el.querySelector('.modal-container');
  container.classList.add('cp-dialog');
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-labelledby', title.id);
  dlg.sub.textContent = 'Отметьте персонажей и сохраните выбор. Фильтры не снимают скрытые отметки.';

  const options = values =>
    [...new Set(values.filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'ru'))
      .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
  dlg.body.innerHTML = `
    <div class="cp-filters">
      <label class="cp-field cp-search"><span>Поиск</span><input class="input" type="search" data-picker-search autocomplete="off" placeholder="Ник, класс или пати"></label>
      <label class="cp-field"><span>Вход на сайт</span><select class="select" data-picker-status>
        <option value="all">Все состояния</option><option value="online">Есть вход</option><option value="offline">Нет входа</option><option value="checking">Проверяется</option>
      </select></label>
      <label class="cp-field"><span>Пати</span><select class="select" data-picker-party><option value="">Все пати</option>${options(characters.map(c => c.party))}</select></label>
      <label class="cp-field"><span>Класс</span><select class="select" data-picker-class><option value="">Все классы</option>${options(characters.map(c => c.cls))}</select></label>
      <label class="cp-field"><span>Сортировка</span><select class="select" data-picker-sort><option value="asc">А → Я</option><option value="desc">Я → А</option></select></label>
    </div>
    <div class="cp-actions">
      <label class="cp-only"><input type="checkbox" data-picker-only-selected> Только выбранные</label>
      <div class="cp-bulk"><button type="button" class="btn small ghost" data-picker-all>Выбрать показанных</button><button type="button" class="btn small ghost" data-picker-none>Снять показанных</button></div>
    </div>
    <div class="promo-list cp-list" data-picker-list role="group" aria-label="Список персонажей" tabindex="0"></div>
    <div class="cp-count" data-picker-count aria-live="polite"></div>`;
  dlg.foot.innerHTML = `
    <button type="button" class="btn ghost" data-picker-cancel>Отмена</button>
    <button type="button" class="btn primary" data-picker-save>Сохранить выбор</button>`;

  const $ = selector => dlg.body.querySelector(selector);
  const list = $('[data-picker-list]');
  const count = $('[data-picker-count]');
  const search = $('[data-picker-search]');
  const status = $('[data-picker-status]');
  const party = $('[data-picker-party]');
  const cls = $('[data-picker-class]');
  const sort = $('[data-picker-sort]');
  const onlySelected = $('[data-picker-only-selected]');

  function visibleCharacters() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    return characters
      .filter(c => {
        const matchesQuery =
          !query ||
          [c.nick, c.party, c.cls].some(v =>
            String(v || '')
              .toLocaleLowerCase('ru')
              .includes(query)
          );
        return (
          matchesQuery &&
          (status.value === 'all' || loginStatus(c) === status.value) &&
          (!party.value || c.party === party.value) &&
          (!cls.value || c.cls === cls.value) &&
          (!onlySelected.checked || draft.has(c.id))
        );
      })
      .sort((a, b) => (sort.value === 'desc' ? -1 : 1) * String(a.nick).localeCompare(String(b.nick), 'ru'));
  }

  function updateCount(visible) {
    count.textContent = `Выбрано: ${draft.size} из ${characters.length} · показано: ${visible.length}`;
    dlg.body.querySelector('[data-picker-all]').disabled = visible.length === 0;
    dlg.body.querySelector('[data-picker-none]').disabled = visible.length === 0;
  }

  function renderList() {
    const visible = visibleCharacters();
    list.innerHTML = visible.length
      ? visible
          .map(c => {
            const state = loginStatus(c);
            const stateText = { online: 'Есть вход', offline: 'Нет входа', checking: 'Проверяется' }[state];
            return `<label class="promo-item cp-character ${stripeCls(c)}" title="${escapeHtml(statusTitle(c))}">
              <input type="checkbox" data-picker-id="${escapeHtml(c.id)}" ${draft.has(c.id) ? 'checked' : ''}>
              ${classIconHtml(c)}
              <span class="cp-character-copy"><b>${escapeHtml(c.nick)}</b><small>${escapeHtml(c.party || 'Без пати')} · ${escapeHtml(c.cls)}</small></span>
              <span class="cp-status ${stripeCls(c)}">${stateText}</span>
            </label>`;
          })
          .join('')
      : '<p class="promo-empty">По этим фильтрам персонажи не найдены.</p>';
    updateCount(visible);
  }

  dlg.body.addEventListener('input', event => {
    if (event.target === search) renderList();
  });
  dlg.body.addEventListener('change', event => {
    const input = event.target;
    if (input.matches('[data-picker-id]')) {
      if (input.checked) draft.add(input.dataset.pickerId);
      else draft.delete(input.dataset.pickerId);
      // При обычном выборе не пересоздаём строку: фокус остаётся на чекбоксе.
      if (onlySelected.checked) renderList();
      else updateCount(visibleCharacters());
    } else if (input.matches('select, [data-picker-only-selected]')) renderList();
  });
  dlg.body.addEventListener('click', event => {
    const button = event.target.closest('[data-picker-all], [data-picker-none]');
    if (!button) return;
    const choose = button.hasAttribute('data-picker-all');
    for (const c of visibleCharacters()) {
      if (choose) draft.add(c.id);
      else draft.delete(c.id);
    }
    renderList();
  });
  dlg.foot.addEventListener('click', event => {
    if (event.target.closest('[data-picker-cancel]')) dlg.close();
    if (event.target.closest('[data-picker-save]')) {
      result = new Set(draft);
      dlg.close();
    }
  });
  // Предыдущее окно недоступно, пока открыт выбор; Tab остаётся внутри диалога.
  dlg.el.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...dlg.el.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'
      )
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  renderList();
  search.focus();
  return dlg;
}
