import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог «Активация подарков» (покупка за Древние монеты) и вид «Подарки» в «Настройки → Журналы»
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(async () => true), toast: vi.fn(), refresh: vi.fn(), rerender: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../js/modules/sync/syncManager.js', () => ({
  scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }), refreshAllBalances: mocks.refresh, rerenderLists: mocks.rerender
}));
vi.mock('../js/modules/sync/queue.js', async (orig) => ({ ...(await orig()), sleep: async () => {} }));   // без реальных пауз
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const wait = (ms = 300) => new Promise(r => setTimeout(r, ms));
const nicks = () => $$('tr.shop-row').map(r => r.querySelector('b').textContent);
const rowOf = (nick) => $$('tr.shop-row').find(r => r.querySelector('b').textContent === nick);
const qtyInput = (nick, key) => rowOf(nick).querySelector(`[data-qty$="|${key}"]`);
const type = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
const clickFoot = async (act, ms = 600) => { document.querySelector(`.tf-dialog-foot [data-act="${act}"]`).click(); await wait(ms); };

const WANTED = ['Камень светлого духа', 'Камень асуров', 'Камень лагеря', 'Камень государя', 'Знак доблести (25 штук)', 'Знак единства (25 штук)', 'Сундук средоточия', 'Ключ от Книги наставлений'];
const ACCOUNT_OF = { a: 'U2', b: 'U1', c: 'U1' };       // «Бб» и «Вв» — один аккаунт сайта, «Аа» — другой
let site;                                               // модель сайта: у каждого аккаунта баланс и остаток лимитов
let state, openShopDialog, store, core, mountLogHub;

const freshSite = () => ({
  U1: { balance: 54, left: { light: 4, asura: 0, camp: 4, sovereign: 4 } },
  U2: { balance: 5, left: { light: 4, asura: 4, camp: 4, sovereign: 4 } }
});
const DEF = {
  'Камень светлого духа': { key: 'light', id: '1', price: 40, desc: 'Описание:Камень для инкрустации' },
  'Камень асуров': { key: 'asura', id: '2', price: 40, desc: '' },
  'Камень лагеря': { key: 'camp', id: '3', price: 40, desc: '' },
  'Камень государя': { key: 'sovereign', id: '4', price: 40, desc: '' },
  'Знак доблести (25 штук)': { key: 'valor', id: '479', price: 10, chest: true, desc: 'Активировав сундучок, вы получите: Знак доблести x 25' },
  'Знак единства (25 штук)': { key: 'unity', id: '480', price: 10, chest: true, desc: '' }
};
const rawItem = (acc, want) => {
  const d = DEF[want];
  if (!d) return { want, found: false, ambiguous: false };
  const left = d.chest ? null : site[acc].left[d.key];
  return { want, found: true, name: want.replace(/ \(.*\)$/, ''), id: d.id, kind: d.chest ? 'chest' : 'item', price: d.price, available: left, max: null, blocked: left === 0, hasLink: true, label: d.chest ? 'Открыть' : 'Купить', desc: d.desc, image: '' };
};
const scanPayload = (acc) => ({ status: 'ok', account: `acc_${acc}`, balance: site[acc].balance, items: WANTED.map(w => rawItem(acc, w)) });

const chars = () => [
  { id: 'a', nick: 'Аа', isLoggedIn: true, ancientCoins: 5 },
  { id: 'b', nick: 'Бб', ancientCoins: 0 },
  { id: 'c', nick: 'Вв', isLoggedIn: true, ancientCoins: 0 }
];

