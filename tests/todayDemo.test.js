import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAppSnapshot, createDemoState, demoDays, partyInfo, summary } from '../demo/today/data.js';
import {
  demoTodayEvents,
  ensureDemoMarathon,
  isDemoMarathonActive,
  makeDemoAppData,
  makeDemoMarathon
} from '../demo/app/fixtures.js';
import { JSDOM } from 'jsdom';

const html = readFileSync('demo/today/index.html', 'utf8');
const $ = selector => document.querySelector(selector);
const click = selector => {
  const element = $(selector);
  expect(element, selector).not.toBeNull();
  element.click();
};
const change = (selector, value) => {
  const element = $(selector);
  if (element.type === 'checkbox') element.checked = value;
  else element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const submitPoll = () => $('[data-guild-poll]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  const dialog = $('#demo-dialog');
  dialog.showModal = function () {
    this.setAttribute('open', '');
  };
  dialog.close = function () {
    this.removeAttribute('open');
  };
  await import('../demo/today/today.js');
});

beforeEach(() => {
  click('#reset-demo');
  click('[data-variant="overview"]');
});

afterAll(() => vi.restoreAllMocks());

describe('вымышленные данные демо', () => {
  it('суммы и статусы согласованы со списком персонажей и пати', () => {
    expect(summary()).toMatchObject({ characters: 8, online: 5, offline: 2, checking: 1, parties: 3, coins: 7160 });
    expect(partyInfo('p2')).toMatchObject({ label: 'Пати «Комета»', online: 2 });
    expect(partyInfo('p2').members).toHaveLength(3);
  });

  it('показывает в сводке повторяющиеся события в их текущий день', () => {
    const app = makeDemoAppData();
    app.plannerEntries = [
      {
        id: 'daily',
        title: 'Ежедневная встреча',
        date: '2026-10-27',
        recurrence: 'daily',
        kind: 'event',
        time: '20:00',
        color: 'blue'
      },
      { id: 'task', title: 'Дело', date: '2026-10-28', recurrence: 'none', kind: 'task', time: '', color: 'green' },
      { id: 'future', title: 'Завтра', date: '2026-10-29', recurrence: 'none', kind: 'event', time: '', color: 'blue' }
    ];
    expect(demoTodayEvents(app, '2026-10-28')).toEqual([
      { id: 'daily', title: 'Ежедневная встреча', time: '20:00', color: 'blue' }
    ]);
  });

  it('ежедневное задание считает по существующему циклу и московской дате', () => {
    const state = createDemoState(new Date('2026-10-28T12:00:00Z'));
    expect(state.date).toBe('2026-10-28');
    expect(demoDays(state.date).map(day => day.key)).toEqual(['armor', 'relic', 'weapon', 'armor', 'relic']);
  });
});

