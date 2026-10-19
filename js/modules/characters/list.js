// js/modules/characters/list.js

import { state, normalizeTags } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, needsCoinRecheck } from '../../core/coins.js';
import { toast, showModal, closeModal, confirmModal, openActionMenu } from '../../core/ui.js';
import { renderParties } from '../parties/index.js';

// Импортируем константы
import { PASS_TYPES, getClassIconSrc } from '../../core/constants.js';

// Импортируем модульную систему персонажей
import { openCharacterProfile, openCharacterForm } from './index.js';
import { levelBonusLabel } from './stateManager.js';

// НОВЫЕ ИМПОРТЫ ДЛЯ СИНХРОНИЗАЦИИ
import { hasGameCenterPath } from '../launcher/launch.js';
import { refreshAllBalances, refreshAllLoginStatuses, openSyncHelper } from '../sync/syncManager.js';
import { getAuthView, authDetails } from '../sync/authStatus.js';
import { fillClassFilter, fillPartyFilter, filterCharacters } from './filters.js';
import { groupChars, applyManualOrder, moveChar, ORDER_MANUAL, ORDER_NICK } from './grouping.js';
import { getManualOrder, saveManualOrder, resetManualOrder, hasManualOrder, canSaveOrder, getViewPrefs, saveViewPrefs, listOrderPresets, saveOrderPreset, deleteOrderPreset, presetValue, presetIdFromValue } from './orderStore.js';
import { onboardingHtml } from './onboarding.js';
import { windowOfCharacter, refreshRunningWindows, onRunningWindows } from '../launcher/runningWindows.js';
import { formatUptime } from '../launcher/windowList.js';
import {
  NO_PARTY_LABEL, partyById, hasNoParty, setMembership, setMainParty, createPartyWith, mainPartyName, mainPartyOf, additionalPartiesOf, totalCoins as totalCoinsOf
} from '../parties/membership.js';
import { partyColorCss } from '../parties/color.js';

// Персонажи, видимые после фильтров (для «выбрать все»)
let visibleIds = [];
let showingCharacterArchive = false;

/**
 * Хелпер для маскирования текста
 */
function maskText(text, length = 8) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= 4) return '••••';
  return str.substring(0, 2) + '•'.repeat(Math.min(length, str.length - 4)) + str.substring(str.length - 2);
}

const EYE_SVG_OPEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_SVG_CLOSED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

export function renderCharacters() {
  // 1. Сначала обновляем состояние кнопок синхронизации (навешиваем обработчики)
  initSyncButtons(); 
  
  // 2. Затем рендерим сетку с учетом фильтров
  document.getElementById('active-character-count')?.replaceChildren(String(state.characters.length));
  document.getElementById('archived-character-count')?.replaceChildren(String(state.archivedCharacters.length));
  const welcomeRow = document.getElementById('welcome-row');
  if (welcomeRow) welcomeRow.hidden = state.characters.length > 0;
  document.getElementById('show-active-characters')?.classList.toggle('secondary', !showingCharacterArchive);
  document.getElementById('show-active-characters')?.classList.toggle('ghost', showingCharacterArchive);
  document.getElementById('show-archived-characters')?.classList.toggle('secondary', showingCharacterArchive);
  document.getElementById('show-archived-characters')?.classList.toggle('ghost', !showingCharacterArchive);
  if (showingCharacterArchive) renderArchivedCharacters();
  else renderFilteredGrid();
  maybeShowWelcome();
}

/**
 * Запуск окон влияет на карточки: у персонажа появляется кнопка закрытия его окна.
 * Поэтому при входе на вкладку список окон опрашивается заново (кэш мог устареть),
 * а когда он меняется — перерисовывается только список, если вкладка сейчас активна.
 */
let runningWindowsBound = false;
export function initRunningWindowsTracking() {
  if (runningWindowsBound) return;
  runningWindowsBound = true;
  onRunningWindows(() => {
    const grid = document.getElementById('character-grid');
    // Перерисовываем только когда видна вкладка «Персонажи» и не открыт архив:
    // иначе перезаписываем то, что пользователь как раз смотрит в другой вкладке.
    if (!grid || !grid.closest('.page')?.classList.contains('active') || showingCharacterArchive) return;
    renderFilteredGrid();
  });
}

function renderArchivedCharacters() {
  const grid = document.getElementById('character-grid');
  if (!grid) return;
  visibleIds = [];
  const bulk = document.getElementById('bulk-bar');
  if (bulk) bulk.hidden = true;
  if (!state.archivedCharacters.length) {
    grid.innerHTML = '<div class="empty-state">Архив персонажей пуст.</div>';
    return;
  }
  grid.innerHTML = state.archivedCharacters.map(char => generateCardHTML(char, { archived: true })).join('');
  bindCharacterEvents(grid, { archived: true });
}

/**
 * Приветственное окно при первом запуске: только когда персонажей нет и его ещё не закрывали.
 * Показываем с небольшой задержкой, чтобы оно появилось после первой отрисовки страницы,
 * а не перекрывало пустой экран в момент загрузки.
 */
let welcomeShown = false;
async function maybeShowWelcome() {
  if (welcomeShown) return;
  const { shouldShowOnboarding } = await import('./onboarding.js');
  if (!shouldShowOnboarding(state)) return;
  welcomeShown = true;
  setTimeout(() => { openWelcome(); }, 400);
}

/**
 * Инициализация фильтров (Поиск, Класс, Пати, Авторизация)
 */
function initFilters() {
  const searchInput = document.getElementById('search-input');
  const classSelect = document.getElementById('class-filter');
  const partySelect = document.getElementById('party-filter');
  const authSelect = document.getElementById('auth-filter'); 
  const tagSelect = document.getElementById('tag-filter');

  if (!searchInput || !classSelect || !partySelect || !authSelect) return;

  // Классы и пати (при каждой отрисовке списка пересобираются заново — см. renderFilteredGrid)
  fillClassFilter(classSelect, state.characters);
  fillPartyFilter(partySelect, state.parties);

  // ЗАПОЛНЕНИЕ АВТОРИЗАЦИИ (СТАТИЧЕСКИЙ СПИСОК)
  authSelect.innerHTML = `
    <option value="">Все статусы</option>
    <option value="online">🟢 Только авторизованные</option>
    <option value="offline">🔴 Только не авторизованные</option>
  `;

  if (tagSelect) {
    tagSelect.onchange = () => renderFilteredGrid();
    fillTagFilter(tagSelect);
  }

  const applyFilters = () => {
    renderFilteredGrid();
  };

  searchInput.oninput = applyFilters;
  classSelect.onchange = applyFilters;
  partySelect.onchange = applyFilters;
  authSelect.onchange = applyFilters; 

  // «Сбросить»: заметно, когда хотя бы один фильтр включён; одним нажатием возвращает весь список
  const clearBtn = document.getElementById('filters-clear');
  if (clearBtn) {
    clearBtn.onclick = () => {
      searchInput.value = '';
      classSelect.value = '';
      partySelect.value = '';
      authSelect.value = '';
      if (tagSelect) tagSelect.value = '';
      renderFilteredGrid();
      searchInput.focus();
    };
  }
  // Группировка и порядок карточек: восстанавливаем выбор и подключаем переключатели
  const groupSelect = document.getElementById('group-filter');
  const orderSelect = document.getElementById('order-filter');
  const prefs = getViewPrefs();
  if (groupSelect) {
    groupSelect.value = prefs.group;
    groupSelect.onchange = () => { saveViewPrefs({ group: groupSelect.value }); renderFilteredGrid(); };
  }
  if (orderSelect) {
    fillOrderOptions(orderSelect, prefs.order);
    orderSelect.onchange = () => {
      const value = orderSelect.value;
      // Сохранённый порядок копируется в живой: перетаскивание работает так же,
      // а сам снимок остаётся нетронутым, пока его не обновят явно
      const presetId = presetIdFromValue(value);
      if (presetId) {
        const preset = listOrderPresets().find(p => p.id === presetId);
        if (preset?.ids.length) saveManualOrder(preset.ids);
      }
      saveViewPrefs({ order: value });
      renderFilteredGrid();
      updateOrderMenu();
    };
  }
  const orderMenu = document.getElementById('order-menu');
  if (orderMenu) {
    orderMenu.onclick = () => openOrderMenu(orderMenu);
    orderMenu.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderMenu(orderMenu); }
    };
  }
  updateOrderMenu();
  updateClearButton();
}

