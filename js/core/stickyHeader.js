// @ts-check
// js/core/stickyHeader.js
// Шапка с вкладками всегда на виду (position: sticky в layout.css). Её высота меняется (на узком окне вкладки переносятся
// на вторую строку), а от неё зависят «липкая» панель выбора персонажей и отступ при прокрутке к элементу,
// поэтому высота пишется в CSS-переменную --topbar-h.

/**
 * Следит за высотой шапки и обновляет `--topbar-h` на <html>.
 * @param {Document} [doc]
 * @returns {() => void} отписка
 */
export function initStickyHeader(doc = document) {
  const bar = /** @type {HTMLElement | null} */ (doc.querySelector('.topbar'));
  if (!bar) return () => {};
  const apply = () => doc.documentElement.style.setProperty('--topbar-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  apply();
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }
  const ro = new ResizeObserver(apply);
  ro.observe(bar);
  return () => ro.disconnect();
}
