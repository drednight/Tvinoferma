// Активация промокода на странице /pin/<КОД> (Issue #25). Настоящая страница: форма POST /pin.php?do=activate,
// поле input#pin (код подставлен из адреса), кнопка input[type=submit] «Активировать» (tests/fixtures/site-pin-*.html). Режим задаёт Rust: window.__TF_PIN = { mode, code, baseline }.
//   inspect — только чтение: вошёл ли игрок, не отклонён ли код, найдена ли ровно одна кнопка «Активировать».
//             Rust повторяет этот режим, пока страница не дорисуется. Ответ при успехе: { state: 'ready', label, sig }.
//   click   — нажимает кнопку «Активировать» ОДИН раз (Rust выполняет его единственный раз и не повторяет: повтор
//             мог бы активировать код дважды). Ответ пишется только при отказе нажимать (error).
//   result  — только чтение: что ответил сайт после нажатия. baseline = sig страницы до нажатия: пока текст
//             не изменился, страница считается неотвеченной (pending), чтобы не принять текст до нажатия за ответ.
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
  // Форма ввода кода: поле `pin` (на настоящей странице: form[action*="pin.php"] > input#pin + submit «Активировать»)
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
  // Текст рабочей области без постоянного описания «Пин-коды — это специальные ключи…», чтобы оно не
  // принималось за ответ сайта.
  function contentText() {
    var root = TF.q('promo.content') || document.body;
    if (!root) return '';
    var clone = root.cloneNode(true);
    TF.qa('promo.static', clone).forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    return squash(clone.innerText || clone.textContent);
  }
  function setValue(input, value) {
    input.value = value;
    ['input', 'change'].forEach(function (name) {
      try { input.dispatchEvent(new Event(name, { bubbles: true })); } catch (e) { /* не критично */ }
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

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var bodyText = squash((document.body && document.body.innerText) || '');
    var text = contentText();
    var lower = text.toLowerCase();
    var sig = hash(bodyText.toLowerCase());
    var excerpt = text.substring(0, 240);

    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(bodyText.substring(0, 240), 'not_logged_in'); return; }

    if (mode === 'result') {
      if (sig === cfg.baseline) { report(document.readyState === 'complete' ? 'complete' : 'loading', 'pending'); return; }
      if (TF.has(lower, 'promo.used')) { report(excerpt, 'already_used'); return; }
      if (TF.has(lower, 'promo.invalid')) { report(excerpt, 'invalid_code'); return; }
      if (TF.has(lower, 'promo.success')) { report({ state: 'success', detail: excerpt }, null); return; }
      report(excerpt, 'unknown');
      return;
    }

    // inspect / click: код ещё не отправлен
    if (TF.has(lower, 'promo.used')) { report(excerpt, 'already_used'); return; }
    if (TF.has(lower, 'promo.invalid')) { report(excerpt, 'invalid_code'); return; }
    var found = findForm();
    var buttons = found ? findButtons(found.form) : [];
    if (!buttons.length) {
      report(document.readyState === 'complete' ? 'complete' : 'loading', mode === 'click' ? 'button_not_found' : 'pending');
      return;
    }
    if (buttons.length > 1) { report(buttons.length, 'button_ambiguous'); return; }
    if (choiceNeeded(found.form)) { report(null, 'needs_choice'); return; }

    var code = String(cfg.code || '');
    var filled = squash(found.input.value).toLowerCase() === code.toLowerCase();
    if (mode === 'click') {
      // /pin/<код> подставляет код в поле сам; если не подставил, вводим его так же, как это сделал бы человек
      if (!filled) setValue(found.input, code);
      buttons[0].click();
      return;
    }
    report({ state: 'ready', label: labelOf(buttons[0]), sig: sig, filled: filled }, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
