// js/core/sections.js
// Разделы приложения: один список, из которого берутся меню, палитра команд и горячие клавиши.
//
// Зачем этот файл: разделы раньше перечислялись в четырёх местах — в разметке меню, в
// `renderActiveTab`, в массиве горячих клавиш и в палитре команд, — и эти списки уже
// разошлись (в палитре нет «Руны» и «Банка», Ctrl+8 не работает). Пользовательская настройка
// «какие разделы показывать и в каком порядке» заставила бы завести раздел в каждом списке
// отдельно, и скрытый раздел всё равно остался бы в палитре и на горячих клавишах. Здесь —
// единственное место, где раздел описан один раз.

/**
 * @typedef {object} Section
 * @property {string} id           ключ раздела: `data-tab` в меню и `data-section` у страницы
 * @property {string} title        название для меню и палитры
 * @property {string} [paletteIcon] значок для палитры команд; в меню своя строка из разметки
 * @property {string} [required]   почему раздел нельзя выключить; `undefined` — можно
 * @property {boolean} [pinned]    раздел вне переставляемого списка (прибит к низу меню)
 */

/**
 * Разделы в порядке по умолчанию.
 *
 * `required` — не «на всякий случай», а потому что без раздела что-то перестаёт быть
 * доступно или приложение становится необратимым настройкой:
 *   - «Сегодня» — на этой странице живёт календарь и кнопка «Открыть день в календаре»
 *     (`todayView.js` рендерит `plannerHtml` именно туда); спрятав раздел, мы забрали бы
 *     календарь, а другого места для него в приложении нет;
 *   - «Настройки» — включить раздел обратно можно только здесь.
 *
 * @type {Section[]}
 */
export const SECTIONS = [
  { id: 'today', title: 'Сегодня', paletteIcon: '⌂', required: 'Здесь календарь и «Открыть день в календаре» — больше их открыть негде.' },
  { id: 'characters', title: 'Персонажи', paletteIcon: '👥' },
  { id: 'parties', title: 'Пати', paletteIcon: '🛡' },
  { id: 'marathons', title: 'Марафоны', paletteIcon: '🏃' },
  { id: 'runes', title: 'Руны', paletteIcon: '🔮' },
  { id: 'finance', title: 'Банк', paletteIcon: '₽' },
  { id: 'tools', title: 'Инструменты', paletteIcon: '⚡' },
  { id: 'settings', title: 'Настройки', paletteIcon: '⚙', pinned: true, required: 'Включить выключенный раздел обратно можно только здесь.' }
];

/** @type {Map<string, Section>} */
const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/** Раздел по ключу; `undefined`, если ключ неизвестен (или пришёл из испорченных данных). */
export function sectionById(id) {
  return BY_ID.get(String(id));
}

/** Раздел выключать нельзя — и в этом есть конкретная причина. */
export function isRequiredSection(id) {
  return !!sectionById(id)?.required;
}

/** Настройка разделов в том виде, в каком её читают: без испорченных данных. */
export function emptySectionsSettings() {
  return { hidden: [], order: SECTIONS.map((s) => s.id) };
}

/**
 * Нормализация настройки разделов из сохранённых данных.
 *
 * Мусор и незнакомые разделы отбрасываются, недостающие дописываются: раздел, добавленный
 * в приложение позже, должен появиться в меню сам, а не молча пропасть из-за старой настройки.
 * Выключенным не может оказаться раздел, который выключать нельзя, — даже если он так записан
 * в данных: иначе «Настройки» могли бы оказаться недостижимы.
 *
 * @param {any} [input]
 * @returns {{ hidden: string[], order: string[] }}
 */
export function normalizeSectionsSettings(input = {}) {
  const known = SECTIONS.map((s) => s.id);

  const hiddenRaw = Array.isArray(input?.hidden) ? input.hidden : [];
  const hidden = [...new Set(hiddenRaw.map(String))]
    .filter((id) => BY_ID.has(id) && !isRequiredSection(id));

  const orderRaw = Array.isArray(input?.order) ? input.order.map(String) : [];
  const order = [...new Set(orderRaw.filter((id) => BY_ID.has(id)))];
  // Всё, чего в настройке не было, дописываем в конце — в порядке по умолчанию
  for (const id of known) if (!order.includes(id)) order.push(id);

  return { hidden, order };
}

/**
 * Разделы в порядке, заданном пользователем (включая выключенные — они нужны панели настроек).
 * @param {any} [settings]
 * @returns {Section[]}
 */
export function sectionOrder(settings) {
  const { order } = normalizeSectionsSettings(settings?.ui?.sections);
  return order.map(sectionById).filter(Boolean);
}

/** Переставляемый список: всё, кроме прибитых к низу разделов. */
export function reorderableSections(settings) {
  return sectionOrder(settings).filter((s) => !s.pinned);
}

/**
 * Показываемые разделы в порядке пользователя — из них строится меню, палитра и горячие клавиши.
 * @param {any} [settings]
 * @returns {Section[]}
 */
export function visibleSections(settings) {
  const { hidden } = normalizeSectionsSettings(settings?.ui?.sections);
  return sectionOrder(settings).filter((s) => !hidden.includes(s.id));
}

/** Показан ли раздел. */
export function isSectionVisible(id, settings) {
  const { hidden } = normalizeSectionsSettings(settings?.ui?.sections);
  return !hidden.includes(String(id));
}

/**
 * Можно ли выключить раздел.
 *
 * Две причины отказа, и обе настоящие: раздел, который выключать нельзя (см. `required`),
 * и последний оставшийся видимый раздел — иначе в приложении будет некуда перейти.
 */
export function canHideSection(id, settings) {
  if (isRequiredSection(id)) return false;
  const visible = visibleSections(settings);
  return visible.length > 1 && visible.some((s) => s.id !== String(id));
}

/**
 * Ставит меню в порядок пользователя и прячет выключенные разделы.
 *
 * Кнопки переставляются переносом узлов, а не пересоздаются: на них уже висят обработчики
 * клика и обновления счётчиков (`bindNavigation`, `initNavBadges`), и пересоздание их
 * потеряло бы.
 *
 * @param {Document} [doc]
 * @param {any} [settings]
 * @returns {{ visible: string[], hidden: string[] }}
 */
export function applySections(doc = document, settings) {
  const { hidden, order } = normalizeSectionsSettings(settings?.ui?.sections);
  for (const id of order) {
    const tab = doc.querySelector(`.tab[data-tab="${id}"]`);
    if (tab) tab.hidden = hidden.includes(id);
  }
  // Порядок задаём только внутри основного списка: «Настройки» лежат в отдельном блоке
  // вместе с часами и статусом серверов, их место определено разметкой.
  const nav = doc.querySelector('.next-nav');
  if (nav) {
    for (const id of order) {
      const tab = nav.querySelector(`.tab[data-tab="${id}"]`);
      if (tab) nav.appendChild(tab);
    }
  }
  return { visible: order.filter((id) => !hidden.includes(id)), hidden };
}

/**
 * Раздел, на который переходить вместо запрошенного: сам запрошенный, если он виден,
 * иначе первый видимый.
 *
 * Нужен потому, что в раздел могут вести не только кнопки меню: палитра команд, горячие
 * клавиши и сохранённые команды переключают раздел по имени. Если раздел выключили, молча
 * ничего не делать нельзя — человек нажал «Марафоны» и ждёт их, а вместо этого остаётся
 * на прежнем экране без объяснений.
 */
export function resolveSection(id, settings) {
  const visible = visibleSections(settings);
  const found = visible.find((s) => s.id === String(id));
  return found || visible[0] || SECTIONS[0];
}