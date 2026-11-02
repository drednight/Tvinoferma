// Активация промокода на странице /pin/<КОД> (Issue #25). Режим задаёт Rust: window.__TF_PIN = { mode, code, baseline }.
// Настоящая страница: форма POST /pin.php?do=activate, поле input#pin (код подставляет сам адрес /pin/<код>),
// кнопка input[type=submit] «Активировать» (tests/fixtures/site-pin-*.html). Ответы сайта: tests/fixtures/site-pin-result-*.html.
//   inspect — только чтение: вошёл ли игрок, подставлен ли код в поле, найдена ли ровно одна кнопка «Активировать».
//             Rust повторяет этот режим, пока страница не дорисуется. Ответ при успехе: { state: 'ready', label, sig }.
//   click   — нажимает кнопку «Активировать» ОДИН раз (Rust выполняет его единственный раз и не повторяет: повтор
//             мог бы активировать код дважды). Код в поле сам НЕ вводится. Ответ пишется только при отказе (error).
//   result  — только чтение: что ответил сайт после нажатия. baseline = sig страницы до нажатия: пока текст
//             не изменился, страница считается неотвеченной (pending). Успех: { state, detail, rewards }.
// Ответ: #TF_PIN_V1_<json> = { data, error }. Все тексты и селекторы: selectors.json (promo.*).
(function () {
  function report(data, error) {
    var payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_PIN_V1_' + encodeURIComponent(JSON.stringify(payload));
  }
  var TF = window.__TF; // селекторы и тексты: selectors.json
  if (!TF) { report(null, 'config_missing'); return; }
  var cfg = window.__TF_PIN || {};
  var mode = cfg.mode || 'inspect';

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
  function labelOf(el) { return squash(el.tagName === 'INPUT' ? el.value : el.textContent).toLowerCase(); }
  function ready(el) { return !hidden(el) && !el.disabled; }
  // Форма ввода кода: поле `pin` (form[action*="pin.php"] > input#pin + submit «Активировать»)
  function findForm() {
    var inputs = TF.qa('promo.input').filter(function (el) { return !hidden(el); });
    for (var i = 0; i < inputs.length; i++) {
      var f = inputs[i].form || inputs[i].closest('form');
      if (f) return { form: f, input: inputs[i] };
    }
    return null;
  }
  // Кнопки отправки В ЭТОЙ форме, подпись которых ЦЕЛИКОМ совпадает с «Активировать» (или запасной подписью
  // из selectors.json); посторонние кнопки страницы (выход, меню) не рассматриваются.
  function findButtons(form) {
    var labels = TF.texts('promo.buttonLabels');
    return TF.qa('promo.controls', form).filter(function (el) {
      return ready(el) && labels.indexOf(labelOf(el)) !== -1;
    });
  }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function choiceNeeded(form) {
    return TF.qa('promo.choice', form).some(function (sel) { return !hidden(sel) && sel.options && sel.options.length > 1; });
  }
  // Сообщение об ошибке на странице (`.m_error`) → код ошибки или null, если сообщения нет
  function pageError() {
    var el = TF.q('promo.error');
    if (!el) return null;
    var text = textOf(el);
    var lower = text.toLowerCase();
    var kind = 'unknown';
    if (TF.has(lower, 'promo.empty')) kind = 'code_empty';
    else if (TF.has(lower, 'promo.used')) kind = 'already_used';
    else if (TF.has(lower, 'promo.expired')) kind = 'expired';
    else if (TF.has(lower, 'promo.invalid')) kind = 'invalid_code';
    return { kind: kind, text: text.substring(0, 240) };
  }
  // Награды со страницы успеха: «Метеорит x 100 (ID: 47493), привязанный»
  function readRewards() {
    return TF.qa('promo.rewards').map(function (li) {
      var text = textOf(li);
      var m = TF.match('promo.reward', text);
      if (!m) return { name: text.substring(0, 120), qty: 1, id: null, bound: false };
      return {
        name: squash(m[1]).substring(0, 120),
        qty: m[2] ? Number(m[2]) : 1,
        id: m[3] || null,
        bound: /привязан/i.test(m[4] || '') && !/не\s+привязан/i.test(m[4] || '')
      };
    }).filter(function (r) { return r.name; });
  }

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var bodyText = squash((document.body && document.body.innerText) || '');
    var sig = hash(bodyText.toLowerCase());

    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(bodyText.substring(0, 240), 'not_logged_in'); return; }

    var err = pageError();

    if (mode === 'result') {
      if (sig === cfg.baseline) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }
      if (err) { report(err.text, err.kind); return; }
      if (TF.q('promo.rewardsBox') || TF.has(bodyText.toLowerCase(), 'promo.success')) {
        var heading = TF.qa('promo.title').filter(function (h) { return TF.has(textOf(h).toLowerCase(), 'promo.success'); })[0];
        var title = heading ? textOf(heading) : 'Код активирован';
        report({ state: 'success', detail: title.substring(0, 240), rewards: readRewards() }, null);
        return;
      }
      var rest = TF.q('promo.content');
      report(squash(rest ? textOf(rest) : bodyText).substring(0, 240), 'unknown');
      return;
    }

    // inspect / click: код ещё не отправлен
    if (err && err.kind !== 'unknown') { report(err.text, err.kind === 'code_empty' ? 'code_not_filled' : err.kind); return; }
    var found = findForm();
    var buttons = found ? findButtons(found.form) : [];
    if (!buttons.length) {
      report(document.readyState === 'complete' ? 'complete' : 'loading', mode === 'click' ? 'button_not_found' : 'pending');
      return;
    }
    if (buttons.length > 1) { report(buttons.length, 'button_ambiguous'); return; }
    if (choiceNeeded(found.form)) { report(null, 'needs_choice'); return; }

    // Код должен быть подставлен самим адресом /pin/<код>; сами мы в поле ничего не вводим
    var filled = squash(found.input.value).toLowerCase() === String(cfg.code || '').toLowerCase();
    if (!filled) { report(null, 'code_not_filled'); return; }

    if (mode === 'click') { buttons[0].click(); return; }
    report({ state: 'ready', label: labelOf(buttons[0]), sig: sig }, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