/** Магазин считается известным: Бб и Вв уже привязаны к одному аккаунту. */
const prefill = () => {
  store.saveScan(['b', 'c'], core.normalizeScan(scanPayload('U1')), new Date());
  store.saveScan(['a'], core.normalizeScan(scanPayload('U2')), new Date());
};

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  site = freshSite();
  mocks.invoke.mockReset().mockImplementation(async (cmd, args) => {
    const acc = ACCOUNT_OF[args.charId];
    if (cmd === 'read_shop') return scanPayload(acc);
    if (cmd === 'read_shop_history') return { status: 'ok', rows: [] };
    if (cmd === 'buy_shop_item') {
      const d = DEF[args.item];
      const s = site[acc];
      if (!d.chest && s.left[d.key] === 0) return { status: 'limit_reached', clicked: false };
      if (s.balance < d.price) return { status: 'no_funds', clicked: false };
      s.balance -= d.price;
      if (!d.chest) s.left[d.key] -= 1;
      return { status: 'success', clicked: true, balanceAfter: s.balance, items: WANTED.map(w => rawItem(acc, w)) };
    }
    throw new Error(`неожиданная команда ${cmd}`);
  });
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  mocks.rerender.mockReset();
  mocks.refresh.mockReset().mockImplementation(async (list) => {
    list.forEach(c => { c.ancientCoins = site[ACCOUNT_OF[c.id]].balance; c.lastCoinUpdate = new Date().toISOString(); });
    return { updated: list.length, failed: 0 };
  });
  document.body.innerHTML = '<div id="modal-root"></div><div id="log-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = chars();
  state.parties = [];
  core = await import('../js/modules/automation/shopCore.js');
  store = await import('../js/modules/automation/shopStore.js');
  ({ openShopDialog } = await import('../js/modules/automation/shop.js'));
  ({ mountLogHub } = await import('../js/core/logHub.js'));
});

describe('окно: предметы', () => {
  it('8 карточек в заданном порядке; цены и описание с сайта; описание вне подписи с галочкой', async () => {
    openShopDialog();
    await wait();
    const cards = $$('.shop-card');
    expect(cards.map(c => c.querySelector('b').textContent)).toEqual(WANTED);
    expect($('[data-card="valor"] .shop-price').textContent).toBe('10 мон. за сундук');
    expect($('[data-card="light"] .shop-price').textContent).toBe('40 мон.');
    const desc = $('[data-card="valor"] .shop-desc');
    expect(desc.textContent).toContain('вы получите');
    expect(desc.closest('label')).toBeNull();
    expect($('.tf-dialog-title').textContent).toContain('🪙');
  });

  it('ивентовых предметов нет на сайте: карточки заблокированы, видно прежнюю цену', async () => {
    openShopDialog();
    await wait();
    expect($('[data-card="focus"]').classList.contains('shop-locked')).toBe(true);
    expect($('[data-item="focus"]').disabled).toBe(true);
    expect($('[data-card="focus"] .shop-price').textContent).toContain('раньше 30 монет');
    expect($('[data-card="guide"] .shop-price').textContent).toContain('раньше 50 монет');
    expect($('[data-item="valor"]').disabled).toBe(false);
  });

  it('если ивентовый предмет появился на сайте — он доступен', async () => {
    DEF['Сундук средоточия'] = { key: 'focus', id: '303', price: 10, chest: true, desc: '' };
    try {
      openShopDialog();
      await wait();
      expect($('[data-item="focus"]').disabled).toBe(false);
      expect($('[data-card="focus"] .shop-price').textContent).toBe('10 мон. за сундук');
    } finally { delete DEF['Сундук средоточия']; }
  });

  it('лимит исчерпан: счётчик у карточки и «лимит исчерпан» в ячейке аккаунта', async () => {
    prefill();
    openShopDialog();
    await wait();
    expect($('[data-card="asura"]').textContent).toContain('лимит исчерпан у 1 из 2');
    $('[data-item="asura"]').click();
    expect(rowOf('Вв').textContent).toContain('лимит исчерпан');
    expect(qtyInput('Вв', 'asura')).toBeNull();
    expect(qtyInput('Аа', 'asura')).not.toBeNull();
  });
});

describe('окно: ход проверки на сайте', () => {
  it('пока идёт проверка — проценты готовности и полоса; по окончании — «Данные с сайта»', async () => {
    const gates = [];
    const base = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((cmd, args) => (cmd === 'read_shop'
      ? new Promise(res => { gates.push(() => res(scanPayload(ACCOUNT_OF[args.charId]))); })
      : base(cmd, args)));
    openShopDialog();
    await wait();
    expect(gates).toHaveLength(3);
    expect($('#shop-scan').textContent).toContain('0%');
    expect($('#shop-scan .shop-bar')).not.toBeNull();
    gates[0]();
    await wait();
    expect($('#shop-scan').textContent).toContain('33%');
    expect($('#shop-scan').textContent).toContain('1 из 3');
    gates[1](); gates[2]();
    await wait();
    expect($('#shop-scan').textContent).toContain('Данные с сайта');
    expect($('#shop-scan .shop-bar')).toBeNull();
  });
});

