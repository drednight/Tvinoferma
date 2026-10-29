// @ts-check
// Только явно выбранные переносимые предпочтения. Остальные группы настроек вообще не читаем:
// пути, параметры ПК, контакты и провайдеры не становятся данными облака по умолчанию.
import { normalizeSectionsSettings } from '../../core/sections.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { array, boolean, invalidExport, number, object, oneOf, text } from './exportSchema.js';

export const PORTABLE_SETTING_GROUPS = Object.freeze(['appearance', 'navigation', 'planner', 'eventReminders']);

function selectedOwn(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidExport();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidExport();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalidExport();
  return descriptor.value;
}
function eventReminders(value) {
  const ids = Object.keys(DEFAULT_SETTINGS.notifications.events);
  const data = object(value, ids);
  return Object.fromEntries(
    ids.map(id => {
      const row = object(data[id], ['enabled', 'leadMinutes']);
      const minutes = number(row.leadMinutes);
      if (!Number.isSafeInteger(minutes) || minutes <= 0) throw invalidExport();
      return [id, { enabled: boolean(row.enabled), leadMinutes: minutes }];
    })
  );
}
function navigation(value) {
  const data = object(value, ['hidden', 'order']);
  const hidden = array(data.hidden, text);
  const order = array(data.order, text);
  const normalized = normalizeSectionsSettings({ hidden, order });
  // Нормализатор умеет отбрасывать новые разделы и править порядок. В экспорте это была бы
  // незаметная потеря, поэтому принимаем только полностью совпадающую структуру.
  if (
    JSON.stringify(normalized.hidden) !== JSON.stringify(hidden) ||
    JSON.stringify(normalized.order) !== JSON.stringify(order)
  )
    throw invalidExport();
  return { hidden, order };
}

/**
 * @param {any} settings нормализованные настройки
 * @param {{ selections?: string[] }} [options] выбираются явно; отсутствие группы не означает её удаление
 */
export function exportPortableSettings(settings, options = {}) {
  const opts = object(options, ['selections']);
  const choices = array(opts.selections, value => oneOf(value, PORTABLE_SETTING_GROUPS));
  if (new Set(choices).size !== choices.length) throw invalidExport();
  const selections = PORTABLE_SETTING_GROUPS.filter(item => choices.includes(item));
  /** @type {Record<string, any>} */
  const values = {};
  if (choices.some(choice => ['appearance', 'navigation', 'planner'].includes(choice))) {
    const ui = object(
      selectedOwn(settings, 'ui'),
      ['theme', 'plannerView', 'sections'],
      ['guideSeen', 'onboardingSeen']
    );
    if (choices.includes('appearance')) values.appearance = { theme: oneOf(ui.theme, ['dark', 'light']) };
    if (choices.includes('navigation')) values.navigation = navigation(ui.sections);
    if (choices.includes('planner')) values.planner = { view: oneOf(ui.plannerView, ['week', 'month']) };
  }
  if (choices.includes('eventReminders')) {
    const notifications = selectedOwn(settings, 'notifications');
    values.eventReminders = eventReminders(selectedOwn(notifications, 'events'));
  }
  return { schemaVersion: 1, selections, values };
}
