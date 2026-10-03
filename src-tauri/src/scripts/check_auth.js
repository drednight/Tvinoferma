// Проверка входа на usercp.php. Ответ: #TF_AUTH_V2_<json> = { data: 'online'|'offline', error }
(function () {
  function report(data, error) {
    const payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_AUTH_V2_' + encodeURIComponent(JSON.stringify(payload));
  }
  const TF = window.__TF; // селекторы и тексты: selectors.json
  if (!TF) { report(null, 'config_missing'); return; }
  try {
    if (TF.isChallenge()) {
      report(null, 'challenge');
      return;
    }
    const bodyText = (document.body && document.body.innerText) || '';
    const nicknameSpan = TF.q('auth.nick');
    if (nicknameSpan && TF.has(bodyText, 'auth.welcome')) { report('online', null); return; }
    if (TF.has(bodyText, 'common.notLoggedIn')) { report('offline', 'not_logged_in'); return; }
    // Страница ещё не дорисована — Rust повторит скрипт
    report(null, 'pending');
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
