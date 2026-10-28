import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
vi.mock('../js/modules/dashboard/todayView.js', () => ({ renderToday: vi.fn() }));
vi.mock('../js/modules/planner/render.js', () => ({ renderPlanner: vi.fn() }));
vi.mock('../js/modules/guild/window.js', () => ({
  openGuild: vi.fn(),
  syncGuildFromSite: vi.fn(),
  respondToEvent: vi.fn(),
  voteInGuildPoll: vi.fn()
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));

import { state } from '../js/core/state.js';
import { toast } from '../js/core/ui.js';
import { open } from '@tauri-apps/plugin-shell';
import { syncGuildFromSite, voteInGuildPoll } from '../js/modules/guild/window.js';
import { bindGuild, renderGuildToday } from '../js/modules/guild/page.js';

const poll = () => ({
  id: '901',
  title: [{ text: 'Выбор ' }, { text: 'ссылка', href: 'https://example.com/' }],
  type: 'multiple',
  options: [
    { id: '501', text: [{ text: 'Первый' }], selected: false },
    { id: '502', text: [{ text: 'Второй' }], selected: false }
  ]
});
const submit = () =>
  document.querySelector('[data-guild-poll]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="guild-today"></div>';
  state.settings.guild = { enabled: true, events: [], parties: [], selfNick: '', poll: poll(), syncedAt: 123 };
  state.planner = { entries: [] };
  bindGuild();
  renderGuildToday();
});

describe('голосование в панели клана', () => {
  it('без выбора ничего не отправляет', () => {
    submit();
    expect(voteInGuildPoll).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Выберите вариант ответа.', 'warning');
  });

  it('после подтверждения голосования обновляет сводку и показывает сохранённый выбор сайта', async () => {
    voteInGuildPoll.mockResolvedValue({ ok: true });
    const updated = poll();
    updated.options[1].selected = true;
    syncGuildFromSite.mockResolvedValue({ events: [], parties: [], selfNick: '', poll: updated });
    document.querySelector('input[value="502"]').checked = true;
    submit();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Голос учтён.', 'success'));
    expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['502']);
    expect(syncGuildFromSite).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[value="502"]').checked).toBe(true);
    expect(state.settings.guild.syncedAt).toBeGreaterThan(123);
  });

  it('если сайт принял голос, но повторная сводка не удалась, не подделывает время полной синхронизации', async () => {
    voteInGuildPoll.mockResolvedValue({ ok: true });
    syncGuildFromSite.mockRejectedValue('timeout');
    document.querySelector('input[value="501"]').checked = true;
    submit();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Голос учтён, но'), 'warning'));
    expect(state.settings.guild.syncedAt).toBe(123);
    expect(state.settings.guild.poll.options[0].selected).toBe(true);
    expect(document.querySelector('input[value="501"]').checked).toBe(true);
  });

  it('не выдаёт неясный результат за успешный и не запускает повторное голосование', async () => {
    voteInGuildPoll.mockRejectedValue('timeout');
    document.querySelector('input[value="502"]').checked = true;
    submit();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('Не удалось подтвердить голос'), 'warning')
    );
    expect(voteInGuildPoll).toHaveBeenCalledTimes(1);
    expect(syncGuildFromSite).not.toHaveBeenCalled();
    expect(document.querySelector('input[value="502"]').checked).toBe(true);
    expect(document.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it('ссылку открывает через системный браузер, а не в окне приложения', async () => {
    document.querySelector('a[data-guild-poll-link]').click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/'));
  });
});
