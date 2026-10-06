import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}), forceRenderAndPersist: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({ getAuthView: (c) => ({ icon: c.isLoggedIn ? '🟢' : '🔴', color: 'red' }) }));
vi.mock('../js/modules/characters/profileView.js', () => ({ openCharacterProfile: vi.fn() }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  syncMarathons: vi.fn(), marathonUrlOf: () => null, SITE_PAGES: [], customPages: () => [], rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(), parseMarathonPage: vi.fn(), pickScannerCharacter: () => null, loadNewsPage: vi.fn(), isNewsUrl: () => false
}));

import { createPartyWith } from '../js/modules/parties/membership.js';
import { phaseHint, daysBetween } from '../js/modules/marathons/dates.js';
import { mskDate, mskAddDays } from '../js/core/msk.js';
import { initStickyHeader } from '../js/core/stickyHeader.js';

describe('создание пати для выбранных персонажей', () => {
  const chars = () => [
    { id: 'a', partyIds: ['p1'], mainPartyId: 'p1', updatedAt: 'old' },
    { id: 'b', partyIds: [], mainPartyId: null, updatedAt: 'old' }
  ];

  it('новая пати становится основной у всех, прежняя основная остаётся дополнительной', () => {
    const parties = [{ id: 'p1', name: 'Старая', order: 1 }];
    const list = chars();
    const res = createPartyWith(parties, list, '  Ферма-2 ', { now: 'NOW' });
    expect(res.party).toMatchObject({ name: 'Ферма-2', order: 2 });
    expect(res.changed).toBe(2);
    expect(parties).toHaveLength(2);
    expect(list[0]).toMatchObject({ mainPartyId: res.party.id, partyIds: ['p1', res.party.id], updatedAt: 'NOW' });
    expect(list[1]).toMatchObject({ mainPartyId: res.party.id, partyIds: [res.party.id] });
  });

  it('режим «дополнительная»: у кого пати была — остаётся основной, у кого нет — становится основной новая', () => {
    const parties = [{ id: 'p1', name: 'Старая', order: 1 }];
    const list = chars();
    const { party } = createPartyWith(parties, list, 'Доп', { asMain: false });
    expect(list[0].mainPartyId).toBe('p1');
    expect(list[0].partyIds).toEqual(['p1', party.id]);
    expect(list[1].mainPartyId).toBe(party.id);
  });

  it('пустое название и повтор названия — ошибка, ничего не меняется', () => {
    const parties = [{ id: 'p1', name: 'Старая', order: 1 }];
    const list = chars();
    expect(createPartyWith(parties, list, '   ').error).toContain('название');
    expect(createPartyWith(parties, list, 'старая').error).toContain('уже существует');
    expect(parties).toHaveLength(1);
    expect(list[1].partyIds).toEqual([]);
  });
});

describe('подпись на карточке марафона', () => {
  it('считает дни и склоняет', () => {
    expect(daysBetween('2026-10-01', '2026-10-04')).toBe(3);
    expect(daysBetween('2026-10-04', '2026-10-01')).toBe(-3);
    const m = { startDate: '2026-09-01', endDate: '2026-10-10' };
    expect(phaseHint(m, '2026-10-05')).toEqual({ text: 'осталось 5 дней', tone: 'info' });
    expect(phaseHint(m, '2026-10-08')).toEqual({ text: 'осталось 2 дня', tone: 'warn' });
    expect(phaseHint(m, '2026-10-09')).toEqual({ text: 'осталось 1 день', tone: 'warn' });
    expect(phaseHint(m, '2026-10-10')).toEqual({ text: 'последний день', tone: 'warn' });
    expect(phaseHint(m, '2026-10-11')).toEqual({ text: 'закончился вчера', tone: 'late' });
    expect(phaseHint(m, '2026-10-21')).toEqual({ text: 'закончился 11 дней назад', tone: 'late' });
    expect(phaseHint(m, '2026-08-31')).toEqual({ text: 'начнётся завтра', tone: 'info' });
    expect(phaseHint(m, '2026-08-20')).toEqual({ text: 'начнётся через 12 дней', tone: 'info' });
  });

  it('у завершённого марафона и без даты окончания подписи нет', () => {
    expect(phaseHint({ status: 'completed', startDate: '2026-09-01', endDate: '2026-10-10' }, '2026-10-05').text).toBe('');
    expect(phaseHint({ startDate: '2026-09-01' }, '2026-10-05').text).toBe('');
  });
});

