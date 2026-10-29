// @ts-check
// Предварительное двухстороннее сравнение подготовленных ПУБЛИЧНЫХ наборов.
// Оно ничего не применяет и не определяет, какая версия новее. Без доказанного общего
// предка и явных tombstones отсутствие записи — не свидетельство удаления.
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { array, invalidExport, object } from './exportSchema.js';
import { PORTABLE_SETTING_GROUPS } from './settingsExport.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance', 'preferences'];
const TYPES = {
  characters: ['character'],
  parties: ['party'],
  marathons: ['marathon', 'marathonSeries', 'marathonTemplate'],
  planner: ['plannerEntry'],
  finance: ['financeOperation', 'financeShopItem', 'financeLoan', 'financePayment']
};
const COMMON_MARATHON = ['title', 'description', 'source', 'createdAt', 'updatedAt'];
const FIELD_KEYS = {
  character: [
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
  ],
  party: ['name', 'order', 'color', 'createdAt', 'updatedAt', 'memberLinks'],
  marathonSeries: [...COMMON_MARATHON, 'childIds'],
  marathon: [
    ...COMMON_MARATHON,
    'seriesId',
    'bonuses',
    'startDate',
    'endDate',
    'status',
    'participantIds',
    'assignments',
    'tasks',
    'progress',
    'balance',
    'awards',
    'completedAt'
  ],
  marathonTemplate: ['name', 'sourceUrl', 'tasks', 'bonuses', 'createdAt'],
  plannerEntry: [
    'title',
    'source',
    'date',
    'time',
    'durationMinutes',
    'kind',
    'priority',
    'reminderMinutes',
    'recurrence',
    'recurrenceEnd',
    'color',
    'status',
    'statusByDate',
    'createdAt',
    'updatedAt'
  ],
  financeOperation: ['date', 'currency', 'kind', 'amount', 'counterparty', 'note', 'status', 'source', 'ref'],
  financeShopItem: ['side', 'name', 'price', 'qty', 'date', 'note'],
  financeLoan: ['direction', 'who', 'principal', 'percent', 'start', 'end', 'currency', 'note', 'opId', 'paymentIds'],
  financePayment: ['loanId', 'date', 'amount']
};
const PRIVATE_KEYS = new Set([
  'contacts',
  'password',
  'recoveryEmail',
  'email',
  'phone',
  'cookie',
  'cookies',
  'token',
  'accessToken',
  'refreshToken',
  'credentials',
  'launch',
  'isLoggedIn',
  'lastLoginCheck',
  'lastLoginReason'
]);
const MISSING = Symbol('missing');

function noPrivateFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) throw invalidExport();
    noPrivateFields(item);
  }
}

function checkOrder(value, expected) {
  const order = array(value, id => {
    if (!isSyncId(id)) throw invalidExport();
    return id;
  });
  if (new Set(order).size !== order.length || order.length !== expected.length) throw invalidExport();
  const required = new Set(expected);
  if (order.some(id => !required.has(id))) throw invalidExport();
}

