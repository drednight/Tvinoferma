// @ts-check
// Подготовка и подтверждённое сохранение новых sync-ID после точного backup.
// Вызывается вручную экспериментальной панелью, но не автосинхронизацией. Старые ID не заменяются.
// Guard ограничен одним JS-контекстом и не является межпроцессным CAS.
import { normalizeState } from '../../core/state.js';
import { assertStateWriteAvailable } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { planSyncIdentities } from './identityMigration.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { currentCloudStateSnapshot, stageGuardedCloudStateWrite } from './guardedStateWrite.js';

/**
 * Все сущности, созданные после последней отправки, получают идентификаторы вместе.
 * До commit новые ID не используются в файле или облаке. Если состояние изменилось
 * либо имеет несохранённые правки, требуется новый план; в этом модуле нет сети.
 * @param {{cryptoSource?:Crypto}} [options]
 */
export function stageSyncIdentities(options = {}) {
  const input = object(options, [], ['cryptoSource']);
  assertStateWriteAvailable();
  const original = currentCloudStateSnapshot();
  const plan = planSyncIdentities({
    snapshot: original,
    ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
  });
  if (!plan.changed) return Object.freeze({ status: 'already_assigned' });
  const publicSnapshot = buildPublicSnapshot(plan.snapshot);
  const { ui: _ui, ...normalized } = normalizeState(plan.snapshot);
  const normalizedPublic = buildPublicSnapshot(normalized);
  const comparison = comparePublicSnapshots({ local: publicSnapshot, cloud: normalizedPublic });
  if (comparison.entries.length || comparison.uncomparedSettings.length)
    throw new Error('Идентификаторы не проходят проверку после перезапуска');
  const count = Object.values(plan.assigned).reduce((sum, value) => sum + value, 0);
  const operation = stageGuardedCloudStateWrite({
    original,
    candidate: plan.snapshot,
    backupLabel: 'pre-cloud-identities',
    selectedCount: count,
    identityOnly: true
  });
  return Object.freeze({ status: 'prepared', assigned: Object.freeze({ ...plan.assigned }), operation });
}