describe('окно: аккаунты', () => {
  it('аккаунт один раз: известные члены одного аккаунта — одна строка, читается один представитель', async () => {
    prefill();
    openShopDialog();
    await wait();
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_shop')).toHaveLength(2);
    expect($$('tr.shop-row')).toHaveLength(2);
    expect(rowOf('Вв').textContent).toContain('также: Бб');
    expect(rowOf('Вв').textContent).toContain('54');
  });

  it('неизвестные аккаунты после чтения объединяются', async () => {
    openShopDialog();
    await wait();
    expect($$('tr.shop-row')).toHaveLength(2);
    expect(store.charSiteMap().b).toBe(store.charSiteMap().c);
  });

  it('способные купить — выше, не способные (5 монет, самый дешёвый предмет 10) — ниже, хотя «Аа» по алфавиту первый', async () => {
    prefill();
    openShopDialog();
    await wait();
    expect(nicks()).toEqual(['Вв', 'Аа']);
  });

  it('внутри групп — по балансу: чем меньше монет, тем ниже (а не по алфавиту)', async () => {
    state.characters.push({ id: 'd', nick: 'Яя', isLoggedIn: true, ancientCoins: 0 });
    ACCOUNT_OF.d = 'U3';
    site.U3 = { balance: 20, left: { light: 4, asura: 4, camp: 4, sovereign: 4 } };
    try {
      prefill();
      openShopDialog();
      await wait();
      expect(nicks()).toEqual(['Вв', 'Яя', 'Аа']);          // 54, 20, и 5 монет — ниже всех
    } finally { delete ACCOUNT_OF.d; }
  });

  it('без входа: внизу, отметить нельзя, сайт не читается', async () => {
    state.characters.push({ id: 'z', nick: 'Яя', isLoggedIn: false, ancientCoins: 3 });
    ACCOUNT_OF.z = 'U2';
    try {
      openShopDialog();
      await wait();
      expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_shop').every(c => c[1].charId !== 'z')).toBe(true);
      const last = $$('tr.shop-row').at(-1);
      expect(last.querySelector('b').textContent).toBe('Яя');
      expect(last.textContent).toContain('нет входа');
      expect(last.querySelector('[data-sel]').disabled).toBe(true);
    } finally { delete ACCOUNT_OF.z; }
  });

  it('фильтр по пати: все / без пати / конкретная; поиск', async () => {
    state.parties = [{ id: 'p1', name: 'Основа' }];
    state.characters[1].partyIds = ['p1'];            // «Бб» и «Вв» (один аккаунт) — в пати, «Аа» — без пати
    state.characters[2].partyIds = ['p1'];
    prefill();
    openShopDialog();
    await wait();
    const opts = $$('#shop-party option').map(o => o.textContent);
    expect(opts).toEqual(['Все пати', 'Без пати', 'Основа']);
    const pick = (v) => { $('#shop-party').value = v; $('#shop-party').dispatchEvent(new Event('change', { bubbles: true })); };
    pick('p1');
    expect(nicks()).toEqual(['Вв']);
    pick('__none__');
    expect(nicks()).toEqual(['Аа']);
    pick('');
    expect(nicks()).toEqual(['Вв', 'Аа']);
    type($('#shop-search'), 'основа');
    expect(nicks()).toEqual(['Вв']);
    type($('#shop-search'), 'бб');
    expect(nicks()).toEqual(['Вв']);                   // «Бб» — член того же аккаунта
  });

  it('«Выбрать всех» / «Снять выбор»', async () => {
    prefill();
    openShopDialog();
    await wait();
    $('[data-q="all"]').click();
    expect($$('[data-sel]:checked')).toHaveLength(2);
    $('[data-q="none"]').click();
    expect($$('[data-sel]:checked')).toHaveLength(0);
  });
});

