// Ordinary browsing only: never autofill credentials, never expose Tauri IPC.
(() => {
  if (window.top !== window) return;
  const mount = () => {
    if (document.getElementById('tf-link-nav')) return;
    const bar = document.createElement('div');
    bar.id = 'tf-link-nav';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:8px;background:#202820;color:#fff;font:13px system-ui;box-shadow:0 1px 5px #0006';
    for (const [text, title, action] of [['←','Назад',()=>history.back()],['→','Вперёд',()=>history.forward()],['↻','Обновить',()=>location.reload()]]) {
      const button = document.createElement('button'); button.textContent = text; button.title = title; button.setAttribute('aria-label',title); button.onclick = action; bar.append(button);
    }
    const address = document.createElement('span'); address.textContent = location.origin + location.pathname; address.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; bar.append(address);
    document.documentElement.style.scrollPaddingTop = '48px';
    document.body.style.paddingTop = '48px'; document.body.append(bar);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