// Структурная проверка входа для read-only сравнения, НЕ полная валидация бизнес-схемы
// для импорта. Перед применением понадобятся отдельные проверки ссылок и согласованности.
function validate(snapshot) {
  validateJsonSnapshot(snapshot);
  const root = object(snapshot, ['schemaVersion', 'sections']);
  if (root.schemaVersion !== 1) throw invalidExport();
  const sections = object(root.sections, SECTIONS);
  const allIds = new Map();
  const guildEvents = new Set();
  const register = (id, identityType) => {
    if (!isSyncId(id) || allIds.has(id)) throw invalidExport();
    allIds.set(id, identityType);
  };
  for (const section of SECTIONS.filter(name => name !== 'preferences')) {
    const data = object(
      sections[section],
      section === 'finance' ? ['records', 'order', 'settings'] : ['records', 'order']
    );
    const records = array(data.records, value => {
      const item = object(value, ['id', 'type', 'fields'], ['archived']);
      if (!TYPES[section].includes(item.type)) throw invalidExport();
      const archivedType = item.type === 'character' || item.type === 'party';
      if (archivedType !== Object.hasOwn(item, 'archived') || (archivedType && typeof item.archived !== 'boolean'))
        throw invalidExport();
      object(item.fields, FIELD_KEYS[item.type]);
      noPrivateFields(item.fields);
      register(item.id, `${section}:${item.type}`);
      if (item.type === 'plannerEntry') {
        const source = object(item.fields.source, ['kind'], ['eventId']);
        if (
          (source.kind === 'manual' && Object.hasOwn(source, 'eventId')) ||
          (source.kind === 'guild' &&
            (typeof source.eventId !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(source.eventId))) ||
          !['manual', 'guild'].includes(source.kind)
        )
          throw invalidExport();
        if (source.kind === 'guild') {
          if (guildEvents.has(source.eventId)) throw invalidExport();
          guildEvents.add(source.eventId);
        }
      }
      if (item.type === 'marathon') {
        for (const task of array(item.fields.tasks, value => value)) {
          if (!task || typeof task !== 'object' || Array.isArray(task)) throw invalidExport();
          register(task.id, `marathonTask:${item.id}`);
          for (const reward of array(task.rewards, value => value))
            register(reward?.id, `marathonReward:${item.id}:${task.id}`);
        }
        for (const bonus of array(item.fields.bonuses, value => value)) register(bonus?.id, `marathonBonus:${item.id}`);
      }
      return item;
    });
    const ids = predicate => records.filter(predicate).map(row => row.id);
    if (section === 'characters' || section === 'parties') {
      const order = object(data.order, ['active', 'archived']);
      checkOrder(
        order.active,
        ids(row => !row.archived)
      );
      checkOrder(
        order.archived,
        ids(row => row.archived)
      );
    } else if (section === 'marathons') {
      const order = object(data.order, ['marathons', 'templates']);
      checkOrder(
        order.marathons,
        ids(row => row.type !== 'marathonTemplate')
      );
      checkOrder(
        order.templates,
        ids(row => row.type === 'marathonTemplate')
      );
    } else if (section === 'planner') {
      checkOrder(
        data.order,
        ids(() => true)
      );
    } else {
      const order = object(data.order, ['operations', 'shopItems', 'loans']);
      checkOrder(
        order.operations,
        ids(row => row.type === 'financeOperation')
      );
      checkOrder(
        order.shopItems,
        ids(row => row.type === 'financeShopItem')
      );
      checkOrder(
        order.loans,
        ids(row => row.type === 'financeLoan')
      );
      object(data.settings, ['goldRate', 'goldRateAt', 'commissionPct', 'opening', 'monthAdjust', 'monthCarry']);
      noPrivateFields(data.settings);
    }
  }
  const pref = object(sections.preferences, ['schemaVersion', 'selections', 'values']);
  if (pref.schemaVersion !== 1) throw invalidExport();
  const selections = array(pref.selections, key => {
    if (!PORTABLE_SETTING_GROUPS.includes(key)) throw invalidExport();
    return key;
  });
  if (new Set(selections).size !== selections.length) throw invalidExport();
  object(pref.values, selections);
  noPrivateFields(pref.values);
  return { sections, identities: allIds };
}

/**
 * Структурная проверка публичного набора для предварительного просмотра, не для импорта.
 * Возвращает отдельную карту sync-ID к типам, включая вложенные сущности марафона.
 */
export function publicSnapshotIdentityTypes(snapshot) {
  return new Map(validate(snapshot).identities);
}

function plain(value) {
  return value !== MISSING && value !== null && typeof value === 'object' && !Array.isArray(value);
}
function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, i) => equal(item, right[i]));
  if (plain(left) && plain(right)) {
    const keys = Object.keys(left).sort();
    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}
