// @ts-check
// Локальная отметка: выборочное применение не является слиянием всей ветки.
// Пишется вместе с state, не содержит значений записей, паролей или токенов.
// Она НЕ является полноценным учётом происхождения и не защищена от отката
// state.json. Пока не обработана, автоматическая публикация должна быть закрыта.
import { isSyncId } from './envelope.js';
import { array, boolean, object } from './exportSchema.js';

const KEY = 'cloudSyncPendingApply';
const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const GROUPS = ['appearance', 'navigation', 'planner', 'eventReminders'];
const MAX_EVENTS = 128;
const MAX_RECORDS = 10_000;
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
function invalid() {
  return new Error('Не удалось сохранить отметку частичного применения');
}
function pin(value) {
  const input = object(value, ['versionId', 'sha256']);
  if (!isSyncId(input.versionId) || typeof input.sha256 !== 'string' || !HEX.test(input.sha256)) throw invalid();
  return { versionId: input.versionId, sha256: input.sha256 };
}
function event(value) {
  const input = object(value, ['provider', 'datasetId', 'pin', 'records', 'settings', 'financeSettings']);
  if (!['google', 'yandex'].includes(input.provider) || !isSyncId(input.datasetId)) throw invalid();
  const records = array(input.records, value => {
    const row = object(value, ['section', 'id']);
    if (!SECTIONS.includes(row.section) || !isSyncId(row.id)) throw invalid();
    return { section: row.section, id: row.id };
  });
  const settings = array(input.settings, value => {
    if (!GROUPS.includes(value)) throw invalid();
    return value;
  });
  if (
    records.length > MAX_RECORDS ||
    new Set(records.map(row => `${row.section}:${row.id}`)).size !== records.length ||
    new Set(settings).size !== settings.length
  )
    throw invalid();
  return {
    provider: input.provider,
    datasetId: input.datasetId,
    pin: pin(input.pin),
    records,
    settings,
    financeSettings: boolean(input.financeSettings)
  };
}
function checked(value) {
  const input = object(value, ['version', 'events']);
  if (input.version !== 1) throw invalid();
  const events = array(input.events, event);
  if (
    !events.length ||
    events.length > MAX_EVENTS ||
    events.reduce((n, item) => n + item.records.length, 0) > MAX_RECORDS
  )
    throw invalid();
  return { version: 1, events };
}

/** Сохранять только в локальных настройках, вместе с самим выбранным кандидатом. */
export function appendPendingSelectiveApply(settings, value) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  const previous = Object.hasOwn(settings, KEY) ? checked(settings[KEY]).events : [];
  const next = checked({ version: 1, events: [...previous, event(value)] });
  return { ...settings, [KEY]: next };
}

/** Проверенные источники частичных применений без значений; отсутствие означает пустой список. */
export function pendingSelectiveApplyEvents(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  return Object.hasOwn(settings, KEY) ? checked(settings[KEY]).events : [];
}

/** Только после отдельной проверки полного совпадения и сохранения принятой основы. */
export function removePendingSelectiveApply(settings) {
  pendingSelectiveApplyEvents(settings);
  const copy = { ...settings };
  delete copy[KEY];
  return copy;
}

/** Повреждённая/неизвестная отметка тоже блокирует отправку, а не считается пустой. */
export function requireResolvedSelectiveApply(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  if (Object.hasOwn(settings, KEY)) {
    checked(settings[KEY]);
    throw new Error('После выборочного применения требуется согласовать происхождение изменений перед отправкой');
  }
}