describe('демо страницы «Сегодня»', () => {
  it('показывает три разных переключаемых варианта с общей сводкой, событиями и кланом', () => {
    for (const variant of ['overview', 'day', 'workspace']) {
      click(`[data-variant="${variant}"]`);
      const root = $(`[data-view="${variant}"]`);
      expect(root).not.toBeNull();
      expect(root.textContent).toContain('Персонажи');
      expect(root.textContent).toContain('Марафон');
      expect(root.textContent).toContain('События');
      expect(root.textContent).toContain('Eternals');
      expect(root.querySelector('[data-guild-poll]')).not.toBeNull();
      expect($(`#tab-${variant}`).getAttribute('aria-selected')).toBe('true');
    }
  });

  it('по отдельности прячет опрос, клан и активный марафон во всех вариантах', () => {
    change('#poll-toggle', false);
    expect($('[data-clan-panel]')).not.toBeNull();
    expect($('.guild-poll')).toBeNull();
    change('#clan-toggle', false);
    expect($('[data-clan-panel]')).toBeNull();
    expect($('#poll-toggle').disabled).toBe(true);
    change('#marathon-toggle', false);
    for (const variant of ['overview', 'day', 'workspace']) {
      click(`[data-variant="${variant}"]`);
      expect($('[data-clan-panel]')).toBeNull();
      expect($('[data-view]').textContent).toMatch(/нет активн/i);
    }
    change('#clan-toggle', true);
    expect($('[data-clan-panel]')).not.toBeNull();
    expect($('.guild-poll')).toBeNull();
    change('#poll-toggle', true);
    expect($('.guild-poll')).not.toBeNull();
  });

  it('позволяет выбирать любую из пати и безопасно имитировать её запуск', () => {
    change('[data-party-select]', 'p2');
    click('[data-open-section="launch"]');
    expect($('#demo-dialog').open).toBe(true);
    expect($('#demo-dialog').textContent).toContain('Комета');
    expect($('#demo-dialog').textContent).toContain('окна игры не запускаются');
    click('[data-confirm-launch]');
    expect($('#demo-dialog').open).toBe(false);
    expect($('.t-party-note').textContent).toContain('Имитация запуска выполнена');
    click('[data-variant="workspace"]');
    expect($('[data-party-select]').value).toBe('p2');
    click('[data-open-section="parties"]');
    expect($('#replica-frame').hidden).toBe(false);
    expect($('[data-nav-section="parties"]').getAttribute('aria-current')).toBe('page');
    click('[data-variant="workspace"]');
    expect($('[data-party-select]').value).toBe('p2');
    change('[data-party-select]', 'p3');
    expect($('[data-party-select]').value).toBe('p3');
  });

  it('запоминает ответы клана и голос между вариантами и при временном скрытии', () => {
    click('[data-clan-event="clan-1"][data-response="yes"]');
    submitPoll();
    expect($('#demo-toast').textContent).toContain('Выберите вариант');
    change('[data-guild-poll] input[value="502"]', true);
    submitPoll();
    expect($('#demo-toast').textContent).toContain('на сайт он не отправлен');
    click('[data-variant="day"]');
    expect($('[data-clan-event="clan-1"][data-response="yes"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-guild-poll] input[value="502"]').checked).toBe(true);
    change('#clan-toggle', false);
    change('#clan-toggle', true);
    expect($('[data-guild-poll] input[value="502"]').checked).toBe(true);
    const links = [...$('[data-guild-poll]').closest('[data-clan-panel]').querySelectorAll('a')];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.every(link => link.target === '_blank' && link.rel.includes('noopener'))).toBe(true);
  });

  it('в плане дня можно отметить дело и посмотреть ежедневное задание на другой день', () => {
    click('[data-variant="day"]');
    change('[data-task="party"]', true);
    expect($('[data-task="party"]').checked).toBe(true);
    expect($('.t-page-title .t-badge').textContent).toContain('2 из 3');
    click('[data-day="2"]');
    expect($('[data-day="2"]').getAttribute('aria-pressed')).toBe('true');
    click('[data-variant="overview"]');
    expect($('.t-dungeon-body small').textContent).toBe('ДАНЖ ДНЯ');
    click('[data-variant="day"]');
    expect($('.t-dungeon-body small').textContent).toBe('ВЫБРАННЫЙ ДЕНЬ');
    expect($('[data-day="2"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-task="party"]').checked).toBe(true);
  });

  it('поддерживает переключение вкладок стрелками клавиатуры', () => {
    $('#tab-overview').focus();
    $('#tab-overview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect($('[data-view="day"]')).not.toBeNull();
    expect(document.activeElement).toBe($('#tab-day'));
    expect($('#today-panel').getAttribute('aria-labelledby')).toBe('tab-day');
  });

  it('не отправляет запросы и не сохраняет изменения приложения', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    click('[data-open-section="refresh"]');
    click('[data-clan-event="clan-1"][data-response="no"]');
    click('[data-open-section="launch"]');
    click('[data-confirm-launch]');
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    fetch.mockRestore();
    setItem.mockRestore();
  });
});

