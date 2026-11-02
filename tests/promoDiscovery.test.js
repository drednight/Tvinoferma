import { describe, it, expect, vi } from 'vitest';
import {
  articleId,
  pinCode,
  newsArticles,
  articleCodes,
  expiryHint
} from '../js/modules/automation/promoNewsParser.js';
import { createPromoDiscovery, promoCoverage } from '../js/modules/automation/promoDiscovery.js';
const index = '<a href="./news.php?article=123">Новость</a><a href="https://pwonline.ru/news.php?article=456">Ещё</a>';
const article = (code = 'PWMIZAR2026HB') =>
  `<h1>Подарок</h1><div class="js-mediator-article"><p>Промокод действует до 5 ноября 2026 года: <a href="./pin/${code}">Активировать</a></p></div>`;
const storage = () => {
  const map = new Map();
  return { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) };
};
describe('official public news extraction', () => {
  it('resolves absolute, root relative and ./pin links, and folds duplicate codes', () => {
    for (const url of ['https://pwonline.ru/pin/PWMIZAR2026HB', '/pin/PWMIZAR2026HB', './pin/PWMIZAR2026HB'])
      expect(pinCode(url, 'https://pwonline.ru/news.php?article=1')).toBe('PWMIZAR2026HB');
    expect(articleCodes(article(), '123')).toEqual([
      expect.objectContaining({
        code: 'PWMIZAR2026HB',
        expiresOn: '2026-11-05',
        sourceUrl: 'https://pwonline.ru/news.php?article=123'
      })
    ]);
    expect(newsArticles(index + index)).toEqual(['123', '456']);
  });
  it.each([
    'https://evil.test/pin/ABCD1234',
    'https://pwonline.ru.evil.test/pin/ABCD1234',
    'javascript:alert(1)',
    'https://a@pwonline.ru/pin/ABCD1234',
    '/pin/../admin',
    '/pin/ABC',
    '/pin/ABC%2FDEF'
  ])('rejects activation link %s', value => expect(pinCode(value)).toBeNull());
  it('does not discover codes in prose/scripts/nav or execute HTML', () => {
    const html =
      '<h1>Новость</h1><article><p>NOTACODE1234</p><script>window.HACKED=true</script><img src=x onerror="window.HACKED=true"></article><nav><a href="/pin/NAVCODE">x</a></nav>';
    expect(articleCodes(html, '1')).toEqual([]);
    expect(window.HACKED).toBeUndefined();
    expect(articleId('https://evil.test/news.php?article=123')).toBeNull();
  });
  it('reports anti-bot/changed markup instead of a false no-code success', () => {
    expect(() => newsArticles('<title>Just a moment</title>')).toThrow('challenge');
    expect(() => newsArticles('<h1>Unavailable</h1>')).toThrow('markup');
    expect(() => articleCodes('<p>Maintenance</p>', '1')).toThrow('markup');
  });
  it('keeps uncertain deadlines as source text, validates dates, does not mix two codes', () => {
    expect(expiryHint('Промокод до 31.02.2026')).toMatchObject({ expiresOn: null });
    expect(expiryHint('Промокод до 5 ноября')).toMatchObject({ expiresOn: null, expiresText: expect.any(String) });
    expect(expiryHint('Скидки до 5 ноября 2026')).toEqual({ expiresOn: null, expiresText: null });
    const html = article().replace('</p>', '<a href="/pin/SECOND12">Второй</a></p>');
    expect(articleCodes(html, '1').every(row => row.expiresOn === null)).toBe(true);
  });
});
describe('bounded background discovery', () => {
  const clock = Date.parse('2026-11-02T03:00:00Z');
  it('reads both indexes and every unique news, deduplicates, persists and does not fetch again the same Moscow day', async () => {
    const read = vi.fn(async args => ({ status: 200, html: args.page ? index : article() }));
    let now = clock;
    const store = storage();
    const service = createPromoDiscovery({ read, storage: store, now: () => now });
    const first = await service.check();
    expect(first.status).toBe('checked');
    expect(first.checked).toBe(2);
    expect(first.codes).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(4);
    await service.check();
    expect(read).toHaveBeenCalledTimes(4);
    await createPromoDiscovery({ read, storage: store, now: () => now }).check();
    expect(read).toHaveBeenCalledTimes(4);
    now += 86400000;
    await service.check();
    expect(read).toHaveBeenCalledTimes(8);
  });
  it('deduplicates concurrent startup/open/manual checks and never sends PIN or character commands', async () => {
    let done;
    const held = new Promise(r => {
      done = r;
    });
    const read = vi.fn(async args => {
      await held;
      return { status: 200, html: args.page ? index : article() };
    });
    const service = createPromoDiscovery({ read, storage: storage(), now: () => clock });
    const a = service.check(),
      b = service.check({ force: true });
    expect(a).toBe(b);
    done();
    await a;
    expect(read.mock.calls.every(([args]) => Object.keys(args).sort().join(',') === 'article,page')).toBe(true);
  });
  it('uses at most two article requests concurrently and keeps partial discoveries on an error', async () => {
    let active = 0,
      maximum = 0;
    const read = vi.fn(async args => {
      if (args.page) return { status: 200, html: index };
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return args.article === '456' ? { status: 403 } : { status: 200, html: article() };
    });
    const service = createPromoDiscovery({ read, storage: storage(), now: () => clock });
    const result = await service.check();
    expect(result.status).toBe('partial');
    expect(result.lastCompleteAt).toBe(0);
    expect(result.codes).toHaveLength(1);
    expect(maximum).toBeLessThanOrEqual(2);
    await service.check();
    expect(read).toHaveBeenCalledTimes(4);
    await service.check({ force: true });
    expect(service.snapshot().codes).toHaveLength(1);
  });
  it('ends on budget, never claims a complete scan, and does not discard old codes when offline', async () => {
    let now = clock;
    let offline = false;
    const read = vi.fn(async args => {
      if (offline) throw Error('offline');
      if (args.article) now += 70000;
      return {
        status: 200,
        html: args.page ? index.replace('</a>', '</a><a href="?article=789">more</a>') : article()
      };
    });
    const service = createPromoDiscovery({ read, storage: storage(), now: () => now });
    expect((await service.check()).status).toBe('partial');
    offline = true;
    expect((await service.check({ force: true })).codes).toHaveLength(1);
  });
  it('provides only confirmed local-log coverage; discovery never marks a code activated', () => {
    expect(
      promoCoverage(
        [{ code: 'CODE1234' }],
        [{ id: 'a' }, { id: 'b' }],
        [{ code: 'code1234', entered: { a: { at: 'today' } } }]
      )[0]
    ).toMatchObject({ entered: 1, remaining: 1 });
  });
});
it('never restores a checking lock after a crash and fences a late response after dispose/reset', async () => {
  const store = storage();
  store.setItem('tf_promo_discovery_v1', JSON.stringify({ version: 1, status: 'checking', codes: [], articles: {} }));
  let release;
  const held = new Promise(r => (release = r));
  const service = createPromoDiscovery({
    storage: store,
    read: async args => {
      await held;
      return { status: 200, html: args.page ? index : article() };
    }
  });
  expect(service.snapshot().status).toBe('partial');
  const pending = service.check({ force: true });
  service.dispose();
  release();
  await pending;
  expect(service.snapshot().codes).toEqual([]);
  expect(JSON.parse(store.getItem('tf_promo_discovery_v1')).codes).toEqual([]);
});

