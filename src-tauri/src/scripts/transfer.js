// Передача предметов в игру на странице /promo_items.php (Issue #26). Режим задаёт Rust: window.__TF_XFER = { mode, ... }.
// Настоящие страницы: tests/fixtures/site-promoitems*.html. Страница сама подставляет в список серверов и персонажей
// данные из переменной `shards` (promo_items.js), а «Передать» отправляет форму `.js-transfer-form` (POST).
//   scan   — только чтение: что ждёт передачи (предметы, сундуки) и на какие серверы и к каким персонажам можно передать.
//            Ответ: { state: 'scan', siteId, accountName, shards, items, chests, locked, empty }.
//   fill   — НИЧЕГО НЕ ОТПРАВЛЯЕТ: выбирает сервер и персонажа в списках сайта и отмечает ВСЕ предметы (лимит сайта в 6 штук
//            проверяется только при клике по галочке, поэтому программная отметка его не включает).
//            Ответ: { state: 'ready', count, items, shard, char, sig }.
//   click  — повторно проверяет выбор и нажимает «Передать» ОДИН раз; если сайт показал свой диалог «Вы уверены…»
//            (настройка «Получать подтверждение…»), нажимает в нём «Да» тоже один раз. Ответ пишется только при отказе.
//   result — только чтение: страница «История передачи» (?do=history). Ответ: { state: 'history', rows } — строки самой
//            новой передачи; решение «успех или нет» принимает приложение (transferCore.js), сверяя их с отправленным.
// Ответ: #TF_XFER_V1_<json> = { data, error }. Все тексты и селекторы: selectors.json (transfer.*).
(function () {
  function report(data, error) {
    var payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_XFER_V1_' + encodeURIComponent(JSON.stringify(payload));
  }
  var TF = window.__TF; // селекторы и тексты: selectors.json
  if (!TF) { report(null, 'config_missing'); return; }
  var cfg = window.__TF_XFER || {};
  var mode = cfg.mode || 'scan';

  function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function textOf(el) { return squash(el.innerText || el.textContent); }
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
  function fire(sel) {
    if (window.jQuery) window.jQuery(sel).trigger('change');
    else sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Заголовок акции над таблицей предметов («Идеальный шанс», «Летние бонусы арены Авроры»)
  function sourceOf(row) {
    var box = row.closest('.promo_container') || row.parentElement;
    var heads = TF.qa('transfer.promoHead');
    for (var n = box && box.previousElementSibling; n; n = n.previousElementSibling) {
      if (heads.indexOf(n) !== -1) {
        var h = TF.q('transfer.promoTitle', n);
        return h ? textOf(h).substring(0, 120) : '';
      }
    }
    return '';
  }
  // «Тайная пилюля: Покой  x2(до 21:01 29.03.2027)» → { name, qty, until }
  function parseLabel(label) {
    var clone = label.cloneNode(true);
    var untilEl = TF.q('transfer.until', clone);
    var until = untilEl ? textOf(untilEl).replace(/^\(\s*до\s*/i, '').replace(/\)\s*$/, '') : '';
    if (untilEl) untilEl.remove();
    var text = squash(clone.textContent);
    var m = TF.match('transfer.item', text);
    return { name: squash(m ? m[1] : text).substring(0, 120), qty: m && m[2] ? Number(m[2]) : 1, until: until };
  }
  // Предметы страницы: те, что можно передать (есть галочка), сундуки (их выбирают на сайте) и строки без галочки
  function readItems() {
    var out = { items: [], chests: 0, locked: 0 };
    TF.qa('transfer.row').forEach(function (row) {
      if (TF.q('transfer.chest', row)) { out.chests++; return; }
      var block = TF.q('transfer.itemBlock', row);
      if (!block) return;
      var label = TF.q('transfer.label', block);
      var box = TF.q('transfer.checkbox', block);
      if (!label) return;
      if (!box || box.disabled) { out.locked++; return; }
      var info = parseLabel(label);
      out.items.push({ id: String(box.value), name: info.name, qty: info.qty, until: info.until, source: sourceOf(row) });
    });
    return out;
  }
  // Серверы и персонажи из переменной страницы `shards` (на странице её объявляет сам сайт); null — переменной нет
  function readShards() {
    var raw = window.shards;
    if (raw == null || typeof raw !== 'object') return null;
    var list = [];
    Object.keys(raw).forEach(function (k) {
      var sh = raw[k];
      if (!sh || !sh.accounts) return;
      var chars = [];
      Object.keys(sh.accounts).forEach(function (ak) {
        var acc = sh.accounts[ak] || {};
        (acc.chars || []).forEach(function (c) {
          chars.push({
            key: String(acc.id) + '_' + String(sh.id) + '_' + String(c.id),
            account: String(acc.name || ''),
            name: squash(c.name),
            cls: squash(c.occupation),
            level: Number(c.level) || 0
          });
        });
      });
      list.push({ id: String(sh.id), name: squash(sh.name), chars: chars });
    });
    return list;
  }
  function siteId() {
    var id = window.olUid || (window.oauth_user_data && window.oauth_user_data.id) || '';
    return String(id).replace(/[^0-9A-Za-z_-]/g, '').substring(0, 40);
  }
  function pageError() {
    var el = TF.q('transfer.error');
    return el ? textOf(el).substring(0, 240) : null;
  }
  function confirmModal() {
    if (window.__TF_XFER_CONFIRMED) return;
    var modal = TF.q('transfer.modal');
    var yes = TF.q('transfer.modalYes');
    if (modal && yes && !hidden(modal)) { window.__TF_XFER_CONFIRMED = true; yes.click(); }
  }
  function selectedCount() {
    return TF.qa('transfer.checkbox').filter(function (b) { return b.checked; }).length;
  }

  // История передачи: строка таблицы → { name, qty, source, account, char, server, status, at }
  function readHistory() {
    var rows = [];
    TF.qa('transfer.historyRow').forEach(function (tr) {
      var tds = tr.querySelectorAll('td');
      if (tds.length < 4) return;
      var b = TF.q('transfer.name', tds[0]);
      var title = squash(b ? b.textContent : tds[0].textContent);
      var m = TF.match('transfer.historyItem', title);
      var small = TF.q('transfer.promoSmall', tds[0]);
      var pm = small ? TF.match('transfer.historyPromo', squash(small.textContent)) : null;
      var who = { account: '', char: '', server: '' };
      tds[1].innerHTML.split(/<br\s*\/?>/i).forEach(function (part) {
        var t = squash(part.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
        TF.texts('transfer.historyAccount').forEach(function (p) { if (t.indexOf(p) === 0) who.account = squash(t.substring(p.length)); });
        TF.texts('transfer.historyChar').forEach(function (p) { if (t.indexOf(p) === 0) who.char = squash(t.substring(p.length)); });
        TF.texts('transfer.historyServer').forEach(function (p) { if (t.indexOf(p) === 0) who.server = squash(t.substring(p.length)); });
      });
      var at = squash(tds[3].textContent);
      if (!TF.match('transfer.historyDate', at)) return;
      rows.push({
        name: squash(m ? m[1] : title).substring(0, 120),
        qty: m ? Number(m[2]) : 1,
        source: pm ? squash(pm[1]).substring(0, 120) : '',
        account: who.account, char: who.char, server: who.server,
        status: squash(tds[2].textContent).substring(0, 60),
        at: at
      });
    });
    return rows;
  }

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var bodyText = squash((document.body && document.body.innerText) || '');
    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(bodyText.substring(0, 240), 'not_logged_in'); return; }

    if (mode === 'result') {
      if (/[?&]do=history\b/.test(window.location.search)) {
        var rows = readHistory();
        if (!rows.length) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }
        report({ state: 'history', rows: rows.slice(0, 60) }, null);
        return;
      }
      // Всё ещё страница передачи: диалог сайта мог остаться неподтверждённым — подтверждаем один раз
      confirmModal();
      var err = pageError();
      if (err) { report(err, 'unknown'); return; }
      if (TF.q('transfer.form')) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }
      report(bodyText.substring(0, 240), 'unknown');
      return;
    }

    var shards = readShards();
    var form = TF.q('transfer.form');
    if (!form || shards === null) {
      var heading = TF.q('transfer.title');
      if (!form && mode === 'scan' && heading && TF.has(textOf(heading), 'transfer.titleText') && !TF.qa('transfer.row').length) {
        report({ state: 'scan', siteId: siteId(), accountName: '', shards: [], items: [], chests: 0, locked: 0, empty: true }, null);
        return;
      }
      report(document.readyState === 'complete' ? 'complete' : 'loading', mode === 'click' ? 'form_not_found' : 'pending');
      return;
    }

    if (mode === 'scan') {
      var read = readItems();
      var acc = TF.q('transfer.accountName');
      report({
        state: 'scan', siteId: siteId(), accountName: acc ? textOf(acc).substring(0, 60) : '',
        shards: shards, items: read.items, chests: read.chests, locked: read.locked, empty: false
      }, null);
      return;
    }

    // fill / click: списки сервера и персонажа заполняет promo_items.js после загрузки страницы
    var shardSel = TF.q('transfer.shard');
    var charSel = TF.q('transfer.char');
    var go = TF.q('transfer.go');
    if (!shardSel || !charSel || !go) { report(document.readyState === 'complete' ? 'complete' : 'loading', mode === 'click' ? 'form_not_found' : 'pending'); return; }
    if (!shardSel.options.length) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }

    var shardId = String(cfg.shard || '');
    var recipient = String(cfg.recipient || '');

    if (mode === 'fill') {
      var usable = TF.qa('transfer.checkbox').filter(function (b) { return !hidden(b) && !b.disabled; });
      if (!usable.length) { report(null, 'no_items'); return; }
      shardSel.value = shardId;
      if (shardSel.value !== shardId) { report(shardId, 'server_not_found'); return; }
      fire(shardSel);
      charSel.value = recipient;
      if (charSel.value !== recipient || !charSel.selectedOptions.length) { report(recipient, 'char_not_found'); return; }
      var shownName = squash(charSel.selectedOptions[0].textContent);
      if (cfg.charName && shownName.indexOf(String(cfg.charName)) !== 0) { report(shownName.substring(0, 80), 'char_mismatch'); return; }
      usable.forEach(function (b) { b.checked = true; });
      var read2 = readItems();
      var chosen = read2.items.filter(function (it) {
        return usable.some(function (b) { return String(b.value) === it.id; });
      });
      report({
        state: 'ready', count: selectedCount(), items: chosen,
        shard: { id: shardId, name: squash(shardSel.selectedOptions[0].textContent) },
        char: { key: recipient, text: shownName },
        sig: hash(bodyText.toLowerCase())
      }, null);
      return;
    }

    if (mode === 'click') {
      var boxes = TF.qa('transfer.checkbox').filter(function (b) { return b.checked; });
      if (!boxes.length) { report(0, 'no_items'); return; }
      if (cfg.count && boxes.length !== Number(cfg.count)) { report(boxes.length, 'selection_changed'); return; }
      if (shardSel.value !== shardId || charSel.value !== recipient) { report(null, 'selection_changed'); return; }
      window.__TF_XFER_CONFIRMED = false;
      go.click();
      // Диалог «Вы уверены…» сайт показывает сразу (если включено подтверждение); без него форма уходит сама
      confirmModal();
      setTimeout(confirmModal, 700);
      return;
    }
    report(null, 'bad_mode');
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