describe('полные копии разделов', () => {
  const frame = () => $('#replica-frame');
  const message = (data, { source = frame().contentWindow, origin = 'null' } = {}) => {
    window.dispatchEvent(new MessageEvent('message', { source, origin, data }));
  };
  const snapshot = overrides => ({
    characters: [{ id: 'new-1', nick: 'Новая', className: 'Маг', party: 'new-p', isLoggedIn: true, coins: 500 }],
    parties: [{ id: 'new-p', name: 'Новая пати' }],
    events: [{ id: 'ev', title: 'Новое событие', time: '12:30', color: 'blue' }],
    marathon: { title: 'Новый марафон', days: 3, percent: 42 },
    bank: 1234,
    clanEnabled: true,
    pollEnabled: true,
    ...overrides
  });

  it('открывает все восемь страниц в одном постоянно смонтированном iframe', () => {
    const sameFrame = frame();
    for (const page of ['characters', 'parties', 'marathons', 'runes', 'bank', 'tools', 'settings']) {
      click(`[data-nav-section="${page}"]`);
      expect(frame()).toBe(sameFrame);
      expect(frame().hidden).toBe(false);
      expect($('#today-screen').hidden).toBe(true);
      expect($(`[data-nav-section="${page}"]`).getAttribute('aria-current')).toBe('page');
    }
    click('[data-variant="original"]');
    expect(frame()).toBe(sameFrame);
    expect(frame().hidden).toBe(false);
    expect($('#tab-original').getAttribute('aria-selected')).toBe('true');
    click('[data-variant="overview"]');
    expect(frame().hidden).toBe(true);
    expect($('#today-screen').hidden).toBe(false);
    expect($('[data-nav-section="today"]').getAttribute('aria-current')).toBe('page');
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals');
  });

  it('передаёт сценарии и навигацию только после готовности копии', () => {
    const post = vi.spyOn(frame().contentWindow, 'postMessage');
    click('[data-nav-section="characters"]');
    expect(post).not.toHaveBeenCalled();
    message({ type: 'tf-demo:ready' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'tf-demo:scenarios', clanEnabled: true }), '*');
    expect(post).toHaveBeenCalledWith({ type: 'tf-demo:navigate', section: 'characters' }, '*');
    click('[data-nav-section="bank"]');
    expect(post).toHaveBeenCalledWith({ type: 'tf-demo:navigate', section: 'finance' }, '*');
    change('#poll-toggle', false);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'tf-demo:scenarios', pollEnabled: false }),
      '*'
    );
    post.mockRestore();
  });

  it('принимает сводку только из собственного iframe и отображает изменения во всех вариантах', () => {
    message({ type: 'tf-demo:ready' });
    message({ type: 'tf-demo:snapshot', snapshot: snapshot() }, { source: window });
    expect($('[data-view="overview"]').textContent).toContain('8 персонажей');
    message({ type: 'tf-demo:snapshot', snapshot: snapshot() }, { origin: 'https://wrong.example' });
    expect($('[data-view="overview"]').textContent).toContain('8 персонажей');
    message({ type: 'tf-demo:snapshot', snapshot: snapshot() });
    expect($('[data-view="overview"]').textContent).toContain('1 персонажей');
    expect($('[data-view="overview"]').textContent).toContain('Новое событие');
    expect($('[data-view="overview"]').textContent).toContain('Новый марафон');
    expect($('[data-party-select]').textContent).toContain('Новая пати');
    click('[data-variant="workspace"]');
    expect($('[data-view="workspace"]').textContent).toContain('1 234');
    expect($('[data-view="workspace"]').textContent).toContain('42%');
    message({ type: 'tf-demo:navigated', section: 'settings' });
    expect($('[data-nav-section="settings"]').getAttribute('aria-current')).toBe('page');
    message({ type: 'tf-demo:navigated', section: 'today' });
    expect($('#tab-original').getAttribute('aria-selected')).toBe('true');
  });

  it('не теряет фокус и ещё не отправленный выбор опроса при обновлении сводки', () => {
    message({ type: 'tf-demo:ready' });
    const input = $('[data-guild-poll] input[value="502"]');
    input.checked = true;
    input.focus();
    message({ type: 'tf-demo:snapshot', snapshot: snapshot() });
    expect($('[data-guild-poll] input[value="502"]').checked).toBe(true);
    expect(document.activeElement).toBe($('[data-guild-poll] input[value="502"]'));
  });

  it('справляется с пустыми данными и экранирует новые значения', () => {
    message({ type: 'tf-demo:ready' });
    message({
      type: 'tf-demo:snapshot',
      snapshot: snapshot({ characters: [], parties: [], events: [], marathon: null })
    });
    expect($('[data-view="overview"]').textContent).toContain('Событий в примере пока нет');
    expect($('[data-party-select]').textContent).toContain('Пока нет пати');
    expect($('[data-open-section="launch"]').disabled).toBe(true);
    expect($('.t-party-members').textContent).toContain('0 участника');
    message({
      type: 'tf-demo:snapshot',
      snapshot: snapshot({
        characters: [{ id: '1', nick: '<img src=x onerror=alert(1)>', className: '__proto__', coins: 0 }],
        events: [{ title: '<script>alert(1)</script>', time: '<b>12</b>', color: 'blue' }],
        marathon: { title: '<img src=x>', days: '<img src=x>', percent: '<img src=x>' }
      })
    });
    expect($('#today-screen img[src="x"], #today-screen script')).toBeNull();
    expect($('#today-screen').textContent).toContain('<script>alert(1)</script>');
  });

  it('отбрасывает повреждённые снимки и нормализует данные перед рендером', () => {
    const state = createDemoState();
    expect(applyAppSnapshot(state, snapshot({ characters: [null] }))).toBe(false);
    expect(summary(state).characters).toBe(8);
    expect(
      applyAppSnapshot(
        state,
        snapshot({ marathon: { title: 'М', days: -1, percent: 500 }, clanEnabled: false, pollEnabled: false })
      )
    ).toBe(true);
    expect(state.marathon).toEqual({ title: 'М', days: 0, percent: 100 });
    expect(state.clanEnabled).toBe(false);
    expect(state.pollEnabled).toBe(false);
  });

  it('включает действующий марафон без потери старых и с актуальным составом', () => {
    const old = makeDemoMarathon('2026-10-01');
    old.status = 'completed';
    const future = makeDemoMarathon('2026-12-01', [], 'future');
    const marathons = [old, future];
    const current = ensureDemoMarathon(marathons, [{ id: 'new-character' }], '2026-10-28');
    expect(current.id).toBe('demo-marathon-2');
    expect(current.participantIds).toEqual(['new-character']);
    expect(isDemoMarathonActive(current, '2026-10-28')).toBe(true);
    expect(marathons).toHaveLength(3);
    expect(ensureDemoMarathon(marathons, [], '2026-10-28')).toBe(current);
    expect(marathons).toHaveLength(3);
  });

  it('заполняет копию вымышленными сущностями в настоящей схеме', () => {
    const data = makeDemoAppData(new Date('2026-10-28T12:00:00Z'));
    expect(data.characters).toHaveLength(8);
    expect(data.parties).toHaveLength(3);
    expect(data.characters.every(c => !c.contacts.email && !c.contacts.password)).toBe(true);
    expect(data.marathons).toHaveLength(1);
    expect(data.plannerEntries.every(event => event.date === '2026-10-28')).toBe(true);
    expect(data.settings.guild.poll.options).toHaveLength(2);
  });
});

