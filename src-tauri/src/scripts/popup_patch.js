// Окна входа VK Play / OAuth открываем в том же окне, а не всплывающим попапом
(function () {
  const originalOpen = window.open;
  window.open = function (url, name, specs) {
    if (url && typeof url === 'string') {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('vkplay') || lowerUrl.includes('oauth') || lowerUrl.includes('passport') || lowerUrl.includes('/login')) {
        window.location.href = url;
        return null;
      }
    }
    try { return originalOpen.call(this, url, name, specs); } catch (e) { return null; }
  };
})();
