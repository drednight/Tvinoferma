import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import {
  TODAY_BLOCKS,
  todayOrder,
  normalizeTodayCanvas,
  applyTodayLayout,
  applyTodayCanvas,
  applyCanvasBlockSize,
  clearTodayCanvasObserver
} from './todayLayout.js';

let editing = false;
let draft = null;
let selected = '';
let saving = false;
let stopGesture = null;
let standard = false;
let captureStandard = false;
const notify = () => window.dispatchEvent(new Event('tf-today-layout-changed'));
export const isTodayLayoutEditing = () => editing;
export function setTodayLayoutEditing(enabled) {
  if (saving) return;
  stopGesture?.();
  if (enabled && !editing) {
    draft = normalizeTodayCanvas(state.settings.ui.todayCanvas);
    standard = false;
    captureStandard = false;
  }
  editing = enabled;
  selected = '';
  notify();
}

function captureCanvas(root, defaults = false) {
  const board = root.querySelector('.rt-board');
  if (!board) return null;
  const bounds = board.getBoundingClientRect();
  const blocks = {};
  let index = 0;
  for (const id of todayOrder(defaults ? [] : state.settings.ui.todayOrder)) {
    const panel = root.querySelector(`.rt-${id}`);
    if (!panel) continue;
    const rect = panel.getBoundingClientRect();
    blocks[id] = {
      x: rect.width ? Math.max(0, rect.left - bounds.left) : (index % 3) * 340,
      y: rect.width ? Math.max(0, rect.top - bounds.top) : Math.floor(index / 3) * 420,
      width: rect.width || 320,
      ...(!defaults && state.settings.ui.todaySizes?.[id]?.height
        ? { height: state.settings.ui.todaySizes[id].height }
        : {})
    };
    index++;
  }
  return normalizeTodayCanvas({ width: bounds.width || 1200, blocks });
}