describe('защита снимка приложения', () => {
  it('подключает guard до приложения и запрещает сеть и отправку форм политикой CSP', () => {
    const appHtml = readFileSync('demo/app/index.html', 'utf8');
    expect(appHtml.indexOf('demo/app/guard.js')).toBeLessThan(appHtml.indexOf('demo/app/bootstrap.js'));
    expect(appHtml).toContain("connect-src 'none'");
    expect(appHtml).toContain("form-action 'none'");
    expect($('#replica-frame').getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('останавливает запуск, если изоляцию нельзя установить', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    Object.defineProperty(w, 'sessionStorage', { value: w.sessionStorage, configurable: false });
    vi.spyOn(w.console, 'error').mockImplementation(() => {});
    w.eval(readFileSync('demo/app/guard.js', 'utf8'));
    expect(w.__DEMO_GUARD_READY__).toBe(false);
    dom.window.close();
  });

  it('заменяет реальные хранилища и блокирует сеть, файлы, буфер и внешние ссылки', async () => {
    const dom = new JSDOM('<!doctype html><body><a href="https://pwonline.ru/">ссылка</a><input type="file"></body>', {
      url: 'https://example.test/Tvinoferma/demo/app/index.html',
      runScripts: 'outside-only'
    });
    const w = dom.window;
    const actualStorage = w.localStorage;
    actualStorage.setItem('tvinoferma_state_v1', 'реальные данные');
    w.eval(readFileSync('demo/app/guard.js', 'utf8'));
    expect(w.__DEMO_GUARD_READY__).toBe(true);
    expect(w.localStorage.getItem('tvinoferma_state_v1')).toBeNull();
    w.localStorage.setItem('tvinoferma_state_v1', 'демо');
    expect(actualStorage.getItem('tvinoferma_state_v1')).toBe('реальные данные');
    expect(w.__TAURI_INTERNALS__).toBeUndefined();
    expect(w.indexedDB).toBeUndefined();
    await expect(w.fetch('https://pwonline.ru/')).rejects.toThrow('отключены');
    await expect(w.navigator.clipboard.writeText('secret')).rejects.toThrow('отключён');
    expect(w.document.execCommand('copy')).toBe(false);
    expect(
      w.document.querySelector('a').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))
    ).toBe(false);
    expect(
      w.document.querySelector('input').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))
    ).toBe(false);
    dom.window.close();
  });
});

describe('состав окон инструментов', () => {
  it('подхватывает текущих персонажей и пати из копии', async () => {
    const { CHARS, PARTIES, setLabRoster, targetChars } = await import('../demo/lab-data.js');
    const oldChars = [...CHARS],
      oldParties = [...PARTIES];
    try {
      setLabRoster(
        [
          { id: 'new', nick: 'Новый', class: 'Маг', mainPartyId: 'party', isLoggedIn: true },
          { id: 'offline', nick: 'Второй', class: 'Воин', mainPartyId: '', isLoggedIn: false }
        ],
        [{ id: 'party', name: 'Новая пати' }]
      );
      expect(CHARS.map(c => c.nick)).toEqual(['Новый', 'Второй']);
      expect(PARTIES).toEqual(['Новая пати']);
      expect(targetChars({ mode: 'party', parties: new Set(['Новая пати']) }).map(c => c.id)).toEqual(['new']);
      expect(CHARS.every(c => /^site-[1-5]$/.test(c.account))).toBe(true);
    } finally {
      CHARS.splice(0, CHARS.length, ...oldChars);
      PARTIES.splice(0, PARTIES.length, ...oldParties);
    }
  });
});
