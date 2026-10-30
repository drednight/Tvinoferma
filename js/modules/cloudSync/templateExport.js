// @ts-check
// Шаблон — отдельная сущность, но его задания и награды являются копируемыми значениями,
// не сущностями исходного марафона: их локальные ID не должны передавать идентичность копии.
import { isSyncId } from './envelope.js';
import { safeSiteUrl } from './marathonExport.js';
import { array, invalidExport, nullableText, number, object, oneOf, text } from './exportSchema.js';

function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  const n = number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalidExport();
  return n;
}
function unique(values) {
  if (new Set(values).size !== values.length) throw invalidExport();
  return values;
}
function schedule(value) {
  const data = object(value, [], ['mode', 'dates', 'weekStartDay']);
  return {
    mode: Object.hasOwn(data, 'mode') ? oneOf(data.mode, ['everyDay', 'weekly', 'dates']) : 'everyDay',
    dates: Object.hasOwn(data, 'dates')
      ? unique(
          array(data.dates, value => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) throw invalidExport();
            return value;
          })
        )
      : [],
    weekStartDay: Object.hasOwn(data, 'weekStartDay') ? integer(data.weekStartDay, 0, 6) : 1
  };
}
function reward(value) {
  const data = object(value, [], ['id', 'threshold', 'rewardText', 'rewardCoins']);
  if (Object.hasOwn(data, 'id') && !text(data.id)) throw invalidExport();
  return {
    threshold: Object.hasOwn(data, 'threshold') ? integer(data.threshold, 1) : 1,
    rewardText: Object.hasOwn(data, 'rewardText') ? text(data.rewardText) : '',
    rewardCoins: Object.hasOwn(data, 'rewardCoins') ? number(data.rewardCoins) : 0
  };
}
function task(value) {
  const data = object(
    value,
    ['title'],
    ['id', 'siteTitle', 'description', 'descriptionSource', 'targetChecks', 'schedule', 'rewards']
  );
  if (Object.hasOwn(data, 'id') && !text(data.id)) throw invalidExport();
  const description = Object.hasOwn(data, 'description') ? text(data.description) : '';
  const descriptionSource = Object.hasOwn(data, 'descriptionSource')
    ? oneOf(data.descriptionSource, ['', 'site', 'news', 'manual'])
    : description
      ? 'site'
      : '';
  return {
    title: text(data.title),
    siteTitle: Object.hasOwn(data, 'siteTitle') ? nullableText(data.siteTitle) : null,
    description,
    descriptionSource,
    targetChecks: Object.hasOwn(data, 'targetChecks') ? integer(data.targetChecks, 1) : 1,
    schedule: Object.hasOwn(data, 'schedule') ? schedule(data.schedule) : schedule({}),
    rewards: Object.hasOwn(data, 'rewards') ? array(data.rewards, reward) : []
  };
}
function bonus(value) {
  const data = object(value, [], ['id', 'needTasks', 'text']);
  if (Object.hasOwn(data, 'id') && !text(data.id)) throw invalidExport();
  return {
    needTasks: Object.hasOwn(data, 'needTasks') ? integer(data.needTasks, 1) : 1,
    text: Object.hasOwn(data, 'text') ? text(data.text) : ''
  };
}

/** @param {{ syncId?: string }} [options] */
export function exportMarathonTemplate(template, options = {}) {
  const opts = object(options, ['syncId']);
  if (!isSyncId(opts.syncId)) throw invalidExport();
  const data = object(template, ['id', 'syncId', 'name', 'tasks'], ['sourceUrl', 'bonuses', 'createdAt']);
  if (!text(data.id) || data.syncId !== opts.syncId || !text(data.name).trim()) throw invalidExport();
  return {
    id: opts.syncId,
    type: 'marathonTemplate',
    fields: {
      name: data.name,
      sourceUrl: Object.hasOwn(data, 'sourceUrl') ? safeSiteUrl(data.sourceUrl) : null,
      tasks: array(data.tasks, task),
      bonuses: Object.hasOwn(data, 'bonuses') ? array(data.bonuses, bonus) : [],
      createdAt: Object.hasOwn(data, 'createdAt') ? nullableText(data.createdAt) : null
    }
  };
}
