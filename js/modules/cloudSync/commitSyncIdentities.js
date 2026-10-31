// @ts-check
// Подготовка и подтверждённое сохранение новых sync-ID после точного backup.
// Вызывается вручную экспериментальной панелью, но не автосинхронизацией. Старые ID не заменяются.
// Guard ограничен одним JS-контекстом и не является межпроцессным CAS.
import { preparationCheck, preparationError } from './preparationDiagnostics.js';
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
  preparationCheck('storage', () => assertStateWriteAvailable());
  const original = currentCloudStateSnapshot();
  const plan = preparationCheck('ids', () =>
    planSyncIdentities({
      snapshot: original,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    })
  );
  const publicSnapshot = preparationCheck('public', () => buildPublicSnapshot(plan.snapshot));
  const { ui: _ui, ...normalized } = preparationCheck('reload', () => normalizeState(plan.snapshot));
  const normalizedPublic = preparationCheck('reload', () => buildPublicSnapshot(normalized));
  const comparison = preparationCheck('roundtrip', () =>
    comparePublicSnapshots({ local: publicSnapshot, cloud: normalizedPublic })
  );
  if (comparison.entries.length || comparison.uncomparedSettings.length)
    preparationCheck('roundtrip', () =>
      preparationCheck(comparison.entries[0]?.section || 'preferences', () => {
        throw preparationError(new Error('Идентификаторы не проходят проверку после перезапуска'), 'reload_changes');
      })
    );
  if (!plan.changed) return Object.freeze({ status: 'already_assigned' });
  const count = Object.values(plan.assigned).reduce((sum, value) => sum + value, 0);
  const operation = preparationCheck('guard', () =>
    stageGuardedCloudStateWrite({
      original,
      candidate: plan.snapshot,
      backupLabel: 'pre-cloud-identities',
      selectedCount: count,
      identityOnly: true
    })
  );
  return Object.freeze({ status: 'prepared', assigned: Object.freeze({ ...plan.assigned }), operation });
}
