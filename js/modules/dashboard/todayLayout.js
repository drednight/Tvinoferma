// Layout identifiers are stable; unknown/duplicate entries never remove real blocks.
export const TODAY_BLOCKS = [
  ['news', 'Новости Perfect World'],
  ['today', 'Календарь и события'],
  ['promos', 'Промокоды'],
  ['marathon', 'Марафон'],
  ['launch', 'Быстрый запуск'],
  ['information', 'Информационная панель']
];
export function normalizeTodayOrder(value) {
  const allowed = new Set(TODAY_BLOCKS.map(([id]) => id));
  return [...new Set((Array.isArray(value) ? value : []).filter(id => allowed.has(id)))];
}
export function todayOrder(value) {
  return [...new Set([...normalizeTodayOrder(value), ...TODAY_BLOCKS.map(([id]) => id)])];
}
export function applyTodayLayout(root, value) {
  if (!normalizeTodayOrder(value).length) return;
  const board = root.querySelector('.rt-board');
  if (!board) return;
  const panels = todayOrder(value)
    .map(id => root.querySelector(`.rt-${id}`))
    .filter(Boolean);
  const extra = [...board.querySelectorAll(':scope > .rt-clan')];
  board.replaceChildren(...panels, ...extra);
  board.classList.add('rt-custom-layout');
}
