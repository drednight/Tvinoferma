// Страница «Передача предметов в игру» (/promo_items.php) в ВИДИМОМ окне персонажа (Issue #26):
//  1) снимает клиентский лимит сайта «за один раз возможно перевести не более 6 предметов» (решение владельца);
//  2) рисует слева, под панелью «Помощник входа», сворачиваемую панель «Типы предметов» с переключателем «По типам | По акциям»:
//     «По типам» — только типы, что есть на странице (строка «Тип:» в описании предмета);
//     «По акциям» — акции в порядке страницы (галочки под заголовком акции — до следующей акции);
//     у каждой строки — «Отметить» и «Снять», внизу — скрытый по умолчанию список «какой предмет к какой группе относится».
// Скрипт вшит как initialization_script, поэтому срабатывает в каждом документе окна до скриптов сайта и сам проверяет адрес.
//
// Лимит: сайт ограничивает число отмеченных предметов обработчиками click/change на галочках. Мы ставим свои обработчики
// в фазе перехвата на window и не пропускаем эти события дальше — обработчики сайта не вызываются, а сама галочка
// отмечается/снимается как обычно. Ничего не отправляется и не нажимается: «Передать» пользователь нажимает сам.
// Ограничения сервера не затрагиваются. Панель — closed shadow DOM, как у «Помощника входа».
(function () {
  if (window.top !== window || window.__tfUnlimitedItems) return;
  const path = String(location.pathname || '');
  const query = String(location.search || '');
  if (!/\/promo_items\.php$/i.test(path) || /[?&]do=history\b/i.test(query)) return;
  try {
    Object.defineProperty(window, '__tfUnlimitedItems', { value: true, configurable: true });
  } catch (e) {
    window.__tfUnlimitedItems = true;
  }

  const SEL = 'input[type="checkbox"][name="cart_items[]"]';
  const HOST_ID = '__tf_items_panel__';
  const LOGIN_ID = '__tf_login_panel__';
  const STORE_KEY = '__tf_ip_collapsed';
  const MODE_KEY = '__tf_ip_mode';
  const NO_TYPE = 'Без типа';
  const NO_PROMO = 'Без акции';
  const HEAD_SEL = '.promo_container_content_body';
  const doc = document;
  const create = Document.prototype.createElement;
  const attach = Element.prototype.attachShadow;
  const later = window.setTimeout.bind(window);
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /* ---------------------------- лимит ---------------------------- */

  const isItemBox = (el) => !!(el && el.nodeType === 1 && el.matches && el.matches(SEL));
  const guard = (e) => {
    if (!isItemBox(e.target)) return;
    e.stopImmediatePropagation();
    later(refresh, 0);
  };
  ['click', 'change', 'input'].forEach((type) => window.addEventListener(type, guard, true));

  /* ------------------------ чтение страницы ------------------------ */

  const boxes = () => Array.prototype.slice.call(doc.querySelectorAll(SEL)).filter((b) => !b.disabled);

  /** «Тип: Пропуск» из описания предмета (строки описания разделены <br>). */
  function typeOf(row) {
    const span = row && row.querySelector('.img_item_cont span');
    if (!span) return NO_TYPE;
    const parts = span.innerHTML.split(/<br\s*\/?>/i);
    for (let i = 0; i < parts.length; i++) {
      const t = squash(parts[i].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
      const m = /^Тип:\s*(.+)$/.exec(t);
      if (m) return squash(m[1]);
    }
    return NO_TYPE;
  }

  /** Название с количеством: «Метеорит x100» (срок «до …» не берём). */
  function nameOf(row) {
    const label = row && row.querySelector('label');
    if (!label) return 'Предмет';
    const c = label.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.date_end'), (n) => n.remove());
    return squash(c.textContent) || 'Предмет';
  }

  /** Акция предмета: ближайший заголовок акции перед блоком `.promo_container` (так же, как sourceOf в transfer.js). */
  function promoOf(row) {
    const cont = row && row.closest('.promo_container');
    for (let n = cont && cont.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.matches && n.matches(HEAD_SEL)) {
        const h = n.querySelector('h6');
        return squash(h ? h.textContent : '').substring(0, 120) || NO_PROMO;
      }
    }
    return NO_PROMO;
  }

  function readItems() {
    return boxes().map((box) => {
      const row = box.closest('tr');
      return { box: box, name: nameOf(row), type: typeOf(row), promo: promoOf(row), row: row };
    });
  }

  /** Группы по ключу: типы — по алфавиту («Без типа» в конце), акции — в порядке страницы («Без акции» в конце). */
  function group(items, key) {
    const map = {};
    const order = [];
    items.forEach((it) => {
      if (!map[it[key]]) { map[it[key]] = []; order.push(it[key]); }
      map[it[key]].push(it);
    });
    const none = key === 'type' ? NO_TYPE : NO_PROMO;
    order.sort((a, b) => (a === none) - (b === none) || (key === 'type' ? a.localeCompare(b, 'ru') : 0));
    return order.map((name) => ({ type: name, items: map[name], first: map[name][0] }));
  }

  /* ----------------------------- панель ---------------------------- */

  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}',
    '.card{width:270px;max-height:var(--tf-max,70vh);overflow:auto;background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 10px 10px 0;padding:10px;box-shadow:0 4px 18px rgba(0,0,0,.45);font-size:12px}',
    '.tab{background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 8px 8px 0;padding:10px 6px;cursor:pointer;font-size:12px;writing-mode:vertical-rl}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}',
    '.title{font-weight:700;color:#f0b84a;font-size:13px}',
    '.muted{color:#9aa0ad;font-size:11px}',
    '.count{margin:6px 0;font-weight:700}',
    '.bar{display:flex;gap:6px;margin-bottom:6px}',
    '.seg{display:flex;margin-bottom:6px}',
    '.seg button{flex:1;border-radius:0}',
    '.seg button:first-child{border-radius:5px 0 0 5px}',
    '.seg button:last-child{border-radius:0 5px 5px 0}',
    '.seg button.on{background:#f0b84a;color:#1c1f26;border-color:#f0b84a;font-weight:700}',
    '.tname.go{cursor:pointer}',
    '.tname.go:hover{color:#f0b84a;text-decoration:underline}',
    '.row{display:flex;align-items:center;gap:4px;padding:3px 0;border-top:1px solid #2d323d}',
    '.tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tcnt{color:#9aa0ad;font-size:11px;min-width:34px;text-align:right}',
    'button{background:#2d323d;color:#e8e8ea;border:1px solid #444a58;border-radius:5px;cursor:pointer;padding:2px 7px;font-size:12px}',
    'button:hover{border-color:#f0b84a}',
    'details{margin-top:8px;color:#e6c25a;font-size:11px}',
    'summary{cursor:pointer}',
    '.grp{color:#f0b84a;margin-top:6px;font-weight:700}',
    'ul{margin:2px 0 0;padding-left:16px;color:#e8e8ea;font-weight:400}'
  ].join('');

  let collapsed = false;
  try { collapsed = window.localStorage.getItem(STORE_KEY) === '1'; } catch (e) { collapsed = false; }
  let detailsOpen = false;          // список «какой предмет к какому типу» при запуске окна всегда скрыт
  let host = null;
  let box = null;                   // контейнер внутри shadow DOM
  let items = [];
  let groups = { type: [], promo: [] };
  let mode = 'type';                // 'type' | 'promo'
  try { if (window.localStorage.getItem(MODE_KEY) === 'promo') mode = 'promo'; } catch (e) { mode = 'type'; }
  let totalEl = null;
  let countEls = [];                // [{ el, items }]

  const make = (tag, cls, text) => {
    const n = create.call(doc, tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const checkedIn = (list) => list.filter((it) => it.box.checked).length;

  function setChecked(list, value) {
    list.forEach((it) => { it.box.checked = value; });
    refresh();
  }

  function refresh() {
    if (totalEl) totalEl.textContent = 'Отмечено: ' + checkedIn(items) + ' из ' + items.length;
    countEls.forEach((c) => { c.el.textContent = checkedIn(c.items) + '/' + c.items.length; });
  }

  /** Под панелью «Помощник входа»: её высота меняется (свёрнута/развёрнута), поэтому положение пересчитывается. */
  function place() {
    if (!host) return;
    const login = doc.getElementById(LOGIN_ID);
    let top = 90;
    if (login) {
      const r = login.getBoundingClientRect();
      if (r && r.bottom > 0) top = Math.round(r.bottom) + 10;
    }
    host.style.top = top + 'px';
    host.style.setProperty('--tf-max', Math.max(120, (window.innerHeight || 800) - top - 16) + 'px');
  }

  function draw() {
    box.textContent = '';
    countEls = [];
    totalEl = null;
    if (collapsed) {
      const tab = make('button', 'tab', '🎁 Типы предметов');
      tab.title = 'Развернуть';
      tab.addEventListener('click', () => setCollapsed(false));
      box.appendChild(tab);
      return;
    }
    const card = make('div', 'card');
    const head = make('div', 'head');
    head.appendChild(make('div', 'title', '🎁 Типы предметов'));
    const min = make('button', '', '–');
    min.title = 'Свернуть';
    min.addEventListener('click', () => setCollapsed(true));
    head.appendChild(min);
    card.appendChild(head);
    card.appendChild(make('div', 'muted', 'Лимит сайта «6 предметов» снят. Отметьте нужные типы и нажмите «Передать» сами.'));
    totalEl = make('div', 'count');
    card.appendChild(totalEl);

    const bar = make('div', 'bar');
    const all = make('button', '', 'Отметить все');
    all.addEventListener('click', () => setChecked(items, true));
    const none = make('button', '', 'Снять все');
    none.addEventListener('click', () => setChecked(items, false));
    bar.appendChild(all);
    bar.appendChild(none);
    card.appendChild(bar);

    const seg = make('div', 'seg');
    [['type', 'По типам'], ['promo', 'По акциям']].forEach((m) => {
      const b = make('button', mode === m[0] ? 'on' : '', m[1]);
      b.title = m[0] === 'type' ? 'Группы по типу предмета' : 'Группы по акциям: галочки под заголовком акции — до следующей акции';
      b.addEventListener('click', () => setMode(m[0]));
      seg.appendChild(b);
    });
    card.appendChild(seg);

    const unit = mode === 'type' ? 'типа' : 'акции';
    groups[mode].forEach((g) => {
      const row = make('div', 'row');
      const name = make('span', 'tname', g.type);
      name.title = g.type;
      if (mode === 'promo') {
        name.classList.add('go');
        name.title = g.type + ' — нажмите, чтобы перейти к акции на странице';
        name.addEventListener('click', () => {
          const target = g.first && g.first.row;
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
        });
      }
      const cnt = make('span', 'tcnt');
      countEls.push({ el: cnt, items: g.items });
      const on = make('button', '', 'Отметить');
      on.title = 'Отметить все предметы ' + unit + ' «' + g.type + '»';
      on.addEventListener('click', () => setChecked(g.items, true));
      const off = make('button', '', 'Снять');
      off.title = 'Снять отметку со всех предметов ' + unit + ' «' + g.type + '»';
      off.addEventListener('click', () => setChecked(g.items, false));
      [name, cnt, on, off].forEach((n) => row.appendChild(n));
      card.appendChild(row);
    });

    const det = make('details');
    if (detailsOpen) det.open = true;
    det.addEventListener('toggle', () => { detailsOpen = det.open; });
    det.appendChild(make('summary', '', mode === 'type' ? '📋 Какие предметы к какому типу относятся' : '📋 Какие предметы в какой акции'));
    groups[mode].forEach((g) => {
      det.appendChild(make('div', 'grp', g.type + ' (' + g.items.length + ')'));
      const ul = make('ul');
      g.items.forEach((it) => ul.appendChild(make('li', '', it.name)));
      det.appendChild(ul);
    });
    card.appendChild(det);
    box.appendChild(card);
    refresh();
    place();
  }

  function setMode(m) {
    mode = m;
    try { window.localStorage.setItem(MODE_KEY, m); } catch (e) { /* не критично */ }
    draw();
    later(place, 0);
  }

  function setCollapsed(v) {
    collapsed = v;
    try { window.localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (e) { /* не критично */ }
    draw();
    later(place, 0);
  }

  function mount() {
    items = readItems();
    if (!items.length) return false;
    groups = { type: group(items, 'type'), promo: group(items, 'promo') };
    const old = doc.getElementById(HOST_ID);
    if (old) old.remove();
    host = make('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:90px;left:0;z-index:2147483646;';
    const root = attach.call(host, { mode: 'closed' });
    const style = make('style');
    style.textContent = CSS;
    root.appendChild(style);
    box = make('div');
    root.appendChild(box);
    draw();
    (doc.body || doc.documentElement).appendChild(host);
    place();
    // «Помощник входа» может появиться позже и менять размер: следим за ним
    const watch = () => {
      const login = doc.getElementById(LOGIN_ID);
      if (login && window.ResizeObserver && !watch.done) {
        watch.done = true;
        new window.ResizeObserver(place).observe(login);
      }
      place();
    };
    let ticks = 0;
    const timer = window.setInterval(() => { watch(); if (++ticks > 30) window.clearInterval(timer); }, 500);
    window.addEventListener('resize', place);
    return true;
  }

  function init() {
    if (mount()) return;
    // Сайт может дорисовать список позже: панель появится, как только есть галочки
    if (window.MutationObserver) {
      const mo = new window.MutationObserver(() => { if (mount()) mo.disconnect(); });
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      later(() => mo.disconnect(), 15000);
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