export function renderTodayLayoutEditor(root) {
  stopGesture?.();
  clearTodayCanvasObserver(root);
  root.querySelector('[data-layout-toolbar]')?.remove();
  root.querySelectorAll('[data-layout-resize]').forEach(el => el.remove());
  if (!editing) {
    if (state.settings.ui.todayCanvas) applyTodayCanvas(root, state.settings.ui.todayCanvas);
    else applyTodayLayout(root, state.settings.ui.todayOrder, state.settings.ui.todaySizes);
    return;
  }
  if (!draft) {
    if (!captureStandard) applyTodayLayout(root, state.settings.ui.todayOrder, state.settings.ui.todaySizes);
    draft = captureCanvas(root, captureStandard);
    captureStandard = false;
  }
  const workspace = applyTodayCanvas(root, draft);
  if (!workspace) return;
  // Includes a block that has just become visible, while retaining hidden block coordinates.
  draft = workspace.canvas;
  const { surface, fit } = workspace;
  const board = root.querySelector('.rt-board');
  const toolbar = document.createElement('div');
  toolbar.dataset.layoutToolbar = '';
  toolbar.className = 'rt-layout-toolbar';
  toolbar.innerHTML = `<p role="status" data-layout-status></p><div class="row gap"><button type="button" class="btn" data-layout-save>Сохранить</button><button type="button" class="btn ghost" data-layout-cancel>Отмена</button><button type="button" class="btn ghost" data-layout-reset>Стандартное расположение</button><button type="button" class="btn ghost" data-layout-auto>Авторазмер</button></div>`;
  board.before(toolbar);
  const auto = toolbar.querySelector('[data-layout-auto]');
  const refreshSelection = () => {
    for (const [id] of TODAY_BLOCKS) {
      surface.querySelector(`.rt-${id}`)?.classList.toggle('rt-layout-selected', selected === id);
    }
    const name = TODAY_BLOCKS.find(([id]) => id === selected)?.[1];
    auto.disabled = saving || !name || !surface.querySelector(`.rt-${selected}`);
    toolbar.querySelector('[data-layout-status]').textContent = name
      ? `Выбран блок «${name}». Тяните за заголовок для перемещения или за угол для изменения размера.`
      : 'Выберите блок. Перетаскивайте за заголовок в любое место, меняйте размер за угол. Авторазмер применяется к выбранному блоку.';
  };
  const choose = id => {
    if (!saving) {
      selected = id;
      refreshSelection();
    }
  };
  const update = (panel, id, patch) => {
    standard = false;
    draft.blocks[id] = normalizeTodayCanvas({
      width: draft.width,
      blocks: { [id]: { ...draft.blocks[id], ...patch } }
    }).blocks[id];
    applyCanvasBlockSize(panel, draft.blocks[id]);
    fit();
  };
  auto.onclick = () => {
    if (saving || !selected) return;
    const panel = surface.querySelector(`.rt-${selected}`);
    if (!panel) return;
    standard = false;
    delete draft.blocks[selected].width;
    delete draft.blocks[selected].height;
    applyCanvasBlockSize(panel, draft.blocks[selected]);
    fit();
  };
  for (const [id, title] of TODAY_BLOCKS) {
    const panel = surface.querySelector(`.rt-${id}`);
    if (!panel) continue;
    panel.onpointerdown = () => choose(id);
    let header = panel.querySelector('.rt-heading, h3, h2');
    if (!header) {
      header = document.createElement('div');
      header.textContent = title;
      panel.prepend(header);
    }
    header.dataset.layoutDrag = id;
    header.tabIndex = 0;
    header.title = 'Перетащите блок за заголовок. Стрелки — перемещение, Shift — точный шаг.';
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'rt-layout-resize';
    grip.dataset.layoutResize = id;
    grip.textContent = '◢';
    grip.setAttribute('aria-label', `Изменить размер: ${title}`);
    grip.title = 'Тяните за угол. Стрелки — размер; Home — авторазмер.';
    panel.append(grip);
    const gesture = (event, resize) => {
      if (saving || event.button !== 0) return;
      if (!resize && event.target.closest('button, a, input, select, textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      stopGesture?.();
      choose(id);
      const target = resize ? grip : header;
      const before = { ...draft.blocks[id] };
      const x = event.clientX,
        y = event.clientY;
      const scrollX = board.scrollLeft,
        scrollY = board.scrollTop;
      const width = panel.offsetWidth || before.width || 320;
      const height = panel.offsetHeight || before.height || 400;
      target.setPointerCapture?.(event.pointerId);
      panel.classList.add('rt-layout-resizing');
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        const dx = e.clientX - x + board.scrollLeft - scrollX;
        const dy = e.clientY - y + board.scrollTop - scrollY;
        update(panel, id, resize ? { width: width + dx, height: height + dy } : { x: before.x + dx, y: before.y + dy });
      };
      const finish = e => {
        if (e && e.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', cancel);
        target.removeEventListener('lostpointercapture', finish);
        panel.classList.remove('rt-layout-resizing');
        if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
        stopGesture = null;
      };
      const cancel = e => {
        if (e.pointerId !== event.pointerId) return;
        draft.blocks[id] = before;
        applyCanvasBlockSize(panel, before);
        fit();
        finish(e);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', cancel);
      target.addEventListener('lostpointercapture', finish);
      stopGesture = finish;
    };
    header.onpointerdown = event => gesture(event, false);
    grip.onpointerdown = event => gesture(event, true);
    const keyboard = (event, resize) => {
      if (saving || event.target !== event.currentTarget) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      choose(id);
      if (event.key === 'Home' && resize) {
        auto.click();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') return;
      const step = event.shiftKey ? 1 : 10;
      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      const block = draft.blocks[id];
      update(
        panel,
        id,
        resize
          ? {
              width: (panel.offsetWidth || block.width || 320) + dx,
              height: (panel.offsetHeight || block.height || 400) + dy
            }
          : { x: block.x + dx, y: block.y + dy }
      );
    };
    header.onkeydown = event => keyboard(event, false);
    grip.onkeydown = event => keyboard(event, true);
    grip.disabled = saving;
  }
  toolbar.querySelector('[data-layout-cancel]').onclick = () => setTodayLayoutEditing(false);
  toolbar.querySelector('[data-layout-reset]').onclick = () => {
    if (saving) return;
    stopGesture?.();
    captureStandard = true;
    standard = true;
    draft = null;
    selected = '';
    notify();
  };
  toolbar.querySelector('[data-layout-save]').onclick = async () => {
    if (saving) return;
    stopGesture?.();
    saving = true;
    notify();
    const previous = state.settings.ui.todayCanvas;
    const previousOrder = state.settings.ui.todayOrder;
    const previousSizes = state.settings.ui.todaySizes;
    state.settings.ui.todayCanvas = standard ? null : normalizeTodayCanvas(draft);
    if (standard) {
      state.settings.ui.todayOrder = [];
      state.settings.ui.todaySizes = {};
    }
    try {
      await persist();
      editing = false;
      draft = null;
      selected = '';
    } catch {
      state.settings.ui.todayCanvas = previous;
      state.settings.ui.todayOrder = previousOrder;
      state.settings.ui.todaySizes = previousSizes;
      toast('Не удалось сохранить расположение. Можно повторить сохранение или отменить изменения.', 'error');
    } finally {
      saving = false;
      notify();
    }
  };
  toolbar.querySelectorAll('button').forEach(button => {
    button.disabled = saving;
  });
  refreshSelection();
}
