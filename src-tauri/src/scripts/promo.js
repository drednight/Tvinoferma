// Активация промокода на странице /pin/<КОД> (Issue #25). Режим задаёт Rust: window.__TF_PIN = { mode, code, baseline }.
//   inspect — только чтение: вошёл ли игрок, не отклонён ли код, найдена ли ровно одна кнопка «Ввести».
//             Rust повторяет этот режим, пока страница не дорисуется. Ответ при успехе: { state: 'ready', label, sig }.
//   click   — нажимает кнопку «Ввести» ОДИН раз (Rust выполняет его единственный раз и не повторяет: повтор
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
  // Контролы, подпись которых ЦЕЛИКОМ совпадает с «Ввести» (или запасной подписью из selectors.json);
  // «Ввести позже» не подойдёт, невидимые контролы не считаются.
  function findButtons() {
    var labels = TF.texts('promo.buttonLabels');
    return TF.qa('promo.controls').filter(function (el) {
      return !hidden(el) && labels.indexOf(labelOf(el)) !== -1;
    });
  }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function choiceNeeded() {
    return TF.qa('promo.choice').some(function (sel) { return !hidden(sel) && sel.options && sel.options.length > 1; });
  }

  try {
    if (TF.isChallenge()) { report(TF.waitKind(), 'challenge'); return; }
    var text = squash((document.body && document.body.innerText) || '');
    var lower = text.toLowerCase();
    var sig = hash(lower);
    var excerpt = text.substring(0, 240);

    var loginUrl = TF.has(window.location.href, 'balance.notLoggedInUrl');
    if (loginUrl || TF.has(text, ['common.notLoggedIn', 'balance.notLoggedIn'])) { report(excerpt, 'not_logged_in'); return; }

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
    var buttons = findButtons();
    if (!buttons.length) {
      report(document.readyState === 'complete' ? 'complete' : 'loading', mode === 'click' ? 'button_not_found' : 'pending');
      return;
    }
    if (buttons.length > 1) { report(buttons.length, 'button_ambiguous'); return; }
    if (choiceNeeded()) { report(null, 'needs_choice'); return; }

    if (mode === 'click') { buttons[0].click(); return; }
    report({ state: 'ready', label: labelOf(buttons[0]), sig: sig }, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
