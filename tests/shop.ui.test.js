import { describe, it, expect, beforeEach, vi } from 'vitest';

// Диалог «Активация подарков» (покупка за Древние монеты) и вид «Подарки» в «Настройки → Журналы»
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
  refresh: vi.fn(),
  rerender: vi.fn()
}));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd, args) =>
    ['resume_scope_command', 'cancel_scope_command'].includes(cmd) ? Promise.resolve() : mocks.invoke(cmd, args)
}));
vi.mock('../js/modules/sync/syncManager.js', () => ({
  scriptSettings: () => ({ retries: 0, retryDelayMs: 0 }),
  refreshAllBalances: mocks.refresh,
  rerenderLists: mocks.rerender
}));
vi.mock('../js/modules/sync/queue.js', async orig => ({ ...(await orig()), sleep: async () => {} })); // без реальных пауз
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const wait = (ms = 300) => new Promise(r => setTimeout(r, ms));
const rowOf = nick => $$('tr.shop-row').find(r => r.querySelector('b').textContent === nick);
const type = (el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const clickFoot = async (act, ms = 600) => {
  document.querySelector(`.tf-dialog-foot [data-act="${act}"]`).click();
  await wait(ms);
};

const WANTED = [
  'Камень светлого духа',
  'Камень асуров',
  'Камень лагеря',
  'Камень государя',
  'Знак доблести (25 штук)',
  'Знак единства (25 штук)',
  'Сундук средоточия',
  'Ключ от Книги наставлений'
];
const ACCOUNT_OF = { a: 'U2', b: 'U1', c: 'U1' }; // «Бб» и «Вв» — один аккаунт сайта, «Аа» — другой
let site; // модель сайта: у каждого аккаунта баланс и остаток лимитов
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
  'Знак доблести (25 штук)': {
    key: 'valor',
    id: '479',
    price: 10,
    chest: true,
    desc: 'Активировав сундучок, вы получите: Знак доблести x 25'
  },
  'Знак единства (25 штук)': { key: 'unity', id: '480', price: 10, chest: true, desc: '' }
};
const rawItem = (acc, want) => {
  const d = DEF[want];
  if (!d) return { want, found: false, ambiguous: false };
  const left = d.chest ? null : site[acc].left[d.key];
  return {
    want,
    found: true,
    name: want.replace(/ \(.*\)$/, ''),
    id: d.id,
    kind: d.chest ? 'chest' : 'item',
    price: d.price,
    available: left,
    max: null,
    blocked: left === 0,
    hasLink: true,
    label: d.chest ? 'Открыть' : 'Купить',
    desc: d.desc,
    image: ''
  };
};
const scanPayload = acc => ({
  status: 'ok',
  account: `acc_${acc}`,
  balance: site[acc].balance,
  items: WANTED.map(w => rawItem(acc, w))
});

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
  mocks.refresh.mockReset().mockImplementation(async list => {
    list.forEach(c => {
      c.ancientCoins = site[ACCOUNT_OF[c.id]].balance;
      c.lastCoinUpdate = new Date().toISOString();
    });
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

const setup = async () => {
  prefill();
  openShopDialog();
  await wait();
};
const choose = (nick, key) => {
  const row = rowOf(nick);
  row.querySelector(`[data-pick-name$="|${key}"]`).click();
};
const next = async () => {
  await clickFoot('start', 20);
  return document.querySelector('[data-quantity-buy]').closest('.tf-dialog');
};
const quantity = (dlg, key) => dlg.querySelector(`[data-qty$="|${key}"]`);
const buy = async dlg => {
  dlg.querySelector('[data-quantity-buy]').click();
  await wait(900);
};
describe('gift item selection → quantities → guarded purchase', () => {
  it('preserves all eight website items, pricing/description and locks missing items', async () => {
    await setup();
    expect($$('[data-item]')).toHaveLength(8);
    expect($('[data-item=valor]').disabled).toBe(false);
    expect($('[data-item=focus]').disabled).toBe(true);
    expect($('[data-card=light] details').textContent).toContain('Описание');
    expect($('[data-card=light] details').open).toBe(false);
  });
  it('main table has choices and current balances, without quantities or remainder totals', async () => {
    await setup();
    $('[data-item=valor]').click();
    expect($('#shop-table input[type=number]')).toBeNull();
    expect($('#shop-table').textContent).not.toContain('остаток');
    expect($('#shop-table').textContent).not.toContain('Итого');
    expect($('[data-act=start]').textContent).toContain('Далее');
  });
  it('unknown accounts merge after scan; a shared account is shown and scanned once after association', async () => {
    await setup();
    expect($$('tr.shop-row')).toHaveLength(2);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'read_shop')).toHaveLength(2);
    expect(store.charSiteMap().b).toBe(store.charSiteMap().c);
    expect(rowOf('Вв').textContent).toContain('Бб');
  });
  it('offline and unchecked characters can be preset, manually selected and selected through All', async () => {
    state.characters[0].isLoggedIn = false;
    prefill();
    openShopDialog({ ids: ['a', 'b'] });
    await wait();
    expect($$('[data-sel]').some(c => c.checked)).toBe(true);
    expect($$('[data-sel]').every(c => !c.disabled)).toBe(true);
    $('[data-q=none]').click();
    expect($$('[data-sel]:checked')).toHaveLength(0);
    $('[data-q=all]').click();
    expect($$('[data-sel]:checked').length).toBeGreaterThan(0);
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
  });
  it('empty selections do not open a quantity window or send purchase commands', async () => {
    await setup();
    await clickFoot('start', 20);
    expect($('[data-quantity-buy]')).toBeNull();
    expect(mocks.toast).toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
  });
  it('next opens per-account/item quantities and live remaining coins, never spends on edits', async () => {
    await setup();
    $('[data-item=valor]').click();
    choose('Вв', 'valor');
    const dlg = await next();
    expect(dlg.textContent).toContain('54');
    type(quantity(dlg, 'valor'), 3);
    expect(dlg.querySelector('[data-quantity-total]').textContent).toContain('24');
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
    expect(dlg.querySelector('[data-quantity-buy]').textContent).toBe('Купить');
  });
  it('multiple selected items share one account balance; limits/funds cap the preview', async () => {
    await setup();
    $('[data-item=valor]').click();
    $('[data-item=unity]').click();
    choose('Вв', 'valor');
    choose('Вв', 'unity');
    const dlg = await next();
    type(quantity(dlg, 'valor'), 3);
    type(quantity(dlg, 'unity'), 3);
    expect(dlg.querySelector('[data-quantity-total]').textContent).toContain('4');
    expect(dlg.textContent).toContain('Объём ограничен');
  });
  it('back preserves selections and sends nothing', async () => {
    await setup();
    $('[data-item=valor]').click();
    choose('Вв', 'valor');
    const dlg = await next();
    dlg.querySelector('[data-quantity-back]').click();
    expect(rowOf('Вв').querySelector('[data-pick-name]').checked).toBe(true);
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
  });
  it('buy uses existing confirmation, single purchases, shared balances and durable log', async () => {
    await setup();
    $('[data-item=valor]').click();
    choose('Вв', 'valor');
    const dlg = await next();
    type(quantity(dlg, 'valor'), 3);
    await buy(dlg);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0][0].text).toContain('необратима');
    const buys = mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item');
    expect(buys).toHaveLength(3);
    expect(buys[0][1]).toMatchObject({ charId: 'c', expectPrice: 10, dryRun: false });
    expect(store.loadShopLog()[0]).toMatchObject({ bought: 3, spent: 30 });
    expect(state.characters.find(c => c.id === 'b').ancientCoins).toBe(24);
  });
  it('declining confirmation makes no purchase and retains main selection', async () => {
    await setup();
    mocks.confirm.mockResolvedValue(false);
    $('[data-item=valor]').click();
    choose('Вв', 'valor');
    const dlg = await next();
    await buy(dlg);
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
    expect($('[data-act=start]')).not.toBeNull();
  });
  it('dry-run also requires quantities, bypasses irreversible consent but never records a purchase', async () => {
    await setup();
    $('[data-item=valor]').click();
    choose('Вв', 'valor');
    await clickFoot('dry', 20);
    const dlg = $('[data-quantity-buy]').closest('.tf-dialog');
    await buy(dlg);
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === 'buy_shop_item');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c[1].dryRun)).toBe(true);
    expect(store.loadShopLog()).toHaveLength(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('limit view uses new filters without purchases and refresh retains search', async () => {
    await setup();
    await clickFoot('limits', 20);
    expect($$('[data-limits-filter] option').map(o => o.textContent)).toEqual([
      'Все',
      'Максимум',
      'Меньше максимума',
      'Исчерпано',
      'Нет данных',
      'Есть дата обновления'
    ]);
    const search = $('[data-limits-search]');
    search.value = 'Вв';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-limits-status]').textContent).toContain('Строк:');
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
  });
  it('refresh without a table selection never scans every account', async () => {
    await setup();
    $('[data-q=none]').click();
    mocks.invoke.mockClear();
    $('[data-q=refresh]').click();
    await wait(20);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('durable gift log', () => {
  it('общий журнал: записи с ником, предметом, суммой; поиск по нику; подробности', async () => {
    const mk = (i, nick, charId, extra = {}) => ({
      at: new Date(Date.now() + i * 1000).toISOString(),
      charId,
      nick,
      members: [nick],
      itemKey: 'valor',
      item: 'Знак доблести (25 штук)',
      requested: 3,
      bought: 3,
      price: 10,
      spent: 30,
      status: 'done',
      ...extra
    });
    store.recordShopRow(mk(1, 'Аа', 'a'));
    store.recordShopRow(
      mk(2, 'Вв', 'c', {
        bought: 4,
        requested: 6,
        status: 'limit',
        itemKey: 'camp',
        item: 'Камень лагеря',
        spent: 160,
        price: 40
      })
    );
    await import('../js/modules/automation/shopLogView.js');
    mountLogHub($('#log-root'), { source: 'shop' });
    const text = $('#log-root').textContent;
    expect(text).toContain('Аа');
    expect(text).toContain('Вв');
    expect(text).toContain('Камень лагеря');
    const { shopLogSource, detailsHtml } = await import('../js/modules/automation/shopLogView.js');
    expect(shopLogSource.list()).toHaveLength(2);
    expect(shopLogSource.list()[0].status).toBe('warn'); // «куплено до лимита»
    expect(detailsHtml(store.loadShopLog()[0])).toContain('Куплено до лимита: 4 из 6');
  });
});

it('all six quota filters select actual rows; exhausted is below maximum and observed maxima survive another account read', async () => {
  await setup();
  site.U2.left.light = 2;
  store.saveScan(['a'], core.normalizeScan(scanPayload('U2')), new Date());
  await clickFoot('limits', 20);
  const item = $('[data-limits-item]'),
    filter = $('[data-limits-filter]');
  const select = (key, value) => {
    key.value = value;
    key.dispatchEvent(new Event('change', { bubbles: true }));
  };
  select(item, 'light');
  select(filter, 'maximum');
  expect($('.shop-limits-table tbody').textContent).toContain('Вв');
  expect($('.shop-limits-table tbody').textContent).not.toContain('Аа');
  select(filter, 'below');
  expect($('.shop-limits-table tbody').textContent).toContain('Аа');
  expect($('.shop-limits-table tbody').textContent).not.toContain('Вв');
  select(filter, 'exhausted');
  expect($$('.shop-limits-table tbody tr')).toHaveLength(0);
  select(item, 'asura');
  expect($('.shop-limits-table tbody').textContent).toContain('Вв');
  select(filter, 'unknown');
  select(item, 'focus');
  expect($('.shop-limits-table tbody').textContent).toContain('Нет данных');
  select(filter, 'reset');
  expect($$('.shop-limits-table tbody tr')).toHaveLength(0);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'buy_shop_item')).toBe(false);
});

