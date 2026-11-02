// Обычные ссылки открываем в том же окне; OAuth должен сохранить дочернее окно и window.opener.
// Скрипт вшивается как initialization_script, поэтому выполняется в КАЖДОМ документе окна
// (после перехода на сайт авторизации и обратно) и до скриптов сайта.
(function () {
  if (window.top !== window || window.__tfPopupPatched) return;
  try {
    Object.defineProperty(window, '__tfPopupPatched', { value: true, configurable: true });
  } catch (e) {
    window.__tfPopupPatched = true;
  }

  const isWeb = (u) => /^https?:\/\//i.test(u);
  const isAuthUrl = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return ['vk.com', 'vk.ru', 'vkplay.ru', 'pwonline.ru'].some(
        (domain) => host === domain || host.endsWith('.' + domain)
      );
    } catch (e) {
      return false;
    }
  };
  const absolute = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return '';
    }
  };
  const SAME = /^_?(self|top|parent)$/i;

  // 1. VK OAuth открывается отдельным окном: callback oauth2.htm использует window.opener.
  const originalOpen = window.open;
  window.open = function (url, name, specs) {
    const target = url ? absolute(url) : '';
    if (!target || !isWeb(target) || isAuthUrl(target)) {
      try {
        return originalOpen.call(this, url, name, specs);
      } catch (e) {
        return null;
      }
    }
    if (target && isWeb(target)) {
      window.location.href = target;
      return null;
    }
    return null;
  };

  // 2. Ссылки и формы с target="_blank" (и любым именем окна) — в это же окно
  const forceSelf = (e) => {
    const el = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (el && el.target && !SAME.test(el.target) && isWeb(absolute(el.href)) && !isAuthUrl(absolute(el.href))) {
      el.target = '_self';
    }
  };
  document.addEventListener('click', forceSelf, true);
  document.addEventListener('auxclick', forceSelf, true);
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (form && form.target && !SAME.test(form.target) && !isAuthUrl(absolute(form.action))) {
        form.target = '_self';
      }
    },
    true
  );
})();
