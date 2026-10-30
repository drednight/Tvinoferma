// @ts-check
// Ручная ОДНОКРАТНАЯ отправка уже подготовленного корня. Это не полная
// синхронизация и не публикация последующих изменений. Потерянный результат
// сверяется чтением, но запрос создания автоматически не повторяется.
// Значения, токены, ID, ответы и исходные ошибки не журналировать.
import { loadData, forgetLoadedState } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { currentCloudStateSnapshot, cloudSnapshotMatchesDisk } from './guardedStateWrite.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

const NO_NETWORK = Object.freeze({
  async generateFileId() {
    throw new Error('not connected');
  },
  async upload() {
    throw new Error('not connected');
  },
  async verify() {
    throw new Error('not connected');
  }
});
function result(status) {
  return Object.freeze({ status });
}
function samePin(left, right, id) {
  return left?.[id] === right?.[id] && left?.sha256 === right?.sha256;
}

/**
 * Стартует только после явного действия. Если подготовленный корень отличается
 * от текущего снимка, его можно отправить только после отдельного подтверждения
 * как историческую основу: позднейшие изменения не считаются при этом отправленными.
 * Проверка уже начатой попытки возможна и при изменении state,
 * поскольку она ничего не записывает в облако. Только локальный JS-контекст и
 * кооперативные IPC; rollback, старое облако и настоящий провайдер не доказаны.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * confirmed:boolean,allowEarlierSnapshot?:boolean,settingsSelections?:string[],cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number,
 * openSession?:typeof openPinnedNativeCloudSession}} options
 */
export async function sendInitialCloudRoot(options) {
  const input = object(
    options,
    ['provider', 'invoke', 'confirmed'],
    ['settingsSelections', 'allowEarlierSnapshot', 'cryptoSource', 'now', 'timeoutMs', 'openSession']
  );
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    input.confirmed !== true ||
    (input.allowEarlierSnapshot !== undefined && typeof input.allowEarlierSnapshot !== 'boolean') ||
    (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections)) ||
    (input.openSession !== undefined && typeof input.openSession !== 'function')
  )
    throw new Error('Не удалось безопасно начать отправку');
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
  let operation;
  let session = null;
  let loaded = null;
  let snapshotForSend = null;
  let earlierSnapshot = false;
  let uncertainRefresh = false;
  try {
    operation = beginCloudDataOperation();
    const pin = /** @type {any} */ (await createNativeDatasetBindingStore({ provider, ...common }).read());
    if (pin.status !== 'ready') return result('binding_missing_or_blocked');
    const key = /** @type {any} */ (await createNativeKeyStateStore(keyOptions).read());
    const account = await readNativeCredentialBinding({ provider, ...common });
    if (
      key.status !== 'ready' ||
      account.status !== 'ready' ||
      key.state.slotId !== pin.binding.keySlotId ||
      key.state.datasetId !== pin.binding.datasetId ||
      account.binding.slotId !== pin.binding.accountSlotId ||
      !samePin(key.state.pin, pin.binding.keyPin, 'bundleId')
    )
      return result('binding_missing_or_blocked');
    const store = createNativeOutboxStore({ provider, ...common });
    const head = await store.read();
    if (head.status !== 'ready' || head.datasetId !== pin.binding.datasetId) return result('queue_blocked');
    const queue = network =>
      createDurableCloudOutbox({
        provider,
        datasetId: pin.binding.datasetId,
        deviceId: head.deviceId,
        slotId: head.slotId,
        clientId: account.binding.clientId,
        accountKey: account.binding.accountKey,
        dataKey: key.state.dataKey,
        store,
        session: network,
        ...(provider === 'google' ? { folderId: pin.binding.folderId } : {}),
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
      });
    const initial = await queue(NO_NETWORK).inspectInitialRoot({
      expectedKeyPin: pin.binding.keyPin,
      expectedRootPin: pin.binding.rootPin
    });
    if (initial.status !== 'ready') return result('queue_blocked');
    if (initial.phase === 'confirmed') return result('already_confirmed');
    if (initial.phase !== 'attempting') {
      let snapshot;
      try {
        snapshot = currentCloudStateSnapshot();
        requireResolvedSelectiveApply(snapshot.settings);
      } catch {
        return result('provenance_review_required');
      }
      let publicSnapshot;
      try {
        publicSnapshot = buildPublicSnapshot(snapshot, { settingsSelections: input.settingsSelections || [] });
        loaded = await loadData();
        if (
          JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshot) ||
          !cloudSnapshotMatchesDisk(snapshot, loaded)
        )
          return result('state_changed_or_unsaved');
      } catch {
        return result('state_changed_or_unsaved');
      } finally {
        if (loaded) forgetLoadedState(loaded);
        loaded = null;
      }
      const compared = await queue(NO_NETWORK).inspectInitialRoot({
        expectedKeyPin: pin.binding.keyPin,
        expectedRootPin: pin.binding.rootPin,
        publicSnapshot
      });
      if (compared.status !== 'ready' || compared.phase !== initial.phase) return result('queue_changed');
      if (compared.snapshotMatches !== true && input.allowEarlierSnapshot !== true)
        return result('prepared_snapshot_outdated');
      earlierSnapshot = compared.snapshotMatches !== true;
      if (JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshot))
        return result('state_changed_or_unsaved');
      snapshotForSend = snapshot;
    }
    // Google может выполнить guarded refresh. Потерянный ответ не отменяет IPC;
    // неподтверждённое открытие блокирует сброс в этом окне до перезапуска.
    uncertainRefresh = provider === 'google';
    const opened = /** @type {any} */ (
      await (input.openSession || openPinnedNativeCloudSession)({
        provider,
        ...keyOptions,
        ...(input.now ? { now: input.now } : {})
      })
    );
    if (opened.status !== 'opened') return result(opened.status || 'unavailable');
    uncertainRefresh = false;
    session = opened.session;
    if (
      opened.datasetId !== pin.binding.datasetId ||
      !samePin(opened.keyPin, pin.binding.keyPin, 'bundleId') ||
      !samePin(opened.rootPin, pin.binding.rootPin, 'versionId')
    )
      return result('binding_missing_or_blocked');
    const outbox = queue(session);
    if (initial.phase !== 'attempting') {
      try {
        if (JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshotForSend))
          return result('state_changed_or_unsaved');
        loaded = await loadData();
        if (
          JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshotForSend) ||
          !cloudSnapshotMatchesDisk(snapshotForSend, loaded)
        )
          return result('state_changed_or_unsaved');
      } catch {
        return result('state_changed_or_unsaved');
      } finally {
        if (loaded) forgetLoadedState(loaded);
        loaded = null;
      }
      const sent = await outbox.sendNext();
      if (sent.status !== 'needs_verification') return result(sent.status);
    }
    const verified = await outbox.verifyNext();
    if (verified.status === 'confirmed') return result(earlierSnapshot ? 'sent_earlier_verified' : 'sent_verified');
    if (verified.status === 'needs_review') return result('cloud_content_mismatch');
    return result('verification_pending');
  } catch {
    return result('unavailable');
  } finally {
    if (loaded) forgetLoadedState(loaded);
    session?.dispose?.();
    operation?.finish(uncertainRefresh);
  }
}
