// @ts-check
// Экспериментальное ТОЛЬКО ЧТЕНИЕ: сверка известных отпечатков истории и сравнение
// с зафиксированной копией локального публичного снимка. Нет резервного копирования,
// записи state, выбора пользователя за него, авторазрешения конфликтов или UI.
// Неполнота/откат всего облачного списка, локальной записи и часов не обнаруживаются.
// Результат содержит пользовательские поля: не логировать и рендерить только как текст.
import { isSyncId, MAX_SNAPSHOT_BYTES } from './envelope.js';
import { array, object } from './exportSchema.js';
import { comparePublicSnapshots, publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { MAX_HISTORY_VERSIONS, verifyHistory } from './history.js';
import { copyCloudEnvelope } from './providers/common.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';

const MAX_HISTORY_CHARS = 64 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
function failed() {
  return new Error('Не удалось безопасно подготовить сравнение облачных версий');
}
function result(status) {
  return Object.freeze({ status });
}
function pin(value) {
  const input = object(value, ['versionId', 'sha256']);
  if (!isSyncId(input.versionId) || typeof input.sha256 !== 'string' || !HEX.test(input.sha256)) throw failed();
  return Object.freeze({ versionId: input.versionId, sha256: input.sha256 });
}
function timestamp(value) {
  if (value === null) return null;
  const date = parseCloudModifiedTime(value);
  if (date === null) throw failed();
  return date;
}
function metadata(value) {
  const input = object(value, ['versionId', 'modifiedAt']);
  if (!isSyncId(input.versionId)) throw failed();
  return Object.freeze({ versionId: input.versionId, modifiedAt: timestamp(input.modifiedAt) });
}
function checkTime(now) {
  const value = now();
  if (!Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000) throw failed();
  return timestamp(new Date(value).toISOString());
}
function savedSnapshot(value) {
  publicSnapshotIdentityTypes(value);
  let copy;
  try {
    // Отвергает Proxy и не оставляет общих ссылок с изменяемым состоянием приложения.
    copy = structuredClone(value);
  } catch {
    throw failed();
  }
  publicSnapshotIdentityTypes(copy);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > MAX_SNAPSHOT_BYTES) throw failed();
  return copy;
}

/**
 * Загружает каждую наблюдаемую версию и проверяет дерево против отдельно доверенных root/knownPins.
 * Целевой файл НЕ выбирается по дате и не применяется. localSavedAt передаётся только
 * если известна его реальная привязка к снимку, иначе null; checkedAt — локальные часы.
 * После получения результата локальные данные могли измениться: для применения нужен
 * повторный witness, backup, проверка зависимостей и отдельное подтверждение. При отмене
 * уже начатое native-чтение может продолжаться; следующее чтение не запускается.
 *
 * @param {{provider:'google'|'yandex',session:any,datasetId:string,dataKey:string,rootPin:any,
 * knownPins:any[],localSnapshot:any,localSavedAt:string|null,now?:()=>number,cryptoSource?:Crypto,signal?:AbortSignal}} options
 */
export async function prepareCloudReview(options) {
  let input, root, known, local, savedAt;
  try {
    input = object(
      options,
      ['provider', 'session', 'datasetId', 'dataKey', 'rootPin', 'knownPins', 'localSnapshot', 'localSavedAt'],
      ['now', 'cryptoSource', 'signal']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !isSyncId(input.datasetId) ||
      typeof input.dataKey !== 'string' ||
      !input.session ||
      typeof input.session.listWithDates !== 'function' ||
      typeof input.session.read !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
    )
      throw failed();
    root = pin(input.rootPin);
    known = array(input.knownPins, pin);
    if (known.length > MAX_HISTORY_VERSIONS || new Set(known.map(item => item.versionId)).size !== known.length)
      throw failed();
    local = savedSnapshot(input.localSnapshot);
    savedAt = timestamp(input.localSavedAt);
  } catch {
    throw failed();
  }
  const { session, provider, datasetId, dataKey, cryptoSource } = input;
  const now = input.now || Date.now;
  const signal = input.signal;
  if (signal?.aborted) return result('cancelled');
  try {
    const listing = object(await session.listWithDates(), ['status'], ['versions']);
    if (signal?.aborted) return result('cancelled');
    if (listing.status === 'account_mismatch' || listing.status === 'account_unavailable')
      return result(listing.status);
    if (listing.status !== 'listed') return result('unavailable');
    const versions = array(listing.versions, metadata);
    if (
      versions.length > MAX_HISTORY_VERSIONS ||
      new Set(versions.map(item => item.versionId)).size !== versions.length
    )
      throw failed();
    const envelopes = [];
    let total = 0;
    for (const item of versions) {
      if (signal?.aborted) return result('cancelled');
      const received = object(await session.read(item.versionId), ['status'], ['envelope']);
      if (signal?.aborted) return result('cancelled');
      if (received.status === 'account_mismatch' || received.status === 'account_unavailable')
        return result(received.status);
      if (received.status === 'not_found' || received.status === 'identity_mismatch') return result('changed');
      if (received.status !== 'found') return result('unavailable');
      const envelope = copyCloudEnvelope(received.envelope, datasetId);
      if (envelope.versionId !== item.versionId) return result('changed');
      total += envelope.ciphertext.length + envelope.iv.length + (envelope.keyCapsule?.length || 0);
      if (total > MAX_HISTORY_CHARS) throw failed();
      envelopes.push(envelope);
    }
    let history;
    try {
      history = await verifyHistory({
        envelopes,
        expectedDatasetId: datasetId,
        recoveryKey: dataKey,
        root,
        knownPins: known,
        cryptoSource
      });
    } catch {
      if (signal?.aborted) return result('cancelled');
      // Список, ключ, версия или доверенные отпечатки не прошли проверку.
      return result('history_unverified');
    }
    if (signal?.aborted) return result('cancelled');
    const pins = new Map(history.pins().map(item => [item.versionId, pin(item)]));
    const heads = new Set(history.observedHeads().map(item => item.versionId));
    const observations = Object.freeze(
      versions.map(item => {
        const current = pins.get(item.versionId);
        if (!current) throw failed();
        return Object.freeze({ pin: current, modifiedAt: item.modifiedAt, observedHead: heads.has(item.versionId) });
      })
    );
    const checkedAt = checkTime(now);
    return Object.freeze({
      status: 'ready_for_review',
      provider,
      checkedAt,
      localSavedAt: savedAt,
      versions: observations,
      /**
       * Явный выбор точного отпечатка. Отсутствие записи в одной стороне не объявляется
       * удалением; результат read-only, содержит значения и может устареть.
       * @param {{versionId:string,sha256:string}} selectedPin
       */
      compare(selectedPin) {
        const selected = pin(selectedPin);
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) throw failed();
        const file = observations.find(item => item.pin.versionId === selected.versionId);
        return Object.freeze({
          provider,
          checkedAt,
          localSavedAt: savedAt,
          cloudModifiedAt: file.modifiedAt,
          pin: current,
          differences: comparePublicSnapshots({ local, cloud: history.publicSnapshot(current) })
        });
      }
    });
  } catch {
    if (signal?.aborted) return result('cancelled');
    // Ошибка транспорта может содержать OAuth, временную ссылку или данные пользователя.
    throw failed();
  }
}