describe('вкладка «Пати»', () => {
  let state, renderer;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div>';
    ({ state } = await import('../js/core/state.js'));
    renderer = await import('../js/modules/parties/renderer.js');
    state.parties = [{ id: 'p1', name: 'Alpha Strike', order: 1 }, { id: 'p2', name: 'Пустая', order: 2 }];
    state.characters = [
      { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: true, ancientCoins: 100, launch: { gcPath: 'D:\\GC\\GameCenter.exe' } },
      { id: 'b', nick: 'Бб', class: 'Маг', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: false, ancientCoins: 50 },
      { id: 'c', nick: 'Вв', class: 'Лучник', partyIds: [], mainPartyId: null, isLoggedIn: false, ancientCoins: 5 }
    ];
    renderer.renderPartiesGrid();
  });

  it('значок и цвет считаются по названию: стабильно и без падений на пустом', () => {
    expect(renderer.partyInitials('Alpha Strike')).toBe('AS');
    expect(renderer.partyInitials('222')).toBe('22');
    expect(renderer.partyInitials('')).toBe('?');
    expect(renderer.partyHue('Alpha Strike')).toBe(renderer.partyHue('Alpha Strike'));
    expect(renderer.partyHue('Alpha Strike')).toBeGreaterThanOrEqual(0);
    expect(renderer.partyHue('Alpha Strike')).toBeLessThan(360);
  });

  it('карточка на пати, «Без пати» — последняя, у неё нет кнопки настроек', () => {
    const cards = [...document.querySelectorAll('.pt-card')];
    expect(cards.map(c => c.dataset.partyName)).toEqual(['Alpha Strike', 'Пустая', 'Без пати']);
    expect(cards[2].classList.contains('is-none')).toBe(true);
    expect(cards[2].querySelector('.edit-party-action-btn')).toBeNull();
    expect(cards[0].querySelector('.edit-party-action-btn')).not.toBeNull();
    expect(cards[0].getAttribute('style')).toContain('--pt-h:');
  });

  it('в карточке: число людей и онлайн, монеты, запуск x/y, стопка значков', () => {
    const card = document.querySelector('.pt-card[data-party-name="Alpha Strike"]');
    expect(card.querySelector('.pt-sub').textContent).toContain('2 чел.');
    expect(card.querySelector('.pt-sub').textContent).toContain('онлайн 1');
    expect(card.querySelector('.pt-coins').textContent).toContain('150');
    expect(card.querySelector('.launch-party-action-btn').textContent.replace(/\s+/g, ' ')).toContain('1/2');
    expect(card.querySelectorAll('.pt-stack .pt-ava').length).toBe(2);
    expect(card.querySelectorAll('.pt-member').length).toBe(2);
    expect(document.querySelector('.pt-card[data-party-name="Пустая"] .launch-party-action-btn').disabled).toBe(true);
  });

  it('сводка над сеткой: персонажи, пати, монеты', () => {
    const text = document.getElementById('party-summary').textContent;
    expect(text).toContain('Персонажей 3');
    expect(text).toContain('Пати 2');
    expect(text).toContain('155');
  });

  it('клик по заголовку раскрывает и сворачивает список участников', () => {
    const card = document.querySelector('.pt-card[data-party-name="Alpha Strike"]');
    expect(card.classList.contains('is-expanded')).toBe(false);
    card.querySelector('.pt-head').click();
    expect(card.classList.contains('is-expanded')).toBe(true);
    card.querySelector('.pt-head').click();
    expect(card.classList.contains('is-expanded')).toBe(false);
  });

  it('раскрытая карточка остаётся раскрытой после перерисовки', () => {
    document.querySelector('.pt-card[data-party-name="Alpha Strike"] .pt-head').click();
    renderer.renderPartiesGrid();
    expect(document.querySelector('.pt-card[data-party-name="Alpha Strike"]').classList.contains('is-expanded')).toBe(true);
  });
});

