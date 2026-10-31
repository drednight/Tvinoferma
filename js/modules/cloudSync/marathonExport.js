// @ts-check
// Снимок одного марафона/папки: только проверенные поля и ссылки на устойчивые sync-ID.
// Не запускает скрипты. История lastSync содержит локальные ошибки входа и не экспортируется.
import { preparationCheck, preparationError } from './preparationDiagnostics.js';
import { isSyncId } from './envelope.js';
import {
  array,
  dictionary,
  invalidExport,
  mappedDictionary,
  nullableNumber,
  nullableText,
  number,
  object,
  oneOf,
  text
} from './exportSchema.js';

const TASK_KEYS = [
  'id',
  'syncId',
  'title',
  'siteTitle',
  'description',
  'descriptionSource',
  'targetChecks',
  'schedule',
  'rewards'
];
const REWARD_KEYS = ['id', 'syncId', 'threshold', 'rewardText', 'rewardCoins'];
const BONUS_KEYS = ['id', 'syncId', 'needTasks', 'text'];
const SINGLE_KEYS = [
  'id',
  'syncId',
  'schemaVersion',
  'kind',
  'seriesId',
  'title',
  'description',
  'source',
  'bonuses',
  'startDate',
  'endDate',
  'status',
  'participantIds',
  'assignments',
  'tasks',
  'progress',
  'lastSync',
  'balance',
  'awards',
  'createdAt',
  'updatedAt',
  'completedAt'
];
const SERIES_KEYS = [
  'id',
  'syncId',
  'schemaVersion',
  'kind',
  'title',
  'description',
  'source',
  'childIds',
  'createdAt',
  'updatedAt'
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function link(map, id) {
  if (!(map instanceof Map) || !text(id) || !isSyncId(map.get(id))) {
    throw preparationError(new Error('Не найдена ссылка марафона; экспорт остановлен'), 'reference');
  }
  return map.get(id);
}
function nullableLink(map, id) {
  return id === null ? null : link(map, id);
}
function unique(values) {
  if (new Set(values).size !== values.length) throw invalidExport('duplicate');
  return values;
}
function date(value) {
  const result = text(value);
  if (!DATE.test(result)) throw invalidExport('date_format');
  return result;
}
function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw invalidExport('integer_range');
  return result;
}

// Ссылка — данные, не разрешение на выполнение. Исполнитель обязан повторно проверять сайт.
// Разрешены только известные URL PW Online; произвольные параметры могут содержать секреты.
export function safeSiteUrl(value) {
  if (value === null) return null;
  const raw = text(value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidExport('url_format');
  }
  if (url.protocol !== 'https:') throw invalidExport('url_scheme');
  if (!['pwonline.ru', 'www.pwonline.ru'].includes(url.hostname)) throw invalidExport('url_host');
  if (url.username || url.password) throw invalidExport('url_auth');
  if (url.port) throw invalidExport('url_port');
  if (url.hash) throw invalidExport('url_fragment');
  const seen = new Set();
  for (const [key, item] of url.searchParams) {
    if (seen.has(key)) throw invalidExport('url_query_duplicate');
    seen.add(key);
    const ok =
      (['article', 'page', 'id'].includes(key) && /^\d+$/.test(item)) ||
      (key === 'archive' && item === 'news') ||
      (key === 'type' && item === 'event');
    if (!ok) throw invalidExport('url_query');
  }
  return raw;
}

function source(value, templateIds) {
  const data = object(value, ['type', 'url', 'siteName'], ['stageKey', 'stageName', 'templateId', 'newsUrl']);
  return {
    type: oneOf(data.type, ['manual', 'site', 'template']),
    url: preparationCheck('url', () => safeSiteUrl(data.url)),
    siteName: nullableText(data.siteName),
    stageKey: Object.hasOwn(data, 'stageKey') ? nullableText(data.stageKey) : null,
    stageName: Object.hasOwn(data, 'stageName') ? nullableText(data.stageName) : null,
    templateId: Object.hasOwn(data, 'templateId')
      ? preparationCheck('templateId', () => nullableLink(templateIds, data.templateId))
      : null,
    newsUrl: Object.hasOwn(data, 'newsUrl') ? preparationCheck('newsUrl', () => safeSiteUrl(data.newsUrl)) : null
  };
}

function cell(value) {
  const data = object(value, [], ['site', 'siteTotal', 'adjust', 'marks', 'history', 'syncedAt']);
  return {
    site: Object.hasOwn(data, 'site') ? nullableNumber(data.site) : null,
    siteTotal: Object.hasOwn(data, 'siteTotal') ? nullableNumber(data.siteTotal) : null,
    adjust: Object.hasOwn(data, 'adjust') ? number(data.adjust) : 0,
    marks: Object.hasOwn(data, 'marks') ? unique(array(data.marks, date)) : [],
    history: Object.hasOwn(data, 'history') ? dictionary(data.history, key => DATE.test(key), number) : {},
    syncedAt: Object.hasOwn(data, 'syncedAt') ? nullableText(data.syncedAt) : null
  };
}
function balance(value, charIds) {
  const data = object(value, ['start', 'end']);
  const points = pointMap =>
    mappedDictionary(
      pointMap,
      id => link(charIds, id),
      value => {
        const point = object(value, ['coins', 'at']);
        return { coins: number(point.coins), at: text(point.at) };
      }
    );
  return { start: points(data.start), end: points(data.end) };
}

