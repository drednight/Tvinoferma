import { openOverlay } from '../marathons/overlay.js';
import { ACTION_WIDGETS, WIDGET_VARIANTS } from './widgetCatalog.js';
import { ensureActionWidgets } from './todayWidgets.js';
import { escapeHtml as esc } from '../../core/utils.js';
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
let grid = false;
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
    if (!panel || (id.startsWith('script-') && panel.hidden)) continue;
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
  ensureActionWidgets(root, editing);
  const info = root.querySelector('.rt-information');
  if (info) {
    const fields = [...info.querySelectorAll('.rt-information-grid>div')];
    const hidden = Array.isArray(state.settings.ui.todayInformationHidden)
      ? state.settings.ui.todayInformationHidden
      : [];
    fields.forEach(el => (el.hidden = hidden.includes(el.querySelector('dt')?.textContent)));
    if (!info.querySelector('[data-info-fields]')) {
      const options = document.createElement('details');
      options.dataset.infoFields = '';
      const summary = document.createElement('summary');
      summary.textContent = 'Показатели';
      options.append(summary);
      fields.forEach(el => {
        const name = el.querySelector('dt')?.textContent;
        if (!name) return;
        const label = document.createElement('label'),
          box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !hidden.includes(name);
        label.append(box, document.createTextNode(' ' + name));
        options.append(label);
        box.onchange = async () => {
          const previous = state.settings.ui.todayInformationHidden;
          const next = fields
            .filter(field => (field === el ? !box.checked : field.hidden))
            .map(field => field.querySelector('dt').textContent);
          state.settings.ui.todayInformationHidden = next;
          options.querySelectorAll('input').forEach(input => (input.disabled = true));
          try {
            await persist();
            el.hidden = !box.checked;
          } catch {
            state.settings.ui.todayInformationHidden = previous;
            box.checked = !box.checked;
            toast('Не удалось сохранить показатели.', 'error');
          } finally {
            options.querySelectorAll('input').forEach(input => (input.disabled = false));
          }
        };
      });
      info.append(options);
    }
  }

  root.querySelector('[data-widget-library]')?.remove();
  root.querySelector('[data-widget-add]')?.remove();
  root.querySelectorAll('[data-widget-remove]').forEach(el => el.remove());
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
  toolbar.innerHTML = `<p role="status" data-layout-status></p><div class="row gap"><button type="button" class="btn ghost" data-layout-grid aria-pressed="${grid}">▦ Сетка: ${grid ? 'вкл' : 'выкл'}</button><button type="button" class="btn ghost" data-widget-library-open>＋ Добавить виджет</button><button type="button" class="btn" data-layout-save>Сохранить</button><button type="button" class="btn ghost" data-layout-cancel>Отмена</button><button type="button" class="btn ghost" data-layout-reset>Стандартное расположение</button><button type="button" class="btn ghost" data-layout-auto>Авторазмер</button></div>`;
  board.before(toolbar);
  surface.classList.toggle('rt-edit-grid', grid);
  toolbar.querySelector('[data-layout-grid]').onclick = () => {
    grid = !grid;
    surface.classList.toggle('rt-edit-grid', grid);
    const button = toolbar.querySelector('[data-layout-grid]');
    button.setAttribute('aria-pressed', String(grid));
    button.textContent = `▦ Сетка: ${grid ? 'вкл' : 'выкл'}`;
  };
  const openLibrary = () => {
    root.querySelector('[data-widget-library]')?.remove();
    const library = document.createElement('section');
    library.dataset.widgetLibrary = '';
    library.className = 'rt-widget-library';
    library.innerHTML = `<header><h3>Библиотека виджетов</h3><button class="btn ghost" data-library-close>Закрыть</button></header><p>Выберите вид и добавьте блок. После добавления его можно свободно растянуть и переместить. Превью — схематическое, ваши данные не меняются.</p><div class="rt-widget-catalog">${TODAY_BLOCKS.filter(
      ([id]) => id !== 'clan' || surface.querySelector('.rt-clan')
    )
      .map(([id, title]) => {
        const exists = surface.querySelector(`.rt-${id}`);
        return `<article><h4>${esc(title)}</h4><div class="rt-widget-preview" aria-hidden="true"><b>${esc(title)}</b><i></i><i></i><i></i></div><select data-widget-variant="${id}" aria-label="Вариант ${esc(title)}">${WIDGET_VARIANTS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select><p>${esc(ACTION_WIDGETS.find(row => row[0] === id)?.[2] || 'Ваши текущие данные в адаптивном блоке.')}</p><button class="btn" data-widget-insert="${id}" ${!exists ? 'disabled' : ''}>${!exists ? 'Недоступен: включите раздел в настройках' : !exists.hidden ? 'Изменить вид' : 'Добавить'}</button></article>`;
      })
      .join('')}</div>`;
    const modal = openOverlay({ title: 'Библиотека виджетов', wide: true });
    modal.body.append(library);
    modal.foot.innerHTML = '';
    modal.sub.textContent = 'Варианты размеров и предпросмотр';
    const closeLibrary = () => modal.close();
    const previewWidget = (article, id, variant) => {
      const original = surface.querySelector(`.rt-${id}`),
        preview = article.querySelector('.rt-widget-preview');
      if (!original) return;
      const [, , width, height] = WIDGET_VARIANTS.find(row => row[0] === variant);
      const clone = original.cloneNode(true);
      clone.hidden = false;
      clone.inert = true;
      clone.setAttribute('aria-hidden', 'true');
      clone.querySelectorAll('[data-layout-resize],[data-widget-remove]').forEach(el => el.remove());
      for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const attr of [...element.attributes])
          if (
            attr.name === 'id' ||
            attr.name === 'tabindex' ||
            attr.name.startsWith('on') ||
            attr.name.startsWith('data-')
          )
            element.removeAttribute(attr.name);
      }
      const scale = Math.min(1, (preview.clientWidth || 200) / width);
      clone.style.cssText = `position:relative;left:0;top:0;width:${width}px;height:${height}px;max-width:none;transform:scale(${scale});transform-origin:top left;pointer-events:none;`;
      preview.style.height = `${Math.min(220, height * scale)}px`;
      preview.replaceChildren(clone);
    };
    library
      .querySelectorAll('[data-widget-insert]')
      .forEach(button => previewWidget(button.closest('article'), button.dataset.widgetInsert, 'compact'));
    library.querySelector('[data-library-close]').onclick = closeLibrary;
    library.querySelectorAll('[data-widget-variant]').forEach(
      select =>
        (select.onchange = () => {
          previewWidget(select.closest('article'), select.dataset.widgetVariant, select.value);
        })
    );
    library.querySelectorAll('[data-widget-insert]').forEach(
      button =>
        (button.onclick = () => {
          const id = button.dataset.widgetInsert,
            panel = surface.querySelector(`.rt-${id}`);
          if (!panel || saving) return;
          const variant = library.querySelector(`[data-widget-variant="${id}"]`).value;
          const [, , width, height] = WIDGET_VARIANTS.find(row => row[0] === variant);
          if (panel.hidden) {
            draft.hidden = (draft.hidden || []).filter(key => key !== id);
            draft.blocks[id] = {
              x: 0,
              y: Math.max(
                0,
                ...Object.entries(draft.blocks)
                  .filter(([key]) => !draft.hidden?.includes(key))
                  .map(([, b]) => b.y + (b.height || 400) + 24)
              ),
              width,
              height
            };
            panel.hidden = false;
          }
          update(panel, id, { width, height });
          choose(id);
          closeLibrary();
        })
    );
  };
  toolbar.querySelector('[data-widget-library-open]').onclick = openLibrary;
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn rt-widget-add';
  add.dataset.widgetAdd = '';
  add.textContent = '＋ Добавить виджет';
  add.onclick = openLibrary;
  board.after(add);

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
    draft.blocks[selected].width = Math.max(
      300,
      Math.min(720, panel.offsetWidth || draft.blocks[selected].width || 360)
    );
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
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rt-widget-remove';
    remove.dataset.widgetRemove = id;
    remove.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>';
    remove.title = `Убрать «${title}»`;
    remove.setAttribute('aria-label', remove.title);
    remove.onclick = () => {
      if (saving) return;
      standard = false;
      draft.hidden = [...new Set([...(draft.hidden || []), id])];
      panel.hidden = true;
      selected = '';
      fit();
      refreshSelection();
    };
    header.append(remove);
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
      const previousZ = panel.style.zIndex;
      panel.style.zIndex = '100';
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        const dx = e.clientX - x + board.scrollLeft - scrollX;
        const dy = e.clientY - y + board.scrollTop - scrollY;
        const snap = value => (grid ? Math.round(value / 20) * 20 : value);
        update(
          panel,
          id,
          resize
            ? { width: snap(width + dx), height: snap(height + dy) }
            : { x: snap(before.x + dx), y: snap(before.y + dy) }
        );
      };
      const finish = e => {
        if (e && e.pointerId !== event.pointerId) return;
        if (!resize && e?.type === 'pointerup') {
          const current = draft.blocks[id],
            cx = current.x + (current.width || width) / 2,
            cy = current.y + (current.height || height) / 2;
          const other = TODAY_BLOCKS.find(([key]) => {
            if (key === id) return false;
            const element = surface.querySelector(`.rt-${key}`),
              b = draft.blocks[key];
            return (
              element &&
              !element.hidden &&
              b &&
              cx > b.x &&
              cx < b.x + (b.width || element.offsetWidth || 320) &&
              cy > b.y &&
              cy < b.y + (b.height || element.offsetHeight || 400)
            );
          });
          if (other) {
            const otherId = other[0],
              b = { ...draft.blocks[otherId] };
            update(panel, id, { x: b.x, y: b.y });
            update(surface.querySelector(`.rt-${otherId}`), otherId, { x: before.x, y: before.y });
          }
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', cancel);
        target.removeEventListener('lostpointercapture', finish);
        panel.classList.remove('rt-layout-resizing');
        panel.style.zIndex = previousZ;
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
