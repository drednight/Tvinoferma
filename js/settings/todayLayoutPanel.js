import { isTodayLayoutEditing, setTodayLayoutEditing } from '../modules/dashboard/todayLayoutEditor.js';

export function bindTodayLayoutPanel(root = document) {
  const host = root.querySelector('[data-today-layout-settings]');
  if (!host || host.dataset.bound) return;
  host.dataset.bound = 'true';
  host.innerHTML = `<label><input type="checkbox" role="switch" data-today-layout-edit> Настраивать расположение блоков на «Сегодня»</label><p class="muted">Включите переключатель и перейдите на «Сегодня». На странице выберите блок, перетащите его за заголовок в любое место и потяните за угол для изменения размера. Общая кнопка «Авторазмер» применяется к выбранному блоку. «Добавить виджет» открывает библиотеку с предпросмотром и вариантами размера; корзина убирает блок, его можно вернуть из библиотеки. Сетка включается отдельной кнопкой только в режиме настройки. Затем сохраните расположение. Подключённый блок клана тоже можно перемещать. Выключение режима без сохранения отменяет изменения.</p>`;
  const toggle = host.querySelector('[data-today-layout-edit]');
  const sync = () => {
    toggle.checked = isTodayLayoutEditing();
  };
  toggle.onchange = () => {
    setTodayLayoutEditing(toggle.checked);
    sync();
  };
  window.addEventListener('tf-today-layout-changed', sync);
  sync();
}
