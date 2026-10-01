// Баланс древних монет на chests2.php. Ответ: #TF_BAL_V5_<json> = { data: number|null, error }
(function () {
  function report(data, error) {
    const payload = { data: data, error: error ? String(error) : null };
    window.location.hash = 'TF_BAL_V5_' + encodeURIComponent(JSON.stringify(payload));
  }
  try {
    if (document.readyState === 'loading' ||
        (document.title || '').includes('Проверка безопасности') ||
        document.querySelector('script[src*="bp_chl"]')) {
      report(null, 'challenge');
      return;
    }
    const bodyText = (document.body && document.body.innerText) || '';
    const href = window.location.href;
    const isNotLoggedIn = bodyText.includes('Вы не авторизованы') ||
      bodyText.includes('Для доступа к разделу необходимо войти') ||
      bodyText.includes('Ошибка авторизации') ||
      href.includes('login.php') || href.includes('vkplay');
    if (isNotLoggedIn) { report(null, 'not_logged_in'); return; }

    const pointsInfo = document.querySelector('.points_info');
    if (!pointsInfo) { report(null, 'container_missing'); return; }
    const strongTag = pointsInfo.querySelector('strong');
    if (!strongTag) { report(null, 'no_value_tag'); return; }
    const value = parseInt(strongTag.innerText.trim().replace(/[^0-9]/g, ''), 10);
    if (isNaN(value)) { report(null, 'parse_nan'); return; }
    if (value === 0 && !document.querySelector('.user-nick, .header-user-name, [class*="username"]')) {
      report(null, 'zero_no_user_session_expired');
      return;
    }
    report(value, null);
  } catch (e) {
    report(null, 'exception_' + String(e.message).substring(0, 20));
  }
})();
