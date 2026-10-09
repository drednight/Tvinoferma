// Скрипт передачи предметов (src-tauri/src/scripts/transfer.js, Issue #26) на НАСТОЯЩИХ обезличенных страницах pwonline.ru:
//   site-promoitems.html         — /promo_items.php: сундуки, предметы по акциям, список «серверы / персонажи»
//   site-promoitems-history.html — /promo_items.php?do=history: «История передачи предметов в игру»
// Переменную `shards` страница получает от сайта, а списки заполняет promo_items.js — в тесте это повторено вручную.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildScript, fixture, editDom } from './helpers/pageScript.js';

const SHARDS = {
  3: {
    id: 3, name: 'Фенрир',
    accounts: {
      1000000002: {
        id: 1000000002, name: 'u_1000000001',
        chars: [
          { id: 1000000003, name: '#Тестовый', occupation: 'Лучник', level: '105' },
          { id: 1000000004, name: 'Второй_alt', occupation: 'Убийца', level: '101' }
        ]
      }
    }
  },
  5: {
    id: 5, name: 'Мицар',
    accounts: { 1000000002: { id: 1000000002, name: 'u_1000000001', chars: [{ id: 1000000005, name: 'Мицарный', occupation: 'Бард', level: '90' }] } }
  }
};

/** То, что делает promo_items.js при загрузке страницы. */
function fillSelects(shards) {
  const shardSel = document.querySelector('select.js-shard');
  const charSel = document.querySelector('select.js-char');
  if (!shardSel || !charSel || !shards || !Object.keys(shards).length) return;
  const charInit = (shardId) => {
    charSel.innerHTML = '';
    Object.values(shards[shardId].accounts).forEach((acc) => {
      const g = document.createElement('optgroup'); g.label = acc.name;
      acc.chars.forEach((c) => {
        const o = document.createElement('option');
        o.value = `${acc.id}_${shardId}_${c.id}`; o.textContent = `${c.name} (${c.occupation}, уровень:${c.level})`;
        g.appendChild(o);
      });
      charSel.appendChild(g);
    });
  };
  Object.values(shards).forEach((s) => { const o = document.createElement('option'); o.value = String(s.id); o.textContent = s.name; shardSel.appendChild(o); });
  shardSel.addEventListener('change', () => charInit(shardSel.value));
  charInit(Object.keys(shards)[0]);
}

