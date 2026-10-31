// @ts-check
// Только фиксированные коды. Ни error.message/cause, ни пользовательские ключи,
// id, индексы, названия или значения не становятся диагностикой для интерфейса.
const details = new WeakMap();
const SCOPES = new Set([
  'storage',
  'crypto',
  'planner',
  'preferences',
  'snapshot',
  'ids',
  'public',
  'reload',
  'roundtrip',
  'guard',
  'root',
  'characters',
  'archivedCharacters',
  'parties',
  'archivedParties',
  'marathons',
  'marathonTemplates',
  'plannerEntries',
  'finance',
  'settings',
  'financeOperations',
  'financeShopItems',
  'financeLoans',
  'financePayments',
  'marathonTasks',
  'marathonRewards',
  'marathonBonuses',
  'stats',
  'statsHistory',
  'coinHistory',
  'marathonData',
  'source',
  'progress',
  'balance',
  'awards',
  'tasks',
  'operations',
  'shopItems',
  'loans',
  'payments'
]);
const REASONS = new Set([
  'invalid',
  'shape',
  'missing_field',
  'unknown_field',
  'array',
  'text',
  'number',
  'boolean',
  'choice',
  'reference',
  'local_id',
  'duplicate_local_id',
  'sync_id',
  'duplicate_sync_id',
  'id_collision',
  'crypto',
  'reload_changes',
  'runtime_value',
  'runtime_object',
  'runtime_field',
  'runtime_array',
  'runtime_cycle',
  'runtime_size',
  'runtime_depth'
]);

export function preparationError(error, reason = 'invalid') {
  const safe = error instanceof Error ? error : new Error('Проверка данных остановлена');
  if (!details.has(safe)) details.set(safe, { scopes: [], reason: REASONS.has(reason) ? reason : 'invalid' });
  return safe;
}

/** Синхронная граница проверки; не перехватывает ошибки Promise. */
export function preparationCheck(scope, run) {
  try {
    return run();
  } catch (error) {
    const safe = preparationError(error);
    const previous = details.get(safe);
    details.set(safe, {
      scopes: [...(SCOPES.has(scope) ? [scope] : []), ...previous.scopes],
      reason: previous.reason
    });
    throw safe;
  }
}

export function preparationDiagnosticCode(error) {
  // Не доверяем внешним error.code/message и даже объекту, похожему на Error.
  const detail = error && typeof error === 'object' ? details.get(error) : null;
  if (!detail) return 'setup/identities/unknown';
  return `setup/identities/${detail.scopes.length ? detail.scopes.join('.') : 'unknown'}/${detail.reason}`;
}
