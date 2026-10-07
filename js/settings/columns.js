// @ts-check
// js/settings/columns.js
// «Настройки» показываются в две колонки. Панели в разметке перечислены в порядке чтения; при запуске они раскладываются
// по колонкам автоматически: сначала заполняется ЛЕВАЯ (больше или поровну), потом правая. Добавили панель в index.html —
// ничего считать вручную не нужно. Каждая смысловая группа балансируется независимо.

/**
 * Раскладывает панели `.settings-cols > .settings-col > .panel` по колонкам, сохраняя их порядок.
 * Левая получает `ceil(n / 2)` панелей. Раскрытые панели остаются раскрытыми (элементы только переносятся).
 * @param {ParentNode} [root]
 * @returns {number[]} сколько панелей в каждой колонке
 */
export function balanceSettingsColumns(root = document) {
  return [...root.querySelectorAll('.settings-cols')].flatMap(balanceGroup);
}

/** @param {Element} wrap */
function balanceGroup(wrap) {
  const cols = /** @type {HTMLElement[]} */ ([...wrap.querySelectorAll(':scope > .settings-col')]);
  if (cols.length < 2) return cols.map(c => c.children.length);
  const panels = cols.flatMap(c => /** @type {HTMLElement[]} */ ([...c.children]).filter(el => el.classList.contains('panel')));
  const left = Math.ceil(panels.length / 2);
  panels.forEach((p, i) => cols[i < left ? 0 : 1].appendChild(p));
  return cols.map(c => c.children.length);
}
