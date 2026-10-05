// @ts-check
// js/core/navBadges.js
// Счётчики в навигации: сколько записей в каждом разделе. Видно, где есть данные,
// не открывая вкладку — и сразу заметно, что импорт или добавление персонажа сработали.
//
// Значение пересчитывается после каждого сохранения (событие tf-persisted) и при переключении
// вкладки, потому что число пати и марафонов меняется и без записи в файл (создание, удаление).

import { state } from './state.js';

/** Что показывать для каждого раздела. Пустой раздел счётчик не показывает — он не кричит нулём. */
export function navCounts(appState = state) {
  const active = (appState.marathons || []).filter(m => m.kind !== 'series' && m.status !== 'completed');
  return {
    characters: (appState.characters || []).length,
    parties: (appState.parties || []).length,
    marathons: active.length
  };
}

/** Подпись счётчика: 128 → «128», 1200 → «1,2 тыс.» — шапка не должна распухать. */
export function countLabel(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  return `${(num / 1000).toFixed(num < 10000 ? 1 : 0).replace('.', ',').replace(/,0$/, '')} тыс.`;
}

/**
 * Обновляет счётчики в разметке навигации.
 * @param {Document} [doc]
 */
export function refreshNavBadges(doc = document) {
  const counts = navCounts();
  for (const [section, value] of Object.entries(counts)) {
    const el = doc.getElementById(`tab-count-${section}`);
    if (!el) continue;
    const label = countLabel(value);
    el.hidden = !value;
    if (el.textContent !== label) el.textContent = label;
    const tab = doc.querySelector(`.tab[data-tab="${section}"]`);
    tab?.setAttribute('aria-label', `${tab.querySelector('span:not(.tab-ico):not(.tab-count)')?.textContent || section}: ${value}`);
  }
}

/** Подключает обновление счётчиков: при старте, после сохранения и при смене вкладки. */
export function initNavBadges(doc = document) {
  const run = () => refreshNavBadges(doc);
  run();
  if (typeof window !== 'undefined') {
    window.addEventListener('tf-persisted', run);
    doc.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', run));
  }
  return run;
}