/**
 * Наполняет список порядков: стандартные режимы плюс сохранённые под своими именами.
 * Повторяет сохранённые после каждого сохранения и удаления — иначе в списке остались бы
 * порядки, которых уже нет.
 *
 * Отделение сохранённых — нижняя граница у «Свой порядок» (`.has-presets` в CSS), а не
 * строка-разделитель: строка занимала бы целиком отдельную строку списка ради ничего.
 *
 * @param {HTMLSelectElement|null} select
 * @param {string} current значение, которое надо восстановить
 */
export function fillOrderOptions(select, current = '') {
  if (!select) return;
  const presets = listOrderPresets();
  const known = [...['nick', 'manual'], ...presets.map(p => presetValue(p.id))];
  // Чего в списке нет — выбирать не на чем: браузер оставил бы пустое значение, и в списке
  // висела бы пустая строка. Тогда — «По нику».
  const selected = known.includes(current) ? current : ORDER_NICK;
  select.innerHTML = `
    <option value="nick">По нику (сначала онлайн)</option>
    <option value="manual">Свой порядок</option>
    ${presets.map(p => `
      <option value="${escapeHtml(presetValue(p.id))}">${escapeHtml(p.name)}</option>`).join('')}`;
  select.value = selected;
  // Черта под «Свой порядок» рисуется только когда сохранённые есть: без них отделять
  // нечего, и линия под последним пунктом была бы просто чужой полоской
  select.classList.toggle('has-presets', presets.length > 0);
}

/**
 * Прячет кнопку порядка, когда делать нечего.
 *
 * Без своего порядка сохранять нечего, обновлять нечего и удалять нечего — до первого
 * перетаскивания кнопка обещала бы четыре действия, из которых ни одно не сработает.
 */
function updateOrderMenu() {
  const btn = document.getElementById('order-menu');
  const value = document.getElementById('order-filter')?.value || getViewPrefs().order;
  if (btn) btn.hidden = !canSaveOrder() && !presetIdFromValue(value);
}

/**
 * Меню порядка: сохранить, обновить, удалить, сбросить.
 *
 * Четыре отдельные кнопки в панели фильтров занимали место и путались с самими фильтрами,
 * поэтому действия собраны под одну. Недоступные пункты не убираем, а гасим: человек должен
 * видеть, что действие существует, и понимать, почему оно сейчас не работает.
 */
function openOrderMenu(btn) {
  const value = document.getElementById('order-filter')?.value || getViewPrefs().order;
  const presetId = presetIdFromValue(value);
  const preset = presetId ? listOrderPresets().find(p => p.id === presetId) : null;
  const hasOrder = canSaveOrder();
  openActionMenu(btn, [
    { id: 'save', icon: '💾', label: 'Сохранить как…', hint: 'Сохранить текущий порядок под своим именем', disabled: !hasOrder, onSelect: () => askOrderPresetName() },
    { id: 'apply', icon: '↻', label: 'Обновить сохранённый', hint: 'Записать текущий порядок обратно в выбранный', disabled: !preset || !hasOrder, onSelect: () => applyPresetUpdate() },
    { id: 'delete', icon: '✕', label: 'Удалить сохранённый', hint: 'Убрать выбранный порядок из списка', disabled: !preset, danger: true, onSelect: () => applyPresetDelete() },
    { id: 'reset', icon: '↺', label: 'Сбросить порядок', hint: 'Вернуть карточки по нику', disabled: !hasOrder && !preset, onSelect: () => applyOrderReset() }
  ]);
}

/** Сброс своего порядка: карточки снова по нику. */
function applyOrderReset() {
  resetManualOrder();
  // Возвращаемся на «По нику», а не на «Свой порядок»: своего порядка после сброса нет,
  // и надпись в списке обещала бы несуществующий порядок
  saveViewPrefs({ order: ORDER_NICK });
  fillOrderOptions(document.getElementById('order-filter'), ORDER_NICK);
  renderFilteredGrid();
  updateOrderMenu();
  toast('Порядок сброшен: карточки по нику', 'success');
}

/** Спрашивает имя и сохраняет текущий свой порядок под ним. */
async function askOrderPresetName() {
  const suggested = listOrderPresets().length ? `Мой порядок ${listOrderPresets().length + 1}` : 'Мой порядок';
  const name = await promptOrderName('Сохранить порядок под именем', suggested);
  if (!name) return;
  let saved;
  try {
    saved = saveOrderPreset(name, getManualOrder());
  } catch (e) {
    toast(e.message || 'Не удалось сохранить порядок', 'error');
    return;
  }
  saveViewPrefs({ order: presetValue(saved.id) });
  fillOrderOptions(document.getElementById('order-filter'), presetValue(saved.id));
  renderFilteredGrid();
  updateOrderMenu();
  toast(saved.replaced ? `Порядок «${saved.name}» обновлён` : `Порядок «${saved.name}» сохранён`, 'success');
}

/** Записывает текущий порядок обратно в выбранный сохранённый. */
function applyPresetUpdate() {
  const presetId = presetIdFromValue(document.getElementById('order-filter')?.value || '');
  if (!presetId) return;
  const preset = listOrderPresets().find(p => p.id === presetId);
  if (!preset) return;
  saveOrderPreset(preset.name, getManualOrder());
  renderFilteredGrid();
  updateOrderMenu();
  toast(`Порядок «${preset.name}» обновлён`, 'success');
}

/**
 * Удаляет выбранный сохранённый порядок.
 *
 * Подтверждение обязательно: список порядков — это настройка, потеря которой молча
 * пропала бы у человека, который её настраивал. После удаления выбор возвращается на
 * «Свой порядок», иначе в списке осталось бы значение, которого уже нет.
 */
async function applyPresetDelete() {
  const select = document.getElementById('order-filter');
  const presetId = presetIdFromValue(select?.value || '');
  const preset = presetId ? listOrderPresets().find(p => p.id === presetId) : null;
  if (!preset) return;
  const ok = await confirmModal({
    title: `Удалить порядок «${preset.name}»?`,
    text: 'Сохранённый порядок пропадёт. Карточки останутся на месте — это только вид списка.',
    okText: 'Удалить',
    danger: true
  });
  if (!ok) return;
  deleteOrderPreset(preset.id);
  saveViewPrefs({ order: ORDER_NICK });
  fillOrderOptions(select, ORDER_NICK);
  renderFilteredGrid();
  updateOrderMenu();
  toast(`Порядок «${preset.name}» удалён`, 'success');
}

