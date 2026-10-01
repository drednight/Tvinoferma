// Проверка входа на usercp.php. Ответ: #TF_AUTH_V2_<json> = { data: 'online'|'offline', error }
(function () {
  function report(data, error) {
    const payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_AUTH_V2_' + encodeURIComponent(JSON.stringify(payload));
  }
  try {
    if (document.readyState === 'loading' ||
        (document.title || '').includes('Проверка безопасности') ||
        document.querySelector('script[src*="bp_chl"]')) {
      report(null, 'challenge');
      return;
    }
    const bodyText = (document.body && document.body.innerText) || '';
    const nicknameSpan = document.querySelector('.info__forumname');
    if (nicknameSpan && bodyText.includes('Добро пожаловать')) { report('online', null); return; }
    if (bodyText.includes('Вы не авторизованы')) { report('offline', 'not_logged_in'); return; }
    // Страница ещё не дорисована — Rust повторит скрипт
    report(null, 'pending');
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