describe('окно: количество, сумма и остаток', () => {
  it('«цена × кол = сумма» и остаток; аккаунт отмечается сам', async () => {
    prefill();
    openShopDialog();
    await wait();
    $('[data-item="valor"]').click();
    const input = qtyInput('Вв', 'valor');
    type(input, 3);
    const row = rowOf('Вв');
    expect(row.querySelector('[data-calc]').textContent).toContain('10 × 3 сундук. = 30');
    expect(row.querySelector('[data-total]').textContent).toContain('остаток: 24');
    expect(row.querySelector('[data-sel]').checked).toBe(true);
    expect($('#shop-summary').textContent).toContain('К покупке: 3 шт. на 30');
    expect(input.isConnected).toBe(true);              // ввод не перерисовывает поле
  });

  it('больше, чем хватает монет, — предупреждение «купится K из N»', async () => {
    prefill();
    openShopDialog();
    await wait();
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'valor'), 9);
    expect(rowOf('Вв').querySelector('[data-calc]').textContent).toContain('купится 5 из 9 (не хватает монет)');
  });

  it('больше лимита — «купится 4 из 6 (лимит)»', async () => {
    site.U1.balance = 500;
    prefill();
    openShopDialog();
    await wait();
    $('[data-item="camp"]').click();
    type(qtyInput('Вв', 'camp'), 6);
    expect(rowOf('Вв').querySelector('[data-calc]').textContent).toContain('купится 4 из 6 (лимит)');
  });

  it('несколько предметов делят один баланс', async () => {
    prefill();
    openShopDialog();
    await wait();
    $('[data-item="light"]').click();
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'light'), 1);
    type(qtyInput('Вв', 'valor'), 3);
    expect(rowOf('Вв').querySelector('[data-calc$="|valor"]').textContent).toContain('купится 1 из 3 (не хватает монет)');
    expect(rowOf('Вв').querySelector('[data-total]').textContent).toContain('остаток: 4');
  });

  it('«всем» — количество для отмеченных аккаунтов', async () => {
    site.U2.balance = 100;
    prefill();
    openShopDialog();
    await wait();
    $('[data-item="valor"]').click();
    $('[data-q="all"]').click();
    const all = $('[data-all="valor"]');
    all.value = '2';
    all.dispatchEvent(new Event('change', { bubbles: true }));
    expect(qtyInput('Вв', 'valor').value).toBe('2');
    expect(qtyInput('Аа', 'valor').value).toBe('2');
  });
});

