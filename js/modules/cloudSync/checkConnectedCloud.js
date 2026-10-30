// @ts-check
// Проверка уже закреплённого набора на реальном desktop IPC. Не создаёт ключи,
// папки или очередь и не применяет данные. Пины в том же vault не защищают от
// согласованного отката; другие процессы и неполнота облака не исключаются.
// Параметры, секреты, исходные ошибки и снимки не журналировать.
import { loadData, forgetLoadedState } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { prepareCloudReview } from './cloudReview.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { currentCloudStateSnapshot, cloudSnapshotMatchesDisk } from './guardedStateWrite.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';
import { beginCloudCredentialOperation } from './credentialResetCoordination.js';

function failed() {
  return new Error('Не удалось безопасно проверить синхронизацию');
}
function status(value) {
  return Object.freeze({ status: value });
}
function samePin(a, b, idKey) {
  return a?.[idKey] === b?.[idKey] && a?.sha256 === b?.sha256;
}
function localTime(snapshot, loaded) {
  if (!cloudSnapshotMatchesDisk(snapshot, loaded)) return null;
  return parseCloudModifiedTime(loaded.savedAt);
}

/**
 * Читает защищённые записи, журнал подтверждений и версии только уже настроенного
 * провайдера. В случае отсутствия записи НЕ создаёт новый набор и не делает вывод,
 * что старого облака нет. localSavedAt сообщается лишь при совпадении файла и памяти.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * settingsSelections?:string[],now?:()=>number,cryptoSource?:Crypto,signal?:AbortSignal,timeoutMs?:number}} options
 */
export async function checkConnectedCloud(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'invoke'],
      ['settingsSelections', 'now', 'cryptoSource', 'signal', 'timeoutMs']
    );
    if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function') throw failed();
  } catch {
    throw failed();
  }
  let session = null;
  let loaded = null;
  let operation;
  let uncertainRefresh = false;
  try {
    operation = beginCloudCredentialOperation();
    if (input.signal?.aborted) return status('cancelled');
    const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
    const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
    const binding = /** @type {any} */ (
      await createNativeDatasetBindingStore({ provider: input.provider, ...common }).read()
    );
    if (binding.status === 'empty') return status('binding_missing');
    if (binding.status !== 'ready') return status('binding_blocked');
    if (input.signal?.aborted) return status('cancelled');
    const original = currentCloudStateSnapshot();
    const publicSnapshot = buildPublicSnapshot(original, { settingsSelections: input.settingsSelections || [] });
    let savedAt = null;
    try {
      loaded = await loadData();
      if (JSON.stringify(currentCloudStateSnapshot()) === JSON.stringify(original))
        savedAt = localTime(original, loaded);
    } finally {
      if (loaded) forgetLoadedState(loaded);
      loaded = null;
    }
    if (input.signal?.aborted) return status('cancelled');
    const key = /** @type {any} */ (await createNativeKeyStateStore(keyOptions).read());
    const account = await readNativeCredentialBinding({ provider: input.provider, ...common });
    if (
      key.status !== 'ready' ||
      account.status !== 'ready' ||
      key.state.slotId !== binding.binding.keySlotId ||
      key.state.datasetId !== binding.binding.datasetId ||
      !samePin(key.state.pin, binding.binding.keyPin, 'bundleId') ||
      account.binding.slotId !== binding.binding.accountSlotId
    )
      return status('binding_blocked');
    const store = createNativeOutboxStore({ provider: input.provider, ...common });
    const head = await store.read();
    if (head.status !== 'ready' || head.datasetId !== binding.binding.datasetId) return status('queue_not_ready');
    if (input.signal?.aborted) return status('cancelled');
    // Google может обновить credential. Потеря ответа не отменяет native IPC;
    // при неподтверждённом открытии не разрешаем сброс до проверки/перезапуска.
    uncertainRefresh = input.provider === 'google';
    const opened = await openPinnedNativeCloudSession({
      provider: input.provider,
      ...keyOptions,
      ...(input.now ? { now: input.now } : {})
    });
    if (opened.status !== 'opened') return status(opened.status);
    uncertainRefresh = false;
    session = opened.session;
    if (
      opened.datasetId !== binding.binding.datasetId ||
      !samePin(opened.rootPin, binding.binding.rootPin, 'versionId') ||
      !samePin(opened.keyPin, binding.binding.keyPin, 'bundleId')
    )
      return status('binding_blocked');
    const outbox = createDurableCloudOutbox({
      provider: input.provider,
      datasetId: opened.datasetId,
      deviceId: head.deviceId,
      slotId: head.slotId,
      clientId: account.binding.clientId,
      accountKey: account.binding.accountKey,
      dataKey: key.state.dataKey,
      store,
      session,
      ...(input.provider === 'google' ? { folderId: binding.binding.folderId } : {}),
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    const confirmed = await outbox.confirmedPins();
    if (confirmed.status !== 'ready') return status('queue_not_ready');
    const pins = new Map([[opened.rootPin.versionId, opened.rootPin]]);
    for (const pin of confirmed.pins) {
      const previous = pins.get(pin.versionId);
      if (previous && !samePin(previous, pin, 'versionId')) return status('binding_blocked');
      pins.set(pin.versionId, pin);
    }
    return await prepareCloudReview({
      provider: input.provider,
      session,
      datasetId: opened.datasetId,
      dataKey: key.state.dataKey,
      rootPin: opened.rootPin,
      knownPins: [...pins.values()],
      localSnapshot: publicSnapshot,
      localSavedAt: savedAt,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch {
    if (input.signal?.aborted) return status('cancelled');
    throw failed();
  } finally {
    if (loaded) forgetLoadedState(loaded);
    session?.dispose();
    operation?.finish(uncertainRefresh);
  }
}