/** Модалка ввода имени порядка. Пустая строка и Отмена — это не имя. */
function promptOrderName(title, value = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-container" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header"><h3>${escapeHtml(title)}</h3></div>
        <div class="modal-body">
          <label class="field">
            <span>Название порядка</span>
            <input id="order-preset-name" class="input" maxlength="40" value="${escapeHtml(value)}" />
          </label>
          <p class="muted" style="margin:8px 0 0;font-size:0.8rem">
            Порядок сохранится под этим именем и появится в списке сортировки.
          </p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn ghost" data-act="cancel">Отмена</button>
          <button type="button" class="btn primary" data-act="ok">Сохранить</button>
        </div>
      </div>`;
    const done = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(''); }
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
    };
    const input = /** @type {HTMLInputElement} */ (overlay.querySelector('#order-preset-name'));
    overlay.addEventListener('click', (e) => {
      const act = /** @type {HTMLElement} */ (e.target).closest?.('[data-act]')?.getAttribute('data-act');
      if (act === 'ok') done(input.value);
      else if (act === 'cancel' || e.target === overlay) done('');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/** Показывает кнопку сброса, только если есть активный фильтр (иначе она занимает место зря). */
function updateClearButton() {
  const btn = document.getElementById('filters-clear');
  if (!btn) return;
  const active = ['search-input', 'class-filter', 'party-filter', 'auth-filter', 'tag-filter']
    .some(id => (document.getElementById(id)?.value || '') !== '');
  btn.hidden = !active;
}

/** Все теги персонажей (без учёта регистра), по алфавиту. */
export function allTags() {
  const map = new Map();
  state.characters.forEach(c => (c.tags || []).forEach(t => { if (!map.has(t.toLowerCase())) map.set(t.toLowerCase(), t); }));
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

function fillTagFilter(select) {
  const current = select.value;
  const tags = allTags();
  select.innerHTML = '<option value="">Все теги</option><option value="__none__">Без тегов</option>' +
    tags.map(t => `<option value="${escapeHtml(t)}">#${escapeHtml(t)}</option>`).join('');
  select.value = tags.includes(current) || current === '__none__' ? current : '';
}

/**
 * Рендер сетки с учетом активных фильтров
 */
function renderFilteredGrid() {
  const gridEl = document.getElementById('character-grid');
  if (!gridEl) return;

  // Варианты фильтров собираем из актуального state.characters при каждой отрисовке:
  // новый класс/пати/тег сразу появляется в списке, исчезнувший — сбрасывает фильтр (issue #2)
  const selectedClass = fillClassFilter(document.getElementById('class-filter'), state.characters);
  const selectedParty = fillPartyFilter(document.getElementById('party-filter'), state.parties);
  const selectedAuth = document.getElementById('auth-filter')?.value || '';
  const tagSelect = document.getElementById('tag-filter');
  if (tagSelect) fillTagFilter(tagSelect);
  const selectedTag = tagSelect?.value || '';

  const filteredChars = filterCharacters(state.characters, {
    search: document.getElementById('search-input')?.value || '',
    tag: selectedTag,
    cls: selectedClass,
    party: selectedParty,
    auth: selectedAuth
  });

  updateClearButton();
  // ОБНОВЛЯЕМ KPI НА ОСНОВЕ ОТФИЛЬТРОВАННЫХ ДАННЫХ
  updateKPIs(filteredChars);
  visibleIds = filteredChars.map(c => c.id);
  renderBulkBar();

  if (filteredChars.length === 0) {
    if (!state.characters.length && state.archivedCharacters.length) {
      gridEl.innerHTML = `<div class="empty-state">Активных персонажей нет. В архиве: ${state.archivedCharacters.length}. Переключитесь на «Архив», чтобы восстановить персонажа.</div>`;
      return;
    }
    // Подсказка первых шагов — только когда персонажей нет вовсе. Если данные есть, но фильтр
    // ничего не нашёл, показываем именно это: иначе пользователь решит, что данные пропали.
    const onb = onboardingHtml(state);
    gridEl.innerHTML = onb || '<div class="empty-state">Ничего не найдено по заданным фильтрам.<br/><small class="muted">Измените условия или нажмите «Сбросить».</small></div>';
    bindOnboardingEvents(gridEl);
    return;
  }

  // Порядок: либо по нику (сначала онлайн), либо свой — заданный перетаскиванием напрямую
  // или выбранный из сохранённых. Сохранённый тоже свой: перетаскивание должно работать,
  // иначе кнопка «Обновить» не имела бы смысла — переписать было бы нечего.
  const prefs = getViewPrefs();
  const manual = prefs.order === ORDER_MANUAL || !!presetIdFromValue(prefs.order);
  const byNick = [...filteredChars].sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
  const ordered = manual
    ? applyManualOrder(byNick, getManualOrder())
    : byNick.sort((a, b) => (b.isLoggedIn ? 1 : 0) - (a.isLoggedIn ? 1 : 0)); // онлайн выше, внутри — по нику

  // Группировка: заголовки групп — строки сетки во всю ширину; внутри группы порядок сохраняется
  const groups = groupChars(ordered, prefs.group, state.parties);
  gridEl.innerHTML = groups
    .map(g => (g.title != null ? groupHeadHtml(g) : '') + g.chars.map(generateCardHTML).join(''))
    .join('');

  markDraggable(gridEl, manual);
  bindManualDrag(gridEl);
  bindCharacterEvents(gridEl);
  updateOrderReset();
}

/** Заголовок группы: строка сетки во всю ширину, с числом карточек и онлайном. */
function groupHeadHtml(g) {
  const online = g.online ? ` · онлайн ${g.online}` : '';
  return `<div class="chars-group-head"><strong>${escapeHtml(g.title)}</strong> <span class="muted">${g.chars.length}${online}</span></div>`;
}

/** Полный список id в своём порядке, включая скрытых фильтрами: так порядок не теряется. */
function fullManualOrder() {
  const byNick = [...state.characters].sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
  return applyManualOrder(byNick, getManualOrder()).map(c => c.id);
}

/** Карточки тянутся только в режиме «Свой порядок» и вне режима выбора. */
function markDraggable(grid, manual) {
  const on = manual && !state.ui.selectionMode;
  grid.querySelectorAll('.clickable-card').forEach(el => { el.draggable = on; });
}

/** Перетаскивание карточек: обработчики на сетке, навешиваются один раз. Меняет только порядок. */
function bindManualDrag(grid) {
  if (grid.dataset.dragBound) return;
  grid.dataset.dragBound = 'true';
  let dragId = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.clickable-card');
    if (!card || !card.draggable) return;
    dragId = card.dataset.charId;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  grid.addEventListener('dragover', (e) => {
    const card = e.target.closest?.('.clickable-card');
    clearDropMarks(grid);
    if (!card || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Показываем, куда встанет карточка: до или после той, над которой держим курсор
    if (card.dataset.charId === dragId) return;
    card.classList.add(dropSide(card, e.clientX) === 'after' ? 'drop-after' : 'drop-before');
  });
  grid.addEventListener('drop', (e) => {
    const card = e.target.closest?.('.clickable-card');
    clearDropMarks(grid);
    if (!card || !dragId) return;
    e.preventDefault();
    const from = dragId;
    const targetId = card.dataset.charId;
    const after = dropSide(card, e.clientX) === 'after';
    dragId = null;
    if (from === targetId) return;
    saveManualOrder(moveChar(fullManualOrder(), { dragId: from, targetId, after }));
    renderFilteredGrid();
  });
  grid.addEventListener('dragend', () => {
    dragId = null;
    clearDropMarks(grid);
    grid.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));
  });
}

