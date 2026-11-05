import { listen, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
async function init() {
  const current = getCurrentWindow();
  await listen('game-macro-snapshot', event => {
    if (event.payload == null) return;
    const data = event.payload;
    document.documentElement.style.setProperty(
      '--alpha',
      String(Math.max(0.3, Math.min(1, Number(data.opacity) || 0.9)))
    );
    document.getElementById('status').textContent = data.paused
      ? 'Макросы на паузе'
      : data.busy
        ? 'Команда выполняется'
        : data.registered
          ? 'Хоткеи включены'
          : 'Хоткеи выключены / недоступны';
    document.getElementById('commands').replaceChildren(
      ...(data.commands || []).map(row => {
        const li = document.createElement('li'),
          key = document.createElement('kbd');
        li.textContent = String(row.name || '');
        key.textContent = String(row.hotkey || 'Кнопка в Инструментах');
        li.append(key);
        return li;
      })
    );
    document.getElementById('logs').textContent = (data.logs || []).join('\n');
  });
  document.querySelectorAll('[data-action]').forEach(button => {
    button.onclick = async () => {
      try {
        await invoke('game_macro_navigate', { action: button.dataset.action });
      } catch {
        document.getElementById('status').textContent = 'Не удалось выполнить действие. Откройте главное окно из трея.';
      }
    };
  });
  document.querySelector('[data-drag]').onpointerdown = event => {
    if (event.button === 0 && !event.target.closest('button')) void current.startDragging();
  };
  let collapsed = false;
  const fold = document.getElementById('fold');
  fold.onclick = async () => {
    fold.disabled = true;
    try {
      await invoke('game_macro_overlay_fold', { collapsed: !collapsed });
      collapsed = !collapsed;
      document.body.classList.toggle('folded', collapsed);
      fold.setAttribute('aria-expanded', String(!collapsed));
      fold.title = collapsed ? 'Развернуть оверлей' : 'Свернуть до верхней полосы';
      fold.setAttribute('aria-label', fold.title);
      fold.textContent = collapsed ? '▾' : '▴';
    } catch {
      document.getElementById('status').textContent = 'Не удалось изменить размер оверлея.';
    } finally {
      fold.disabled = false;
    }
  };
  document.getElementById('close').onclick = () => current.close();
  await emitTo('main', 'game-overlay-ready', null);
}
void init().catch(() => {
  document.getElementById('status').textContent = 'Оверлей доступен в настольном приложении.';
});
