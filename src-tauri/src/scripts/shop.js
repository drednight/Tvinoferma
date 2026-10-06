// Магазин подарков /chests2.php и «История монет» /chests2.php?do=history: чтение и покупка за Древние монеты.
// Режим задаёт Rust: window.__TF_SHOP = { mode, wanted, target, expectPrice, baseline }.
// Настоящие страницы: tests/fixtures/site-shop.html, site-shop-history.html. Все селекторы и тексты: selectors.json (shop.*).
//   scan    — только чтение: аккаунт, баланс и данные нужных предметов (cfg.wanted — названия).
//   inspect — только чтение: можно ли купить cfg.target сейчас (цена, лимит, баланс). Ответ при успехе: { state: 'ready', sig, label, balance, item }.
//   click   — нажимает «Купить» ОДИН раз и подтверждает окно «Вы хотите купить…?» кнопкой «Да», как человек.
//             Rust выполняет его единственный раз и не повторяет. Ответ пишется только при отказе (error).
//   after   — только чтение: страница после покупки. Пока текст страницы совпадает с baseline — pending.
//   history — только чтение: «История монет» (последние 10 записей).
// Ответ: #TF_SHOP_V1_<json> = { data, error }.
(function () {
  function report(data, error) {
    var payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_SHOP_V1_' + encodeURIComponent(JSON.stringify(payload));
  }
  var TF = window.__TF; // селекторы и тексты: selectors.json
  if (!TF) { report(null, 'config_missing'); return; }
  var cfg = window.__TF_SHOP || {};
  var mode = cfg.mode || 'scan';

  function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function textOf(el) { return squash(el.innerText || el.textContent); }
  function norm(s) { return squash(s).toLowerCase().replace(/\u0451/g, '\u0435'); }
  function baseName(s) { return squash(String(s).replace(/\s*\([^)]*\)\s*$/, '')); }
  function hidden(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return true;
      var st = window.getComputedStyle ? window.getComputedStyle(n) : null;
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
    }
    return false;
  }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  // Копия parseCoins из js/core/coins.js (как и в balance.js; совпадение проверяет tests/coins.test.js)
  /*PARSE_START*/
  function parseCoins(text) {
    let s = String(text == null ? '' : text).replace(/[\s\u00a0\u202f\u2009]/g, '').replace(/[^0-9.,]/g, '');
    if (!/[0-9]/.test(s)) return NaN;
    s = s.replace(/[.,]+$/, '').replace(/^[.,]/, '0$&');
    const hasDot = s.indexOf('.') !== -1;
    const hasComma = s.indexOf(',') !== -1;
    let num;
    if (hasDot && hasComma) {
      // Оба знака: десятичным считается тот, что стоит последним ("1.285,5" и "1,285.5" → 1285.5)
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      const thousands = dec === '.' ? ',' : '.';
      if (s.split(dec).length > 2) return NaN;
      const groups = s.slice(0, s.lastIndexOf(dec)).split(thousands);
      if (!groups.slice(1).every((g) => g.length === 3)) return NaN;
      num = s.split(thousands).join('').replace(dec, '.');
    } else if (hasDot || hasComma) {
      const sep = hasDot ? '.' : ',';
      const parts = s.split(sep);
      if (parts.length > 2) {
        // Несколько одинаковых знаков — это разделители тысяч ("1,285,000"); группы по 3 цифры
        if (!parts.slice(1).every((p) => p.length === 3)) return NaN;
        num = parts.join('');
      } else if (parts[1].length === 3 && parts[0] !== '' && parts[0] !== '0' && parts[0].length <= 3) {
        // Ровно 3 цифры после знака и 1–3 цифры перед ним: "1,285" — тысячи
        num = parts.join('');
      } else {
        // Иначе дробная часть: "28,5", "28,50", "0,285"
        num = parts[0] + '.' + parts[1];
      }
    } else {
      num = s;
    }
    const v = parseFloat(num);
    // Лишние знаки после первого отбрасываются (округление вниз): 0,285 → 0,2
    return isFinite(v) ? Math.floor(v * 10 + 1e-6) / 10 : NaN;
  }
  /*PARSE_END*/
  function absUrl(src) {
    var s = squash(src);
    if (!s) return '';
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('/') === 0) return 'https://pwonline.ru' + s;
    return s;
  }
  // Описание предмета построчно: переносы <br> становятся строками, «Доступно Вам» и «Максимальное количество» убираются (читаются отдельно)
  function describe(el) {
    if (!el) return '';
    var clone = el.cloneNode(true);
    var brs = clone.querySelectorAll('br');
    for (var i = 0; i < brs.length; i++) brs[i].parentNode.replaceChild(document.createTextNode('\n'), brs[i]);
    return String(clone.textContent || '').split('\n').map(squash).filter(function (line) {
      return line && !TF.match('shop.available', line) && !TF.match('shop.maxMonth', line);
    }).join('\n').substring(0, 700);
  }

  function readItem(li) {
    var titleEl = TF.q('shop.title', li);
    if (!titleEl) return null;
    var priceEl = TF.q('shop.price', li);
    var valueEl = priceEl ? (TF.q('shop.priceValue', priceEl) || priceEl) : null;
    var price = valueEl ? parseCoins(valueEl.textContent) : NaN;
    var link = TF.q('shop.buyLink', li);
    var href = link ? (link.getAttribute('href') || '') : '';
    var idm = TF.match('shop.itemId', href);
    var km = TF.match('shop.kind', href);
    var infoEl = TF.q('shop.infoText', li);
    var info = infoEl ? String(infoEl.textContent || '') : '';
    var am = TF.match('shop.available', info);
    var mm = TF.match('shop.maxMonth', info);
    var img = TF.q('shop.image', li);
    return {
      name: squash(titleEl.textContent),
      id: idm ? idm[1] : '',
      kind: km ? km[1] : '',
      price: isFinite(price) ? price : null,
      label: link ? squash(link.textContent) : '',
      hasLink: !!link,
      available: am ? Number(am[1]) : null,
      max: mm ? Number(mm[1]) : null,
      blocked: !!TF.q('shop.blocked', li),
      desc: describe(infoEl),
      image: img ? absUrl(img.getAttribute('src')) : ''
    };
  }

  // Предмет по названию: точное совпадение, затем без скобок («Знак доблести (25 штук)» → «Знак доблести»); неоднозначное — не найдено
  function findItem(name, all) {
    var n = norm(name);
    var b = norm(baseName(name));
    var titles = all.map(function (li) {
      var t = TF.q('shop.title', li);
      return { li: li, title: t ? squash(t.textContent) : '' };
    });
    var exact = titles.filter(function (x) { return norm(x.title) === n; });
    if (exact.length === 1) return { li: exact[0].li, ambiguous: false };
    if (exact.length > 1) return { li: null, ambiguous: true };
    var base = titles.filter(function (x) { return norm(baseName(x.title)) === b; });
    if (base.length === 1) return { li: base[0].li, ambiguous: false };
    return { li: null, ambiguous: base.length > 1 };
  }

  function readBalance() {
    var box = TF.q('balance.container');
    if (!box) return { error: 'container_missing' };
    var tag = TF.q('balance.value', box);
    if (!tag) return { error: 'no_value_tag' };
    var v = parseCoins(tag.textContent);
    return isNaN(v) ? { error: 'parse_nan' } : { value: v };
  }

  function readAccount() {
    var el = TF.q('shop.account');
    return el ? squash(el.textContent).substring(0, 60) : '';
  }

  // Данные страницы: аккаунт, баланс и нужные предметы
  function scanData(all) {
    var bal = readBalance();
    if (bal.error) return { error: bal.error };
    var wanted = Array.isArray(cfg.wanted) ? cfg.wanted : [];
    var items = wanted.map(function (name) {
      var f = findItem(name, all);
      var item = f.li ? readItem(f.li) : null;
      if (!item) return { want: name, found: false, ambiguous: f.ambiguous };
      item.want = name;
      item.found = true;
      return item;
    });
    return { data: { state: 'scan', account: readAccount(), balance: bal.value, items: items } };
  }

  // Проверки перед покупкой cfg.target: код ошибки или null, если можно покупать
  function checkTarget(item, balance) {
    if (!item) return { error: 'item_missing', data: null };
    if (item.price == null) return { error: 'price_unreadable', data: null };
    if (cfg.expectPrice != null && Math.abs(item.price - Number(cfg.expectPrice)) > 0.001) return { error: 'price_changed', data: { price: item.price, available: item.available } };
    if (item.blocked || item.available === 0) return { error: 'limit_reached', data: { price: item.price, available: item.available } };
    if (!item.hasLink) return { error: 'button_not_found', data: null };
    if (balance < item.price) return { error: 'no_funds', data: { price: item.price, balance: balance } };
    return null;
  }

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var bodyText = squash((document.body && document.body.innerText) || '');
    var sig = hash(bodyText.toLowerCase());

    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(bodyText.substring(0, 240), 'not_logged_in'); return; }

    if (mode === 'history') {
      var rows = TF.qa('shop.historyRows');
      if (!rows.length) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }
      var list = [];
      rows.forEach(function (tr) {
        var c = tr.cells;
        if (!c || c.length < 5) return;
        var at = squash(c[0].textContent);
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at)) return;
        var d = squash(c[1].textContent);
        var delta = parseCoins(d.replace(/^-/, ''));
        var before = parseCoins(c[2].textContent);
        var after = parseCoins(c[3].textContent);
        list.push({
          at: at,
          delta: isNaN(delta) ? null : (/^-/.test(d) ? -delta : delta),
          before: isNaN(before) ? null : before,
          after: isNaN(after) ? null : after,
          action: squash(c[4].textContent).substring(0, 160)
        });
      });
      report({ state: 'history', account: readAccount(), rows: list }, null);
      return;
    }

    var all = TF.qa('shop.item');
    if (mode === 'after' && cfg.baseline && sig === cfg.baseline) {
      report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending');
      return;
    }
    if (!all.length) {
      if (mode === 'after') { report(bodyText.substring(0, 240), 'other_page'); return; }
      report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending');
      return;
    }

    if (mode === 'scan' || mode === 'after') {
      var scan = scanData(all);
      if (scan.error) { report(null, scan.error); return; }
      scan.data.sig = sig;
      report(scan.data, null);
      return;
    }

    // inspect / click: один предмет
    var scanned = scanData(all);
    if (scanned.error) { report(null, scanned.error); return; }
    var found = findItem(cfg.target || '', all);
    var item = found.li ? readItem(found.li) : null;
    var problem = checkTarget(item, scanned.data.balance);
    if (problem) { report(problem.data, problem.error); return; }

    if (mode === 'click') {
      var li = found.li;
      var link = TF.q('shop.buyLink', li);
      var hrefOk = !!TF.match('shop.buyHref', link.getAttribute('href') || '');
      if (!hrefOk) { report(null, 'button_not_found'); return; }
      // Страница сама показывает окно подтверждения. Если её скрипт не сработал, ссылка перешла бы к покупке
      // без подтверждения: такой переход останавливаем.
      var stopped = false;
      link.addEventListener('click', function (e) { if (!e.defaultPrevented) { e.preventDefault(); stopped = true; } });
      link.click();
      if (stopped) { report(null, 'modal_missing'); return; }
      setTimeout(function () {
        var modal = TF.q('shop.modal');
        var yes = TF.q('shop.modalConfirm');
        var title = TF.q('shop.modalTitle');
        if (!modal || !yes || !title || hidden(modal)) { report(null, 'modal_missing'); return; }
        if (norm(textOf(title)) !== norm(item.name)) { report(textOf(title).substring(0, 80), 'modal_mismatch'); return; }
        var href = yes.getAttribute('href') || '';
        var idm = TF.match('shop.itemId', href);
        if (!TF.match('shop.buyHref', href) || !idm || idm[1] !== item.id) { report(null, 'modal_mismatch'); return; }
        yes.click();
      }, 400);
      return;
    }

    report({ state: 'ready', sig: sig, label: item.label, balance: scanned.data.balance, account: scanned.data.account, item: item }, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
