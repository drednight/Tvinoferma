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
    await invoke('game_macro_guide_result', { save });
  } catch {
    document.getElementById('error').textContent = point
      ? 'Не удалось сохранить. Поместите крестик внутрь выбранного игрового окна и повторите.'
      : 'Не удалось сохранить размер. Допустимо от 160 до 8000 физических пикселей по каждой стороне.';
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

if (!point) {
  document.getElementById('save').textContent = 'Применить и выйти · Enter';
  document.getElementById('cancel').textContent = 'Выйти · Esc';
  const update = () =>
    (document.getElementById('title').textContent =
      `Границы клиента · ${Math.round(innerWidth * devicePixelRatio)} × ${Math.round(innerHeight * devicePixelRatio)} px`);
  window.addEventListener('resize', update);
  document.getElementById('resize').onpointerdown = e => {
    e.preventDefault();
    void getCurrentWindow().startResizeDragging('SouthEast');
  };
}
