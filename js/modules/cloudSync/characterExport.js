// @ts-check
// Первый раздел будущего allowlist. Не подключён к облаку или state.json.
// Экспортируется только явно перечисленная схема персонажа; входы и пути остаются локальными.
// Новые/неизвестные поля останавливают экспорт до проверки, а не теряются молча.
import { preparationCheck, preparationError } from './preparationDiagnostics.js';
import { DEFAULT_STATS } from '../characters/stateManager.js';
import { isSyncId } from './envelope.js';

const SHARED = [
  'nick',
  'favorite',
  'class',
  'partyIds',
  'mainPartyId',
  'partyOrder',
  'notes',
  'level',
  'sky',
  'dungeonPasses',
  'stats',
  'statsHistory',
  'tags',
  'ancientCoins',
  'lastCoinUpdate',
  'coinsParserV',
  'marathonData',
  'coinHistory',
  'createdAt',
  'updatedAt'
];
const LOCAL = ['id', 'contacts', 'launch', 'isLoggedIn', 'lastLoginCheck', 'lastLoginReason'];
const STATS = Object.keys(DEFAULT_STATS);
const LIMIT = 100_000;

function invalid(reason = 'invalid') {
  return preparationError(new Error('Неподдерживаемая структура данных персонажа; экспорт остановлен'), reason);
}

function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) throw invalid('unknown_field');
  for (const key of required) if (!Object.hasOwn(descriptors, key)) throw invalid('missing_field');
  const result = {};
  for (const key of keys) {
    if (typeof key !== 'string') throw invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return result;
}

function array(value, mapper) {
  if (!Array.isArray(value) || value.length > LIMIT) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw invalid();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    result.push(mapper(descriptor.value));
  }
  return result;
}

function text(value) {
  if (typeof value !== 'string') throw invalid();
  return value;
}
function nullableText(value) {
  return value === null ? null : text(value);
}
function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) throw invalid();
  return value;
}
function nullableNumber(value) {
  return value === null ? null : number(value);
}
function boolean(value) {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}
function stats(value) {
  const data = shape(value, STATS);
  return Object.fromEntries(STATS.map(key => [key, number(data[key])]));
}
function statsHistory(value) {
  return array(value, item => {
    const row = shape(item, ['at', 'stats']);
    return { at: nullableText(row.at), stats: stats(row.stats) };
  });
}
function coinHistory(value) {
  return array(value, item => {
    const row = shape(item, ['delta'], ['id', 'date', 'createdAt', 'note', 'balanceAfter']);
    const out = { delta: number(row.delta) };
    for (const key of ['id', 'date', 'createdAt', 'note']) if (Object.hasOwn(row, key)) out[key] = text(row[key]);
    if (Object.hasOwn(row, 'balanceAfter')) out.balanceAfter = number(row.balanceAfter);
    return out;
  });
}
function marathonData(value) {
  if (value === null) return null;
  const data = shape(value, ['lastSyncDate', 'quests', 'summary']);
  const summary = shape(data.summary, ['completed', 'total', 'percentage']);
  return {
    lastSyncDate: text(data.lastSyncDate),
    quests: array(data.quests, item => {
      const row = shape(item, ['title', 'description', 'completed', 'total', 'percentage']);
      return {
        title: text(row.title),
        description: text(row.description),
        completed: number(row.completed),
        total: number(row.total),
        percentage: number(row.percentage)
      };
    }),
    summary: {
      completed: number(summary.completed),
      total: number(summary.total),
      percentage: number(summary.percentage)
    }
  };
}

/**
 * ТОЛЬКО экспорт персонажа: ничего не сохраняет и не отправляет.
 * syncId и соответствия партий должны быть заранее назначены и сохранены миграцией.
 * Пароли/контакты здесь не поддерживаются даже при дополнительных параметрах.
 */
export function exportCharacter(character, options) {
  const opts = shape(options, ['syncId', 'partySyncIds'], ['archived']);
  if (!isSyncId(opts.syncId) || !(opts.partySyncIds instanceof Map)) throw invalid();
  const archived = Object.hasOwn(opts, 'archived') ? boolean(opts.archived) : false;
  const data = shape(character, [...SHARED, 'syncId'], LOCAL);
  if (data.syncId !== opts.syncId || !text(data.id)) throw invalid();

  const resolveParty = localId => {
    if (typeof localId !== 'string' || !localId) throw invalid();
    const mapped = opts.partySyncIds.get(localId);
    if (!isSyncId(mapped)) throw new Error('Не найдены стабильные идентификаторы партий; экспорт остановлен');
    return mapped;
  };
  const partyIds = array(data.partyIds, resolveParty);
  if (new Set(partyIds).size !== partyIds.length) throw invalid();
  const mainPartyId = data.mainPartyId === null ? null : resolveParty(data.mainPartyId);
  if (mainPartyId && !partyIds.includes(mainPartyId)) throw invalid();

  if (!data.partyOrder || typeof data.partyOrder !== 'object' || Array.isArray(data.partyOrder)) throw invalid();
  const orderPrototype = Object.getPrototypeOf(data.partyOrder);
  if (orderPrototype !== Object.prototype && orderPrototype !== null) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(data.partyOrder);
  const orderKeys = Reflect.ownKeys(data.partyOrder);
  if (orderKeys.length > LIMIT) throw invalid();
  const partyOrder = {};
  for (const key of orderKeys) {
    if (typeof key !== 'string') throw invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    const mapped = resolveParty(key);
    if (Object.hasOwn(partyOrder, mapped)) throw invalid();
    partyOrder[mapped] = number(descriptor.value);
  }
  const sky = shape(data.sky, ['name', 'level']);
  const passes = shape(data.dungeonPasses, ['weapon', 'armor', 'relic']);
  return {
    id: opts.syncId,
    type: 'character',
    archived,
    fields: {
      nick: text(data.nick),
      favorite: boolean(data.favorite),
      class: text(data.class),
      partyIds,
      mainPartyId,
      partyOrder,
      notes: text(data.notes),
      level: number(data.level),
      sky: { name: nullableText(sky.name), level: nullableNumber(sky.level) },
      dungeonPasses: { weapon: number(passes.weapon), armor: number(passes.armor), relic: number(passes.relic) },
      stats: preparationCheck('stats', () => stats(data.stats)),
      statsHistory: preparationCheck('statsHistory', () => statsHistory(data.statsHistory)),
      tags: array(data.tags, text),
      ancientCoins: number(data.ancientCoins),
      lastCoinUpdate: nullableText(data.lastCoinUpdate),
      coinsParserV: number(data.coinsParserV),
      marathonData: preparationCheck('marathonData', () => marathonData(data.marathonData)),
      coinHistory: preparationCheck('coinHistory', () => coinHistory(data.coinHistory)),
      createdAt: text(data.createdAt),
      updatedAt: text(data.updatedAt)
    }
  };
}
