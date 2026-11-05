import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
import { state } from '../js/core/state.js';
import { mergeSettings } from '../js/core/state/settings.js';
import {
  normalizeTodayOrder,
  todayOrder,
  applyTodayLayout,
  normalizeTodaySizes,
  normalizeTodayCanvas,
  applyTodayCanvas
} from '../js/modules/dashboard/todayLayout.js';
import { bindTodayLayoutPanel } from '../js/settings/todayLayoutPanel.js';
import {
  setTodayLayoutEditing,
  renderTodayLayoutEditor,
  isTodayLayoutEditing
} from '../js/modules/dashboard/todayLayoutEditor.js';
let cleanup = () => {};
afterEach(() => {
  cleanup();
  setTodayLayoutEditing(false);
});
beforeEach(() => {
  document.body.innerHTML = '<div data-today-layout-settings></div>';
  state.settings = mergeSettings({});
  vi.clearAllMocks();
});
function mount(clan = true) {
  bindTodayLayoutPanel();
  const root = document.createElement('div');
  document.body.append(root);
  const draw = () => {
    root.innerHTML = `<div class="rt-board"><div class="rt-left">${['news', 'today', 'promos'].map(id => `<section class="lg-panel rt-${id}"><h3>${id}</h3><button data-content-action>Action</button></section>`).join('')}</div><div class="rt-right">${['marathon', 'launch', 'information'].map(id => `<section class="lg-panel rt-${id}"><h3>${id}</h3></section>`).join('')}</div>${clan ? '<section class="lg-panel rt-clan"><h3>Clan</h3></section>' : ''}</div>`;
    renderTodayLayoutEditor(root);
  };
  window.addEventListener('tf-today-layout-changed', draw);
  cleanup = () => window.removeEventListener('tf-today-layout-changed', draw);
  draw();
  return root;
}
const toggle = () => {
  const input = document.querySelector('[data-today-layout-edit]');
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
};
function pointer(target, type, x, y, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId, button: 0 });
  target.dispatchEvent(event);
}
function drag(root, id, dx, dy, resize = false, cancel = false) {
  const handle = root.querySelector(`[data-layout-${resize ? 'resize' : 'drag'}="${id}"]`);
  pointer(handle, 'pointerdown', 0, 0);
  pointer(window, 'pointermove', dx, dy);
  pointer(window, cancel ? 'pointercancel' : 'pointerup', dx, dy);
}
async function save(root) {
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
}
it('normalizes stable ids, legacy sizes, and includes clan', () => {
  expect(normalizeTodayOrder(['launch', 'bad', 'launch', '<script>'])).toEqual(['launch']);
  expect(todayOrder(['launch'])).toEqual(['launch', 'news', 'today', 'promos', 'marathon', 'information', 'clan']);
  expect(normalizeTodaySizes({ clan: { width: 2, height: 480 }, launch: { width: 8 }, news: { span: 5 } })).toEqual({
    clan: { width: 2, height: 480 },
    news: { span: 5 }
  });
});
it('leaves default composition intact and preserves existing controls in legacy layout', () => {
  const root = mount();
  const click = vi.fn();
  root.querySelector('[data-content-action]').onclick = click;
  applyTodayLayout(root, []);
  expect(root.querySelector('.rt-left')).not.toBeNull();
  applyTodayLayout(root, ['clan']);
  root.querySelector('[data-content-action]').click();
  expect(click).toHaveBeenCalledOnce();
});
it('sanitizes free coordinates, dimensions, unknown blocks and non-finite values', () => {
  const input = {
    width: 100000,
    blocks: {
      news: { x: -10, y: 100000, width: 1, height: 99999 },
      clan: { x: 17.4, y: 83.2 },
      bad: { x: 1, y: 2 },
      launch: { x: NaN, y: 1 }
    }
  };
  const expected = {
    width: 20000,
    blocks: { news: { x: 0, y: 20000, width: 160, height: 4000 }, clan: { x: 17, y: 83 } }
  };
  expect(normalizeTodayCanvas(input)).toEqual(expected);
  expect(mergeSettings({ ui: { todayCanvas: input } }).ui.todayCanvas).toEqual(expected);
  expect(normalizeTodayCanvas({ blocks: {} })).toBeNull();
});
it('has no swap buttons or per-block auto buttons; toolbar auto is disabled without selection', () => {
  const root = mount();
  toggle();
  expect(root.querySelector('[data-layout-swap]')).toBeNull();
  expect(root.querySelectorAll('[data-layout-auto]')).toHaveLength(1);
  expect(root.querySelector('[data-layout-toolbar] [data-layout-auto]').disabled).toBe(true);
  expect(root.querySelectorAll('[data-layout-drag]')).toHaveLength(7);
  expect(root.querySelectorAll('[data-layout-resize]')).toHaveLength(7);
});
it('freely moves and resizes clan without grid snapping, only persisting on Save', async () => {
  const root = mount();
  toggle();
  drag(root, 'clan', 137, 53);
  const panel = root.querySelector('.rt-clan');
  expect(panel.style.left).toBe('137px');
  expect(panel.style.top).toBe('893px');
  drag(root, 'clan', 43, 81, true);
  expect(panel.style.width).toBe('363px');
  expect(panel.style.height).toBe('481px');
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(state.settings.ui.todayCanvas).toBeNull();
  await save(root);
  expect(state.settings.ui.todayCanvas.blocks.clan).toEqual({ x: 137, y: 893, width: 363, height: 481 });
  expect(root.querySelector('.rt-clan').style.left).toBe('137px');
  expect(root.querySelector('[data-layout-resize]')).toBeNull();
  expect(root.querySelector('[data-layout-toolbar]')).toBeNull();
});
it('toolbar auto size only resets selected dimensions and keeps its position', async () => {
  const root = mount();
  toggle();
  drag(root, 'news', 37, 29);
  drag(root, 'news', 200, 50, true);
  drag(root, 'clan', 80, 70, true);
  pointer(root.querySelector('.rt-news'), 'pointerdown', 0, 0);
  root.querySelector('[data-layout-auto]').click();
  expect(root.querySelector('.rt-news').style.left).toBe('37px');
  expect(root.querySelector('.rt-news').style.top).toBe('29px');
  expect(root.querySelector('.rt-news').style.width).toBe('320px');
  expect(root.querySelector('.rt-news').style.height).toBe('');
  expect(root.querySelector('.rt-clan').style.width).toBe('400px');
  await save(root);
  expect(state.settings.ui.todayCanvas.blocks.news).toEqual({ x: 37, y: 29 });
});
it('cancel and disabling Settings switch discard the whole draft', () => {
  const root = mount();
  toggle();
  drag(root, 'news', 10, 20);
  root.querySelector('[data-layout-cancel]').click();
  expect(root.querySelector('.rt-left')).not.toBeNull();
  expect(state.settings.ui.todayCanvas).toBeNull();
  toggle();
  drag(root, 'news', 50, 30);
  toggle();
  expect(root.querySelector('.rt-left')).not.toBeNull();
  expect(mocks.persist).not.toHaveBeenCalled();
});
it('standard layout reset is a draft; Save restores original composition and clears legacy customization', async () => {
  state.settings.ui.todayOrder = ['clan'];
  state.settings.ui.todaySizes = { news: { width: 2 } };
  state.settings.ui.todayCanvas = { width: 1000, blocks: { news: { x: 50, y: 60, width: 600 } } };
  const root = mount();
  toggle();
  root.querySelector('[data-layout-reset]').click();
  expect(state.settings.ui.todayCanvas.blocks.news.x).toBe(50);
  expect(root.querySelector('.rt-news').style.left).toBe('0px');
  await save(root);
  expect(state.settings.ui.todayCanvas).toBeNull();
  expect(state.settings.ui.todaySizes).toEqual({});
  expect(state.settings.ui.todayOrder).toEqual([]);
  expect(root.querySelector('.rt-left')).not.toBeNull();
});
it('hidden clan coordinates survive editing another block', async () => {
  state.settings.ui.todayCanvas = { width: 1200, blocks: { clan: { x: 47, y: 333 }, news: { x: 10, y: 20 } } };
  const root = mount(false);
  toggle();
  expect(root.querySelector('.rt-clan')).toBeNull();
  drag(root, 'news', 57, 43);
  await save(root);
  expect(state.settings.ui.todayCanvas.blocks.clan).toEqual({ x: 47, y: 333 });
  expect(state.settings.ui.todayCanvas.blocks.news.x).toBe(67);
});
it('newly visible clan is placed below existing blocks', () => {
  const root = mount();
  applyTodayCanvas(root, { width: 1200, blocks: { news: { x: 0, y: 100, height: 500 } } });
  expect(parseFloat(root.querySelector('.rt-clan').style.top)).toBeGreaterThan(600);
});
it('storage failure rolls back persisted layout but retains a retryable draft', async () => {
  const root = mount();
  toggle();
  drag(root, 'news', 77, 23);
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(state.settings.ui.todayCanvas).toBeNull();
  expect(root.querySelector('.rt-news').style.left).toBe('77px');
  await save(root);
  expect(state.settings.ui.todayCanvas.blocks.news.x).toBe(77);
});
it('locks gestures and Settings switch during persistence', async () => {
  const root = mount();
  toggle();
  let resolve;
  mocks.persist.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  root.querySelector('[data-layout-save]').click();
  expect(root.querySelector('[data-layout-cancel]').disabled).toBe(true);
  const before = root.querySelector('.rt-news').style.left;
  drag(root, 'news', 100, 100);
  expect(root.querySelector('.rt-news').style.left).toBe(before);
  toggle();
  expect(isTodayLayoutEditing()).toBe(true);
  resolve();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
});
it('cancelled pointer gesture restores size and position; dimensions stay within limits', () => {
  const root = mount();
  toggle();
  drag(root, 'news', 81, 93, false, true);
  expect(root.querySelector('.rt-news').style.left).toBe('0px');
  drag(root, 'news', -99999, -99999, true);
  expect(root.querySelector('.rt-news').style.width).toBe('160px');
  expect(root.querySelector('.rt-news').style.height).toBe('120px');
});
it('keyboard moves and resizes without grid snapping and Home applies selected auto size', () => {
  const root = mount();
  toggle();
  const header = root.querySelector('[data-layout-drag="news"]');
  header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  expect(root.querySelector('.rt-news').style.left).toBe('1px');
  const grip = root.querySelector('[data-layout-resize="news"]');
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(root.querySelector('.rt-news').style.width).toBe('330px');
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(root.querySelector('.rt-news').style.width).toBe('320px');
  expect(root.querySelector('.rt-news').style.left).toBe('1px');
});