/** Сторона карточки, на которую указывает курсор: левая половина — перед, правая — после. */
function dropSide(card, clientX) {
  const r = card.getBoundingClientRect();
  return clientX > r.left + r.width / 2 ? 'after' : 'before';
}

/** Убирает метки места вставки со всей сетки. */
function clearDropMarks(grid) {
  grid.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

/** Кнопка «Сбросить порядок» видна только когда свой порядок задан. */
function updateOrderReset() {
  const btn = document.getElementById('order-reset');
  if (btn) btn.hidden = !hasManualOrder();
}

/**
 * Кнопка закрытия окна игры прямо в карточке персонажа (жалоба пользователей: закрытие окна было
 * спрятано в настройках). Показывается только когда окно этого персонажа сейчас запущено —
 * определяем по последнему опросу Rust (`runningWindows.js`), поэтому кнопка не мешает
 * на остальных карточках. В архиве кнопки нет: архивные персонажи не запускаются.
 * @param {any} char
 * @param {boolean} archived
 */
function gameWindowBtn(char, archived) {
  if (archived) return '';
  const win = windowOfCharacter(char.id);
  if (!win) return '';
  const nick = char.nick ? escapeHtml(char.nick) : 'этого персонажа';
  return `<button class="card-act close-game-window-action" type="button" aria-label="Закрыть окно игры"
                  title="Закрыть окно игры: ${nick}${win.uptimeMs != null ? ` (работает ${formatUptime(win.uptimeMs)})` : ''}. Всё, что не сохранено в игре, будет потеряно">🛑</button>`;
}

/**
 * Закрытие окна игры конкретного персонажа по кнопке в его карточке.
 *
 * Список окон берётся из общего кэша, но перед закрытием опрашивается заново: игрок мог
 * закрыть окно вручную, и тогда PID уже не существует. Итог закрытия показывается тем же
 * способом, что и при закрытии пати, — вместе с предложением повторить с правами администратора.
 * @param {string} charId
 * @param {HTMLElement} btn кнопка, на время запроса блокируется
 * @returns {Promise<number>} сколько окон закрыто
 */
async function closeCharacterGameWindow(charId, btn) {
  const char = state.characters.find(c => c.id === charId);
  if (!char) return 0;
  // Свежий список: кэш мог устареть, пока окно открывали и закрывали
  await refreshRunningWindows();
  const win = windowOfCharacter(charId);
  if (!win) {
    toast(`Окно игры «${char.nick || charId}» уже закрыто`, 'info');
    renderCharacters();
    return 0;
  }

  const ok = await confirmModal({
    title: `Закрыть окно игры: ${win.nick || char.nick}?`,
    text: 'Всё, что не сохранено в игре, будет потеряно.',
    okText: 'Закрыть окно',
    danger: true
  });
  if (!ok) return 0;

  btn.disabled = true;
  try {
    const [{ closeClientsByPid }, { showCloseReport }] = await Promise.all([
      import('../launcher/launch.js'),
      import('../launcher/partyLaunch.js')
    ]);
    const report = await closeClientsByPid([win.pid]);
    showCloseReport(report);
    return Number(report?.closed) || 0;
  } catch (e) {
    toast(`Не удалось закрыть окно: ${String(e?.message || e)}`, 'error');
    return 0;
  } finally {
    await refreshRunningWindows();
    btn.disabled = false;
    renderCharacters();
  }
}

/**
 * Генерация HTML одной карточки персонажа
 */
function generateCardHTML(char, { archived = false } = {}) {
    const iconSrc = getClassIconSrc(char.class);
    const avatarContent = iconSrc
      ? `<img src="${iconSrc}" alt="${escapeHtml(char.class)}" />`
      : `<span>${(char.class || '?')[0]}</span>`;

    const skyInfo = char.sky?.name ? `${escapeHtml(char.sky.name)}${char.sky.level ? ` (Ур.${char.sky.level})` : ''}` : 'Небо не выбрано';
    
    const stats = char.stats || {};
    const fmtStat = (val) => val > 0 ? val : '-';

    const emailMasked = maskText(char.contacts?.email);
    const passMasked = maskText(char.contacts?.password);
    const hasEmail = !!char.contacts?.email;
    const hasPass = !!char.contacts?.password;

    const passes = char.dungeonPasses || {};
    const passesHtml = PASS_TYPES.map(pt => {
      const count = passes[pt.key] || 0;
      const imgPath = pt.img;
      return `<span class="pass-item" title="${pt.label}: ${count}"><img class="pass-icon-img" src="${imgPath}" alt="${pt.label}" /><span>${count}</span></span>`;
    }).join('');

    // Предупреждение о балансе: видно сразу на карточке, а не только в профиле
    const coinWarn = needsCoinRecheck(char)
      ? ' <span class="coin-warn" title="Баланс записан до исправления разбора (28,5 → 285). Откройте профиль и нажмите «Перепроверить».">⚠</span>'
      : '';
    const coinsDisplay = `${formatCoins(char.ancientCoins || 0)}${coinWarn}`;
    const archivedPartyLinks = archived
      ? state.archivedParties.flatMap(party => (party.memberLinks || [])
          .filter(link => link.characterId === char.id)
          .map(link => ({ party, link })))
      : [];
    const mainName = mainPartyName(char, state.parties);
    const extraNames = additionalPartiesOf(char, state.parties).map(p => p.name);
    const activePartyLabel = mainName
      ? `${escapeHtml(mainName)}${extraNames.length ? ` <span title="Дополнительные: ${escapeHtml(extraNames.join(', '))}">+${extraNames.length}</span>` : ''}`
      : NO_PARTY_LABEL;
    const archivedPartyLabel = archivedPartyLinks
      .map(({ party, link }) => `${escapeHtml(party.name)}${link.isMain ? ' · основная' : ''} · архив`)
      .join(', ');
    const partyLabel = [activePartyLabel !== NO_PARTY_LABEL ? activePartyLabel : '', archivedPartyLabel]
      .filter(Boolean).join(', ') || NO_PARTY_LABEL;
    // Цвет бейджа пати: свой выбранный цвет пати, иначе автоматический оттенок по названию
    const mainParty = mainPartyOf(char, state.parties);
    const partyColor = mainParty ? partyColorCss(mainParty) : '';

    // ЛОГИКА ИНДИКАТОРА СТАТУСА
    const authView = getAuthView(char);
    const statusColor = authView.color;
    const statusText = authView.text;
    const statusTitle = escapeHtml(`${authView.title}. ${authDetails(char)}`);
    const checkingAuth = !archived && state.ui?.authCheck?.[char.id] === 'checking';

    const tagsHtml = (char.tags || []).map(t => `<span class="tag-chip" data-tag="${escapeHtml(t)}" title="Показать всех с тегом">#${escapeHtml(t)}</span>`).join('');
    const selecting = !archived && state.ui.selectionMode;
    const selected = selecting && state.ui.selection.has(char.id);
    const selectBox = selecting
      ? `<span class="select-box" title="Выбрать"><input type="checkbox" class="char-select" tabindex="-1" ${selected ? 'checked' : ''}/></span>`
      : '';

    return `
      <article class="card character-card clickable-card${selected ? ' is-selected' : ''}${archived ? ' archived-character-card' : ''}" data-char-id="${escapeHtml(char.id)}" style="--state-c:${statusColor}">

        <header class="card-header">
          <div class="card-head-main">
            ${selectBox}
            <div class="char-avatar">
              ${avatarContent}
            </div>
            <div class="char-ident">
              <h3 class="char-nick">${escapeHtml(char.nick)}</h3>
              <div class="char-facts">
                <span class="char-fact char-class">${escapeHtml(char.class)}</span>
                <span class="char-fact char-level">Ур. ${char.level}${levelBonusLabel(char) ? ` <b class="char-bu" title="Бонус к уровню">${levelBonusLabel(char)}</b>` : ''}</span>
              </div>
              <div class="char-sky">${skyInfo}</div>
            </div>
          </div>

          <div class="card-head-side">
             ${archived
               ? '<span class="badge">В архиве</span>'
               : `<div class="state ${authView.cls}" title="${statusTitle}">
                    <span class="state-dot"></span><span>${statusText}</span>
                  </div>`}
          </div>
        </header>

        <div class="card-meta">
           <span class="badge party card-party${partyColor ? ' has-color' : ''}"${partyColor ? ` style="--party-c:${partyColor}"` : ''}>${partyLabel}</span>
           <span class="badge coins card-coins"><span aria-hidden="true"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg></span><strong>${coinsDisplay}</strong></span>
           <div class="card-tags tag-list">${tagsHtml}</div>
        </div>

        <div class="card-body">
           <div class="card-stats">
              <div><span class="muted">HP</span><strong>${fmtStat(stats.hp)}</strong></div>
              <div><span class="muted">PA</span><strong>${fmtStat(stats.pa)}</strong></div>
              <div><span class="muted">PZ</span><strong>${fmtStat(stats.pz)}</strong></div>
              <div><span class="muted">PvE-PA</span><strong>${fmtStat(stats.pvePa)}</strong></div>
              <div><span class="muted">PvE-PZ</span><strong>${fmtStat(stats.pvePz)}</strong></div>
           </div>

           <div class="card-contacts">
              <div class="contact-row-mini${hasEmail ? '' : ' is-empty'}">
                 <span class="muted contact-key">EMAIL</span>
                 <div class="contact-row-actions">
                    <span class="contact-value mini-copy-trigger" data-type="email" title="Нажмите, чтобы скопировать" data-original="${escapeHtml(char.contacts?.email || '')}">${hasEmail ? emailMasked : '—'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="email" type="button" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>

              <div class="contact-row-mini${hasPass ? '' : ' is-empty'}">
                 <span class="muted contact-key">PASS</span>
                 <div class="contact-row-actions">
                    <span class="contact-value mini-copy-trigger" data-type="password" title="Нажмите, чтобы скопировать" data-original="${escapeHtml(char.contacts?.password || '')}">${hasPass ? passMasked : '—'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="password" type="button" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>
           </div>
        </div>

        <footer class="card-footer">
           <!-- Левая часть: Проходки -->
           <div class="card-passes">
              ${passesHtml}
           </div>

           <!-- Правая часть: компактные кнопки — запуск игры и вход на сайт (подписи — во всплывающих подсказках) -->
           <div class="card-actions">
              <button class="card-act play${hasGameCenterPath(char) ? '' : ' is-unset'}"
                      type="button"
                      data-action="launch"
                      aria-label="Играть"
                      title="${hasGameCenterPath(char) ? 'Играть: запустить игру для этого персонажа' : 'Играть: сначала укажите GameCenter (откроется карточка)'}">
                 <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>
              </button>
               <button id="btn-open-site-${char.id}"
                       class="card-act${checkingAuth ? ' is-disabled' : ''}"
                       type="button"
                       data-action="site"
                       aria-label="Открыть сайт"
                       title="${checkingAuth ? 'Идёт проверка входа — дождитесь окончания' : 'Открыть сайт: браузер персонажа для входа'}"
                       ${checkingAuth ? 'disabled' : ''}>🌐</button>
               ${gameWindowBtn(char, archived)}
               ${archived

                ? `<button class="card-act restore-character-action" type="button" aria-label="Восстановить"
                          title="Вернуть персонажа в активный список">↩</button>`
                : `<button class="card-act archive-character-action" type="button" aria-label="В архив"
                          title="Переместить персонажа в архив">📦</button>`}
           </div>
        </footer>
      </article>
    `;
}

/**
 * Обновление KPI на основе переданного массива отфильтрованных персонажей
 */
function updateKPIs(charsToCount) {
  // Если массив пуст, ставим нули
  if (!charsToCount || charsToCount.length === 0) {
      document.getElementById('kpi-total-chars').textContent = '0';
      document.getElementById('kpi-active-parties').textContent = '0';
      document.getElementById('kpi-no-party').textContent = '0';
      document.getElementById('kpi-coins').textContent = '0';
      document.getElementById('kpi-online-count').textContent = '0';
      document.getElementById('kpi-offline-count').textContent = '0';
      return;
  }

  // 1. Всего персонажей в выборке
  const totalChars = charsToCount.length;
  document.getElementById('kpi-total-chars').textContent = totalChars;

  // 2. Активные пати (уникальные основные пати среди отфильтрованных)
  const uniquePartiesSet = new Set(charsToCount.map(c => c.mainPartyId).filter(id => partyById(state.parties, id)));
  document.getElementById('kpi-active-parties').textContent = uniquePartiesSet.size;

  // 3. Без пати
  const noPartyCount = charsToCount.filter(c => hasNoParty(c, state.parties)).length;
  document.getElementById('kpi-no-party').textContent = noPartyCount;

  // 4. Сумма древних монет
  document.getElementById('kpi-coins').textContent = formatCoins(totalCoinsOf(charsToCount));

  // 5. Онлайн (Авторизовано)
  const onlineCount = charsToCount.filter(c => c.isLoggedIn === true).length;
  const onlineEl = document.getElementById('kpi-online-count');
  if(onlineEl) {
    onlineEl.textContent = onlineCount;
    onlineEl.style.color = '#9ece6a'; // Зеленый
  }

  // 6. Оффлайн (Требуется вход)
  const offlineCount = charsToCount.filter(c => c.isLoggedIn !== true).length;
  const offlineEl = document.getElementById('kpi-offline-count');
  if(offlineEl) {
    offlineEl.textContent = offlineCount;
    offlineEl.style.color = '#f7768e'; // Красный
  }
}

/**
 * Инициализация кнопок синхронизации в UI
 */
// Кнопок может не быть в разметке (запуск скриптов идёт через меню «Скрипты»), тогда ничего не делаем.
function initSyncButtons() {
    // Кнопка "Проверить авторизацию"
    const checkBtn = document.getElementById('btn-check-auth-status');
    if(checkBtn) {
        console.log('[SYNC BUTTONS] Found Auth Check button.');
        
        // Проверяем, не навешен ли уже обработчик (чтобы не дублировать события)
        if(!checkBtn.dataset.bound) {
            checkBtn.onclick = async () => {
                console.log('[ACTION] Clicked: Check Authorization');
                checkBtn.disabled = true;
                const originalText = checkBtn.innerHTML;
                checkBtn.innerHTML = '⏳ Проверка...';
                
                try {
                    await refreshAllLoginStatuses();
                    toast('Статусы авторизации обновлены.', 'success');
                } catch (err) {
                    console.error(err);
                    toast('Ошибка проверки статусов', 'error');
                } finally {
                    setTimeout(() => {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = originalText;
                    }, 1000);
                }
            };
            checkBtn.dataset.bound = "true";
        }
    }

    // Кнопка "Обновить балансы"
    const balanceBtn = document.getElementById('btn-refresh-balances');
    if(balanceBtn) {
        console.log('[SYNC BUTTONS] Found Balance Refresh button.');
        
        if(!balanceBtn.dataset.bound) {
            balanceBtn.onclick = async () => {
                console.log('[ACTION] Clicked: Update Balances');
                balanceBtn.disabled = true;
                const originalText = balanceBtn.innerHTML;
                balanceBtn.innerHTML = '⏳ Обновление...';
                
                try {
                    await refreshAllBalances();
                } catch (err) {
                    console.error(err);
                    toast('Ошибка обновления балансов', 'error');
                } finally {
                    setTimeout(() => {
                        balanceBtn.disabled = false;
                        balanceBtn.innerHTML = originalText;
                    }, 1000);
                }
            };
            balanceBtn.dataset.bound = "true";
        }
    }
}

/**
 * Действия кнопок экрана «Сегодня»: проверка входа, обновление баланса, переходы.
 * @param {string} action
 * @param {any} payload
 */
export async function runTodayAction(action, payload) {
  if (action === 'check-auth-one') {
    const char = state.characters.find(c => c.id === payload);
    if (char) await refreshAllLoginStatuses([char]);
    return;
  }
  if (action === 'balance-one') {
    const char = state.characters.find(c => c.id === payload);
    if (char) await refreshAllBalances([char]);
    return;
  }
  if (action === 'open-marathon') {
    document.querySelector('.tab[data-tab="marathons"]')?.click();
    const { openMarathon } = await import('../marathons/page.js');
    openMarathon(payload);
    return;
  }
  if (action === 'open-party') {
    document.querySelector('.tab[data-tab="parties"]')?.click();
    return;
  }
}

/**
 * Кнопки подсказки первых шагов: ведут к нужному действию.
 * Разметка подсказки перерисовывается вместе с сеткой, поэтому обработчик навешивается каждый раз.
 */
export function bindOnboardingEvents(container, { closeBeforeAction = false } = {}) {
  container.querySelectorAll('[data-onb]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = /** @type {HTMLElement} */ (btn).dataset.onb;
      if (closeBeforeAction) closeModal();
      if (action === 'new-character') { openCharacterForm(null); return; }
      if (action === 'new-party') {
        const { openCreatePartyModal } = await import('../parties/manager.js');
        openCreatePartyModal();
        return;
      }
      if (action === 'open-help') openLoginHelp();
    });
  });
}