/** @param {{ syncId?: string, characterSyncIds?: Map<string,string>, marathonSyncIds?: Map<string,string>, templateSyncIds?: Map<string,string> }} [options] */
export function exportMarathon(marathon, options = {}) {
  const opts = object(options, ['syncId', 'characterSyncIds', 'marathonSyncIds', 'templateSyncIds']);
  if (
    !isSyncId(opts.syncId) ||
    !(opts.characterSyncIds instanceof Map) ||
    !(opts.marathonSyncIds instanceof Map) ||
    !(opts.templateSyncIds instanceof Map)
  )
    throw invalidExport();
  // Прежде чем выбирать схему по kind, не выполнять getter на недоверенном объекте.
  const base = object(
    marathon,
    ['id', 'syncId', 'schemaVersion', 'kind', 'title', 'description', 'source', 'createdAt', 'updatedAt'],
    [
      'seriesId',
      'bonuses',
      'startDate',
      'endDate',
      'status',
      'participantIds',
      'assignments',
      'tasks',
      'progress',
      'lastSync',
      'balance',
      'awards',
      'completedAt',
      'childIds'
    ]
  );
  const kind = oneOf(base.kind, ['single', 'series']);
  const data = object(marathon, kind === 'series' ? SERIES_KEYS : SINGLE_KEYS);
  if (!text(data.id) || data.syncId !== opts.syncId || data.schemaVersion !== 2) throw invalidExport();
  if (opts.marathonSyncIds.get(data.id) !== opts.syncId) throw invalidExport();
  const common = {
    title: text(data.title),
    description: text(data.description),
    source: preparationCheck('source', () => source(data.source, opts.templateSyncIds)),
    createdAt: text(data.createdAt),
    updatedAt: text(data.updatedAt)
  };
  if (kind === 'series') {
    const childIds = preparationCheck('childIds', () =>
      unique(array(data.childIds, id => link(opts.marathonSyncIds, id)))
    );
    if (childIds.includes(opts.syncId)) throw invalidExport('self_reference');
    return { id: opts.syncId, type: 'marathonSeries', fields: { ...common, childIds } };
  }

  const taskIds = new Map();
  const used = new Set([opts.syncId]);
  const addId = row => {
    if (!text(row.id) || !isSyncId(row.syncId) || used.has(row.syncId)) throw invalidExport();
    used.add(row.syncId);
    return row.syncId;
  };
  const tasks = preparationCheck('tasks', () =>
    array(data.tasks, value => {
      const task = object(value, TASK_KEYS);
      const taskId = addId(task);
      if (taskIds.has(task.id)) throw invalidExport();
      taskIds.set(task.id, taskId);
      const schedule = preparationCheck('schedule', () => object(task.schedule, ['mode', 'dates', 'weekStartDay']));
      const rewardIds = new Set();
      const rewards = preparationCheck('rewards', () =>
        array(task.rewards, value => {
          const reward = object(value, REWARD_KEYS);
          if (rewardIds.has(reward.id)) throw invalidExport();
          rewardIds.add(reward.id);
          return {
            id: addId(reward),
            threshold: integer(reward.threshold, 1),
            rewardText: text(reward.rewardText),
            rewardCoins: number(reward.rewardCoins)
          };
        })
      );
      return {
        id: taskId,
        title: text(task.title),
        siteTitle: nullableText(task.siteTitle),
        description: text(task.description),
        descriptionSource: oneOf(task.descriptionSource, ['', 'site', 'news', 'manual']),
        targetChecks: preparationCheck('schedule', () => integer(task.targetChecks, 1)),
        schedule: preparationCheck('schedule', () => ({
          mode: oneOf(schedule.mode, ['everyDay', 'weekly', 'dates']),
          dates: preparationCheck('dates', () => unique(array(schedule.dates, date))),
          weekStartDay: integer(schedule.weekStartDay, 0, 6)
        })),
        rewards
      };
    })
  );
  const bonusIds = new Set();
  const bonuses = preparationCheck('bonuses', () =>
    array(data.bonuses, value => {
      const bonus = object(value, BONUS_KEYS);
      if (bonusIds.has(bonus.id)) throw invalidExport();
      bonusIds.add(bonus.id);
      return { id: addId(bonus), needTasks: integer(bonus.needTasks, 1), text: text(bonus.text) };
    })
  );
  const charLink = id => link(opts.characterSyncIds, id);
  const taskLink = id => link(taskIds, id);
  const participantIds = preparationCheck('participantIds', () => unique(array(data.participantIds, charLink)));
  const assignments = preparationCheck('assignments', () =>
    mappedDictionary(data.assignments, charLink, value => unique(array(value, taskLink)))
  );
  const progress = preparationCheck('progress', () =>
    mappedDictionary(data.progress, charLink, taskMap => mappedDictionary(taskMap, taskLink, cell))
  );
  const awards = preparationCheck('awards', () =>
    array(data.awards, value => {
      const award = object(value, ['characterId', 'charNick', 'taskId', 'taskTitle', 'rewardText', 'coins']);
      return {
        characterId: nullableLink(opts.characterSyncIds, award.characterId),
        charNick: text(award.charNick),
        taskId: nullableLink(taskIds, award.taskId),
        taskTitle: text(award.taskTitle),
        rewardText: text(award.rewardText),
        coins: number(award.coins)
      };
    })
  );
  const seriesId = preparationCheck('seriesId', () => nullableLink(opts.marathonSyncIds, data.seriesId));
  if (seriesId === opts.syncId) throw invalidExport('self_reference');
  return {
    id: opts.syncId,
    type: 'marathon',
    fields: {
      ...common,
      seriesId,
      bonuses,
      startDate: preparationCheck('startDate', () => date(data.startDate)),
      endDate: preparationCheck('endDate', () => date(data.endDate)),
      status: oneOf(data.status, ['active', 'completed']),
      participantIds,
      assignments,
      tasks,
      progress,
      balance: preparationCheck('balance', () => balance(data.balance, opts.characterSyncIds)),
      awards,
      completedAt: nullableText(data.completedAt)
    }
  };
}
