import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  actions: vi.fn(async () => ({ ok: false, message: 'Только в приложении' })),
  promos: [],
  native: false
}));
vi.mock('../js/modules/dashboard/todayRuntime.js', () => ({
  connectedTodayState: s => ({ ...s, sitePromos: mocks.promos }),
  runTodayAction: mocks.actions,
  nativeToday: () => mocks.native
}));
import { createLabState } from '../demo/design-lab/model.js';
import {
  renderReferenceToday,
  bindReferenceToday,
  referenceDayEvents,
  referencePromoStatus
} from '../demo/design-lab/referenceToday.js';
import { refreshSiteFeed } from '../js/modules/dashboard/siteFeed.js';
let state, root, dialog, render, toast;
const $ = s => document.querySelector(s);
beforeEach(() => {
  document.body.innerHTML = '<main></main><dialog></dialog>';
  state = createLabState();
  state.day.date = '2026-11-03';
  state.calendarEvents = [
    { id: 'personal', date: state.day.date, time: '20:00', title: 'Личный сбор', kind: 'event' },
    { id: 'todo', date: state.day.date, title: 'Проверить припасы', kind: 'task' }
  ];
  root = $('main');
  dialog = $('dialog');
  dialog.close = () => dialog.removeAttribute('open');
  render = () => {
    root.innerHTML = renderReferenceToday(state);
  };
  toast = vi.fn();
  mocks.promos = [];
  mocks.actions.mockClear();
  mocks.native = false;
  bindReferenceToday({
    root,
    dialog,
    getState: () => state,
    render,
    toast,
    modal: (title, body) => {
      dialog.innerHTML = `<h2>${title}</h2>${body}`;
      dialog.setAttribute('open', '');
    }
  });
  render();
});
afterEach(() => {
  document.body.replaceChildren();
});
describe('Today 12 revised connected dashboard', () => {
  it('preserves columns, info on the right and full-width clan below; removes the pass legend and game sub-list', () => {
    expect($('.rt-left .rt-today')).not.toBeNull();
    expect($('.rt-right > .rt-information')).not.toBeNull();
    expect($('.rt-board > .rt-clan')).not.toBeNull();
    expect($('.rt-pass-legend')).toBeNull();
    expect($('.rt-other-events')).toBeNull();
    expect(root.querySelectorAll('.rt-week button')).toHaveLength(7);
    state.scenarios.clan = false;
    render();
    expect($('.rt-clan')).toBeNull();
    expect($('.rt-information')).not.toBeNull();
  });
  it('shows 2–3 news directly with the real last successful refresh time, never a fabricated success', async () => {
    await refreshSiteFeed({
      invokeFn: vi.fn(async () => ({
        status: 200,
        html: '<a href="/news.php?article=3">Третья новость</a><a href="/news.php?article=2">Вторая новость</a><a href="/news.php?article=1">Первая новость</a><article><p>Раскрытый текст новости.</p></article>'
      })),
      now: () => new Date('2026-11-03T13:20:00Z')
    });
    render();
    expect(root.querySelectorAll('.rt-news article')).toHaveLength(3);
    expect($('.rt-news').textContent).toContain('16:20');
    expect($('.rt-news details')).toBeNull();
    expect([...root.querySelectorAll('.rt-news article a')].map(a => a.href)).toEqual(
      [3, 2, 1].map(id => `https://pwonline.ru/news.php?article=${id}`)
    );
    expect(root.textContent).not.toContain('Сохранённый пример');
  });
  it('promo rewards are collapsed on every render, with no source link', () => {
    mocks.promos = [
      {
        code: 'CURRENT',
        expiresOn: '2026-11-04',
        sourceUrl: 'https://pwonline.ru/news.php?article=3',
        entered: 2,
        rewards: ['Награда × 2']
      }
    ];
    render();
    expect($('.rt-promo').textContent).toContain('CURRENT');
    expect($('.rt-promo').textContent).toContain('Введён: 2');
    expect($('.rt-promo').textContent).toContain('Награда × 2');
    expect($('.rt-promo a')).toBeNull();
    const details = $('.rt-promo details');
    expect(details.open).toBe(false);
    details.querySelector('summary').click();
    expect(details.open).toBe(true);
    render();
    expect($('.rt-promo details').open).toBe(false);
    expect($('[data-today-action=promo-restore]')).toBeNull();
  });
  it('tabs separate timed events from To-Do, preserving task completion across tabs', () => {
    expect($('.rt-events').textContent).toContain('Личный сбор');
    expect($('.rt-events').textContent).not.toContain('Проверить припасы');
    $('[data-today-tab=todo]').click();
    expect($('.rt-events').textContent).toContain('Проверить припасы');
    $('[data-today-todo=todo]').click();
    expect(state.calendarEvents[1].status).toBe('done');
    $('[data-today-tab=events]').click();
    $('[data-today-tab=todo]').click();
    expect($('[data-today-todo=todo]').checked).toBe(true);
  });
  it('uses production recurring events for the chosen date, not invented event times', () => {
    state.day.chosenDay = 1;
    expect(
      referenceDayEvents(state).some(e => e.title === 'Ритм Гильдии' && e.time === '19:30' && e.endTime === '19:59')
    ).toBe(true);
  });
  it('opens an actual month grid; date changes update the agenda and add form; month navigation works', () => {
    $('[data-today-action=calendar]').click();
    expect(dialog.querySelectorAll('[data-today-date]')).toHaveLength(30);
    $('[data-today-date="2026-11-04"]').click();
    expect(dialog.textContent).toContain('Ритм Гильдии');
    dialog.querySelector('[data-today-action=event-add]').click();
    expect($('[name=date]').value).toBe('2026-11-04');
    $('[name=title]').value = 'Задача на завтра';
    $('[name=kind]').value = 'task';
    $('[data-reference-event]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(state.calendarEvents.at(-1)).toMatchObject({ date: '2026-11-04', title: 'Задача на завтра', kind: 'task' });
    $('[data-today-action=calendar]').click();
    $('[data-today-month="1"]').click();
    expect(dialog.querySelectorAll('[data-today-date]')).toHaveLength(31);
  });
  it('party picker is immediately visible; both buttons delegate to production instead of the mock launcher', async () => {
    expect($('.rt-party-select').closest('details')).toBeNull();
    $('[data-today-action=launch]').click();
    $('[data-today-action=windows]').click();
    await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledWith('launch', { partyId: 'p1' }));
    expect(mocks.actions).toHaveBeenCalledWith('windows', { partyId: 'p1' });
    expect(state.activeWindows).toHaveLength(2);
  });
  it('RSVP is committed only after the production action succeeds, not by clicking in the preview', async () => {
    $('[data-today-vote=training][data-value=yes]').click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(state.referenceVotes).toBeUndefined();
    expect($('[data-today-copy-party]')).not.toBeNull();
  });
  it.each([
    ['2026-11-02', 'expired'],
    ['2026-11-03', 'soon'],
    ['2026-11-05', 'soon'],
    ['2026-11-06', 'active']
  ])('uses the same inclusive promo deadline rules as scripts: %s', (expiresOn, tone) =>
    expect(referencePromoStatus({ expiresOn }, '2026-11-03').tone).toBe(tone)
  );
  it('escapes display values and renders no password controls', () => {
    state.calendarEvents[0].title = '<script>bad()</script>';
    render();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('input[type=password]')).toBeNull();
    expect(root.textContent).toContain('<script>bad()</script>');
  });
});