describe('news metadata from separate paragraphs (acceptance examples, synthetic HTML)', () => {
  const html = (code, deadline, server, rewards) =>
    `<h1>Подарки</h1><article><p><a href="/pin/${code}">Активировать</a></p><p>Промокод можно активировать ${deadline}.</p><p>Предметы хранятся 7 дней.</p>${server ? `<p>Важно! Предметы можно перевести только на сервер «${server}».</p>` : ''}<p>В состав подарка входят:</p><ul>${rewards.map(r => `<li>${r}</li>`).join('')}</ul></article>`;
  it('9142: 23:59 MSK, explicit 2026, Cepheus restriction and all nine reward types', () => {
    const rewards = [
      'S-коробка ×50',
      'Камень божества ×50',
      'Метеорит ×75',
      'Платиновый амулет ×5',
      'Платиновый идол ×5',
      'Самоцвет оружия ×50',
      'Самоцвет реликвии ×50',
      'Самоцвет брони ×50',
      'Запечатанная грамота Лиги ×25'
    ];
    const [row] = articleCodes(html('PWCEPHEUS26', 'до 23:59 МСК 25 октября 2026 года', 'Цефей', rewards), '9142');
    expect(row.expiresOn).toBe('2026-10-25');
    expect(row.expiresText).toContain('23:59 МСК');
    expect(row.serverRestriction).toBe('Цефей');
    expect(row.rewards).toEqual(rewards);
  });
  it('9126: yearless deadline is displayed without inventing a year, separate Mizar restriction', () => {
    const [row] = articleCodes(
      html(
        'PWMIZAR2026HB',
        'до 23:59 МСК 4 октября',
        'Мицар',
        Array.from({ length: 13 }, (_, i) => `Предмет ${i + 1}`)
      ),
      '9126'
    );
    expect(row.expiresText).toContain('23:59 МСК 4 октября');
    expect(row.expiresOn).toBeNull();
    expect(row.serverRestriction).toBe('Мицар');
    expect(row.rewards).toHaveLength(13);
  });
  it('9110: transfer start is not the activation deadline; no server is invented', () => {
    const article = html('PWZNANIYA26', 'до 23:59 МСК 13 сентября', null, ['Колокол', 'Небесная пилюля ×30']).replace(
      '<article>',
      '<article><p>Перевод доступен после 19:00 МСК 31 августа.</p>'
    );
    const [row] = articleCodes(article, '9110');
    expect(row.expiresText).toContain('13 сентября');
    expect(row.expiresText).not.toContain('31 августа');
    expect(row.serverRestriction).toBeNull();
    expect(row.rewards).toHaveLength(2);
  });
  it('hiding survives reload and the code can be restored without deleting its metadata', async () => {
    const disk = storage(),
      read = async args => ({ status: 200, html: args.article ? article() : index });
    const first = createPromoDiscovery({ storage: disk, read });
    await first.check();
    first.setHidden('PWMIZAR2026HB');
    const second = createPromoDiscovery({ storage: disk, read });
    expect(second.snapshot().hiddenCodes).toContain('PWMIZAR2026HB');
    expect(second.snapshot().codes[0].code).toBe('PWMIZAR2026HB');
    second.setHidden('PWMIZAR2026HB', false);
    expect(second.snapshot().hiddenCodes).toEqual([]);
  });
});

