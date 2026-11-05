// js/core/scrollPreservation.js
// Сохраняет прокрутку окна и вложенных областей при перерисовке DOM.
//
// Почти все разделы обновляются через `element.innerHTML = ...`. Браузер в этот момент
// выбрасывает старые узлы: у прокручиваемого блока (тело мастера, таблица «персонажи ×
// задания») сбрасывается scrollTop/scrollLeft, а при изменении высоты страницы положение
// окна может прижаться к верху. Это особенно заметно при фоновых сверках, которые
// перерисовывают разделы без действий пользователя.
//
// Позиции запоминаются по пути от стабильного корня (сам корень не пересоздаётся) и,
// если узел помечен `data-scroll-key`, по этому ключу. Фокус возвращается на такой же
// элемент по одному из его опознавательных атрибутов — иначе клик по чекбоксу в таблице
// тоже уводит окно к началу.

/** Атрибуты, по которым можно найти тот же элемент после перерисовки. */
const FOCUS_ATTRS = [
  'data-focus-key',
  'data-cell',
  'data-party-task',
  'data-party',
  'data-char',
  'data-col',
  'data-f',
  'data-act',
  'data-open',
  'id',
  'name'
];

const isElement = value => !!value && value.nodeType === 1;
const defaultScope = () => document.body || document.documentElement;

/** Корневой прокручиваемый элемент документа; в jsdom `scrollingElement` может отсутствовать. */
function scrollingRoot() {
  return document.scrollingElement || document.documentElement || document.body || null;
}

/** Положение окна. `window.scrollY` в jsdom всегда 0, поэтому читаем и корневой элемент. */
function viewportScroll() {
  const root = scrollingRoot();
  const x = Number(window.scrollX ?? window.pageXOffset) || 0;
  const y = Number(window.scrollY ?? window.pageYOffset) || 0;
  return {
    x: x || Number(root?.scrollLeft) || 0,
    y: y || Number(root?.scrollTop) || 0
  };
}

/** В реальном браузере прокрутка `document.scrollingElement` двигает и окно. */
function setViewportScroll({ x, y }) {
  const root = scrollingRoot();
  if (root) {
    root.scrollLeft = x;
    root.scrollTop = y;
  }
  const body = document.body;
  if (body && body !== root) {
    body.scrollLeft = x;
    body.scrollTop = y;
  }
}

/** Путь из индексов детей от корня до узла. */
function nodePath(root, node) {
  const path = [];
  let cur = node;
  while (cur && cur !== root) {
    const parent = cur.parentElement;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.children, cur);
    if (index < 0) return null;
    path.unshift(index);
    cur = parent;
  }
  return cur === root ? path : null;
}

function nodeByPath(root, path) {
  let cur = root;
  for (const index of path) {
    if (!cur?.children) return null;
    cur = cur.children[index];
  }
  return cur || null;
}

/** Грубая подпись узла, чтобы не восстановить прокрутку случайно на другом элементе. */
function nodeSignature(el) {
  if (!isElement(el)) return '';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`;
}

function focusKey(el) {
  if (!isElement(el)) return null;
  for (const attr of FOCUS_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return { attr, value };
  }
  return null;
}

function findByAttr(root, { attr, value }) {
  if (isElement(root) && root.getAttribute(attr) === value) return root;
  const nodes = root?.querySelectorAll?.(`[${attr}]`) || [];
  for (const el of nodes) if (el.getAttribute(attr) === value) return el;
  return null;
}

function findByScrollKey(root, key) {
  if (!key) return null;
  if (isElement(root) && root.getAttribute('data-scroll-key') === key) return root;
  const nodes = root?.querySelectorAll?.('[data-scroll-key]') || [];
  for (const el of nodes) if (el.getAttribute('data-scroll-key') === key) return el;
  return null;
}

/**
 * Запоминает прокрутку окна и всех ненулевых прокруток внутри `scope`.
 * @param {Element|Document|null} [scope] стабильный корень, который сам не заменяется
 * @param {string|null} [key] если не null, восстановление возможно только с тем же ключом
 * @param {{ focus?: boolean }} [options]
 */
export function captureScroll(scope = defaultScope(), key = null, { focus = true } = {}) {
  const root = scope || defaultScope();
  const nodes = [];
  const collect = el => {
    const top = Number(el.scrollTop) || 0;
    const left = Number(el.scrollLeft) || 0;
    if (!top && !left) return;
    const path = el === root ? [] : nodePath(root, el);
    if (path === null) return;
    nodes.push({
      top,
      left,
      path,
      key: el.getAttribute('data-scroll-key') || null,
      signature: nodeSignature(el)
    });
  };
  if (isElement(root)) collect(root);
  root.querySelectorAll?.('*').forEach(collect);

  const active = document.activeElement;
  return {
    root,
    key,
    viewport: viewportScroll(),
    nodes,
    focus: focus && active && root.contains?.(active) ? focusKey(active) : null
  };
}

/**
 * Возвращает запомненные позиции после перерисовки.
 * @param {ReturnType<typeof captureScroll>} snapshot
 * @param {{ key?: string|null, focus?: boolean }} [options]
 */
export function restoreScroll(snapshot, { key = snapshot.key, focus = true } = {}) {
  if (!snapshot) return false;
  // Ключ изменился (другой шаг мастера, другая страница, другая вкладка) — новая
  // прокрутка должна начаться сверху, а не наследовать старую позицию.
  if (snapshot.key !== null && key !== snapshot.key) return false;

  setViewportScroll(snapshot.viewport);
  for (const item of snapshot.nodes) {
    let el = findByScrollKey(snapshot.root, item.key);
    if (!el && item.path) {
      const candidate = nodeByPath(snapshot.root, item.path);
      if (candidate && (!item.signature || nodeSignature(candidate) === item.signature)) el = candidate;
    }
    if (!el) continue;
    el.scrollTop = item.top;
    el.scrollLeft = item.left;
  }

  if (focus && snapshot.focus) {
    const target = findByAttr(snapshot.root, snapshot.focus);
    if (target && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch (_) {
        target.focus();
      }
    }
  }
  return true;
}

/**
 * Выполняет перерисовку, сохраняя прокрутку и фокус.
 *
 * `key` может быть функцией: если за время рендера ключ изменился, позиция НЕ
 * восстанавливается. Передайте `key: null`, чтобы намеренно сбросить прокрутку
 * (например, при переходе на другой шаг мастера).
 *
 * @template T
 * @param {() => T|Promise<T>} render
 * @param {{ scope?: Element|Document|null, key?: string|null|(() => string|null), focus?: boolean }} [options]
 * @returns {T|Promise<T>}
 */
export function withPreservedScroll(render, { scope = defaultScope(), key = undefined, focus = true } = {}) {
  if (key === null) return render();
  const keyNow = () => (typeof key === 'function' ? key() : key);
  const snapshot = captureScroll(scope, keyNow(), { focus });
  const restore = () => restoreScroll(snapshot, { key: keyNow(), focus });
  let result;
  try {
    result = render();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}
