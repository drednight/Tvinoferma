// Баланс древних монет на chests2.php. Ответ: #TF_BAL_V5_<json> = { data: number|null, error }
// Селекторы и тексты — в selectors.json (balance.*, common.*).
(function () {
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

  function report(data, error) {
    const payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_BAL_V5_' + encodeURIComponent(JSON.stringify(payload));
  }
  const TF = window.__TF; // селекторы и тексты: selectors.json (common.js подставляется перед скриптом)
  if (!TF) { report(null, 'config_missing'); return; }
  try {
    if (TF.isChallenge()) {
      report(null, 'challenge');
      return;
    }
    const bodyText = (document.body && document.body.innerText) || '';
    const href = window.location.href;
    const isNotLoggedIn = TF.has(bodyText, ['common.notLoggedIn', 'balance.notLoggedIn']) ||
      TF.has(href, 'balance.notLoggedInUrl');
    if (isNotLoggedIn) { report(null, 'not_logged_in'); return; }

    const pointsInfo = TF.q('balance.container');
    if (!pointsInfo) { report(null, 'container_missing'); return; }
    const strongTag = TF.q('balance.value', pointsInfo);
    if (!strongTag) { report(null, 'no_value_tag'); return; }
    // Баланс может быть дробным и с разделителями тысяч: 285, 28,5, 1 285,5 — см. parseCoins
    const value = parseCoins(strongTag.innerText);
    if (isNaN(value)) { report(null, 'parse_nan'); return; }
    // Ноль без признаков входа — скорее «сессия истекла», чем реальный нулевой баланс.
    // Признак входа на реальной странице: ник в шапке, ссылка <a href="/usercp.php"><strong>ник</strong></a>
    const hasUser = TF.q('balance.userMarker');
    if (value === 0 && !hasUser) {
      report(null, 'zero_no_user_session_expired');
      return;
    }
    report(value, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