it('preserves a post-date clock and MSK without taking a later transfer start', () => {
  expect(
    expiryHint('Промокод действует до 25 октября 2026 года в 23:59 МСК. Перевод после 19:00 МСК.').expiresText
  ).toContain('23:59 МСК');
});
it('new hidden codes remain persistable after the first 200 discoveries', () => {
  const disk = storage(),
    first = createPromoDiscovery({ storage: disk, read: async () => ({ status: 200, html: index }) });
  for (let n = 0; n < 205; n++) first.setHidden(`PWTEST${String(n).padStart(4, '0')}`);
  const second = createPromoDiscovery({ storage: disk, read: async () => ({ status: 200, html: index }) });
  expect(second.snapshot().hiddenCodes).toHaveLength(205);
  expect(second.snapshot().hiddenCodes).toContain('PWTEST0204');
});

it('reward names and quantities exclude the real website hover descriptions', () => {
  const html = `<article><a href="/pin/PWEXAMPLE26">Код</a><p>В состав подарка входят:</p><ul><li><span class="img_item_small_cont"><span><em>Пилюля х50</em><strong>Описание:</strong> Даёт опыт. Тип: опыт.</span><b><img src="x"></b></span>Небесная пилюля (50 шт.);</li><li>Амулет ×2</li></ul></article>`;
  expect(articleCodes(html, '123')[0].rewards).toEqual(['Небесная пилюля (50 шт.);', 'Амулет ×2']);
});

it('refreshes old cached reward metadata without losing codes or hidden choices', async () => {
  const disk = storage();
  const at = Date.now();
  disk.setItem(
    'tf_promo_discovery_v1',
    JSON.stringify({
      version: 1,
      metadataVersion: 2,
      status: 'checked',
      articles: { 123: at },
      codes: [{ code: 'PWEXAMPLE26', rewards: ['Описание: OLD DESCRIPTION'], firstSeenAt: at }],
      hiddenCodes: ['PWEXAMPLE26'],
      lastCompleteAt: at,
      lastAttemptAt: at
    })
  );
  const read = vi.fn(async ({ article: id }) => ({
    status: 200,
    html: id
      ? `<article><a href="/pin/PWEXAMPLE26">Код</a><p>В состав подарка входят:</p><ul><li>Награда ×2</li></ul></article>`
      : '<a href="/news.php?article=123">Новость</a>'
  }));
  const service = createPromoDiscovery({ storage: disk, now: () => at, read });
  expect(service.snapshot().codes[0].rewards).toEqual([]);
  expect(service.snapshot().hiddenCodes).toEqual(['PWEXAMPLE26']);
  await service.check();
  expect(read).toHaveBeenCalledWith({ page: null, article: '123' });
  expect(service.snapshot().codes[0].rewards).toEqual(['Награда ×2']);
  expect(service.snapshot().hiddenCodes).toEqual(['PWEXAMPLE26']);
});
