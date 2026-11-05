import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast }));
import { state } from '../js/core/state.js';
import { mergeSettings } from '../js/core/state/settings.js';
import { normalizeTodayOrder, todayOrder, applyTodayLayout } from '../js/modules/dashboard/todayLayout.js';
import { bindTodayLayoutPanel } from '../js/settings/todayLayoutPanel.js';
beforeEach(() => {
  document.body.innerHTML = '<div data-today-layout-settings></div>';
  state.settings = mergeSettings({});
  vi.clearAllMocks();
});
it('filters hostile, unknown and duplicate ids and adds future/default blocks', () => {
  expect(normalizeTodayOrder(['launch', 'launch', 'bad', '<script>'])).toEqual(['launch']);
  expect(todayOrder(['launch'])).toEqual(['launch', 'news', 'today', 'promos', 'marathon', 'information']);
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
it('does not persist drafts until Save; reset restores the original composition', async () => {
  bindTodayLayoutPanel();
  document.querySelector('[data-layout-up="launch"]').click();
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(state.settings.ui.todayOrder).toEqual([]);
  document.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-layout-status]').textContent).toContain('сохранено'));
  expect(state.settings.ui.todayOrder[3]).toBe('launch');
  document.querySelector('[data-layout-reset]').click();
  await vi.waitFor(() => expect(state.settings.ui.todayOrder).toEqual([]));
});
it('rolls back the active order when storage fails', async () => {
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  bindTodayLayoutPanel();
  document.querySelector('[data-layout-up="launch"]').click();
  document.querySelector('[data-layout-save]').click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(state.settings.ui.todayOrder).toEqual([]);
});
