import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { TODAY_BLOCKS, todayOrder, normalizeTodaySizes, applyTodayLayout, applyTodayBlockSize } from './todayLayout.js';

// Editing is transient and shared across Settings/Today rerenders; only Save persists.
let draft = null;
let draftSizes = {};
let selected = '';
let saving = false;
let stopResize = null;
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
  stopResize?.();
  root.querySelectorAll('[data-layout-resize]').forEach(el => el.remove());
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
  toolbar.innerHTML = `<p role="status">${selected ? 'Теперь выберите второй блок — они поменяются местами.' : 'Выберите по очереди два блока, чтобы поменять их местами. Тяните за угол блока, чтобы изменить размер. Изменения сохраняются только кнопкой «Сохранить».'}</p><div class="row gap"><button type="button" class="btn" data-layout-save>Сохранить</button><button type="button" class="btn ghost" data-layout-cancel>Отмена</button><button type="button" class="btn ghost" data-layout-reset>Стандартное расположение</button></div>`;
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
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'btn ghost';
    auto.dataset.layoutAuto = id;
    auto.textContent = 'Авторазмер';
    auto.onclick = () => {
      if (saving) return;
      delete draftSizes[id];
      applyTodayBlockSize(panel, id, {});
    };
    controls.append(auto);
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'rt-layout-resize';
    grip.dataset.layoutResize = id;
    grip.textContent = '◢';
    grip.setAttribute('aria-label', `Изменить размер: ${title}`);
    grip.title = 'Тяните за угол. Клавиши ← → меняют ширину, ↑ ↓ — высоту; Home — авторазмер.';
    const updateSize = (span, height) => {
      draftSizes[id] = {
        span: Math.max(3, Math.min(12, Math.round(span))),
        height: Math.max(200, Math.min(1600, Math.round(height)))
      };
      applyTodayBlockSize(panel, id, draftSizes[id]);
    };
    grip.onpointerdown = event => {
      if (saving || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      stopResize?.();
      const rect = panel.getBoundingClientRect();
      const boardWidth = board.getBoundingClientRect().width;
      if (!boardWidth) return;
      const gap = parseFloat(getComputedStyle(board).columnGap) || 0;
      const unit = (boardWidth + gap) / 12;
      const x = event.clientX,
        y = event.clientY;
      const before = draftSizes[id] ? { ...draftSizes[id] } : null;
      grip.setPointerCapture?.(event.pointerId);
      panel.classList.add('rt-layout-resizing');
      const finish = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', finish);
        grip.removeEventListener('pointercancel', cancel);
        grip.removeEventListener('lostpointercapture', finish);
        panel.classList.remove('rt-layout-resizing');
        if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        stopResize = null;
      };
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        updateSize((rect.width + e.clientX - x + gap) / unit, rect.height + e.clientY - y);
      };
      const cancel = () => {
        if (before) draftSizes[id] = before;
        else delete draftSizes[id];
        applyTodayBlockSize(panel, id, before || {});
        finish();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', finish);
      grip.addEventListener('pointercancel', cancel);
      grip.addEventListener('lostpointercapture', finish);
      stopResize = finish;
    };
    grip.onkeydown = event => {
      if (saving || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') {
        auto.click();
        return;
      }
      const size = draftSizes[id] || {};
      const span = size.span || (size.width ? size.width * 4 : id === 'clan' ? 12 : 4);
      const height = size.height || panel.getBoundingClientRect().height;
      updateSize(
        span + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0),
        height + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0)
      );
    };
    panel.append(grip);
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
    .querySelectorAll('[data-layout-toolbar] button, [data-layout-controls] button, [data-layout-resize]')
    .forEach(button => {
      button.disabled = saving;
    });
}