/**
 * Показать персонажей с этим тегом. Нужно профилю: тег в шапке профиля ведёт к тем же
 * людям в списке, что и клик по тегу в карточке.
 * @param {string} tag
 */
export function showCharactersWithTag(tag) {
  document.querySelector('.tab[data-tab="characters"]')?.click();
  const select = document.getElementById('tag-filter');
  if (!select) return;
  fillTagFilter(select);
  select.value = tag;
  renderFilteredGrid();
  select.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}

/** Справка «Как войти на сайт игры»: один текст на приветственное окно и на страницу. */
export function openLoginHelp() {
  showModal({
    title: 'Как войти на сайт игры',
    content: `
      <ol class="onb-help">
        <li>Откройте карточку персонажа и заполните Email и пароль — они сразу уходят в защищённое хранилище учётных данных ОС.</li>
        <li>Нажмите <b>«🌐 Открыть сайт»</b>: откроется окно браузера персонажа с отдельной сессией, поэтому аккаунты не мешают друг другу.</li>
        <li>Войдите на сайте игры обычным способом — приложение ничего не нажимает за вас.</li>
        <li>Сессия сохранится. Дальше кнопка <b>«🔐 Проверить вход»</b> покажет, кто ещё авторизован, а кто требует повторного входа.</li>
      </ol>
      <p class="muted">Если сессия истекла, приложение подскажет это в карточке персонажа и в фильтре «Все статусы».</p>`,
    submitText: null,
    cancelText: 'Понятно'
  });
}