describe('вкладка «Марафоны»', () => {
  let state, model, page;
  // Приложение считает дни по Москве, поэтому и тест берёт «сегодня» по МСК, а не по часовому поясу машины
  const day = (offset) => mskAddDays(mskDate(), offset);
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div class="page" data-section="marathons"><div id="marathon-list"></div></div><div id="modal-root"></div>';
    ({ state } = await import('../js/core/state.js'));
    model = await import('../js/modules/marathons/model.js');
    page = await import('../js/modules/marathons/page.js');
    state.characters = [];
  });

  it('пустой список подсказывает про круглую кнопку «+»', () => {
    state.marathons = [];
    page.renderMarathons();
    const text = document.getElementById('marathon-list').textContent;
    expect(text).toContain('Марафонов пока нет');
    expect(text).toContain('«+»');
    expect(text).not.toContain('Создать»');
  });

  it('группы по состоянию, сводка, подпись «осталось …» и папка', () => {
    const active = model.createMarathon({ title: 'Идёт', startDate: day(-3), endDate: day(2), tasks: [] });
    const waiting = model.createMarathon({ title: 'Ждёт', startDate: day(-20), endDate: day(-5), tasks: [] });
    const done = model.createMarathon({ title: 'Готов', startDate: day(-40), endDate: day(-30), tasks: [] });
    done.status = 'completed';
    const folder = model.createSeries({ title: 'Лето', source: { type: 'manual', url: null } });
    state.marathons = [active, waiting, done, folder];
    page.renderMarathons();
    const root = document.getElementById('marathon-list');
    const titles = (sel) => [...root.querySelectorAll(`${sel} .mr-card-title`)].map(e => e.textContent);
    expect(titles('.mr-group-active')).toContain('Идёт');
    expect(titles('.mr-group-active')).toContain('📁Лето');   // пустая папка считается идущей
    expect(root.querySelector('.mr-group-ended .mr-card-title').textContent).toBe('Ждёт');
    expect(root.querySelector('.mr-group-completed')).not.toBeNull();
    expect(root.querySelector('.mr-group-active .mr-card:not(.mr-series) .mr-hint').textContent).toBe('осталось 2 дня');
    expect(root.querySelector('.mr-group-ended .mr-hint').textContent).toBe('закончился 5 дней назад');
    expect(root.querySelector('.mr-series .mr-card-title').textContent).toContain('Лето');
    expect(root.querySelector('.mr-overview').textContent).toContain('заработано');
    expect(document.querySelector('.page[data-section="marathons"]').dataset.view).toBe('list');
    // карточка открывается кликом
    root.querySelector('.mr-group-active .mr-card:not(.mr-series)').click();
    expect(document.querySelector('.page[data-section="marathons"]').dataset.view).toBe('detail');
  });
});

describe('карточка задачи (док)', () => {
  it('идущая задача: кольцо с процентом, кнопка остановки, полоса, счётчик и сообщение о шаге', async () => {
    vi.resetModules();
    vi.doMock('../js/core/state.js', () => ({ state: { characters: [] } }));
    const { startTask, taskCardHtml } = await import('../js/core/taskLog.js');
    const t = startTask('Проверка входа', { total: 10, cancelable: true });
    t.progress(7, 10, 'Ауразак: жду страницу');
    const el = document.createElement('div');
    el.innerHTML = taskCardHtml(t);
    expect(el.querySelector('.tl-card.tl-s-running')).not.toBeNull();
    expect(el.querySelector('.tl-ring').getAttribute('style')).toContain('--p:70');
    expect(el.querySelector('.tl-ring b').textContent).toBe('70%');
    expect(el.querySelector('[data-task-cancel]')).not.toBeNull();
    expect(el.querySelector('.tl-bar span').getAttribute('style')).toContain('width:70%');
    expect(el.querySelector('.tl-chip').textContent).toBe('7/10');
    expect(el.querySelector('.tl-step').textContent).toBe('Ауразак: жду страницу');
    t.finish('Готово', 'warn');
    el.innerHTML = taskCardHtml(t, { closable: true });
    expect(el.querySelector('.tl-card.tl-s-warn')).not.toBeNull();
    expect(el.querySelector('.tl-ring-end')).not.toBeNull();
    expect(el.querySelector('[data-task-cancel]')).toBeNull();
    expect(el.querySelector('[data-task-close]')).not.toBeNull();
    vi.doUnmock('../js/core/state.js');
  });
});

describe('липкая шапка', () => {
  it('высота шапки пишется в --topbar-h и обновляется при изменении', () => {
    document.body.innerHTML = '<header class="topbar"></header>';
    const bar = document.querySelector('.topbar');
    bar.getBoundingClientRect = () => ({ height: 71.2 });
    const stop = initStickyHeader(document);
    expect(document.documentElement.style.getPropertyValue('--topbar-h')).toBe('72px');
    stop();
  });

  it('без шапки ничего не делает', () => {
    document.body.innerHTML = '';
    expect(() => initStickyHeader(document)()).not.toThrow();
  });
});
