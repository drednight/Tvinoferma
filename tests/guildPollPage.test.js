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
vi.mock('../js/core/taskLog.js', () => ({
  startTask: () => ({ waitTurn: async () => {}, progress: vi.fn(), log: vi.fn(), finish: vi.fn() })
}));

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
const optionButton = id => document.querySelector(`.guild-poll-options button[data-option="${id}"]`);
const submit = () => document.querySelector('.guild-poll-submit button');

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="guild-today"></div>';
  state.settings.guild = { enabled: true, events: [], parties: [], selfNick: '', polls: [poll()], syncedAt: 123 };
  state.planner = { entries: [] };
  bindGuild();
  renderGuildToday();
});

describe('голосование в панели клана', () => {
  it('сразу ставит выбор локально, а голос отправляет через паузу', async () => {
    vi.useFakeTimers();
    voteInGuildPoll.mockResolvedValue({ ok: true });
    syncGuildFromSite.mockResolvedValue({
      events: [],
      parties: [],
      selfNick: '',
      polls: [{ ...poll(), options: [{ id: '501', text: [{ text: 'Первый' }], selected: true }, { id: '502', text: [{ text: 'Второй' }], selected: false }] }]
    });
    optionButton('501').click();
    // Выбор виден сразу: вариант выделен, статус «ожидает отправки».
    expect(optionButton('501').getAttribute('aria-pressed')).toBe('true');
    expect(toast).toHaveBeenCalledWith('Голос записан, отправка через пару секунд.', 'info');
    expect(voteInGuildPoll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['501']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.settings.guild.syncedAt).toBeGreaterThan(123);
    expect(optionButton('501').getAttribute('aria-pressed')).toBe('true');
    vi.useRealTimers();
  });

  it('без выбора ничего не отправляет', () => {
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(voteInGuildPoll).not.toHaveBeenCalled();
  });

  it('многовариантный опрос отправляет выбранные варианты кнопкой', async () => {
    vi.useFakeTimers();
    voteInGuildPoll.mockResolvedValue({ ok: true });
    syncGuildFromSite.mockResolvedValue({
      events: [],
      parties: [],
      selfNick: '',
      polls: [poll()]
    });
    optionButton('501').click();
    optionButton('502').click();
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(voteInGuildPoll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['501', '502']);
    vi.useRealTimers();
  });

  it('в одиночном опросе клик по варианту ставит выбор и уходит в очередь', async () => {
    vi.useFakeTimers();
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
    expect(single.getAttribute('aria-pressed')).toBe('true');
    await vi.advanceTimersByTimeAsync(8000);
    expect(voteInGuildPoll).toHaveBeenCalledWith('901', ['501']);
    vi.useRealTimers();
  });

  it('ссылку открывает через системный браузер, а не в окне приложения', async () => {
    document.querySelector('a[data-guild-poll-link]').click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/'));
  });
});