describe('покупка', () => {
  const setup = async (ids = []) => {
    prefill();
    openShopDialog({ ids });
    await wait();
  };

  it('подтверждение, N покупок штука за штукой, итог, проверка баланса, копирование баланса остальным членам аккаунта, журнал', async () => {
    await setup();
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'valor'), 3);
    await clickFoot('start', 900);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0][0].text).toContain('необратима');
    const buys = mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item');
    expect(buys).toHaveLength(3);
    expect(buys[0][1]).toMatchObject({ charId: 'c', item: 'Знак доблести (25 штук)', expectPrice: 10, dryRun: false });
    expect($('.tf-dialog-sub').textContent).toContain('Куплено: 3 шт. на 30');

    // проверка баланса: представитель аккаунта, всем отмеченным; результат скопирован «Бб»
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh.mock.calls[0][0].map(c => c.id)).toEqual(['c']);
    expect(mocks.refresh.mock.calls[0][1]).toMatchObject({ onlyLoggedIn: false });
    expect(state.characters.find(c => c.id === 'c').ancientCoins).toBe(24);
    expect(state.characters.find(c => c.id === 'b').ancientCoins).toBe(24);
    expect(store.getAccount(store.charSiteMap().c).balance).toBe(24);
    expect($('.tf-dialog-body').textContent).toContain('24');

    const log = store.loadShopLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ nick: 'Вв', itemKey: 'valor', bought: 3, requested: 3, spent: 30, status: 'done' });
    expect(log[0].members).toContain('Бб');
  });

  it('отказ в подтверждении: ничего не куплено', async () => {
    await setup();
    mocks.confirm.mockResolvedValue(false);
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'valor'), 2);
    await clickFoot('start');
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item')).toHaveLength(0);
  });

  it('лимит: запрошено 6, доступно 4 — куплено 4, итог «куплено до лимита», срок обновления запомнен', async () => {
    site.U1.balance = 500;
    await setup();
    $('[data-item="camp"]').click();
    type(qtyInput('Вв', 'camp'), 6);
    await clickFoot('start', 1200);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item')).toHaveLength(4);
    expect($('.tf-dialog-body').textContent).toContain('Куплено до лимита: 4 из 6');
    const acc = store.getAccount(store.charSiteMap().c);
    expect(acc.items.camp.available).toBe(0);
    expect(acc.tracks.camp.resetAt).toBeTruthy();
  });

  it('пробный запуск: без подтверждения, dryRun, без записи в журнал и проверки баланса', async () => {
    await setup();
    mocks.invoke.mockImplementation(async (cmd, args) => (cmd === 'buy_shop_item'
      ? { status: 'dry_run', clicked: false, detail: 'Открыть' } : scanPayload(ACCOUNT_OF[args.charId])));
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'valor'), 3);
    await clickFoot('dry', 900);
    expect(mocks.confirm).not.toHaveBeenCalled();
    const buys = mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item');
    expect(buys).toHaveLength(1);
    expect(buys[0][1].dryRun).toBe(true);
    expect(store.loadShopLog()).toHaveLength(0);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect($('.tf-dialog-sub').textContent).toContain('Пробный запуск');
  });

  it('нечего покупать: подсказка вместо запуска', async () => {
    await setup();
    await clickFoot('start', 100);
    expect(mocks.toast).toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('«Активировать другие предметы»: выбор сброшен, магазин прочитан заново, кнопка видна только после итогов', async () => {
    await setup();
    $('[data-item="valor"]').click();
    type(qtyInput('Вв', 'valor'), 1);
    await clickFoot('start', 900);
    const again = document.querySelector('[data-act="again"]');
    expect(again.textContent).toContain('Активировать другие предметы');
    const scansBefore = mocks.invoke.mock.calls.filter(c => c[0] === 'read_shop').length;
    again.click();
    await wait();
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_shop').length).toBeGreaterThan(scansBefore);
    expect($$('.shop-card')).toHaveLength(8);
    expect($$('[data-item]:checked')).toHaveLength(0);
    expect($('[data-qty]')).toBeNull();
    // обновлённый баланс (54 − 10) уже на экране
    expect(rowOf('Вв').textContent).toContain('44');
  });
});

describe('журнал покупок', () => {
  it('общий журнал: записи с ником, предметом, суммой; поиск по нику; подробности', async () => {
    const mk = (i, nick, charId, extra = {}) => ({ at: new Date(Date.now() + i * 1000).toISOString(), charId, nick, members: [nick], itemKey: 'valor', item: 'Знак доблести (25 штук)', requested: 3, bought: 3, price: 10, spent: 30, status: 'done', ...extra });
    store.recordShopRow(mk(1, 'Аа', 'a'));
    store.recordShopRow(mk(2, 'Вв', 'c', { bought: 4, requested: 6, status: 'limit', itemKey: 'camp', item: 'Камень лагеря', spent: 160, price: 40 }));
    await import('../js/modules/automation/shopLogView.js');
    mountLogHub($('#log-root'), { source: 'shop' });
    const text = $('#log-root').textContent;
    expect(text).toContain('Аа');
    expect(text).toContain('Вв');
    expect(text).toContain('Камень лагеря');
    const { shopLogSource, detailsHtml } = await import('../js/modules/automation/shopLogView.js');
    expect(shopLogSource.list()).toHaveLength(2);
    expect(shopLogSource.list()[0].status).toBe('warn');          // «куплено до лимита»
    expect(detailsHtml(store.loadShopLog()[0])).toContain('Куплено до лимита: 4 из 6');
  });
});