let go;
function mount(html, opts = {}) {
  const { populate = true, mode = 'scan', cfg = {}, search = '' } = opts;
  const shards = 'shards' in opts ? opts.shards : SHARDS;
  if (!('innerText' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.title = doc.title;
  document.body.innerHTML = doc.body.innerHTML;
  window.history.replaceState(null, '', `/promo_items.php${search}`);
  window.location.hash = '';
  window.shards = shards;
  window.olUid = '1000000001';
  window.showNotice = false;
  document.querySelectorAll('.modals, .modals_fade').forEach((m) => { m.style.display = 'none'; });   // как в CSS сайта
  if (populate) fillSelects(shards);
  window.__TF_XFER = { mode, ...cfg };
  window.__TF_XFER_CONFIRMED = undefined;
  go = document.querySelector('.js-transfer-go');
  if (go) go.addEventListener('click', go.__h = vi.fn());
}
const exec = () => new Function(buildScript('transfer.js'))();
const payload = () => JSON.parse(decodeURIComponent(window.location.hash.replace('#TF_XFER_V1_', '')));
const run = (html, mode, cfg, extra = {}) => { mount(html, { mode, cfg, ...extra }); exec(); return payload(); };
const KEY = '1000000002_3_1000000003';
const FILL = { shard: '3', recipient: KEY, charName: '#Тестовый' };

beforeEach(() => { window.__TF_XFER = undefined; delete window.shards; delete window.jQuery; });

describe('transfer.js: servers (страница «Статус серверов», только чтение)', () => {
  const page = () => fixture('site-serverstatus.html');

  it('все серверы со страницы и рекомендуемый; номеров на странице нет', () => {
    const r = run(page(), 'servers', {}, { shards: undefined });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({
      state: 'servers', recommended: 'Капелла',
      servers: [{ name: 'Центавр', online: true }, { name: 'Фенрир', online: true }, { name: 'Мицар', online: true }, { name: 'Капелла', online: true }]
    });
  });

  it('оффлайн-сервер помечается; вход на сайт для этой страницы не нужен', () => {
    const html = editDom(page(), (d) => {
      const span = d.querySelector('.servers_container li span'); span.className = 'server_status_0';
      d.body.insertAdjacentHTML('beforeend', '<p>Вы не авторизованы</p>');
    });
    const r = run(html, 'servers', {}, { shards: undefined });
    expect(r.error).toBeNull();
    expect(r.data.servers[0]).toEqual({ name: 'Центавр', online: false });
  });

  it('вёрстка изменилась (списка нет): pending, а не пустой список', () => {
    const html = editDom(page(), (d) => { d.querySelector('.servers_container').remove(); });
    const r = run(html, 'servers', {}, { shards: undefined });
    expect(r.error).toBe('pending');
  });

  it('проверка безопасности вместо страницы → challenge', () => {
    const r = run('<html><head><title>Проверка безопасности</title></head><body></body></html>', 'servers', {}, { shards: undefined });
    expect(r.error).toBe('challenge');
  });
});

describe('transfer.js: персонаж без ника', () => {
  const NONICK = { 3: { id: 3, name: 'Фенрир', accounts: { 1000000002: { id: 1000000002, name: 'u_1000000001', chars: [{ id: 1000000009, name: '', occupation: 'Призрак', level: '103' }] } } } };
  it('scan отдаёт персонажа с пустым ником; fill выбирает его по ключу, без проверки имени', () => {
    const s = run(fixture('site-promoitems.html'), 'scan', {}, { shards: NONICK });
    expect(s.data.shards[0].chars).toEqual([{ key: '1000000002_3_1000000009', account: 'u_1000000001', name: '', cls: 'Призрак', level: 103 }]);
    const f = run(fixture('site-promoitems.html'), 'fill', { shard: '3', recipient: '1000000002_3_1000000009', charName: '' }, { shards: NONICK });
    expect(f.error).toBeNull();
    expect(f.data.state).toBe('ready');
    expect(f.data.char.key).toBe('1000000002_3_1000000009');
  });
});

describe('transfer.js: scan (только чтение)', () => {
  it('предметы по акциям, сундуки и строки без галочки; серверы и персонажи из shards', () => {
    const r = run(fixture('site-promoitems.html'), 'scan');
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('scan');
    expect(r.data.siteId).toBe('1000000001');
    expect(r.data.chests).toBe(3);                 // «Подарочный мешок»: выбор награды на сайте, не передаётся
    expect(r.data.locked).toBeGreaterThan(0);      // «Песчаная отметка»: строка без галочки
    expect(r.data.items.length).toBeGreaterThan(5);
    expect(r.data.items[0]).toEqual({ id: '550314371', name: 'Тайная пилюля: Покой', qty: 2, until: '21:01 29.03.2027', source: 'Идеальный шанс' });
    expect(r.data.items.map(i => i.source)).toContain('День рождения «Мицара»');
    expect(r.data.shards).toEqual([
      { id: '3', name: 'Фенрир', chars: [
        { key: '1000000002_3_1000000003', account: 'u_1000000001', name: '#Тестовый', cls: 'Лучник', level: 105 },
        { key: '1000000002_3_1000000004', account: 'u_1000000001', name: 'Второй_alt', cls: 'Убийца', level: 101 }] },
      { id: '5', name: 'Мицар', chars: [{ key: '1000000002_5_1000000005', account: 'u_1000000001', name: 'Мицарный', cls: 'Бард', level: 90 }] }
    ]);
  });

  it('название без количества: qty = 1', () => {
    const html = editDom(fixture('site-promoitems.html'), (d) => {
      const l = d.querySelector('.item_input_block label'); l.firstChild.textContent = 'Набор рун (8-го ур.) ';
    });
    expect(run(html, 'scan').data.items[0]).toMatchObject({ name: 'Набор рун (8-го ур.)', qty: 1 });
  });

  it('у аккаунта нет персонажей: shards = [] — это не ошибка', () => {
    expect(run(fixture('site-promoitems.html'), 'scan', {}, { shards: [] }).data.shards).toEqual([]);
  });

  it('переменной shards нет, страница загружена → pending (а не «пусто»); есть заголовок и нет таблиц → пустое состояние', () => {
    const noVar = run(fixture('site-promoitems.html'), 'scan', {}, { shards: undefined });
    expect(noVar.error).toBe('pending');
    const empty = editDom(fixture('site-promoitems.html'), (d) => { d.querySelector('.items_container').remove(); });
    expect(run(empty, 'scan', {}, { shards: undefined }).data).toMatchObject({ state: 'scan', empty: true, items: [], shards: [] });
  });

  it('настоящая страница «ваша корзина с подарками пуста» → пустое состояние, а не ошибка', () => {
    // site-promoitems-empty.html — реальная страница аккаунта без подарков: нет ни переменной
    // `shards`, ни формы передачи. Раньше это выглядело бы как «страница не прочитана».
    const r = run(fixture('site-promoitems-empty.html'), 'scan');
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'scan', empty: true, shards: [], items: [], chests: 0, locked: 0 });
  });

  it('вёрстка изменилась: нет формы → pending; нет входа → not_logged_in; «Проверка безопасности» → challenge', () => {
    const noForm = editDom(fixture('site-promoitems.html'), (d) => { d.querySelector('form').className = 'x'; });
    expect(run(noForm, 'scan').error).toBe('pending');
    expect(run(fixture('site-warning.html'), 'scan').error).toBe('not_logged_in');
    document.title = 'Проверка безопасности';
    const r = run('<html><head><title>Проверка безопасности</title></head><body></body></html>', 'scan');
    expect(r.error).toBe('challenge');
  });
});

