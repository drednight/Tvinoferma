import { beforeEach, it, expect, vi } from 'vitest';
import { actionWidgetData } from '../js/modules/dashboard/actionWidgetData.js';
const m = vi.hoisted(() => ({ unsubscribe: vi.fn(), change: vi.fn(), statistics: vi.fn() }));
vi.mock('../js/core/taskLog.js', () => ({
  scriptWidgetReports: () => [],
  openTaskStatistics: m.statistics,
  onTaskChange: fn => {
    m.change(fn);
    return m.unsubscribe;
  }
}));
import { state } from '../js/core/state.js';
import { mountActionWidget } from '../js/modules/dashboard/actionWidget.js';
const chars = [
  { id: 'a', nick: 'Alpha', partyIds: ['p'], ancientCoins: 17, isLoggedIn: true },
  {
    id: 'b',
    nick: 'Beta',
    partyIds: ['q'],
    ancientCoins: 25,
    lastCoinUpdate: '2026-11-05T12:00:00Z',
    lastLoginCheck: '2026-11-05T12:00:00Z',
    isLoggedIn: false
  }
];
beforeEach(() => {
  document.body.innerHTML = '<section></section>';
  state.characters = structuredClone(chars);
  state.parties = [
    { id: 'p', name: 'Пати' },
    { id: 'q', name: 'Другая' }
  ];
  state.marathons = [];
  state.ui.authCheck = {};
  localStorage.clear();
  m.change.mockClear();
  m.unsubscribe.mockClear();
});
it('never treats missing timestamps as a checked balance or confirmed authorization', () => {
  const auth = actionWidgetData('check-auth', { characters: chars });
  expect(auth.summary).toContain('0/2');
  expect(auth.rows[0].detail).toBe('Не проверено');
  const balance = actionWidgetData('update-balance', { characters: chars });
  expect(balance.summary).toContain('25');
  expect(balance.summary).not.toContain('42');
  expect(balance.note).toContain('часть данных не проверена');
});
it('distinguishes unknown inventory from a known empty inventory', () => {
  const data = actionWidgetData('caravan', {
    characters: chars,
    rosters: { a: { at: '2026-11-05T12:00:00Z', pending: { chests: 0 } } }
  });
  expect(data.rows[0].detail).toContain(': 0');
  expect(data.rows[1].detail).toBe('Нет сохранённого инвентаря');
});
it('does not double count a shared shop account', () => {
  const data = actionWidgetData('shop', {
    characters: chars,
    shop: { charSite: { a: 'shared', b: 'shared' }, accounts: { shared: { balance: 50, at: '2026-11-05T12:00:00Z' } } }
  });
  expect(data.rows).toHaveLength(1);
  expect(data.summary).toContain(': 1');
  expect(data.rows[0].name).toContain('Beta');
});
it('shows per-selected-character report counts without exposing report details', () => {
  const data = actionWidgetData('transfer', {
    characters: [chars[0]],
    reports: [
      {
        kind: 'transfer',
        rows: [
          { charId: 'a', status: 'ok' },
          { charId: 'b', status: 'bad' }
        ]
      }
    ]
  });
  expect(data.report.rows).toHaveLength(1);
});
it('keeps promo contents hidden until its existing dialog is explicitly opened', () => {
  const data = actionWidgetData('promo', { characters: chars });
  expect(data.rows).toEqual([]);
  expect(data.summary).toContain('скрыто');
});
it('mounts read-only facts, filters membership and escapes untrusted nicknames', () => {
  state.characters[0].nick = '<img src=x onerror=alert(1)>';
  const panel = document.querySelector('section'),
    widget = mountActionWidget(panel, 'check-auth', false);
  expect(panel.querySelector('img')).toBeNull();
  expect(panel.textContent).toContain('<img');
  const select = panel.querySelector('select');
  select.value = 'p';
  select.dispatchEvent(new Event('change'));
  expect(widget.selectedCharacters().map(c => c.id)).toEqual(['a']);
  expect(panel.textContent).not.toContain('Beta');
  expect(m.statistics).not.toHaveBeenCalled();
});
it('disables controls in layout editing and unsubscribes after removal', async () => {
  const panel = document.querySelector('section');
  mountActionWidget(panel, 'update-balance', true);
  expect(panel.querySelector('select').disabled).toBe(true);
  expect(panel.querySelector('button').disabled).toBe(true);
  panel.remove();
  await Promise.resolve();
  expect(m.unsubscribe).toHaveBeenCalled();
});

it('does not present malformed saved timestamps as verified auth or balance', () => {
  const characters = [
    {
      id: 'a',
      nick: 'Alpha',
      lastLoginCheck: 'not-a-date',
      isLoggedIn: true,
      lastCoinUpdate: 'invalid',
      ancientCoins: 400
    }
  ];
  const auth = actionWidgetData('check-auth', { characters });
  expect(auth.summary).toContain('0/1');
  expect(auth.summary).toContain('не проверено: 1');
  expect(auth.rows[0].detail).toBe('Не проверено');
  const balance = actionWidgetData('update-balance', { characters });
  expect(balance.summary).toContain('проверено 0/1');
  expect(balance.summary).not.toContain('400');
  expect(balance.rows[0].detail).toBe('Баланс не проверен');
});

it('only reports a strictly confirmed login and consistent valid freshness', () => {
  const data = actionWidgetData('check-auth', {
    characters: [
      { id: 'a', nick: 'Alpha', lastLoginCheck: '2026-11-05T12:00:00Z', isLoggedIn: 'true' },
      { id: 'b', nick: 'Beta', lastLoginCheck: 0, isLoggedIn: true }
    ]
  });
  expect(data.summary).toContain('0/2');
  expect(data.rows[0].detail).toContain('Вход не подтверждён');
  expect(data.rows[1].detail).toBe('Не проверено');
  expect(data.note).toContain('часть данных не проверена');
});
