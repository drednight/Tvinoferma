import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
const query = new URLSearchParams(location.search),
  point = query.get('mode') === 'point';
document.body.className = point ? 'point' : 'size';
document.getElementById('title').textContent = point
  ? 'Задание координат'
  : `Границы клиента · ${query.get('width')} × ${query.get('height')} px`;
let pending = false;
async function finish(save) {
  if (pending) return;
  pending = true;
  try {
    await invoke('game_macro_guide_result', { save: save && point });
  } catch {
    document.getElementById('error').textContent =
      'Не удалось сохранить. Поместите крестик внутрь выбранного игрового окна и повторите.';
  } finally {
    pending = false;
  }
}
document.getElementById('save').onclick = () => finish(true);
document.getElementById('cancel').onclick = () => finish(false);
document.querySelector('[data-drag]').onpointerdown = event => {
  if (event.button === 0 && !event.target.closest('button')) void getCurrentWindow().startDragging();
};
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault();
    void finish(event.key === 'Enter');
  }
});
