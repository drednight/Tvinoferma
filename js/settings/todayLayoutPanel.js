import { state } from '../core/state.js';
import { persist } from '../core/storage.js';
import { TODAY_BLOCKS, todayOrder } from '../modules/dashboard/todayLayout.js';
import { toast } from '../core/ui.js';
export function bindTodayLayoutPanel(root = document) {
  const host = root.querySelector('[data-today-layout-settings]');
  if (!host || host.dataset.bound) return;
  host.dataset.bound = 'true';
  let draft = todayOrder(state.settings.ui.todayOrder);
  let dragged = '';
  let saving = false;
  const draw = () => {
    host.innerHTML = `<p class="muted">Перетащите строки или используйте стрелки. На странице «Сегодня» кнопок настройки нет. Изменения применяются после сохранения.</p><ol class="today-layout-list">${draft.map((id, i) => `<li draggable="true" data-layout-id="${id}"><span aria-hidden="true">⠿</span><span>${TODAY_BLOCKS.find(b => b[0] === id)[1]}</span><button type="button" class="btn ghost small" data-layout-up="${id}" aria-label="Выше: ${TODAY_BLOCKS.find(b => b[0] === id)[1]}" ${i ? '' : 'disabled'}>↑</button><button type="button" class="btn ghost small" data-layout-down="${id}" aria-label="Ниже: ${TODAY_BLOCKS.find(b => b[0] === id)[1]}" ${i < draft.length - 1 ? '' : 'disabled'}>↓</button></li>`).join('')}</ol><div class="row gap"><button type="button" class="btn" data-layout-save>Сохранить расположение</button><button type="button" class="btn ghost" data-layout-reset>Сбросить расположение</button></div><p role="status" data-layout-status></p>`;
  };
  const save = async reset => {
    if (saving) return;
    saving = true;
    host.querySelectorAll('button').forEach(button => {
      button.disabled = true;
    });
    const previous = state.settings.ui.todayOrder;
    state.settings.ui.todayOrder = reset || draft.every((id, i) => id === TODAY_BLOCKS[i][0]) ? [] : [...draft];
    try {
      await persist();
      if (reset) draft = todayOrder([]);
      draw();
      host.querySelector('[data-layout-status]').textContent = reset
        ? 'Стандартное расположение восстановлено.'
        : 'Расположение сохранено.';
      window.dispatchEvent(new Event('tf-today-layout-changed'));
    } catch {
      state.settings.ui.todayOrder = previous;
      draw();
      toast('Не удалось сохранить расположение. Изменения не применены.', 'error');
    } finally {
      saving = false;
    }
  };
  host.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button || button.disabled || saving) return;
    if (button.hasAttribute('data-layout-save')) return void save(false);
    if (button.hasAttribute('data-layout-reset')) return void save(true);
    const id = button.dataset.layoutUp || button.dataset.layoutDown;
    const index = draft.indexOf(id),
      next = index + (button.dataset.layoutUp ? -1 : 1);
    if (index < 0 || next < 0 || next >= draft.length) return;
    [draft[index], draft[next]] = [draft[next], draft[index]];
    draw();
    host.querySelector(`[data-layout-${button.dataset.layoutUp ? 'up' : 'down'}="${id}"]`)?.focus();
  });
  host.addEventListener('dragstart', e => {
    if (saving) {
      e.preventDefault();
      return;
    }
    dragged = e.target.closest('[data-layout-id]')?.dataset.layoutId || '';
    e.dataTransfer?.setData('text/plain', dragged);
  });
  host.addEventListener('dragover', e => {
    if (dragged) e.preventDefault();
  });
  host.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('[data-layout-id]')?.dataset.layoutId;
    if (saving || !dragged || !target || dragged === target) return;
    draft.splice(draft.indexOf(dragged), 1);
    draft.splice(draft.indexOf(target), 0, dragged);
    dragged = '';
    draw();
  });
  host.addEventListener('dragend', () => {
    dragged = '';
  });
  draw();
}
