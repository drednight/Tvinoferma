// @ts-check
// Общий жизненный цикл окон: очистка нужна и при замене формы, а не только при Escape.
/** @type {Map<Element, () => void>} */
const closers = new Map();

/** @param {Element} element @param {() => void} close */
export function registerModal(element, close) {
  closers.set(element, close);
  return () => closers.delete(element);
}

/** @param {Element} element */
export function isTopModal(element) {
  return [...document.querySelectorAll('.modal-overlay')].at(-1) === element;
}

/** Снимок детей: onClose может открыть новое окно, его удалять нельзя.
 * @param {HTMLElement} root
 */
export function closeModalRoot(root) {
  for (const element of [...root.children].reverse()) {
    const close = closers.get(element);
    if (close) close();
    else element.remove();
  }
}
