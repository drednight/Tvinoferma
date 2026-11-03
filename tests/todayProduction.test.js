import { beforeEach, describe, it, expect, vi } from 'vitest';
import { parseLatestNews, refreshSiteFeed, siteFeedSnapshot } from '../js/modules/dashboard/siteFeed.js';
import { mskDate, mskAddDays } from '../js/core/msk.js';
import { state } from '../js/core/state.js';
import { connectedTodayState, runTodayAction } from '../js/modules/dashboard/todayRuntime.js';
import { createLabState } from '../demo/design-lab/model.js';
const calls = vi.hoisted(() => ({ launch: vi.fn(), windows: vi.fn(), persist: vi.fn() }));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ launchPartyByName: calls.launch }));
vi.mock('../js/modules/launcher/windowPicker.js', () => ({ openWindowPicker: calls.windows }));
vi.mock('../js/core/storage.js', () => ({ persist: calls.persist }));
beforeEach(() => {
  delete window.__TAURI_INTERNALS__;
  calls.launch.mockReset();
  calls.windows.mockReset();
  calls.persist.mockReset();
  state.parties = [{ id: 'real', name: 'Настоящий отряд' }];
  state.characters = [
    {
      id: 'real-char',
      nick: 'Реальный',
      class: 'Воин',
      mainPartyId: 'real',
      partyIds: ['real'],
      ancientCoins: 100,
      isLoggedIn: true,
      contacts: { password: 'MUST_NOT_LEAK' }
    }
  ];
  state.plannerEntries = [];
  state.marathons = [];
  state.settings.guild = { enabled: false };
});
describe('production Today adapters', () => {
  it('parses only canonical official links, deduplicates and returns latest three inert text titles', () => {
    const rows = parseLatestNews(
      '<script>alert(1)</script><a href="https://evil.test/news.php?article=99">Bad</a>' +
        [1, 2, 3, 4, 4].map(n => `<a href="/news.php?article=${n}">Новость ${n}</a>`).join('')
    );
    expect(rows.map(r => r.id)).toEqual(['4', '3', '2']);
    expect(rows.every(r => r.url.startsWith('https://pwonline.ru/news.php?article='))).toBe(true);
    expect(() => parseLatestNews('<p>Нет новостей</p>')).toThrow();
  });
  it('deduplicates concurrent reads and never advances the success timestamp on HTTP/markup failure', async () => {
    let release;
    const gate = new Promise(r => {
      release = r;
    });
    const invoke = vi.fn(async () => {
      await gate;
      return {
        status: 200,
        html: '<a href="/news.php?article=999">Новая публикация</a><article><p>Текст публикации</p></article>'
      };
    });
    const first = refreshSiteFeed({ invokeFn: invoke, now: () => new Date('2026-11-03T13:20:00Z') });
    const second = refreshSiteFeed({ invokeFn: invoke });
    expect(first).toBe(second);
    release();
    await first;
    expect(invoke).toHaveBeenCalledTimes(1);
    const stamp = siteFeedSnapshot().updatedAt;
    await refreshSiteFeed({ invokeFn: async () => ({ status: 500 }) });
    expect(siteFeedSnapshot()).toMatchObject({ updatedAt: stamp, status: 'unavailable' });
  });
  it('the browser never calls a native launcher or pretends to have opened windows', async () => {
    expect((await runTodayAction('launch', { partyId: 'real' })).ok).toBe(false);
    expect(calls.launch).not.toHaveBeenCalled();
    expect(calls.windows).not.toHaveBeenCalled();
  });
  it('real dashboard state excludes contact values, uses real IDs, currency balances and existing icon stems', () => {
    window.__TAURI_INTERNALS__ = {};
    const s = connectedTodayState(createLabState());
    expect(s.parties[0].id).toBe('real');
    expect(s.characters[0]).toMatchObject({ nick: 'Реальный', icon: 'var', coins: 100 });
    expect(s.characters[0].contacts).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('MUST_NOT_LEAK');
    expect(s.scenarios.clan).toBe(false);
    expect(s.scenarios.marathon).toBe(false);
  });
  it('native launch/windows delegate to the exact production entry points and reject unknown parties', async () => {
    window.__TAURI_INTERNALS__ = {};
    expect((await runTodayAction('launch', { partyId: 'missing' })).ok).toBe(false);
    await runTodayAction('launch', { partyId: 'real' });
    await runTodayAction('windows');
    expect(calls.launch).toHaveBeenCalledWith('Настоящий отряд');
    expect(calls.windows).toHaveBeenCalledTimes(1);
  });
  it('does not execute clan operations unless the production activation flag permits them', async () => {
    window.__TAURI_INTERNALS__ = {};
    expect(await runTodayAction('clan-open')).toMatchObject({ ok: false });
  });
  it('new calendar records and To-Do use the production planner and persist only the intended state', async () => {
    window.__TAURI_INTERNALS__ = {};
    await runTodayAction('event-add', { title: 'Моя задача', date: '2026-11-04', time: '', kind: 'task' });
    const entry = state.plannerEntries[0];
    expect(entry).toMatchObject({ title: 'Моя задача', date: '2026-11-04', status: 'todo' });
    await runTodayAction('todo', { eventId: entry.id, date: entry.date, response: 'done' });
    expect(entry.status).toBe('done');
    expect(calls.persist).toHaveBeenCalledTimes(2);
  });
});

