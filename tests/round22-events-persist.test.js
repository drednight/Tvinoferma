import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сохраняем реальный storage.js (localStorage-адаптер в jsdom), чтобы проверить,
// что pendingResponses реально уходит на диск через полный путь respond.
// isTauri подменяем в true: jsdom — не Tauri, иначе enabled() вернёт false.
vi.mock('../js/core/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isTauri: () => true };
});
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
vi.mock('../js/modules/guild/window.js', () => ({
  openGuild: vi.fn(),
  respondToEvent: vi.fn(async () => ({ ok: true })),
  respondToEvents: vi.fn(async (events) => ({
    ok: true,
    results: events.map(e => ({ eventId: e.eventId, response: e.response, ok: true, message: '' }))
  })),
  syncGuildFromSite: vi.fn(async () => ({ events: [], parties: [], selfNick: '', polls: [] })),
  voteInGuildPoll: vi.fn()
}));
vi.mock('../js/core/taskLog.js', () => ({
  startTask: () => ({ waitTurn: async () => {}, progress: vi.fn(), log: vi.fn(), finish: vi.fn() })
}));

import { state } from '../js/core/state.js';

describe('реальный persist: ответ на событие сохраняется', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('respond сохраняет pendingResponses и переписывает state.json', async () => {
    const page = await import('../js/modules/guild/page.js');
    const ok = await page.respond('1', 'yes');
    expect(ok).toBe(true);
    expect(state.settings.guild.pendingResponses).toEqual([{ eventId: '1', response: 'yes', failed: false }]);
    // Дождёмся всех микростепов persist (writeChain).
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const raw = localStorage.getItem('tvinoferma_state_v1');
    if (!raw) throw new Error('state не записан в localStorage');
    const parsed = JSON.parse(raw);
    expect(parsed.settings.guild.pendingResponses).toEqual([{ eventId: '1', response: 'yes', failed: false }]);
  });
});
