// @ts-check
// Explicit second-provider connection to the SAME encrypted dataset/root.
// Source key/pin/queue are never replaced. No upload; each disk keeps its own queue.
import { object } from './exportSchema.js';
import { generateSyncId } from './envelope.js';
import { verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';
import { historyEnvelopePin } from './history.js';
import { createPairingCode } from './pairingCode.js';
import { createDatasetBindingRecord } from './datasetBindingRecord.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { captureInitialCloudBaseline } from './initialCloudBaseline.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

const result = (status, extra = {}) => Object.freeze({ status, ...extra });
const noNetwork = async () => {
  throw new Error('Подключение не отправляет файлы');
};
const NO_NETWORK = Object.freeze({ upload: noNetwork, verify: noNetwork, generateFileId: noNetwork });
const same = (a, b) => a?.versionId === b?.versionId && a?.sha256 === b?.sha256;

/** @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,confirmed:boolean,cryptoSource?:Crypto,timeoutMs?:number,settingsSelections?:string[],openSession?:typeof openPinnedNativeCloudSession}} options */
export async function connectAdditionalCloud(options) {
  const input = object(
    options,
    ['provider', 'invoke', 'confirmed'],
    ['cryptoSource', 'timeoutMs', 'settingsSelections', 'openSession']
  );
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function' || input.confirmed !== true)
    throw new Error('Требуется подтверждение подключения второго диска');
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const sourceProvider = provider === 'google' ? 'yandex' : 'google';
  const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
  let operation, baseline, session;
  let uncertainRefresh = false;
  let uncertainWrite = false;
  try {
    operation = beginCloudDataOperation();
    const key = /** @type {any} */ (await createNativeKeyStateStore(keyOptions).read());
    if (key.status !== 'ready') return result('key_missing_or_blocked');
    const pins = createNativeDatasetBindingStore({ provider, ...common });
    const sourcePins = createNativeDatasetBindingStore({ provider: sourceProvider, ...common });
    const source = /** @type {any} */ (await sourcePins.read());
    if (source.status !== 'ready') return result('source_binding_unavailable');
    if (
      source.binding.keySlotId !== key.state.slotId ||
      source.binding.datasetId !== key.state.datasetId ||
      source.binding.keyPin.bundleId !== key.state.pin.bundleId ||
      source.binding.keyPin.sha256 !== key.state.pin.sha256
    )
      return result('key_mismatch');
    const existing = /** @type {any} */ (await pins.read());
    if (existing.status === 'ready') {
      if (
        existing.binding.datasetId !== source.binding.datasetId ||
        !same(existing.binding.rootPin, source.binding.rootPin)
      )
        return result('binding_not_installed');
      return result('additional_connected');
    }
    if (existing.status !== 'empty') return result('binding_not_installed');
    const account = await readNativeCredentialBinding({ provider, ...common });
    const sourceAccount = await readNativeCredentialBinding({ provider: sourceProvider, ...common });
    if (account.status !== 'ready' || sourceAccount.status !== 'ready') return result('credential_missing_or_blocked');
    const sourceStore = createNativeOutboxStore({ provider: sourceProvider, ...common });
    const sourceHead = /** @type {any} */ (await sourceStore.read());
    if (sourceHead.status !== 'ready' || sourceHead.datasetId !== key.state.datasetId) return result('queue_blocked');
    const queue = (p, head, store, credential, folderId) =>
      createDurableCloudOutbox({
        provider: p,
        datasetId: key.state.datasetId,
        deviceId: head.deviceId,
        slotId: head.slotId,
        clientId: credential.clientId,
        accountKey: credential.accountKey,
        dataKey: key.state.dataKey,
        store,
        session: NO_NETWORK,
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
        ...(p === 'google' ? { folderId } : {})
      });
    const sourceQueue = queue(sourceProvider, sourceHead, sourceStore, sourceAccount.binding, source.binding.folderId);
    const retained = /** @type {any} */ (await sourceQueue.sharedRoot(source.binding.rootPin, key.state.pin));
    let envelope;
    if (retained.status === 'ready') envelope = retained.envelope;
    else if (retained.status === 'source_root_unavailable') {
      // The root may have left the local queue after history compaction. Read it
      // from its already pinned source; never trust a discovered root or overwrite it.
      uncertainRefresh = sourceProvider === 'google';
      const opened = /** @type {any} */ (
        await (input.openSession || openPinnedNativeCloudSession)({ provider: sourceProvider, ...keyOptions })
      );
      if (opened.status !== 'opened') return result(opened.status);
      uncertainRefresh = false;
      session = opened.session;
      const found = await session.read(source.binding.rootPin.versionId);
      if (found.status !== 'found') return result('source_root_unavailable');
      envelope = found.envelope;
    } else return result('queue_blocked');
    await verifyPortableEnvelopeBinding({
      envelope,
      dataKey: key.state.dataKey,
      expectedPin: key.state.pin,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    const rootPin = await historyEnvelopePin({
      envelope,
      expectedDatasetId: key.state.datasetId,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    if (!same(rootPin, source.binding.rootPin)) return result('root_mismatch');
    baseline = await captureInitialCloudBaseline({ settingsSelections: input.settingsSelections || [] });
    if (baseline.status !== 'ready') return result(baseline.status);
    const guard = {
      accountSlotId: account.binding.slotId,
      keySlotId: key.state.slotId,
      bundleId: key.state.pin.bundleId,
      fingerprint: key.state.pin.sha256,
      linkSource: { binding: source.raw, revisionId: sourceHead.revisionId, sha256: sourceHead.sha256 }
    };
    const store = createNativeOutboxStore({ provider, ...common, initialGuard: guard });
    let head = /** @type {any} */ (await store.read());
    if (!['empty', 'ready'].includes(head.status)) return result('queue_blocked');
    if (head.status === 'empty')
      head = { slotId: generateSyncId(input.cryptoSource), deviceId: generateSyncId(input.cryptoSource) };
    else if (head.datasetId !== key.state.datasetId) return result('queue_blocked');
    const destination = queue(provider, head, store, account.binding, 'root');
    if (!(await baseline.stillCurrentAndSaved())) return result('state_changed_or_unsaved');
    uncertainWrite = true;
    const initialized = await destination.initializeWithRoot(envelope, true);
    uncertainWrite = initialized.status === 'journal_uncertain';
    if (initialized.status === 'already_initialized') {
      const pending = /** @type {any} */ (await destination.pendingInitializationRoot(key.state.pin));
      if (pending.status !== 'ready' || !same(pending.rootPin, rootPin)) return result('queue_blocked');
    } else if (initialized.status !== 'initialized')
      return result(initialized.status === 'journal_uncertain' ? 'setup_uncertain' : 'queue_not_initialized');
    // Recheck before pin installation; native CAS above atomically checks source
    // pin/revision under the shared OS lock. A retry only completes the same root.
    const sourceNow = /** @type {any} */ (await sourcePins.read());
    if (sourceNow.status !== 'ready' || sourceNow.raw !== source.raw) return result('local_binding_changed');
    const binding = createDatasetBindingRecord({
      provider,
      accountSlotId: account.binding.slotId,
      keySlotId: key.state.slotId,
      datasetId: key.state.datasetId,
      keyPin: key.state.pin,
      rootPin,
      ...(provider === 'google' ? { folderId: 'root' } : {})
    });
    uncertainWrite = true;
    const installed = await pins.install(binding.binding, true);
    if (!['installed', 'occupied'].includes(installed.status)) {
      uncertainWrite = false;
      return result('binding_not_installed');
    }
    const saved = /** @type {any} */ (await pins.read());
    if (saved.status !== 'ready' || saved.raw !== binding.raw) {
      uncertainWrite = true;
      return result('setup_uncertain');
    }
    uncertainWrite = false;
    return result('additional_connected', {
      backup: baseline.backup,
      pairingCode: createPairingCode({ datasetId: key.state.datasetId, keyPin: key.state.pin, rootPin })
    });
  } catch {
    return result('setup_uncertain');
  } finally {
    session?.dispose?.();
    baseline?.close?.();
    operation?.finish(uncertainRefresh || uncertainWrite);
  }
}
