// Вход через VK Play / OAuth и любые ссылки «в новом окне» открываем в том же окне, а не попапом.
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
  const absolute = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return '';
    }
  };
  const SAME = /^_?(self|top|parent)$/i;

  // 1. window.open с любым http(s)-адресом — переход в этом же окне
  const originalOpen = window.open;
  window.open = function (url, name, specs) {
    const target = url ? absolute(url) : '';
    if (target && isWeb(target)) {
      window.location.href = target;
      return null;
    }
    try {
      return originalOpen.call(this, url, name, specs);
    } catch (e) {
      return null;
    }
  };

  // 2. Ссылки и формы с target="_blank" (и любым именем окна) — в это же окно
  const forceSelf = (e) => {
    const el = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (el && el.target && !SAME.test(el.target) && isWeb(absolute(el.href))) {
      el.target = '_self';
    }
  };
  document.addEventListener('click', forceSelf, true);
  document.addEventListener('auxclick', forceSelf, true);
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (form && form.target && !SAME.test(form.target)) form.target = '_self';
    },
    true
  );
})();
