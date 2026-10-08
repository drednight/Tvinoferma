// «Сундук караванщика»: открытие сундуков из инвентаря на сайте. Режим задаёт Rust: window.__TF_CARAVAN = { mode, ... }.
// Настоящие страницы: tests/fixtures/site-promoitems-caravan.html (список), site-chest-activate.html (открытый сундук).
//   scan   — только чтение, страница /promo_items.php: какие «Сундуки караванщика» лежат в инвентаре.
//            Ответ: { state: 'scan', chests: [{ cartId, until }], other }, other — сундуки других видов (их не трогаем).
//   fill   — страница /promo_items.php?do=activate&cart_id=N: отмечает ВСЕ предметы сундука (ничего не отправляет).
//            Ответ: { state: 'ready', cartId, count, names, sig }.
//   click  — повторно проверяет отметки и нажимает кнопку отправки формы ОДИН раз. Ответ пишется только при отказе.
//   after  — только чтение после нажатия: ждёт, пока откроется новая страница (метка window.__TF_CARAVAN_MARK пропадает),
//            и коротко описывает её. Ответ: { state: 'after', title, text, hasForm }.
// Ответ: #TF_CARAVAN_V1_<json> = { data, error }. Все тексты и селекторы: selectors.json (caravan.*, transfer.*).
(function () {
  function report(data, error) {
    var payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_CARAVAN_V1_' + encodeURIComponent(JSON.stringify(payload));
  }
  var TF = window.__TF;
  if (!TF) { report(null, 'config_missing'); return; }
  var cfg = window.__TF_CARAVAN || {};
  var mode = cfg.mode || 'scan';

  function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function textOf(el) { return squash(el.innerText || el.textContent); }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function cartIdOf(url) {
    var m = TF.match('caravan.cartId', String(url || ''));
    return m ? m[1] : '';
  }
  function pending() { return document.readyState === 'complete' ? 'complete' : 'loading'; }

  // Один сундук на странице списка: { cartId, until, name } или null, если это не сундук с ссылкой «Активировать»
  function readChest(box) {
    var label = TF.q('transfer.label', box);
    var link = box.tagName === 'A' ? box : TF.q('caravan.link', box);
    if (!link) return null;
    var clone = label ? label.cloneNode(true) : null;
    var until = '';
    if (clone) {
      var u = TF.q('transfer.until', clone);
      if (u) { until = textOf(u).replace(/^\(\s*до\s*/i, '').replace(/\)\s*$/, ''); u.remove(); }
    }
    return {
      cartId: cartIdOf(link.getAttribute('href') || link.href),
      until: until,
      name: squash(clone ? clone.textContent : box.getAttribute('title')).substring(0, 120)
    };
  }

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var bodyText = squash((document.body && document.body.innerText) || '');
    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(bodyText.substring(0, 240), 'not_logged_in'); return; }

    if (mode === 'scan') {
      // Страница прогружена, когда есть форма передачи или заголовок «Передача предметов»
      var heading = TF.q('transfer.title');
      var loaded = !!TF.q('transfer.form') || (heading && TF.has(textOf(heading), 'transfer.titleText'));
      if (!loaded) { report(pending(), 'pending'); return; }
      var mine = [];
      var other = 0;
      TF.qa('transfer.chest').forEach(function (box) {
        var c = readChest(box);
        if (!c || !c.cartId) return;
        if (TF.has(c.name, 'caravan.chestName')) mine.push({ cartId: c.cartId, until: c.until });
        else other++;
      });
      report({ state: 'scan', chests: mine.slice(0, 60), other: other }, null);
      return;
    }

    if (mode === 'fill' || mode === 'click') {
      var want = String(cfg.cartId || '');
      if (!want || cartIdOf(window.location.href) !== want) { report(pending(), 'pending'); return; }
      var form = TF.q('caravan.form');
      if (!form || cartIdOf(form.getAttribute('action')) !== want) {
        // Страница загрузилась, но формы этого сундука нет: сундук уже открыт или недоступен
        report(pending(), document.readyState === 'complete' ? 'chest_not_found' : 'pending');
        return;
      }
      var boxes = TF.qa('caravan.itemBox', form).filter(function (b) { return !b.disabled; });
      if (!boxes.length) { report(null, 'no_items'); return; }
      var submit = TF.q('caravan.submit', form);
      if (!submit) { report(null, 'button_not_found'); return; }

      if (mode === 'fill') {
        boxes.forEach(function (b) { b.checked = true; });
        var names = boxes.map(function (b) {
          var l = b.parentNode ? TF.q('caravan.itemLabel', b.parentNode) : null;
          return squash(l ? l.textContent : b.value).substring(0, 80);
        });
        report({ state: 'ready', cartId: want, count: boxes.length, names: names, sig: hash(bodyText.toLowerCase()) }, null);
        return;
      }

      // click: отмечено ровно то, что было при fill
      var checked = boxes.filter(function (b) { return b.checked; }).length;
      if (checked !== boxes.length || (cfg.count && Number(cfg.count) !== checked)) { report(checked, 'selection_changed'); return; }
      window.__TF_CARAVAN_MARK = true;
      submit.click();
      return;
    }

    if (mode === 'after') {
      // Старая страница ещё не ушла: метка стоит, ждём новую
      if (window.__TF_CARAVAN_MARK) { report(pending(), 'pending'); return; }
      if (document.readyState !== 'complete') { report('loading', 'pending'); return; }
      var head = TF.q('transfer.title');
      report({
        state: 'after',
        title: head ? textOf(head).substring(0, 120) : squash(document.title).substring(0, 120),
        text: bodyText.substring(0, 160),
        hasForm: !!TF.q('caravan.form')
      }, null);
      return;
    }
    report(null, 'bad_mode');
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