describe('transfer.js: fill (выбор без отправки)', () => {
  it('выбирает сервер и персонажа, отмечает ВСЕ предметы (без лимита в 6), сундуки не трогает, ничего не нажимает', () => {
    mount(fixture('site-promoitems.html'), { mode: 'fill', cfg: FILL });
    exec();
    const r = payload();
    expect(r.error).toBeNull();
    const total = document.querySelectorAll('input[name="cart_items[]"]').length;
    expect(total).toBeGreaterThan(6);
    expect(r.data).toMatchObject({ state: 'ready', count: total, shard: { id: '3', name: 'Фенрир' } });
    expect(r.data.char.text).toContain('#Тестовый');
    expect(r.data.items).toHaveLength(total);
    expect([...document.querySelectorAll('input[name="cart_items[]"]')].every(b => b.checked && !b.disabled)).toBe(true);
    expect(document.querySelector('.js-shard').value).toBe('3');
    expect(document.querySelector('.js-char').value).toBe(KEY);
    expect(go.__h).not.toHaveBeenCalled();
  });

  it('предметы акции из skipSources (сайт принимает их только на другой сервер) не отмечаются; остальные — да', () => {
    const SRC = 'День рождения «Мицара»';
    mount(fixture('site-promoitems.html'), { mode: 'scan' }); exec();
    const all = payload().data.items;
    const own = all.filter(i => i.source === SRC);
    expect(own.length).toBeGreaterThan(0);
    const r = run(fixture('site-promoitems.html'), 'fill', { ...FILL, skipSources: [SRC.toLowerCase()] });   // без учёта регистра
    expect(r.error).toBeNull();
    expect(r.data.skipped).toBe(own.length);
    expect(r.data.count).toBe(all.length - own.length);
    expect(r.data.items.some(i => i.source === SRC)).toBe(false);
    const checked = [...document.querySelectorAll('input[name="cart_items[]"]')].filter(b => b.checked).map(b => b.value);
    expect(checked).toHaveLength(all.length - own.length);
    own.forEach(i => expect(checked).not.toContain(i.id));
  });

  it('без skipSources skipped = 0; если пропускается всё — no_items и ничего не отмечено', () => {
    expect(run(fixture('site-promoitems.html'), 'fill', FILL).data.skipped).toBe(0);
    mount(fixture('site-promoitems.html'), { mode: 'scan' }); exec();
    const sources = [...new Set(payload().data.items.map(i => i.source))];
    const r = run(fixture('site-promoitems.html'), 'fill', { ...FILL, skipSources: sources });
    expect(r.error).toBe('no_items');
    expect([...document.querySelectorAll('input[name="cart_items[]"]')].some(b => b.checked)).toBe(false);
  });

  it('другой сервер: список персонажей перестраивается, выбирается нужный', () => {
    const r = run(fixture('site-promoitems.html'), 'fill', { shard: '5', recipient: '1000000002_5_1000000005', charName: 'Мицарный' });
    expect(r.error).toBeNull();
    expect(r.data.shard.name).toBe('Мицар');
    expect(r.data.char.text).toContain('Мицарный');
  });

  it('сервера или персонажа нет в списках сайта → ничего не отмечается, ошибка', () => {
    mount(fixture('site-promoitems.html'), { mode: 'fill', cfg: { ...FILL, shard: '9' } }); exec();
    expect(payload().error).toBe('server_not_found');
    expect(document.querySelectorAll('input[name="cart_items[]"]:checked')).toHaveLength(0);
    expect(run(fixture('site-promoitems.html'), 'fill', { ...FILL, recipient: '1_3_9' }).error).toBe('char_not_found');
  });

  it('ник в списке не тот, что ожидали (персонажа переименовали) → char_mismatch, предметы не отмечены', () => {
    mount(fixture('site-promoitems.html'), { mode: 'fill', cfg: { ...FILL, charName: 'Другой' } }); exec();
    expect(payload().error).toBe('char_mismatch');
    expect(document.querySelectorAll('input[name="cart_items[]"]:checked')).toHaveLength(0);
  });

  it('списки сайта ещё не заполнены → pending; нет предметов → no_items', () => {
    expect(run(fixture('site-promoitems.html'), 'fill', FILL, { populate: false }).error).toBe('pending');
    const none = editDom(fixture('site-promoitems.html'), (d) => d.querySelectorAll('input[name="cart_items[]"]').forEach(b => b.remove()));
    expect(run(none, 'fill', FILL).error).toBe('no_items');
  });
});