it('the quantity step caps purchases by the real limit, remembers reset evidence, and reopening other items rescans without retaining quantities', async () => {
  site.U1.balance = 500;
  await setup();
  $('[data-item=light]').click();
  choose('Вв', 'light');
  const dlg = await next();
  type(quantity(dlg, 'light'), 6);
  expect(dlg.querySelector('[data-quantity-total]').textContent).toContain('Остаток: 340');
  await buy(dlg);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'buy_shop_item')).toHaveLength(4);
  expect(store.getAccount(store.charSiteMap().c).tracks.light.resetAt).toBeTruthy();
  const scans = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'read_shop').length;
  $('[data-act=again]').click();
  await wait();
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'read_shop').length).toBeGreaterThan(scans);
  expect($$('[data-item]:checked')).toHaveLength(0);
  expect($('[data-qty]')).toBeNull();
});
it('retry from the new quantity workflow still requires consent and buys only the confirmed uncompleted remainder', async () => {
  await setup();
  const actual = mocks.invoke.getMockImplementation();
  let attempts = 0;
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'buy_shop_item' && ++attempts === 2) return { status: 'error', error: 'timeout', clicked: false };
    return actual(cmd, args);
  });
  $('[data-item=valor]').click();
  choose('Вв', 'valor');
  const dlg = await next();
  type(quantity(dlg, 'valor'), 3);
  await buy(dlg);
  expect(attempts).toBe(2);
  mocks.confirm.mockResolvedValueOnce(false);
  await clickFoot('retry', 50);
  expect(attempts).toBe(2);
  await clickFoot('retry', 900);
  expect(attempts).toBe(4);
  expect(mocks.confirm.mock.calls.at(-1)[0].text).toContain('2 шт.');
});
it('shows balance immediately after nickname and selects an item for every unique shared wallet', async () => {
  await setup();
  $('[data-item=valor]').click();
  const row = rowOf('Вв');
  expect(row.children[2].textContent).toContain('54');
  expect(row.textContent).not.toContain('общий аккаунт');
  $('[data-pick-all=valor]').click();
  expect($$('[data-pick-name]:checked')).toHaveLength(2);
  expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
  $('[data-pick-all=valor]').click();
  expect($$('[data-pick-name]:checked')).toHaveLength(0);
});
it('column maximum caps each selected character by balance/quota without purchasing or enabling a missing item', async () => {
  site.U1.balance = 500;
  state.characters[2].class = 'Воин';
  await setup();
  $('[data-item=light]').click();
  $('[data-pick-all=light]').click();
  const dlg = await next();
  expect(dlg.querySelector('th').textContent).toBe('Персонажи');
  expect(dlg.querySelector('tbody td img')).not.toBeNull();
  dlg.querySelector('[data-quantity-max=light]').click();
  expect([...dlg.querySelectorAll('[data-qty]')].map(i => Number(i.value)).sort()).toEqual([0, 4]);
  expect(mocks.invoke.mock.calls.some(c => c[0] === 'buy_shop_item')).toBe(false);
});
