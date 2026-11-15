import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ running: vi.fn(), close: vi.fn(), confirm: vi.fn(), toast: vi.fn(), style: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ isTauri: () => true }));
vi.mock('../js/core/ui.js', () => ({ confirmModal: m.confirm, toast: m.toast }));
vi.mock('../js/modules/launcher/launch.js', () => ({ runningClientDetails: m.running, closeClientsByPid: m.close }));
vi.mock('../js/modules/launcher/windowPicker.js', () => ({ openStyleDialog: m.style }));
import { mountWindowsWidget } from '../js/modules/dashboard/windowsWidget.js';
import { state } from '../js/core/state.js';
const client = { pid: 10, startedAt: 1000, title: 'Alpha — Жрец' };
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<section></section>';
  state.characters = [{ id: 'a', nick: 'Alpha', class: 'Жрец' }];
  m.running.mockResolvedValue([client]);
  m.close.mockResolvedValue({ closed: 1 });
  m.confirm.mockResolvedValue(true);
});
async function mount() {
  mountWindowsWidget(document.querySelector('section'), false);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Закрыть'));
  return [...document.querySelectorAll('button')].find(b => b.textContent === 'Закрыть');
}
it('renders native clients inline without opening a launcher dialog', async () => {
  await mount();
  expect(document.body.textContent).toContain('Alpha');
  expect(m.style).not.toHaveBeenCalled();
  expect(m.close).not.toHaveBeenCalled();
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('Вид')).click();
  await vi.waitFor(() => expect(m.style).toHaveBeenCalledOnce());
});
it('closes only a confirmed, freshly checked process', async () => {
  const close = await mount();
  close.click();
  await vi.waitFor(() => expect(m.close).toHaveBeenCalledWith([10]));
  expect(m.confirm).toHaveBeenCalledOnce();
  expect(m.running.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('does not close a recycled PID', async () => {
  const close = await mount();
  m.running.mockResolvedValue([{ ...client, startedAt: 2000 }]);
  close.click();
  await vi.waitFor(() => expect(m.toast).toHaveBeenCalled());
  expect(m.close).not.toHaveBeenCalled();
});
it('cancel performs no closing', async () => {
  m.confirm.mockResolvedValue(false);
  const close = await mount();
  close.click();
  await vi.waitFor(() => expect(m.confirm).toHaveBeenCalledOnce());
  expect(m.close).not.toHaveBeenCalled();
});
