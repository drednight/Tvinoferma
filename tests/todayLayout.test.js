import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
import { state } from '../js/core/state.js';
import { mergeSettings } from '../js/core/state/settings.js';
import {
  normalizeTodayOrder,
  normalizeTodaySizes,
  todayOrder,
  applyTodayLayout
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
it('filters hostile, unknown and duplicate ids and adds future/default blocks', () => {
  expect(normalizeTodayOrder(['launch', 'launch', 'bad', '<script>'])).toEqual(['launch']);
  expect(todayOrder(['launch'])).toEqual(['launch', 'news', 'today', 'promos', 'marathon', 'information', 'clan']);
  expect(mergeSettings({ ui: { todayOrder: ['launch', 'launch', 'bad'] } }).ui.todayOrder).toEqual(['launch']);
});
it('leaves the normal layout alone, then moves the original nodes without losing controls', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="rt-board"><div class="rt-left"><section class="rt-news">News</section><section class="rt-today">Day</section></div><div class="rt-right"><section class="rt-launch"><button>Action</button></section><section class="rt-information">Info</section></div><section class="rt-clan">Extra</section></div>';
  const button = root.querySelector('button'),
    click = vi.fn();
  button.onclick = click;
  applyTodayLayout(root, []);
  expect(root.querySelector('.rt-left')).not.toBeNull();
  applyTodayLayout(root, ['launch', 'information']);
  expect([...root.querySelector('.rt-board').children].map(e => e.className)).toEqual([
    'rt-launch',
    'rt-information',
    'rt-news',
    'rt-today',
    'rt-clan'
  ]);
  button.click();
  expect(click).toHaveBeenCalledOnce();
});

function mount(clan = true) {
  bindTodayLayoutPanel();
  const root = document.createElement('div');
  document.body.append(root);
  const draw = () => {
    root.innerHTML = `<div class="rt-board"><div class="rt-left"><section class="rt-news">News</section><section class="rt-today">Day</section><section class="rt-promos">Promos</section></div><div class="rt-right"><section class="rt-marathon">Marathon</section><section class="rt-launch">Launch</section><section class="rt-information">Info</section></div>${clan ? '<section class="rt-clan">Clan</section>' : ''}</div>`;
    renderTodayLayoutEditor(root);
  };
  window.addEventListener('tf-today-layout-changed', draw);
  cleanup = () => window.removeEventListener('tf-today-layout-changed', draw);
  draw();
  return root;
}
const order = root => [...root.querySelector('.rt-board').children].map(el => el.className);
const toggle = () => {
  const input = document.querySelector('[data-today-layout-edit]');
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
};
it('Settings contains only a switch; actual blocks including clan swap on Today and save explicitly', async () => {
  const root = mount();
  expect(document.querySelector('[data-layout-up]')).toBeNull();
  expect(root.querySelector('[data-layout-toolbar]')).toBeNull();
  toggle();
  expect(root.querySelectorAll('[data-layout-swap]')).toHaveLength(7);
  root.querySelector('[data-layout-swap="clan"]').click();
  root.querySelector('[data-layout-swap="news"]').click();
  expect(order(root)[0]).toBe('rt-clan');
  expect(state.settings.ui.todayOrder).toEqual([]);
  expect(mocks.persist).not.toHaveBeenCalled();
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todayOrder[0]).toBe('clan');
  expect(root.querySelector('[data-layout-toolbar]')).toBeNull();
  expect(document.querySelector('[data-today-layout-edit]').checked).toBe(false);
  expect(order(root)[0]).toBe('rt-clan');
});
it('switching off or cancelling discards drafts and restores the original composition', () => {
  const root = mount();
  toggle();
  root.querySelector('[data-layout-swap="news"]').click();
  root.querySelector('[data-layout-swap="launch"]').click();
  toggle();
  expect(root.querySelector('.rt-left')).not.toBeNull();
  expect(state.settings.ui.todayOrder).toEqual([]);
  expect(mocks.persist).not.toHaveBeenCalled();
  toggle();
  root.querySelector('[data-layout-cancel]').click();
  expect(isTodayLayoutEditing()).toBe(false);
});
it('reset is a draft until saved and restores the original default layout', async () => {
  state.settings.ui.todayOrder = ['clan', 'launch'];
  const root = mount();
  toggle();
  root.querySelector('[data-layout-reset]').click();
  expect(state.settings.ui.todayOrder).toEqual(['clan', 'launch']);
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todayOrder).toEqual([]);
  expect(root.querySelector('.rt-left')).not.toBeNull();
});
it('hidden clan is not fabricated and its position survives editing other blocks', async () => {
  state.settings.ui.todayOrder = ['clan', 'news'];
  const root = mount(false);
  toggle();
  expect(root.querySelector('[data-layout-swap="clan"]')).toBeNull();
  root.querySelector('[data-layout-swap="news"]').click();
  root.querySelector('[data-layout-swap="launch"]').click();
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todayOrder[0]).toBe('clan');
});
it('failed storage rolls back persisted order, keeps draft available and allows retry', async () => {
  const root = mount();
  toggle();
  root.querySelector('[data-layout-swap="clan"]').click();
  root.querySelector('[data-layout-swap="news"]').click();
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(state.settings.ui.todayOrder).toEqual([]);
  expect(isTodayLayoutEditing()).toBe(true);
  expect(order(root)[0]).toBe('rt-clan');
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todayOrder[0]).toBe('clan');
});
it('locks swaps, reset, cancel and Settings switch while a save is pending', async () => {
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
  toggle();
  expect(isTodayLayoutEditing()).toBe(true);
  expect(document.querySelector('[data-today-layout-edit]').checked).toBe(true);
  resolve();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
});

