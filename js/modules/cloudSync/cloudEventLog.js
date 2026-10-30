// @ts-check
// Локальный, неавторитетный журнал пользовательских действий. Он не является
// очередью или доказательством успешной синхронизации и пока не переносится на ПК.
// Принимает только заранее заданные коды: никаких имён, путей, ошибок, ответов API,
// содержимого снимков, секретов или кодов сверки в журнал не попадает.
import { readLog, writeLogBounded } from '../../core/logStore.js';

const KEY = 'tf_cloud_activity_v1';
const MAX = 200;
const ACTIONS = Object.freeze({
  prepare: 'Подготовка первого набора',
  recover: 'Восстановление подключения',
  send: 'Отправка первого снимка',
  queue: 'Подготовка последующих изменений',
  publish: 'Отправка последующих изменений',
  check: 'Проверка обновлений',
  apply: 'Выборочное применение',
  file_replace: 'Замена данных полным файлом',
  reconcile: 'Согласование полного совпадения',
  merge: 'Объединение изменений',
  identities: 'Подготовка локальных идентификаторов',
  private_prepare: 'Подготовка защищённой партии контактов',
  private_check: 'Проверка выбранных контактов',
  private_apply: 'Применение выбранных контактов'
});
const OUTCOMES = Object.freeze({
  success: 'подтверждено',
  empty: 'подтверждённых версий не найдено',
  cancelled: 'отменено',
  blocked: 'остановлено проверкой',
  uncertain: 'результат не подтверждён',
  unavailable: 'не завершено'
});
let volatile = [];
let storageFailed = false;
const subscribers = new Set();
function valid(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    (value.provider === 'google' || value.provider === 'yandex') &&
    Object.hasOwn(ACTIONS, value.action) &&
    Object.hasOwn(OUTCOMES, value.outcome) &&
    typeof value.at === 'string' &&
    value.at.length === 24 &&
    Number.isFinite(Date.parse(value.at)) &&
    new Date(value.at).toISOString() === value.at
  );
}
function copy(value) {
  return Object.freeze({ provider: value.provider, action: value.action, outcome: value.outcome, at: value.at });
}
/** @returns {readonly {provider:string,action:string,outcome:string,at:string}[]} */
export function cloudActivity() {
  const saved = readLog(KEY, []);
  const rows = storageFailed ? volatile : Array.isArray(saved) ? saved : [];
  return Object.freeze(rows.filter(valid).slice(0, MAX).map(copy));
}
/** Записывает только перечисленные коды. Не используйте как свидетельство результата. */
export function recordCloudActivity(provider, action, outcome) {
  const at = new Date().toISOString();
  const entry = { provider, action, outcome, at };
  if (!valid(entry)) throw new Error('Некорректный код события синхронизации');
  const rows = [copy(entry), ...cloudActivity()].slice(0, MAX);
  volatile = rows;
  storageFailed = !writeLogBounded(KEY, rows);
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      /* уведомление не влияет на операцию */
    }
  }
  return !storageFailed;
}
/** Сохранился ли журнал в localStorage; false означает только память текущего запуска. */
export function cloudActivityPersisted() {
  return !storageFailed;
}
export function clearCloudActivity() {
  volatile = [];
  storageFailed = !writeLogBounded(KEY, []);
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      /* не мешать очистке */
    }
  }
  return !storageFailed;
}
export function subscribeCloudActivity(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
/** Готовые строки содержат только предопределённые подписи. */
export function describeCloudActivity(entry) {
  if (!valid(entry)) return '';
  const disk = entry.provider === 'google' ? 'Google Диск' : 'Яндекс Диск';
  return `${new Date(entry.at).toLocaleString('ru-RU', { timeZoneName: 'short' })} · ${disk} · ${ACTIONS[entry.action]} — ${OUTCOMES[entry.outcome]}`;
}