function side(value) {
  return value === MISSING ? { present: false } : { present: true, value: structuredClone(value) };
}
function keyedItems(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  return value.every(item => {
    if (!plain(item) || !isSyncId(item.id) || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
}
function diffValue(local, cloud, path, changes) {
  if (equal(local, cloud)) return;
  if (plain(local) && plain(cloud)) {
    for (const key of [...new Set([...Object.keys(local), ...Object.keys(cloud)])].sort()) {
      diffValue(
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(cloud, key) ? cloud[key] : MISSING,
        [...path, key],
        changes
      );
    }
    return;
  }
  // Вложенные задания/награды имеют ID: не сопоставляем разные элементы по индексу.
  if (keyedItems(local) && keyedItems(cloud)) {
    const a = new Map(local.map(item => [item.id, item]));
    const b = new Map(cloud.map(item => [item.id, item]));
    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      diffValue(a.has(id) ? a.get(id) : MISSING, b.has(id) ? b.get(id) : MISSING, [...path, id], changes);
    }
    const sameIds = a.size === b.size && [...a.keys()].every(id => b.has(id));
    if (sameIds && !equal([...a.keys()], [...b.keys()]))
      changes.push({ path: [...path, 'order'], local: side([...a.keys()]), cloud: side([...b.keys()]) });
    return;
  }
  changes.push({ path, local: side(local), cloud: side(cloud) });
}
function label(record) {
  for (const key of ['nick', 'title', 'name', 'who', 'counterparty', 'date']) {
    if (typeof record.fields[key] === 'string' && record.fields[key].trim()) return record.fields[key];
  }
  return '';
}
function compareOrder(local, cloud, section, results) {
  if (Array.isArray(local) && Array.isArray(cloud)) {
    // Разный состав уже показан по записям; изменение порядка показываем отдельно
    // только при одинаковом составе, чтобы отсутствие не выглядело удалением.
    const cloudIds = new Set(cloud);
    const same = local.length === cloud.length && local.every(id => cloudIds.has(id));
    if (same && !equal(local, cloud)) results.push({ section, kind: 'order_changed', path: ['order'] });
  } else {
    for (const key of Object.keys(local)) {
      const a = local[key];
      const b = cloud[key];
      const cloudIds = new Set(b);
      const same = a.length === b.length && a.every(id => cloudIds.has(id));
      if (same && !equal(a, b)) results.push({ section, kind: 'order_changed', path: ['order', key] });
    }
  }
}

/**
 * Возвращает независимый read-only список различий и непроверенных выбранных настроек.
 * Нет данных о предке — не называем отсутствие добавлением или удалением.
 * @param {{local: any, cloud: any}} options
 */
export function comparePublicSnapshots({ local, cloud }) {
  const checkedLocal = validate(local);
  const checkedCloud = validate(cloud);
  for (const [id, identityType] of checkedLocal.identities) {
    if (checkedCloud.identities.has(id) && checkedCloud.identities.get(id) !== identityType) throw invalidExport();
  }
  const a = checkedLocal.sections;
  const b = checkedCloud.sections;
  const entries = [];
  const types = new Map();
  for (const section of SECTIONS.filter(name => name !== 'preferences')) {
    for (const row of [...a[section].records, ...b[section].records]) {
      const known = types.get(row.id);
      if (known && known !== `${section}:${row.type}`) throw invalidExport();
      types.set(row.id, `${section}:${row.type}`);
    }
    const left = new Map(a[section].records.map(row => [row.id, row]));
    const right = new Map(b[section].records.map(row => [row.id, row]));
    const identityReview = new Set();
    if (section === 'planner') {
      const guild = records =>
        new Map(records.filter(row => row.fields.source.kind === 'guild').map(row => [row.fields.source.eventId, row]));
      const localGuild = guild(a.planner.records);
      const cloudGuild = guild(b.planner.records);
      for (const [eventId, localRecord] of localGuild) {
        const cloudRecord = cloudGuild.get(eventId);
        if (cloudRecord && localRecord.id !== cloudRecord.id) {
          identityReview.add(localRecord.id);
          identityReview.add(cloudRecord.id);
          entries.push({
            section,
            kind: 'identity_review',
            type: 'plannerEntry',
            label: label(localRecord) || label(cloudRecord),
            localId: localRecord.id,
            cloudId: cloudRecord.id,
            changes: []
          });
        }
      }
    }
    for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (identityReview.has(id)) continue;
      const localRecord = left.get(id);
      const cloudRecord = right.get(id);
      if (!localRecord || !cloudRecord) {
        const record = localRecord || cloudRecord;
        entries.push({
          section,
          id,
          type: record.type,
          label: label(record),
          kind: localRecord ? 'only_local' : 'only_cloud',
          changes: []
        });
        continue;
      }
      const changes = [];
      if (Object.hasOwn(localRecord, 'archived'))
        diffValue(localRecord.archived, cloudRecord.archived, ['archived'], changes);
      diffValue(localRecord.fields, cloudRecord.fields, [], changes);
      if (changes.length)
        entries.push({
          section,
          id,
          type: localRecord.type,
          label: label(localRecord) || label(cloudRecord),
          kind: 'changed',
          changes
        });
    }
    compareOrder(a[section].order, b[section].order, section, entries);
    if (section === 'finance') {
      const changes = [];
      diffValue(a.finance.settings, b.finance.settings, [], changes);
      if (changes.length) entries.push({ section, kind: 'settings_changed', changes });
    }
  }
  const uncomparedSettings = [];
  for (const name of PORTABLE_SETTING_GROUPS) {
    const onLocal = a.preferences.selections.includes(name);
    const onCloud = b.preferences.selections.includes(name);
    if (onLocal !== onCloud) {
      uncomparedSettings.push(name);
    } else if (onLocal) {
      const changes = [];
      diffValue(a.preferences.values[name], b.preferences.values[name], [], changes);
      if (changes.length) entries.push({ section: 'preferences', kind: 'settings_changed', group: name, changes });
    }
  }
  return { entries, uncomparedSettings };
}