it('the event stream is chronological rather than shuffled by task priority/status', () => {
  state.calendarEvents = [
    { id: 'later', date: state.day.date, title: 'Позже', time: '20:00', kind: 'event', priority: 'high' },
    { id: 'early', date: state.day.date, title: 'Раньше', time: '10:00', kind: 'event', status: 'done' }
  ];
  const rows = referenceDayEvents(state).filter(e => ['later', 'early'].includes(e.id));
  expect(rows.map(e => e.id)).toEqual(['early', 'later']);
});
it('calendar labels weekdays/dungeons without pass icons and can return to current date', () => {
  $('[data-today-action=calendar]').click();
  expect([...dialog.querySelectorAll('.rt-calendar-weekdays b')].map(e => e.textContent)).toEqual([
    'Пн',
    'Вт',
    'Ср',
    'Чт',
    'Пт',
    'Сб',
    'Вс'
  ]);
  expect(dialog.querySelector('.rt-calendar-grid img')).toBeNull();
  expect(dialog.querySelector('[data-today-date] small').textContent).toMatch(/Оружие|Доспех|Реликвия/);
  $('[data-today-date="2026-11-04"]').click();
  $('[data-today-action=calendar-today]').click();
  expect(state.day.chosenDay).toBe(0);
  expect($('[data-today-date="2026-11-03"]').getAttribute('aria-pressed')).toBe('true');
});
it('independent compact refresh actions replace the combined server button and removed footer', async () => {
  expect($('[data-today-action=news-refresh]').closest('.rt-news')).not.toBeNull();
  expect($('[data-today-action=promo-refresh]').previousElementSibling.dataset.todayAction).toBe('promo');
  expect(root.textContent).not.toContain('Обновить с серверами');
  expect(root.textContent).not.toContain('Подключения этой страницы');
  expect(root.textContent).not.toContain('Источник статуса ввода');
  expect(root.textContent).toContain('Запущено окон');
  $('[data-today-action=news-refresh]').click();
  $('[data-today-action=promo-refresh]').click();
  await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledWith('promo-refresh', { partyId: 'p1' }));
  expect(mocks.actions).toHaveBeenCalledWith('news-refresh', { partyId: 'p1' });
});

it('keeps copy as an accessible icon beside the party event title, without a parties navigation button', () => {
  const copy = $('[data-today-copy-party]');
  expect(copy.closest('.rt-party-heading').querySelector('b')).not.toBeNull();
  expect(copy.getAttribute('aria-label')).toContain('кроме своего');
  expect(copy.querySelector('svg')).not.toBeNull();
  expect($('.rt-clan [data-go-source=parties]')).toBeNull();
});
it('restores the attendance pressed state from the saved response', () => {
  state.guild = { events: [{ id: 'saved', title: 'Сбор', response: 'yes' }], parties: [] };
  render();
  expect($('[data-today-vote=saved][data-value=yes]').getAttribute('aria-pressed')).toBe('true');
  expect($('[data-today-vote=saved][data-value=no]').getAttribute('aria-pressed')).toBe('false');
});