it('normalizes size settings without accepting unknown blocks or invalid dimensions', () => {
  const input = {
    clan: { width: 2, height: 480 },
    news: { width: 99, height: -1 },
    evil: { width: 3 },
    launch: { width: 1, height: '400' },
    information: { span: 5, height: 300 },
    marathon: { span: 99 }
  };
  expect(normalizeTodaySizes(input)).toEqual({
    clan: { width: 2, height: 480 },
    launch: { width: 1 },
    information: { span: 5, height: 300 }
  });
  expect(mergeSettings({ ui: { todaySizes: input } }).ui.todaySizes).toEqual(normalizeTodaySizes(input));
});

function pointer(target, type, x, y, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId, button: 0 });
  target.dispatchEvent(event);
}
function drag(root, id, dx, dy, cancel = false) {
  const board = root.querySelector('.rt-board');
  board.getBoundingClientRect = () => ({ width: 1200 });
  const panel = root.querySelector(`.rt-${id}`);
  const width = Number(panel.dataset.layoutSpan) * 100;
  panel.getBoundingClientRect = () => ({ width, height: parseInt(panel.style.height) || 300 });
  const grip = panel.querySelector('[data-layout-resize]');
  grip.setPointerCapture = vi.fn();
  pointer(grip, 'pointerdown', 0, 0);
  pointer(grip, 'pointermove', dx, dy);
  pointer(grip, cancel ? 'pointercancel' : 'pointerup', dx, dy);
}
it('drags the clan corner to resize, saves dimensions and hides grips outside edit mode', async () => {
  const root = mount();
  expect(root.querySelector('[data-layout-resize]')).toBeNull();
  toggle();
  expect(root.querySelector('input[type="number"]')).toBeNull();
  expect(root.querySelector('select')).toBeNull();
  drag(root, 'clan', -400, 180);
  expect(root.querySelector('.rt-clan').style.height).toBe('480px');
  expect(root.querySelector('.rt-clan').dataset.layoutSpan).toBe('8');
  expect(state.settings.ui.todaySizes).toEqual({});
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todaySizes.clan).toEqual({ span: 8, height: 480 });
  expect(root.querySelector('.rt-clan').style.height).toBe('480px');
  expect(root.querySelector('[data-layout-resize]')).toBeNull();
});
it('cancel restores saved sizes and storage failure rolls them back too', async () => {
  state.settings.ui.todaySizes = { news: { width: 2, height: 350 } };
  const root = mount();
  toggle();
  drag(root, 'news', 100, 350);
  expect(root.querySelector('.rt-news').style.height).toBe('700px');
  root.querySelector('[data-layout-cancel]').click();
  expect(root.querySelector('.rt-news').style.height).toBe('350px');
  toggle();
  root.querySelector('[data-layout-reset]').click();
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(state.settings.ui.todaySizes.news).toEqual({ width: 2, height: 350 });
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todaySizes).toEqual({});
  expect(root.querySelector('.rt-left')).not.toBeNull();
});
it('clamps dragging to safe dimensions and restores a cancelled gesture', async () => {
  const root = mount();
  toggle();
  drag(root, 'news', 100000, 100000);
  expect(root.querySelector('.rt-news').dataset.layoutSpan).toBe('12');
  expect(root.querySelector('.rt-news').style.height).toBe('1600px');
  drag(root, 'news', -100000, -100000, true);
  expect(root.querySelector('.rt-news').dataset.layoutSpan).toBe('12');
  expect(root.querySelector('.rt-news').style.height).toBe('1600px');
  drag(root, 'news', -100000, -100000);
  expect(root.querySelector('.rt-news').dataset.layoutSpan).toBe('3');
  expect(root.querySelector('.rt-news').style.height).toBe('200px');
  root.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(isTodayLayoutEditing()).toBe(false));
  expect(state.settings.ui.todaySizes.news).toEqual({ span: 3, height: 200 });
});
it('supports keyboard resizing and resetting a single block to auto size', () => {
  const root = mount();
  toggle();
  const panel = root.querySelector('.rt-news');
  panel.getBoundingClientRect = () => ({ height: 300 });
  const grip = panel.querySelector('[data-layout-resize]');
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(panel.dataset.layoutSpan).toBe('5');
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(panel.style.height).toBe('320px');
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(panel.style.height).toBe('');
  expect(panel.dataset.layoutSpan).toBe('4');
});
