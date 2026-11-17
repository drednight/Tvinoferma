import { beforeEach, describe, expect, it, vi } from 'vitest';

// Реальный storage (localStorage в jsdom), isTauri подменён в true.
vi.mock('../js/core/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isTauri: () => true };
});
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
const winMocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ok: true })),
  read: vi.fn(async () => ({ events: [{ id: '1', response: 'yes' }], parties: [], selfNick: '', polls: [] }))
}));
vi.mock('../js/modules/guild/window.js', () => ({
  openGuild: vi.fn(),
  respondToEvent: winMocks.send,
  syncGuildFromSite: winMocks.read,
  voteInGuildPoll: vi.fn()
}));
vi.mock('../js/core/taskLog.js', () => ({
  startTask: () => ({ waitTurn: async () => {}, progress: vi.fn(), log: vi.fn(), finish: vi.fn() })
}));

import { state } from '../js/core/state.js';

const model = () => ({
  production: true,
  day: { date: '2026-11-16', chosenDay: 0, favoriteParty: '', marathon: {}, marathonTasks: [] },
  calendarEvents: [],
  characters: [],
  parties: [],
  activeWindows: [],
  scenarios: {}
});

describe('интеграция: ответ на событие сохраняется и виден после рендера', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    winMocks.send.mockReset().mockResolvedValue({ ok: true });
    winMocks.read.mockReset().mockResolvedValue({ events: [{ id: '1', response: 'yes' }], parties: [], selfNick: '', polls: [] });
    state.settings.guild = {
      enabled: true,
      syncedAt: 123,
      events: [{ id: '1', title: 'Событие', response: 'no' }],
      parties: [],
      selfNick: '',
      polls: [],
      pendingResponses: [],
      pendingPollVotes: []
    };
  });

  it('respond сохраняет выбор, рендер показывает нажатую кнопку, flush не стирает без потерь', async () => {
    const page = await import('../js/modules/guild/page.js');
    const { renderReferenceToday } = await import('../js/modules/dashboard/referenceTodayView.js');

    const root = document.createElement('div');
    document.body.appendChild(root);
    const refresh = () => {
      root.innerHTML = renderReferenceToday(model());
    };
    page.setGuildRefresh(refresh);
    refresh();

    const btn = root.querySelector('button[data-today-vote="1"][data-value="yes"]');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    const ok = await page.respond('1', 'yes');
    expect(ok).toBe(true);
    expect(state.settings.guild.pendingResponses).toEqual([{ eventId: '1', response: 'yes', failed: false }]);

    // changed (renderTodayNow) должен перерисовать с выбором.
    await vi.advanceTimersByTimeAsync(0);
    refresh();
    const btn2 = root.querySelector('button[data-today-vote="1"][data-value="yes"]');
    expect(btn2.getAttribute('aria-pressed')).toBe('true');

    // Flush: отправка и подтверждение по сводке.
    await vi.advanceTimersByTimeAsync(10000);
    expect(winMocks.send).toHaveBeenCalledWith('1', 'yes');
    // После подтверждения выбор переходит в events[].response.
    expect(state.settings.guild.events[0].response).toBe('yes');
    // И кнопка всё ещё нажата (через events[].response).
    refresh();
    const btn3 = root.querySelector('button[data-today-vote="1"][data-value="yes"]');
    expect(btn3.getAttribute('aria-pressed')).toBe('true');
    vi.useRealTimers();
  });

  it('если отправка не подтверждается по сводке, выбор остаётся в очереди (failed)', async () => {
    // Сводка не подтверждает (ответ остаётся старым) — выбор не должен потеряться.
    winMocks.read.mockResolvedValue({ events: [{ id: '1', response: 'no' }], parties: [], selfNick: '', polls: [] });
    const page = await import('../js/modules/guild/page.js');
    const ok = await page.respond('1', 'yes');
    expect(ok).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(winMocks.send).toHaveBeenCalledWith('1', 'yes');
    // Не подтверждён: остаётся в pendingResponses как failed.
    expect(state.settings.guild.pendingResponses).toEqual([{ eventId: '1', response: 'yes', failed: true }]);
    vi.useRealTimers();
  });
});
