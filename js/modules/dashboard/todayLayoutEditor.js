import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { TODAY_BLOCKS, todayOrder, normalizeTodaySizes, applyTodayLayout } from './todayLayout.js';

// Editing is transient and shared across Settings/Today rerenders; only Save persists.
let draft = null;
let draftSizes = {};
let selected = '';
let saving = false;
const notify = () => window.dispatchEvent(new Event('tf-today-layout-changed'));
export const isTodayLayoutEditing = () => draft !== null;
export function setTodayLayoutEditing(enabled) {
  if (saving) return;
  if (enabled && draft === null) {
    draft = todayOrder(state.settings.ui.todayOrder);
    draftSizes = normalizeTodaySizes(state.settings.ui.todaySizes);
  }
  if (!enabled) draft = null;
  selected = '';
  notify();
}
export function renderTodayLayoutEditor(root) {
  root.querySelector('[data-layout-toolbar]')?.remove();
  root.querySelectorAll('[data-layout-controls]').forEach(el => el.remove());
  root.querySelectorAll('.rt-layout-selected').forEach(el => el.classList.remove('rt-layout-selected'));
  if (!draft) {
    applyTodayLayout(root, state.settings.ui.todayOrder, state.settings.ui.todaySizes);
    return;
  }
  applyTodayLayout(root, draft, draftSizes);
  const board = root.querySelector('.rt-board');
  if (!board) return;
  const toolbar = document.createElement('div');
  toolbar.dataset.layoutToolbar = '';
  toolbar.className = 'rt-layout-toolbar';
  toolbar.innerHTML = `<p role="status">${selected ? 'Теперь выберите второй блок — они поменяются местами.' : 'Выберите по очереди два блока, чтобы поменять их местами. Изменения сохраняются только кнопкой «Сохранить».'}</p><div class="row gap"><button type="button" class="btn" data-layout-save>Сохранить</button><button type="button" class="btn ghost" data-layout-cancel>Отмена</button><button type="button" class="btn ghost" data-layout-reset>Стандартное расположение</button></div>`;
  board.before(toolbar);
  for (const [id, title] of TODAY_BLOCKS) {
    const panel = [...board.children].find(el => el.classList.contains(`rt-${id}`));
    if (!panel) continue; // Inactive clan is absent, but its saved position is retained.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost rt-layout-swap';
    button.dataset.layoutSwap = id;
    button.textContent = selected === id ? 'Выбран — нажмите другой блок' : 'Поменять местами';
    button.setAttribute('aria-label', `Поменять местами: ${title}`);
    button.setAttribute('aria-pressed', String(selected === id));
    panel.classList.toggle('rt-layout-selected', selected === id);
    const controls = document.createElement('div');
    controls.dataset.layoutControls = '';
    controls.className = 'rt-layout-controls';
    controls.append(button);
    const widthLabel = document.createElement('label');
    widthLabel.textContent = 'Ширина ';
    const width = document.createElement('select');
    width.dataset.layoutWidthInput = id;
    width.setAttribute('aria-label', `Ширина: ${title}`);
    width.innerHTML =
      '<option value="1">1 колонка</option><option value="2">2 колонки</option><option value="3">Вся строка</option>';
    width.value = String(draftSizes[id]?.width || (id === 'clan' ? 3 : 1));
    widthLabel.append(width);
    const heightLabel = document.createElement('label');
    heightLabel.textContent = 'Высота, px ';
    const height = document.createElement('input');
    height.type = 'number';
    height.min = '200';
    height.max = '1600';
    height.step = '1';
    height.placeholder = 'Авто';
    height.dataset.layoutHeightInput = id;
    height.setAttribute('aria-label', `Высота: ${title}; пусто — автоматически`);
    height.value = String(draftSizes[id]?.height || '');
    heightLabel.append(height);
    const resize = () => {
      if (saving) return;
      if (!height.checkValidity()) {
        height.reportValidity();
        return;
      }
      draftSizes[id] = { width: Number(width.value), ...(height.value ? { height: Number(height.value) } : {}) };
      applyTodayLayout(root, draft, draftSizes);
    };
    width.onchange = resize;
    height.onchange = resize;
    controls.append(widthLabel, heightLabel);
    panel.prepend(controls);
    button.onclick = () => {
      if (saving) return;
      if (selected && selected !== id) {
        const a = draft.indexOf(selected),
          b = draft.indexOf(id);
        [draft[a], draft[b]] = [draft[b], draft[a]];
        selected = '';
      } else selected = selected === id ? '' : id;
      notify();
    };
  }
  toolbar.querySelector('[data-layout-cancel]').onclick = () => setTodayLayoutEditing(false);
  toolbar.querySelector('[data-layout-reset]').onclick = () => {
    if (saving) return;
    draft = todayOrder([]);
    draftSizes = {};
    selected = '';
    notify();
  };
  toolbar.querySelector('[data-layout-save]').onclick = async () => {
    if (saving) return;
    const invalid = [...root.querySelectorAll('[data-layout-height-input]')].find(input => !input.checkValidity());
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    saving = true;
    notify();
    const previous = state.settings.ui.todayOrder;
    const previousSizes = state.settings.ui.todaySizes;
    const defaults = todayOrder([]);
    state.settings.ui.todayOrder = draft.every((id, i) => id === defaults[i]) ? [] : [...draft];
    state.settings.ui.todaySizes = normalizeTodaySizes(draftSizes);
    try {
      await persist();
      draft = null;
      selected = '';
    } catch {
      state.settings.ui.todayOrder = previous;
      state.settings.ui.todaySizes = previousSizes;
      toast('Не удалось сохранить расположение. Можно повторить сохранение или отменить изменения.', 'error');
    } finally {
      saving = false;
      notify();
    }
  };
  root
    .querySelectorAll(
      '[data-layout-toolbar] button, [data-layout-controls] button, [data-layout-controls] select, [data-layout-controls] input'
    )
    .forEach(button => {
      button.disabled = saving;
    });
}