it('the connected calendar reuses the production editor for add/edit, preserving the original record ID', async () => {
  document.body.innerHTML = '<div id="modal-root"></div><main></main>';
  const { renderConnectedToday } = await import('../js/modules/dashboard/connectedToday.js');
  const root = document.querySelector('main');
  root.dataset.referenceToday = 'true';
  const render = () => renderConnectedToday(root, {}, render);
  render();
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => dialog.removeAttribute('open');
  root.querySelector('[data-today-action="event-add"]').click();
  document.querySelector('#modal-root [name="title"]').value = 'План из нового вида';
  document.querySelector('#modal-root .modal-footer .btn.primary').click();
  await vi.waitFor(() => expect(state.plannerEntries).toHaveLength(1));
  const id = state.plannerEntries[0].id;
  root.querySelector('[data-today-action="calendar"]').click();
  dialog.querySelector('[data-today-action="planner-day"]').click();
  document.querySelector(`[data-planner-edit="${id}"]`).click();
  document.querySelector('#modal-root [name="title"]').value = 'Изменённый план';
  document.querySelector('#modal-root .modal-footer .btn.primary').click();
  await vi.waitFor(() => expect(state.plannerEntries[0].title).toBe('Изменённый план'));
  expect(state.plannerEntries[0].id).toBe(id);
  expect(state.characters[0].contacts.password).toBe('MUST_NOT_LEAK');
});
it('uses exactly the top finance widget balances, including month corrections', () => {
  const previous = state.finance;
  try {
    state.finance = {
      settings: { opening: { gold: 10, coins: 20 }, monthAdjust: { '2026-11': { gold: 1000, coins: 2000 } } },
      operations: [
        { date: '2026-11-03', currency: 'gold', kind: 'in', amount: 1 },
        { date: '2026-11-03', currency: 'coins', kind: 'in', amount: 2 }
      ]
    };
    const s = connectedTodayState({ ...createLabState(), production: true });
    expect(s.day.gold).toBe(1001);
    expect(s.day.bank).toBe(2002);
  } finally {
    state.finance = previous;
  }
});

it('shows the nearest upcoming marathon within seven days, not a distant one', () => {
  const today = mskDate();
  const upcoming = days => ({
    id: `m${days}`,
    title: `Марафон ${days}`,
    startDate: mskAddDays(today, days),
    endDate: mskAddDays(today, days + 20),
    tasks: [],
    participantIds: []
  });
  state.marathons = [upcoming(10), upcoming(7), upcoming(2)];
  const preview = { ...createLabState(), production: true };
  const result = connectedTodayState(preview);
  expect(result.scenarios.marathon).toBe(true);
  expect(result.day.marathon.id).toBe('m2');
  expect(result.day.marathon.percent).toBe(0);
  state.marathons = [upcoming(8)];
  expect(connectedTodayState(preview).scenarios.marathon).toBe(false);
});