/**
 * Приветственное окно при первом запуске.
 *
 * Показывается один раз: когда персонажей нет и пользователь его ещё не закрывал. Закрытие
 * отмечается в настройках, поэтому само оно больше не появится — но остаётся доступным
 * по кнопке «С чего начать», чтобы инструкцию можно было перечитать.
 */
export async function openWelcome() {
  const { onboardingModalHtml, markOnboardingSeen } = await import('./onboarding.js');
  // Отмечаем показанным сразу при открытии. В `onClose` полагаться нельзя: он вызывается
  // только у кнопки отмены, а у «Начать» его нет — окно закрывалось бы, не запомнив показ.
  await markOnboardingSeen();
  showModal({
    title: 'Добро пожаловать в Твиноферму',
    content: onboardingModalHtml(),
    submitText: 'Начать',
    cancelText: 'Позже',
    // Без onSubmit кнопка «Начать» не закрывала окно: `showModal` вызывал несуществующий
    // обработчик и падал в alert. Здесь просто подтверждаем закрытие.
    onSubmit: () => true
  });
  const modal = document.getElementById('modal-root');
  bindOnboardingEvents(modal, { closeBeforeAction: true });
  // Esc и «Позже» тоже закрывают окно, ничего дополнительно записывать не нужно
}

function bindCharacterEvents(container, { archived = false } = {}) {  container.onclick = async (e) => {
    const target = e.target;

    const restoreBtn = target.closest('.restore-character-action');
    if (restoreBtn) {
      e.stopPropagation();
      restoreBtn.disabled = true;
      try {
        const { restoreCharacter } = await import('../archive/archive.js');
        await restoreCharacter(restoreBtn.closest('[data-char-id]')?.dataset.charId);
      } catch (error) {
        console.error('[ARCHIVE] Character restore failed:', error);
        toast(`Не удалось восстановить персонажа: ${error?.message || error}`, 'error');
      } finally {
        restoreBtn.disabled = false;
      }
      return;
    }

    const closeWinBtn = target.closest('.close-game-window-action');
    if (closeWinBtn) {
        e.stopPropagation();
        await closeCharacterGameWindow(closeWinBtn.closest('[data-char-id]')?.dataset.charId, closeWinBtn);
        return;
    }

    const archiveBtn = target.closest('.archive-character-action');
    if (archiveBtn) {
      e.stopPropagation();
      const id = archiveBtn.closest('[data-char-id]')?.dataset.charId;
      archiveBtn.disabled = true;
      try {
        const { archiveCharacters } = await import('../archive/archive.js');
        await archiveCharacters([id]);
      } catch (error) {
        console.error('[ARCHIVE] Character archive failed:', error);
        toast(`Не удалось переместить персонажа в архив: ${error?.message || error}`, 'error');
      } finally {
        archiveBtn.disabled = false;
      }
      return;
    }

    // Действия кнопок карточки: запуск игры и открытие сайта. Раньше это были инлайновые
    // onclick с ID персонажа внутри строки — код кнопки теперь рядом с остальными действиями.
    const act = target.closest('[data-action]');
    if (act) {
      e.stopPropagation();
      const id = act.closest('[data-char-id]')?.dataset.charId;
      try {
        if (act.dataset.action === 'launch') await window.handleLaunchChar(id);
        else if (act.dataset.action === 'site') window.handleOpenSite(id);
      } catch (error) {
        toast(`Не удалось выполнить действие: ${error?.message || error}`, 'error');
      }
      return;
    }

    // 0. Режим выбора: клик по карточке переключает выбор
    if (!archived && state.ui.selectionMode) {
      const card = target.closest('.clickable-card');
      if (card && !target.closest('button') && !target.closest('.contact-value')) {
        toggleSelected(card.dataset.charId);
        return;
      }
    }

    // 0a. Клик по тегу — фильтр по этому тегу
    const chip = target.closest('.tag-chip');
    if (chip) {
      e.stopPropagation();
      const tagSelect = document.getElementById('tag-filter');
      if (tagSelect) { fillTagFilter(tagSelect); tagSelect.value = chip.dataset.tag; renderFilteredGrid(); }
      return;
    }

    // 1. Мини-глазик
    const eyeBtn = target.closest('.mini-toggle-eye');
    if (eyeBtn) {
      e.stopPropagation();
      const row = eyeBtn.closest('.contact-row-mini');
      const valueSpan = row.querySelector('.mini-copy-trigger');
      
      if (valueSpan && valueSpan.dataset.original) {
        const originalVal = valueSpan.dataset.original;
        const isCurrentlyMasked = valueSpan.textContent.includes('•');
        
        if (isCurrentlyMasked) {
           valueSpan.textContent = originalVal;
           eyeBtn.innerHTML = EYE_SVG_CLOSED;
           eyeBtn.style.opacity = '1';
        } else {
           valueSpan.textContent = maskText(originalVal);
           eyeBtn.innerHTML = EYE_SVG_OPEN;
           eyeBtn.style.opacity = '0.4';
        }
      }
      return;
    }

    // 2. Мини-копирование
    const contactVal = target.closest('.mini-copy-trigger');
    if (contactVal && contactVal.dataset.original) {
       e.stopPropagation();
       navigator.clipboard.writeText(contactVal.dataset.original).then(() => {
         toast('Скопировано!', 'success');
         const oldBg = contactVal.style.background;
         contactVal.style.background = 'rgba(76, 175, 80, 0.3)';
         setTimeout(() => contactVal.style.background = oldBg, 300);
       });
       return;
    }

    // 3. Клик по карточке -> Открыть ПРОФИЛЬ
    const card = target.closest('.clickable-card');
    if (card && !target.closest('button') && !target.closest('.contact-value')) {
       const id = card.dataset.charId;
       const char = (archived ? state.archivedCharacters : state.characters).find(c => c.id === id);
       if (char) {
         openCharacterProfile(char); // Вызываем функцию из модуля
       }
    }
  };
}

