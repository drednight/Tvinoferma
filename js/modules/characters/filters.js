// js/modules/characters/filters.js
// Фильтры списка персонажей. Варианты выпадающих списков (классы, пати, теги) собираются
// из актуального state.characters при КАЖДОЙ отрисовке, а не один раз при старте (issue #2).

import { escapeHtml } from '../../core/utils.js';
import { NO_PARTY, isInParty } from '../parties/membership.js';

/** Уникальные непустые значения по алфавиту (без учёта регистра букв ru). */
export function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Перестраивает <option> у <select>, сохраняя выбранное значение.
 * Если выбранного значения больше нет (удалили последнего персонажа класса, переименовали пати),
 * фильтр сбрасывается на «Все…». Возвращает итоговое значение.
 * @param {HTMLSelectElement} select
 * @param {{ allLabel: string, fixed?: {value:string,label:string}[], values: string[], prefix?: string }} opts
 */
export function fillFilterSelect(select, { allLabel, fixed = [], values, prefix = '' }) {
  if (!select) return '';
  const current = select.value;
  // values — строки или { value, label } (для пати: значение — id, подпись — название)
  const options = [{ value: '', label: allLabel }, ...fixed,
    ...values.map(v => (typeof v === 'object' ? { value: v.value, label: prefix + v.label } : { value: v, label: prefix + v }))];
  // Не трогаем DOM, если список вариантов не изменился (иначе открытый выпадающий список «моргает»
  // при фоновых обновлениях балансов и входов)
  const html = options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  if (select.dataset.optionsHtml !== html) {
    select.innerHTML = html;
    select.dataset.optionsHtml = html;
  }
  const keep = options.some(o => o.value === current);
  select.value = keep ? current : '';
  return select.value;
}

export const fillClassFilter = (select, chars) =>
  fillFilterSelect(select, { allLabel: 'Все классы', values: uniqueSorted(chars.map(c => c.class)) });

/** Варианты — все существующие пати (value = id партии), в порядке партий. */
export const fillPartyFilter = (select, parties) =>
  fillFilterSelect(select, {
    allLabel: 'Все пати',
    fixed: [{ value: NO_PARTY, label: 'Без пати' }],
    values: [...(parties || [])]
      .sort((a, b) => (Number(a.order) || 1e9) - (Number(b.order) || 1e9) || a.name.localeCompare(b.name, 'ru'))
      .map(p => ({ value: p.id, label: p.name }))
  });

/** Применяет фильтры к списку персонажей (поиск, тег, класс, пати, статус входа). */
export function filterCharacters(chars, { search = '', tag = '', cls = '', party = '', auth = '' } = {}) {
  const searchTerm = String(search).toLowerCase().trim();
  let out = chars;

  // Поиск по нику (и по тегам: «#тег» или просто слово)
  if (searchTerm) {
    const term = searchTerm.replace(/^#/, '');
    out = out.filter(c => c.nick.toLowerCase().includes(searchTerm) ||
      (c.tags || []).some(t => t.toLowerCase().includes(term)));
  }

  if (tag === '__none__') {
    out = out.filter(c => !(c.tags || []).length);
  } else if (tag) {
    const tl = tag.toLowerCase();
    out = out.filter(c => (c.tags || []).some(t => t.toLowerCase() === tl));
  }

  if (cls) out = out.filter(c => c.class === cls);

  // party — id партии: «персонаж входит в выбранную партию»
  if (party === NO_PARTY) out = out.filter(c => !(c.partyIds || []).length);
  else if (party) out = out.filter(c => isInParty(c, party));

  if (auth === 'online') out = out.filter(c => c.isLoggedIn === true);
  else if (auth === 'offline') out = out.filter(c => c.isLoggedIn !== true);

  return out;
}
