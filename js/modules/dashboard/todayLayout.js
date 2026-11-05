// Layout identifiers are stable; unknown/duplicate entries never remove real blocks.
export const TODAY_BLOCKS = [
  ['news', 'Новости Perfect World'],
  ['today', 'Календарь и события'],
  ['promos', 'Промокоды'],
  ['marathon', 'Марафон'],
  ['launch', 'Быстрый запуск'],
  ['information', 'Информационная панель'],
  ['clan', 'Клан']
];
export function normalizeTodayOrder(value) {
  const allowed = new Set(TODAY_BLOCKS.map(([id]) => id));
  return [...new Set((Array.isArray(value) ? value : []).filter(id => allowed.has(id)))];
}
export function todayOrder(value) {
  return [...new Set([...normalizeTodayOrder(value), ...TODAY_BLOCKS.map(([id]) => id)])];
}
export function applyTodayLayout(root, value, sizes = {}) {
  const normalizedSizes = normalizeTodaySizes(sizes);
  if (!normalizeTodayOrder(value).length && !Object.keys(normalizedSizes).length) return;
  const board = root.querySelector('.rt-board');
  if (!board) return;
  const panels = todayOrder(value)
    .map(id => root.querySelector(`.rt-${id}`))
    .filter(Boolean);
  board.replaceChildren(...panels);
  board.classList.add('rt-custom-layout');
  for (const [id] of TODAY_BLOCKS) {
    const panel = panels.find(el => el.classList.contains(`rt-${id}`));
    if (!panel) continue;
    applyTodayBlockSize(panel, id, normalizedSizes[id] || {});
  }
}

export function applyTodayBlockSize(panel, id, size) {
  const span = size.span || (size.width ? size.width * 4 : id === 'clan' ? 12 : 4);
  panel.dataset.layoutSpan = String(span);
  panel.style.setProperty('--rt-layout-span', String(span));
  panel.style.height = size.height ? `${size.height}px` : '';
  panel.classList.toggle('rt-layout-fixed-height', !!size.height);
}

export function normalizeTodaySizes(value) {
  const result = {};
  for (const [id] of TODAY_BLOCKS) {
    const size = value && typeof value === 'object' && Object.hasOwn(value, id) ? value[id] : null;
    if (!size || typeof size !== 'object') continue;
    const row = {};
    if ([1, 2, 3].includes(size.width)) row.width = size.width;
    if (Number.isInteger(size.span) && size.span >= 3 && size.span <= 12) row.span = size.span;
    if (Number.isInteger(size.height) && size.height >= 200 && size.height <= 1600) row.height = size.height;
    if (Object.keys(row).length) result[id] = row;
  }
  return result;
}

// Free canvas is separate from legacy grid settings, so old layouts keep working.
export function normalizeTodayCanvas(value) {
  if (!value || typeof value !== 'object' || !value.blocks || typeof value.blocks !== 'object') return null;
  const blocks = {};
  for (const [id] of TODAY_BLOCKS) {
    const row = Object.hasOwn(value.blocks, id) ? value.blocks[id] : null;
    if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.y)) continue;
    const block = {
      x: Math.round(Math.max(0, Math.min(20000, row.x))),
      y: Math.round(Math.max(0, Math.min(20000, row.y)))
    };
    if (Number.isFinite(row.width)) block.width = Math.round(Math.max(160, Math.min(4000, row.width)));
    if (Number.isFinite(row.height)) block.height = Math.round(Math.max(120, Math.min(4000, row.height)));
    blocks[id] = block;
  }
  if (!Object.keys(blocks).length) return null;
  return { width: Math.round(Math.max(320, Math.min(20000, Number(value.width) || 1200))), blocks };
}

export function applyCanvasBlockSize(panel, block) {
  panel.style.left = `${block.x}px`;
  panel.style.top = `${block.y}px`;
  panel.style.width = block.width ? `${block.width}px` : '320px';
  panel.style.height = block.height ? `${block.height}px` : '';
  panel.classList.toggle('rt-layout-fixed-height', !!block.height);
}

const canvasObservers = new WeakMap();
export function clearTodayCanvasObserver(root) {
  canvasObservers.get(root)?.disconnect();
  canvasObservers.delete(root);
}
export function applyTodayCanvas(root, value) {
  const canvas = normalizeTodayCanvas(value);
  const board = root.querySelector('.rt-board');
  if (!canvas || !board) return;
  clearTodayCanvasObserver(root);
  const panels = todayOrder([])
    .map(id => [id, root.querySelector(`.rt-${id}`)])
    .filter(([, panel]) => panel);
  const surface = document.createElement('div');
  surface.className = 'rt-free-surface';
  board.replaceChildren(surface);
  board.classList.remove('rt-custom-layout');
  board.classList.add('rt-free-layout');
  let nextY = Math.max(0, ...Object.values(canvas.blocks).map(block => block.y + (block.height || 400) + 18));
  for (const [id, panel] of panels) {
    surface.append(panel);
    // A newly enabled clan/new block is placed below existing blocks, never at (0,0).
    if (!canvas.blocks[id]) {
      canvas.blocks[id] = { x: 0, y: nextY };
      nextY += 418;
    }
    applyCanvasBlockSize(panel, canvas.blocks[id]);
  }
  const fit = () => {
    surface.style.width = `${Math.max(canvas.width, ...panels.map(([, panel]) => parseFloat(panel.style.left) + (panel.offsetWidth || parseFloat(panel.style.width))))}px`;
    surface.style.height = `${Math.max(200, ...panels.map(([, panel]) => parseFloat(panel.style.top) + (panel.offsetHeight || parseFloat(panel.style.height) || 400))) + 24}px`;
  };
  fit();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(fit);
    panels.forEach(([, panel]) => observer.observe(panel));
    canvasObservers.set(root, observer);
  }
  return { canvas, surface, fit };
}