// Глобальная функция для вызова из inline onclick кнопки "Открыть сайт"
window.handleOpenSite = (charId) => {
    const char = [...state.characters, ...state.archivedCharacters].find(c => c.id === charId);
    if (char) {
        openSyncHelper(charId);
    } else {
        toast('Персонаж не найден', 'error');
    }
};

// Кнопка «▶ Играть» на карточке
window.handleLaunchChar = async (charId) => {
    const char = [...state.characters, ...state.archivedCharacters].find(c => c.id === charId);
    if (!char) { toast('Персонаж не найден', 'error'); return; }
    const { launchOne } = await import('../launcher/partyLaunch.js');
    launchOne(char);
};

export function bindCharacters() {
  const welcomeButton = document.getElementById('welcome-btn');
  if (welcomeButton && !welcomeButton.dataset.bound) {
    welcomeButton.dataset.bound = 'true';
    welcomeButton.addEventListener('click', () => {
      openWelcome().catch(error => {
        console.error('[ONBOARDING] Could not open welcome guide:', error);
        toast(`Не удалось открыть справку: ${error?.message || error}`, 'error');
      });
    });
  }
  for (const [id, archived] of [['show-active-characters', false], ['show-archived-characters', true]]) {
    const button = document.getElementById(id);
    if (button && !button.dataset.bound) {
      button.dataset.bound = 'true';
      button.addEventListener('click', () => {
        showingCharacterArchive = archived;
        if (state.ui.selectionMode) setSelectionMode(false);
        renderCharacters();
      });
    }
  }
  const addBtn = document.getElementById('add-character-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openCharacterForm(null);
    });
  }

  // Кнопка «Выбрать» переехала в меню круглой кнопки «+» (js/core/uiActions.js, data-fab-action="select-mode").
  // Ссылка на старую кнопку удалена — element быть больше не может, optional chaining больше не нужен.
  document.getElementById('bulk-bar')?.addEventListener('click', onBulkAction);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.ui.selectionMode && !document.querySelector('.modal-overlay')) setSelectionMode(false);
  });
  
  // ВАЖНО: Сначала инициализируем фильтры, потом рендерим
  initFilters(); 
  renderCharacters(); 
}

// --- ЭКСПОРТ ДЛЯ ДРУГИХ МОДУЛЕЙ ---
export { openCharacterProfile, openCharacterForm };
/* ------------------------------------------------------------------ */
/*  Режим выбора и массовые действия                                   */
/* ------------------------------------------------------------------ */

export function setSelectionMode(on) {
  state.ui.selectionMode = !!on;
  if (!on) state.ui.selection.clear();
  // Состояние режима выбора видно на самой сетке (чекбоксы карточек); отдельная кнопка больше не нужна
  renderFilteredGrid();
}

function toggleSelected(id) {
  const sel = state.ui.selection;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const card = document.querySelector(`.character-card[data-char-id="${CSS.escape(id)}"]`);
  card?.classList.toggle('is-selected', sel.has(id));
  const box = card?.querySelector('.char-select');
  if (box) box.checked = sel.has(id);
  renderBulkBar();
}

/** Выбрать всех, кто виден после фильтров (повторный вызов снимает выбор). */
export function selectAllVisible() {
  if (!state.ui.selectionMode) setSelectionMode(true);
  const sel = state.ui.selection;
  const allSelected = visibleIds.length && visibleIds.every(id => sel.has(id));
  if (allSelected) visibleIds.forEach(id => sel.delete(id));
  else visibleIds.forEach(id => sel.add(id));
  renderFilteredGrid();
}

function selectedChars() {
  return state.characters.filter(c => state.ui.selection.has(c.id));
}

function renderBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  // Выбор не должен «помнить» удалённых персонажей
  const ids = new Set(state.characters.map(c => c.id));
  [...state.ui.selection].forEach(id => { if (!ids.has(id)) state.ui.selection.delete(id); });

  bar.hidden = !state.ui.selectionMode;
  if (!state.ui.selectionMode) return;
  const n = state.ui.selection.size;
  const dis = n ? '' : 'disabled';
  bar.innerHTML = `
    <strong class="bulk-count">Выбрано: ${n}</strong>
    <button class="btn ghost small" data-bulk="all">☑ Все по фильтру (${visibleIds.length})</button>
    <span class="bulk-sep"></span>
    <button class="btn secondary small" data-bulk="auth" ${dis}>🔐 Проверить вход</button>
    <button class="btn secondary small" data-bulk="balance" ${dis}><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Балансы</button>
    <button class="btn secondary small" data-bulk="promo" ${dis}>🎁 Промокод</button>
    <button class="btn secondary small" data-bulk="transfer" ${dis}>📦 Передать предметы</button>
    <button class="btn secondary small" data-bulk="shop" ${dis} title="Активация подарков: покупка за Древние монеты"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Подарки</button>
    <button class="btn secondary small" data-bulk="caravan" ${dis} title="Сундук караванщика: открыть сундуки в инвентаре">🧰 Сундук</button>
    <button class="btn secondary small" data-bulk="launch" ${dis} title="Запустить игру для выбранных по очереди">▶ Запустить</button>
    <button class="btn secondary small" data-bulk="tag-add" ${dis}>🏷 Добавить тег</button>
    <button class="btn secondary small" data-bulk="tag-remove" ${dis}>🏷 Убрать тег</button>
    <button class="btn secondary small" data-bulk="party" ${dis}>👥 В пати</button>
    <button class="btn secondary small" data-bulk="archive" ${dis}>📦 В архив</button>
    <button class="btn danger small" data-bulk="delete" ${dis}>🗑 Удалить</button>
    <button class="btn ghost small" data-bulk="close" title="Esc">✕ Готово</button>
  `;
}