describe('transfer.js: click (единственное нажатие «Передать»)', () => {
  const ready = () => {
    mount(fixture('site-promoitems.html'), { mode: 'fill', cfg: FILL }); exec();
    const count = payload().data.count;
    window.location.hash = '';
    window.__TF_XFER = { mode: 'click', ...FILL, count };
    return count;
  };

  it('нажимает «Передать» ровно один раз; окна подтверждения нет — «Да» не нажимается', () => {
    ready();
    const yes = vi.fn();
    document.querySelector('.js-transfer-done').addEventListener('click', yes);
    exec();
    expect(go.__h).toHaveBeenCalledTimes(1);
    expect(yes).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('сайт показал свой диалог «Вы уверены…» → «Да» нажимается один раз', () => {
    vi.useFakeTimers();
    try {
      ready();
      const yes = vi.fn();
      document.querySelector('.js-transfer-done').addEventListener('click', yes);
      go.addEventListener('click', () => { document.querySelector('.modals').style.display = 'block'; });
      exec();
      vi.advanceTimersByTime(2000);
      expect(go.__h).toHaveBeenCalledTimes(1);
      expect(yes).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('выбор изменился (другое число предметов, другой персонаж) — не нажимает', () => {
    const count = ready();
    document.querySelector('input[name="cart_items[]"]').checked = false;
    exec();
    expect(payload().error).toBe('selection_changed');
    document.querySelector('input[name="cart_items[]"]').checked = true;
    window.location.hash = '';
    document.querySelector('.js-char').value = '1000000002_3_1000000004';
    window.__TF_XFER = { mode: 'click', ...FILL, count };
    exec();
    expect(payload().error).toBe('selection_changed');
    expect(go.__h).not.toHaveBeenCalled();
  });

  it('ничего не отмечено → no_items, кнопка не нажата; нет кнопки «Передать» → form_not_found/pending', () => {
    mount(fixture('site-promoitems.html'), { mode: 'click', cfg: { ...FILL, count: 3 } }); exec();
    expect(payload().error).toBe('no_items');
    expect(go.__h).not.toHaveBeenCalled();
    const noGo = editDom(fixture('site-promoitems.html'), (d) => d.querySelector('.js-transfer-go').remove());
    expect(run(noGo, 'click', FILL).error).toBe('form_not_found');
  });
});

describe('transfer.js: result (история передачи)', () => {
  const hist = (edit) => run(edit ? editDom(fixture('site-promoitems-history.html'), edit) : fixture('site-promoitems-history.html'), 'result', {}, { search: '?do=history', shards: undefined });

  it('читает строки истории: предмет, количество, акция, аккаунт, персонаж, сервер, статус, время', () => {
    const r = hist();
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('history');
    expect(r.data.rows.length).toBeGreaterThan(5);
    expect(r.data.rows[0]).toEqual({
      name: 'Великий метеорит', qty: 2, source: 'Летние бонусы арены Авроры',
      account: 'u_1000000001', char: '#Тестовый', server: 'Фенрир', status: 'В обработке', at: '2026-10-04 03:39:02'
    });
    expect(r.data.rows[1]).toMatchObject({ name: 'Вино «Медная печать»', qty: 50, status: 'Передан' });
  });

  it('пустая таблица → pending (ждём), а не успех', () => {
    expect(hist((d) => d.querySelectorAll('.promo_history tr').forEach((tr, i) => { if (i) tr.remove(); })).error).toBe('pending');
  });

  it('страница передачи осталась без изменений → pending; сообщение об ошибке → unknown с текстом; нет входа → not_logged_in', () => {
    expect(run(fixture('site-promoitems.html'), 'result', {}).error).toBe('pending');
    const err = editDom(fixture('site-promoitems.html'), (d) => d.querySelector('#content_top').insertAdjacentHTML('afterend', '<div id="content_body"><div class="m_error">Что-то пошло не так</div></div>'));
    expect(run(err, 'result', {})).toEqual({ data: 'Что-то пошло не так', error: 'unknown' });
    expect(run(fixture('site-warning.html'), 'result', {}).error).toBe('not_logged_in');
  });

  it('страница «Предупреждение» вместо истории (предметы только на другой сервер) → warning с текстом и названием сервера', () => {
    const r = run(fixture('site-promoitems-warning.html'), 'result', {}, { shards: undefined });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({
      state: 'warning', onlyServer: 'Мицар',
      message: 'Уважаемый пользователь, данные предметы можно перевести только на сервер «Мицар»'
    });
  });

  it('другое предупреждение сайта: текст есть, сервера нет; предупреждение «не авторизован» остаётся not_logged_in', () => {
    const other = fixture('site-promoitems-warning.html').replace('данные предметы можно перевести только на сервер «Мицар»', 'передача сейчас недоступна');
    const r = run(other, 'result', {}, { shards: undefined });
    expect(r.data).toMatchObject({ state: 'warning', onlyServer: '' });
    expect(r.data.message).toContain('передача сейчас недоступна');
    expect(run(fixture('site-warning.html'), 'result', {}).error).toBe('not_logged_in');
  });

  it('подтверждение сайта осталось на экране → «Да» нажимается один раз', () => {
    mount(fixture('site-promoitems.html'), { mode: 'result' });
    document.querySelector('.modals').style.display = 'block';
    const yes = vi.fn(); document.querySelector('.js-transfer-done').addEventListener('click', yes);
    exec(); exec();
    expect(yes).toHaveBeenCalledTimes(1);
  });
});
