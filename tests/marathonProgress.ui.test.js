import { describe, it, expect, beforeEach, vi } from 'vitest';

// Плитки на странице марафона: процент по отметкам и отдельный счётчик закрытых заданий.
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({
  getAuthView: () => ({ icon: '', text: 'в сети', color: '#0f0' }),
  getAuthState: () => 'online'
}));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  syncMarathons: vi.fn(),
  marathonUrlOf: () => null,
  SITE_PAGES: [],
  customPages: () => [],
  rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(),
  parseMarathonPage: vi.fn(),
  pickScannerCharacter: () => null,
  loadNewsPage: vi.fn(),
  isNewsUrl: () => false
}));

let page, state, model;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="marathon-list"></div><div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  model = await import('../js/modules/marathons/model.js');
  page = await import('../js/modules/marathons/page.js');

  // 53 назначенных задания по 7 выполнений: 371 нужная отметка, по одной в каждом.
  const tasks = Array.from({ length: 53 }, (_, i) =>
    model.createTask({ id: `t${i}`, title: `Задание ${i}`, targetChecks: 7 })
  );
  const progress = {
    c: Object.fromEntries(tasks.map(t => [t.id, { site: 1, adjust: 0, marks: [], history: {} }]))
  };
  const m = model.createMarathon({
    id: 'm',
    title: 'Большой марафон',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    participantIds: ['c'],
    tasks,
    assignments: { c: tasks.map(t => t.id) },
    progress
  });
  state.characters = [{ id: 'c', nick: 'Ник', partyIds: [], mainPartyId: null, class: '' }];
  state.parties = [];
  state.marathons = [m];
  page.openMarathon(m.id);
});

const card = label =>
  [...document.querySelectorAll('.mr-kpis .kpi-card')].find(c => c.querySelector('.kpi-label')?.textContent === label);

describe('плитки прогресса на странице марафона', () => {
  it('показывает 14% по отметкам при 0 выполненных заданий', () => {
    expect(card('Прогресс').querySelector('strong').textContent).toBe('14%');
    expect(card('Прогресс').querySelector('.mr-bar span').style.width).toBe('14%');
    const done = card('Выполнено заданий');
    expect(done.querySelector('strong').textContent).toBe('0/53');
    expect(done.textContent).toContain('отметок 53/371');
  });

  it('полоса прогресса на карточке списка тоже зависит от отметок', () => {
    expect(model.marathonTotals(state.marathons[0]).percent).toBe(14);
    expect(card('Прогресс').textContent).not.toContain('0%');
  });
});