async function saveAndRender(message) {
  await persist();
  renderCharacters();
  renderParties();
  if (message) toast(message, 'success');
}

function tagModal({ title, submitText, tags, onTag }) {
  const options = tags.map(t => `<option value="${escapeHtml(t)}"></option>`).join('');
  showModal({
    title,
    content: `
      <div class="field">
        <label>Тег (можно несколько через запятую)</label>
        <input class="input" name="tag" list="bulk-tag-list" autocomplete="off" autofocus />
        <datalist id="bulk-tag-list">${options}</datalist>
      </div>`,
    submitText,
    cancelText: 'Отмена',
    onSubmit(formData) {
      const list = normalizeTags(formData.get('tag'));
      if (!list.length) { toast('Введите тег', 'warning'); return false; }
      onTag(list);
    }
  });
}

async function onBulkAction(e) {
  const btn = e.target.closest('[data-bulk]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.bulk;
  const chars = selectedChars();
  const now = new Date().toISOString();

  switch (action) {
    case 'all': selectAllVisible(); break;
    case 'close': setSelectionMode(false); break;
    case 'auth': await refreshAllLoginStatuses(chars); break;
    case 'balance': await refreshAllBalances(chars); break;
    case 'promo': {
      const { openPromoDialog } = await import('../automation/promo.js');
      openPromoDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'transfer': {
      const { openTransferDialog } = await import('../automation/transfer.js');
      openTransferDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'shop': {
      const { openShopDialog } = await import('../automation/shop.js');
      openShopDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'caravan': {
      const { openCaravanDialog } = await import('../automation/caravan.js');
      openCaravanDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'launch': {
      const { launchGroup } = await import('../launcher/partyLaunch.js');
      launchGroup(`Запуск игры: выбранные (${chars.length})`, chars);
      break;
    }
    case 'tag-add':
      tagModal({
        title: `Добавить тег (${chars.length} перс.)`, submitText: 'Добавить', tags: allTags(),
        onTag: (list) => {
          chars.forEach(c => { c.tags = normalizeTags([...(c.tags || []), ...list]); c.updatedAt = now; });
          saveAndRender(`Тег добавлен: ${chars.length} перс.`);
        }
      });
      break;
    case 'tag-remove': {
      const present = [...new Set(chars.flatMap(c => c.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
      if (!present.length) { toast('У выбранных персонажей нет тегов', 'info'); break; }
      tagModal({
        title: `Убрать тег (${chars.length} перс.)`, submitText: 'Убрать', tags: present,
        onTag: (list) => {
          const drop = new Set(list.map(t => t.toLowerCase()));
          chars.forEach(c => { c.tags = (c.tags || []).filter(t => !drop.has(t.toLowerCase())); c.updatedAt = now; });
          saveAndRender(`Тег убран: ${chars.length} перс.`);
        }
      });
      break;
    }
    case 'party': {
      // Можно выбрать существующую пати или создать новую для выбранных персонажей
      const NEW = '__new__';
      const options = [...state.parties.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`),
        `<option value="${NEW}">➕ Создать новую пати…</option>`].join('');
      showModal({
        title: `Пати (${chars.length} перс.)`,
        content: `
          <div class="field"><label>Пати</label><select class="select" name="party" id="bulk-party-select">${options}</select></div>
          <div class="field" id="bulk-party-new"><label>Название новой пати</label>
            <input class="input" name="newName" id="bulk-party-name" placeholder="Например: Группа-2" maxlength="40" autocomplete="off" />
            <small class="muted">В неё попадут выбранные персонажи (${chars.length}).</small>
          </div>
          <div class="field"><label>Действие</label>
            <label class="switch-row"><input type="radio" name="op" value="main" checked /> Сделать основной (прежняя основная станет дополнительной)</label>
            <label class="switch-row"><input type="radio" name="op" value="add" /> Добавить как дополнительную (у кого нет пати — станет основной)</label>
            <label class="switch-row" data-existing-only><input type="radio" name="op" value="remove" /> Убрать из этой пати</label>
            <label class="switch-row" data-existing-only><input type="radio" name="op" value="clear" /> Убрать из всех пати</label>
          </div>`,
        submitText: 'Применить',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
          const partyId = String(formData.get('party') || '');
          const op = String(formData.get('op') || 'add');
          if (partyId === NEW) {
            const res = createPartyWith(state.parties, chars, String(formData.get('newName') || ''), { asMain: op !== 'add', now });
            if ('error' in res) { setError(res.error); return false; }
            saveAndRender(`Создана пати «${res.party.name}»: ${res.changed} перс.`);
            return;
          }
          const party = partyById(state.parties, partyId);
          if (op === 'clear') {
            chars.forEach(c => { c.partyIds = []; c.mainPartyId = null; c.updatedAt = now; });
            saveAndRender(`Убраны из всех пати: ${chars.length}`);
            return;
          }
          if (!party) return false;
          let changed = 0;
          chars.forEach(c => {
            const did = op === 'main' ? setMainParty(c, party.id) : setMembership(c, party.id, op === 'add');
            if (did) { c.updatedAt = now; changed++; }
          });
          const msg = { main: `Основная пати «${party.name}»`, add: `Добавлены в «${party.name}»`, remove: `Убраны из «${party.name}»` }[op];
          saveAndRender(`${msg}: ${changed}`);
        }
      });
      // «Создать новую» — показываем поле названия; «убрать из пати» к новой пати не относится
      const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('bulk-party-select'));
      const sync = () => {
        const isNew = sel?.value === NEW;
        const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
        show(document.getElementById('bulk-party-new'), isNew);
        document.querySelectorAll('#modal-root [data-existing-only]').forEach(el => show(el, !isNew));
        if (isNew) {
          const keep = /** @type {HTMLInputElement | null} */ (document.querySelector('#modal-root input[name="op"][value="add"]'));
          const main = /** @type {HTMLInputElement | null} */ (document.querySelector('#modal-root input[name="op"][value="main"]'));
          if (main && !keep?.checked) main.checked = true;   // «убрать» к новой пати не относится
          document.getElementById('bulk-party-name')?.focus();
        }
      };
      sel?.addEventListener('change', sync);
      sync();
      break;
    }
    case 'delete': {
      const ok = await confirmModal({
        title: `Удалить персонажей: ${chars.length}?`,
        text: 'Действие необратимо. Вместе с персонажами удаляются их пароли в хранилище ОС, запомненные входы GameCenter и история монет.',
        okText: `Удалить (${chars.length})`,
        danger: true
      });
      if (ok) {
        const ids = new Set(chars.map(c => c.id));
        state.characters = state.characters.filter(c => !ids.has(c.id));
        state.ui.selection.clear();
        saveAndRender(`Удалено: ${ids.size}`);
      }
      break;
    }
    case 'archive': {
      try {
        const { archiveCharacters } = await import('../archive/archive.js');
        await archiveCharacters(chars.map(char => char.id));
        setSelectionMode(false);
      } catch (error) {
        console.error('[ARCHIVE] Bulk character archive failed:', error);
        toast(`Не удалось переместить персонажей в архив: ${error?.message || error}`, 'error');
      }
      break;
    }
  }
}
