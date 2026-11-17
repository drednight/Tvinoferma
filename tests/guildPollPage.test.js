import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({
  persist: vi.fn(async () => {}),
  isTauri: () => true,
  assertStateWriteAvailable: vi.fn()
}));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
vi.mock('../js/modules/dashboard/todayView.js', () => ({ renderToday: vi.fn() }));
vi.mock('../js/modules/planner/render.js', () => ({ renderPlanner: vi.fn() }));
vi.mock('../js/modules/guild/window.js', () => ({
  openGuild: vi.fn(),
  syncGuildFromSite: vi.fn(),
  respondToEvent: vi.fn(),
  voteInGuildPoll: vi.fn()
}));
vi.mock('../js/core/linkBrowser.js', () => ({ openWebLink: vi.fn(async () => {}) }));

import { state } from '../js/core/state.js';
import { toast } from '../js/core/ui.js';
import { openWebLink as open } from '../js/core/linkBrowser.js';
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
const optionButton = id =>
  document.querySelector(`.guild-poll-options button[data-option="${id}"]`);
const submit = () =>
  document.querySelector('.guild-poll-submit button');

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="guild-today"></div>';
  state.settings.guild = { enabled: true, events: [], parties: [], selfNick: '', polls: [poll()], syncedAt: 123 };
  state.planner = { entries: [] };
  bindGuild();
  renderGuildToday();
});

describe('голосование в панели клана', () => {
  it('без выбора не позволяет отправить голос многовариантного опроса', () => {
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(voteInGuildPoll).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('Голос учтён'), expect.anything());
  });

  it('после подтверждения голосования обновляет сводку и показывает сохранённый выбор сайта', async () => {
    voteInGuildPoll.mockResolvedValue({ ok: true });
    const updated = poll();
    updated.options[1].selected = true;
    syncGuildFromSite.mockResolvedValue({ events: [], parties: [], selfNick: '', polls: [updated] });
    optionButton('502').click();
    expect(submit().disabled).toBe(false);
    submit().click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Голос учтён.', 'success'));
    expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['502']);
    expect(syncGuildFromSite).toHaveBeenCalledTimes(1);
    expect(optionButton('502').getAttribute('aria-pressed')).toBe('true');
    expect(state.settings.guild.syncedAt).toBeGreaterThan(123);
  });

  it('если сайт принял голос, но повторная сводка не удалась, не подделывает время полной синхронизации', async () => {
    voteInGuildPoll.mockResolvedValue({ ok: true });
    syncGuildFromSite.mockRejectedValue('timeout');
    optionButton('501').click();
    submit().click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Голос учтён, но'), 'warning'));
    expect(state.settings.guild.syncedAt).toBe(123);
    expect(state.settings.guild.polls[0].options[0].selected).toBe(true);
    expect(optionButton('501').getAttribute('aria-pressed')).toBe('true');
  });

  it('не выдаёт неясный результат за успешный и не запускает повторное голосование', async () => {
    voteInGuildPoll.mockRejectedValue('timeout');
    optionButton('502').click();
    submit().click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('Не удалось подтвердить голос'), 'warning')
    );
    expect(voteInGuildPoll).toHaveBeenCalledTimes(1);
    expect(syncGuildFromSite).not.toHaveBeenCalled();
    expect(optionButton('502').getAttribute('aria-pressed')).toBe('true');
    expect(submit().disabled).toBe(false);
  });

  it('в одиночном опросе клик по варианту сразу отправляет голос', async () => {
    state.settings.guild = {
      enabled: true,
      events: [],
      parties: [],
      selfNick: '',
      polls: [{ ...poll(), type: 'single' }],
      syncedAt: 123
    };
    voteInGuildPoll.mockResolvedValue({ ok: true });
    syncGuildFromSite.mockResolvedValue({ events: [], parties: [], selfNick: '', polls: [poll()] });
    renderGuildToday();
    const single = document.querySelector('.guild-poll[data-poll-id="901"] .guild-poll-options button');
    single.click();
    await vi.waitFor(() => expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['501']));
    expect(toast).toHaveBeenCalledWith('Голос учтён.', 'success');
  });

  it('ссылку открывает через системный браузер, а не в окне приложения', async () => {
    document.querySelector('a[data-guild-poll-link]').click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/'));
  });
});
