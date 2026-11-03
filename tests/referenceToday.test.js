import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLabState, launchParty } from '../demo/design-lab/model.js';
import {
  renderReferenceToday,
  bindReferenceToday,
  referenceDayEvents,
  referenceGameEvents,
  referencePromoStatus
} from '../demo/design-lab/referenceToday.js';
const $ = s => document.querySelector(s);
let state, root, dialog, render, toast;
beforeEach(() => {
  document.body.innerHTML = '<main id="root"></main><dialog id="dialog"></dialog>';
  state = createLabState();
  state.day.date = '2026-11-03';
  state.calendarEvents = [{ date: state.day.date, time: '20:00', title: 'Личный сбор' }];
  state.day.promos = [{ code: 'EXAMPLE', expiresOn: '2026-11-05', entered: [] }];
  root = $('#root');
  dialog = $('#dialog');
  render = () => {
    root.innerHTML = renderReferenceToday(state);
  };
  toast = vi.fn();
  dialog.close = () => dialog.removeAttribute('open');
  const modal = (title, body, footer = '') => {
    dialog.innerHTML = `<h2>${title}</h2>${body}${footer}`;
    dialog.setAttribute('open', '');
  };
  bindReferenceToday({ root, dialog, getState: () => state, render, modal, toast, launchParty });
  render();
});
const submit = form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
describe('Today 12 annotated reference', () => {
  it('has the requested arrangement, existing pass assets, no inline month calendar, and an optional clan banner', () => {
    expect($('.rt-left .rt-news')).not.toBeNull();
    expect($('.rt-left .rt-today')).not.toBeNull();
    expect($('.rt-right .rt-promos')).not.toBeNull();
    expect($('.rt-right .rt-marathon')).not.toBeNull();
    expect($('.rt-launch')).not.toBeNull();
    expect($('.rt-clan')).not.toBeNull();
    expect(root.querySelectorAll('.rt-week button')).toHaveLength(7);
    expect([...root.querySelectorAll('.rt-pass-legend img')].map(i => i.getAttribute('src'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('pass-weapon.webp'),
        expect.stringContaining('pass-armor.webp'),
        expect.stringContaining('pass-relic.webp')
      ])
    );
    expect(root.querySelector('.lg-month')).toBeNull();
    expect(root.textContent).toContain('не свежая онлайн-лента');
    state.scenarios.clan = false;
    render();
    expect($('.rt-clan').textContent).toContain('Зайти в кланнер');
    expect($('.rt-clan').textContent).not.toContain('ГвГ · защита');
  });
  it('reuses real weekly calendar rules and does not show another date’s personal events', () => {
    state.day.chosenDay = 1;
    const events = referenceDayEvents(state);
    expect(events.some(e => e.title === 'Ритм Гильдии')).toBe(true);
    expect(events.some(e => e.title === 'Запретное учение')).toBe(true);
    expect(events.some(e => e.title === 'Личный сбор')).toBe(false);
    expect(events.map(e => e.time)).toContain('19:30–19:59');
  });
  it.each([
    ['2026-11-02', 'expired'],
    ['2026-11-03', 'soon'],
    ['2026-11-06', 'soon'],
    ['2026-11-07', 'active']
  ])('inclusive expiry %s has %s tone', (expiresOn, tone) =>
    expect(referencePromoStatus({ expiresOn }, '2026-11-03').tone).toBe(tone)
  );
  it('manual codes from other sources, multiple active codes, duplicate prevention, hide and restore', () => {
    $('[data-today-action=promo-add]').click();
    $('[name=code]').value = 'TELEGRAM';
    $('[name=expiresOn]').value = '2026-11-10';
    $('[name=reward]').value = 'Учебные награды';
    submit($('[data-reference-promo]'));
    expect(state.day.promos).toHaveLength(2);
    expect($('.rt-promos').textContent).toContain('TELEGRAM');
    $('[data-today-hide="1"]').click();
    expect(root.querySelectorAll('.rt-promo')).toHaveLength(1);
    $('[data-today-action=promo-restore]').click();
    $('[data-today-restore="1"]').click();
    expect(root.querySelectorAll('.rt-promo')).toHaveLength(2);
    $('[data-today-action=promo-add]').click();
    $('[name=code]').value = 'telegram';
    $('[name=expiresOn]').value = '2026-11-10';
    submit($('[data-reference-promo]'));
    expect(state.day.promos).toHaveLength(2);
    state.day.promos.push({ code: 'THIRD', expiresOn: '2026-11-11' });
    render();
    expect(root.querySelectorAll('.rt-promo')).toHaveLength(3);
  });
  it('launch-missing scopes to unopened party members and never duplicates windows', () => {
    expect(state.activeWindows).toHaveLength(2);
    $('[data-today-action=launch-missing]').click();
    expect([...dialog.querySelectorAll('[name=rt-launch]')].map(e => e.value)).toEqual(['c3']);
    $('[data-today-confirm-launch]').click();
    expect(state.activeWindows).toHaveLength(3);
    $('[data-today-action=launch-missing]').click();
    expect(dialog.querySelector('[data-today-confirm-launch]')).toBeNull();
    expect(state.activeWindows).toHaveLength(3);
  });
  it('an empty launch does nothing and an archive is not a launch candidate', () => {
    state.characters[2].archived = true;
    $('[data-today-action=launch-all]').click();
    expect(dialog.querySelectorAll('[name=rt-launch]')).toHaveLength(2);
    dialog.querySelectorAll('[name=rt-launch]').forEach(e => {
      e.checked = false;
    });
    $('[data-today-confirm-launch]').click();
    expect(state.activeWindows).toHaveLength(2);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Никто не выбран'));
  });
  it('clan attendance decisions are independent and switching to the empty state does not lose them', () => {
    $('[data-today-vote=training][data-value="Пойду"]').click();
    $('[data-today-vote=defence][data-value="Не пойду"]').click();
    expect(state.referenceVotes).toEqual({ training: 'Пойду', defence: 'Не пойду' });
    state.scenarios.clan = false;
    render();
    $('[data-today-action=clan-open]').click();
    $('[data-today-action=clan-demo]').click();
    expect($('[data-today-vote=training][data-value="Пойду"]').getAttribute('aria-pressed')).toBe('true');
  });
  it('event details explain their action and the calendar opens only on demand', () => {
    $('[data-today-event="0"]').click();
    expect(dialog.textContent).toContain('Личный сбор');
    expect(dialog.textContent).toContain('не запускает игру');
    $('[data-today-action=calendar]').click();
    expect(dialog.textContent).toContain('День в календаре');
    expect(root.querySelector('.lg-month')).toBeNull();
    root.querySelector('[data-today-action=event-add]').click();
    $('[name=title]').value = 'Новый сбор';
    submit($('[data-reference-event]'));
    expect($('.rt-events').textContent).toContain('Новый сбор');
  });
  it('untrusted display values are text, not HTML; no password inputs or native actions', () => {
    state.day.promos[0].code = '<img src=x onerror=alert(1)>';
    state.calendarEvents[0].title = '<script>bad()</script>';
    render();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img[onerror]')).toBeNull();
    expect(root.textContent).toContain('<script>bad()</script>');
    expect(root.querySelector('input[type=password]')).toBeNull();
    expect(root.querySelector('[data-go-source=marathons]')).not.toBeNull();
  });
});

it('shows all five requested game-event categories and opens an explanatory card, without inventing unknown hours', () => {
  const rows = referenceGameEvents(state);
  expect(rows.map(e => e.title)).toEqual([
    'Битва Династий',
    'Императорская битва',
    'Арена Авроры',
    'ГвГ · клановые бои',
    'Башня'
  ]);
  expect(rows[0].time).toBe('20:20–22:20');
  expect(rows[1].time).toBe('Время уточняется');
  $('[data-today-game-event="1"]').click();
  expect(dialog.textContent).toContain('Это карточка события, не запуск');
});
