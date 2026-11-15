import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ persist: vi.fn(), guard: vi.fn(), send: vi.fn(), read: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({
  persist: mocks.persist,
  isTauri: () => true,
  assertStateWriteAvailable: mocks.guard
}));
vi.mock('../js/modules/guild/window.js', () => ({
  openGuild: vi.fn(),
  respondToEvent: mocks.send,
  syncGuildFromSite: mocks.read,
  voteInGuildPoll: vi.fn()
}));
vi.mock('../js/core/taskLog.js', () => ({
  startTask: () => ({ waitTurn: async () => {}, progress: vi.fn(), log: vi.fn(), finish: vi.fn() })
}));
vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));
let page, state;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.persist.mockReset().mockResolvedValue();
  mocks.guard.mockReset();
  mocks.send.mockReset().mockResolvedValue({ ok: true });
  mocks.read.mockReset().mockResolvedValue({ events: [{ id: '1', response: 'yes' }] });
  ({ state } = await import('../js/core/state.js'));
  state.settings.guild = {
    enabled: true,
    syncedAt: 123,
    events: [{ id: '1', title: 'Событие', response: 'no' }],
    pendingResponses: []
  };
  page = await import('../js/modules/guild/page.js');
  document.body.innerHTML = '<div id="guild-today"></div>';
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('клик сразу сохраняет локальный ответ и перерисовывает панель, сайт вызывается только через 7 секунд', async () => {
  const render = vi.fn();
  page.setGuildRefresh(render);
  expect(await page.respond('1', 'yes')).toBe(true);
  expect(render).toHaveBeenCalled();
  expect(state.settings.guild.pendingResponses).toEqual([{ eventId: '1', response: 'yes', failed: false }]);
  expect(state.settings.guild.events[0].response).toBe('no');
  expect(state.settings.guild.syncedAt).toBe(123);
  expect(mocks.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.send).toHaveBeenCalledWith('1', 'yes');
  expect(state.settings.guild.events[0].response).toBe('yes');
  expect(state.settings.guild.pendingResponses).toEqual([]);
});

it('применение видимости во время защищённого старта не возобновляет старые фоновые ответы', async () => {
  state.settings.guild.pendingResponses = [{ eventId: '1', response: 'yes', failed: false }];
  page.applyGuildVisibility();
  await vi.advanceTimersByTimeAsync(20000);
  expect(mocks.send).not.toHaveBeenCalled();
  page.startGuildDailySync();
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('защита восстановления блокирует и старую очередь, и новые ответы, и фоновое обновление', async () => {
  state.settings.guild.pendingResponses = [{ eventId: '1', response: 'yes', failed: false }];
  mocks.guard.mockImplementation(() => {
    throw new Error('protected');
  });
  page.startGuildDailySync();
  expect(await page.respond('2', 'no')).toBe(false);
  await page.autoSync();
  await vi.advanceTimersByTimeAsync(60000);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
});
it('выделяет ПЛ золотой рамкой и показывает каноническую иконку стрелка по названию класса', () => {
  state.settings.guild.parties = [
    {
      name: 'Test',
      members: [
        { nick: 'Alpha', cls: 'gun', title: 'Стрелок', leader: true },
        { nick: 'Beta', cls: 'wrong-file', title: 'Стрелок' }
      ]
    }
  ];
  state.settings.guild.selfNick = 'Alpha';
  page.renderGuildToday();
  const members = document.querySelectorAll('.guild-member');
  expect(members[0].classList.contains('is-leader')).toBe(true);
  expect(members[0].classList.contains('is-self')).toBe(true);
  expect(members[0].querySelector('.guild-leader-label').textContent).toBe('ПЛ');
  expect(members[1].classList.contains('is-leader')).toBe(false);
  for (const member of members)
    expect(member.querySelector('img').getAttribute('src')).toBe('assets/icons/classes/gan.webp');
});

it('offers per-party display leader fallback without guessing self or first member', () => {
  state.settings.guild.parties = [{ name: 'Party', members: [{ nick: 'Alpha' }, { nick: 'Beta' }] }];
  state.settings.guild.selfNick = 'Alpha';
  page.renderGuildToday();
  expect(document.querySelector('.is-leader')).toBeNull();
  expect(document.querySelector('[data-guild-leader]').options.length).toBe(3);
  state.settings.guild.leaderOverrides = [{ party: 'Party', nick: 'Beta' }];
  page.renderGuildToday();
  expect(document.querySelector('.is-leader').textContent).toContain('Beta');
  expect(document.querySelector('.is-leader').title).toContain('вручную');
  state.settings.guild.parties[0].members.pop();
  page.renderGuildToday();
  expect(document.querySelector('.is-leader')).toBeNull();
});
