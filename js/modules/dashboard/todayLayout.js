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
