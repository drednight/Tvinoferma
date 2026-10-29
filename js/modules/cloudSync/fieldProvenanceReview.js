// @ts-check
// Ограниченный учёт происхождения выбранных ПОЛЕЙ одной существующей записи.
// Модель в памяти: не подтверждает сохранение на диске, не публикует снимки и не разрешает
// создание, удаление, архивирование или конфликты. Изолированный checkpoint-кодек может
// восстановить модель по независимым доверенным отметкам, но не сохраняет её в приложении.
// Подтверждение в этой модели — совпадение с другой версией в переданном проверенном дереве;
// реальное приложение обязано отдельно подтвердить транзакционную запись и доверенный корень.
import {
  decryptSnapshot,
  encryptSnapshot,
  generateSyncId,
  isSyncId,
  validateEnvelope,
  validateJsonSnapshot
} from './envelope.js';
import { isVerifiedHistory, MAX_HISTORY_VERSIONS } from './history.js';
import { array, object, oneOf } from './exportSchema.js';
import { createSelectiveRecordReview } from './selectiveRecordReview.js';
import { reviewSnapshotDependencies } from './reviewDependencies.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ORIGIN_EVENTS = 10_000;
const MISSING = Symbol('missing');
// Метаданные выдаются только для настоящих объектов модели, а не для произвольного JSON.
const reviewStates = new WeakMap();
const UNSAFE_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);
const CHECKPOINT_FORMAT = 'tvinoferma-field-provenance-checkpoint';
const CHECKPOINT_VERSION = 1;
const CHECKPOINT_HASH_DOMAIN = 'tvinoferma-provenance-checkpoint-envelope-sha256-v1';
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];

function invalid() {
  return new Error('Не удалось подтвердить происхождение выбранных изменений');
}

function pin(value) {
  const data = object(value, ['versionId', 'sha256']);
  if (!isSyncId(data.versionId) || typeof data.sha256 !== 'string' || !SHA256.test(data.sha256)) throw invalid();
  return { versionId: data.versionId, sha256: data.sha256 };
}

function samePin(a, b) {
  return a.versionId === b.versionId && a.sha256 === b.sha256;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (plain(left) && plain(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}

function copy(value) {
  return structuredClone(value);
}

function requireHistory(history) {
  // Это лишь маркер результата verifyHistory, не доказательство доверия к корню или полноты облака.
  if (!isVerifiedHistory(history)) throw invalid();
}

function requireDescendant(history, oldPin, newPin) {
  if (!samePin(history.commonAncestor(oldPin, newPin), oldPin)) {
    throw new Error('Обнаружено разветвление истории; требуется новый просмотр');
  }
}

function rejectKnownRemoteDescendant(history, remotePin, localPin) {
  // Нельзя притворяться, что просмотренная облачная версия — последняя, когда уже есть
  // другая известная её ветвь. Наблюдаемый локальный снимок не является новой облачной ветвью.
  for (const head of history.observedHeads()) {
    if (samePin(head, remotePin) || samePin(head, localPin)) continue;
    if (samePin(history.commonAncestor(remotePin, head), remotePin)) {
      throw new Error('Обнаружена новая версия в известной истории; требуется отдельный просмотр');
    }
  }
}

function findRecord(snapshot, section, id) {
  const record = snapshot.sections[section].records.find(item => item.id === id);
  if (!record) throw new Error('Нет общей записи для безопасного сравнения');
  return record;
}

function checkIdentity(record, expected) {
  if (record.id !== expected.id || record.type !== expected.type) throw invalid();
  if (Object.hasOwn(record, 'archived') !== expected.hasArchive) throw invalid();
  if (expected.hasArchive && record.archived !== expected.archived) {
    throw new Error('Архивация требует отдельной проверки');
  }
}

function selectedValueIntoBaseline(baseline, remote, path) {
  if (!path.length) throw invalid();
  let dest = baseline;
  let source = remote;
  for (const key of path.slice(0, -1)) {
    if (!plain(dest) || !plain(source) || !Object.hasOwn(dest, key) || !Object.hasOwn(source, key)) throw invalid();
    dest = dest[key];
    source = source[key];
  }
  const key = path[path.length - 1];
  if (!plain(dest) || !plain(source) || !Object.hasOwn(source, key)) throw invalid();
  dest[key] = copy(source[key]);
}

function visibleChange(change, sourcePin) {
  return { ...copy(change), source: { ...sourcePin } };
}

function valueAtPath(value, path) {
  for (const key of path) {
    if (!plain(value) || !Object.hasOwn(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

function makeReview(state) {
  const { history, localPin, remotePin, section, id, expected } = state;
  const localSnapshot = history.publicSnapshot(localPin);
  const remoteSnapshot = history.publicSnapshot(remotePin);
  const local = findRecord(localSnapshot, section, id);
  const remote = findRecord(remoteSnapshot, section, id);
  checkIdentity(local, expected);
  checkIdentity(remote, expected);
  const localRecord = { deleted: false, fields: local.fields };
  const remoteRecord = { deleted: false, fields: remote.fields };
  const selective = createSelectiveRecordReview({
    base: { deleted: false, fields: state.baseline },
    local: localRecord,
    remote: remoteRecord
  });
  const incoming = () => selective.changes().map(change => visibleChange(change, remotePin));

  const review = Object.freeze({
    /** Ожидающие изменения с версией-источником; поля и пути нельзя записывать в лог. */
    changes() {
      return incoming();
    },
    /** Последовательность ранее подтверждённых в этой модели выбранных путей и источников. */
    origins() {
      return copy(state.origins);
    },
    /**
     * Строит только предложение. До bind никакое выбранное поле не считается принятым.
     * Конфликты, отсутствие поля и ошибки известных связей блокируют всё предложение.
     * @param {{selected: string[][]}} options
     */
    plan(options) {
      const request = object(options, ['selected']);
      const result = selective.plan({ selected: request.selected });
      if (result.status !== 'planned') {
        return Object.freeze({
          status: 'needs_review',
          details: () => ({
            pending: incoming(),
            blocked: result.blocked.map(change => visibleChange(change, remotePin))
          })
        });
      }
      if (!result.applied.length) {
        return Object.freeze({ status: 'no_selection', details: () => ({ pending: incoming() }) });
      }
      rejectKnownRemoteDescendant(history, remotePin, localPin);
      if (state.origins.length + result.applied.length > MAX_ORIGIN_EVENTS) {
        throw new Error('Слишком много изменений происхождения; требуется отдельная обработка');
      }
      const candidate = copy(localSnapshot);
      const candidateRecord = findRecord(candidate, section, id);
      candidateRecord.fields = copy(result.record.fields);
      const dependencyIssues = reviewSnapshotDependencies(candidate).issues;
      if (dependencyIssues.length) {
        return Object.freeze({
          status: 'dependency_review',
          details: () => ({ pending: incoming(), issues: copy(dependencyIssues) })
        });
      }
      const nextBaseline = copy(state.baseline);
      for (const change of result.applied) selectedValueIntoBaseline(nextBaseline, remote.fields, change.path);
      const origins = [
        ...copy(state.origins),
        ...result.applied.map(change => ({ path: [...change.path], source: { ...remotePin } }))
      ];
      let consumed = false;
      return Object.freeze({
        status: 'proposed',
        details() {
          return {
            selected: result.applied.map(change => visibleChange(change, remotePin)),
            pending: result.pending.map(change => visibleChange(change, remotePin))
          };
        },
        /** Копия для тестового расчёта; это не подтверждённая запись и не разрешение на импорт. */
        proposedSnapshot() {
          return copy(candidate);
        },
        /**
         * Проверяет точное совпадение следующего снимка с просмотренным предложением. Эта
         * проверка в памяти сама по себе НЕ доказывает, что desktop-файл сохранён атомарно.
         * @param {{history: any, localPin: any, remotePin: any}} options
         */
        bind(options) {
          if (consumed) throw new Error('Предложение уже использовано');
          const request = object(options, ['history', 'localPin', 'remotePin']);
          requireHistory(request.history);
          const nextLocal = pin(request.localPin);
          const observedRemote = pin(request.remotePin);
          if (!samePin(observedRemote, remotePin))
            throw new Error('Облачная версия изменилась; требуется новый просмотр');
          if (samePin(nextLocal, localPin)) throw invalid();
          requireDescendant(request.history, localPin, nextLocal);
          // Проверяем, что источник не был заменён в заново проверенном дереве.
          request.history.publicSnapshot(remotePin);
          const actual = request.history.publicSnapshot(nextLocal);
          if (!equal(candidate, actual)) throw new Error('Локальные данные изменились; требуется новый просмотр');
          rejectKnownRemoteDescendant(request.history, remotePin, nextLocal);
          const next = makeReview({
            ...state,
            history: request.history,
            localPin: nextLocal,
            baseline: nextBaseline,
            origins
          });
          consumed = true;
          return next;
        }
      });
    },
    /**
     * Обновляет ссылки на версии без применения данных. Пока есть невыбранные изменения,
     * облачную ветку не продвигаем: старые входящие должны остаться ожидающими.
     * @param {{history: any, localPin: any, remotePin: any}} options
     */
    refresh(options) {
      const request = object(options, ['history', 'localPin', 'remotePin']);
      requireHistory(request.history);
      const nextLocal = pin(request.localPin);
      const nextRemote = pin(request.remotePin);
      requireDescendant(request.history, localPin, nextLocal);
      requireDescendant(request.history, remotePin, nextRemote);
      const pending = incoming();
      if (!samePin(nextRemote, remotePin) && pending.length) {
        throw new Error('Сначала требуется разобраться с ожидающими входящими изменениями');
      }
      if (!samePin(nextLocal, localPin) && pending.length) {
        const nextRecord = findRecord(request.history.publicSnapshot(nextLocal), section, id);
        checkIdentity(nextRecord, expected);
        // Даже совпавшее с облаком значение не означает, что старое изменение приняли.
        if (
          pending.some(
            change => !equal(valueAtPath(local.fields, change.path), valueAtPath(nextRecord.fields, change.path))
          )
        ) {
          throw new Error('Ожидающее поле изменено локально; требуется отдельное разрешение');
        }
      }
      return makeReview({ ...state, history: request.history, localPin: nextLocal, remotePin: nextRemote });
    }
  });
  reviewStates.set(review, state);
  return review;
}

/**
 * Начинает предварительный учёт для одной записи, общей для обоих снимков и их предка.
 * Выбранный общий предок проверяется history.js, но доверие к его корню и полнота списка
 * должны быть обеспечены вызывающим кодом. Долговременного хранения этого учёта пока нет.
 * @param {{history: any, localPin: any, remotePin: any, section: string, id: string}} options
 */
export function createFieldProvenanceReview(options) {
  const input = object(options, ['history', 'localPin', 'remotePin', 'section', 'id']);
  requireHistory(input.history);
  const section = oneOf(input.section, SECTIONS);
  if (!isSyncId(input.id)) throw invalid();
  const localPin = pin(input.localPin);
  const remotePin = pin(input.remotePin);
  const basePin = input.history.commonAncestor(localPin, remotePin);
  const base = findRecord(input.history.publicSnapshot(basePin), section, input.id);
  const expected = {
    id: base.id,
    type: base.type,
    hasArchive: Object.hasOwn(base, 'archived'),
    archived: base.archived
  };
  checkIdentity(findRecord(input.history.publicSnapshot(localPin), section, input.id), expected);
  checkIdentity(findRecord(input.history.publicSnapshot(remotePin), section, input.id), expected);
  return makeReview({
    history: input.history,
    basePin,
    initialLocalPin: localPin,
    initialRemotePin: remotePin,
    localPin,
    remotePin,
    section,
    id: input.id,
    expected,
    baseline: copy(base.fields),
    origins: []
  });
}

// Этот внутренний формат НЕ является облачной историей и не содержит значений полей.
// Даже пути и идентификаторы могут быть личными: они шифруются и не пишутся в журнал.
function checkpointModel(state) {
  return {
    section: state.section,
    id: state.id,
    basePin: { ...state.basePin },
    initialLocalPin: { ...state.initialLocalPin },
    initialRemotePin: { ...state.initialRemotePin },
    localPin: { ...state.localPin },
    remotePin: { ...state.remotePin },
    origins: copy(state.origins)
  };
}

function checkedModel(value) {
  const data = object(value, [
    'section',
    'id',
    'basePin',
    'initialLocalPin',
    'initialRemotePin',
    'localPin',
    'remotePin',
    'origins'
  ]);
  const section = oneOf(data.section, SECTIONS);
  if (!isSyncId(data.id) || !Array.isArray(data.origins) || data.origins.length > MAX_ORIGIN_EVENTS) throw invalid();
  const origins = array(data.origins, value => {
    const origin = object(value, ['path', 'source']);
    const path = array(origin.path, part => {
      if (typeof part !== 'string' || !part || part.length > 256 || UNSAFE_PATH_PARTS.has(part)) throw invalid();
      return part;
    });
    if (!path.length || path.length > 64) throw invalid();
    return { path, source: pin(origin.source) };
  });
  return {
    section,
    id: data.id,
    basePin: pin(data.basePin),
    initialLocalPin: pin(data.initialLocalPin),
    initialRemotePin: pin(data.initialRemotePin),
    localPin: pin(data.localPin),
    remotePin: pin(data.remotePin),
    origins
  };
}

function checkpointEnvelope(value) {
  const data = object(value, ENVELOPE_FIELDS);
  if (typeof data.ciphertext !== 'string' || data.ciphertext.length > Math.ceil((MAX_CHECKPOINT_BYTES + 16) / 3) * 4)
    throw invalid();
  const result = Object.fromEntries(ENVELOPE_FIELDS.map(key => [key, data[key]]));
  validateEnvelope(result);
  return result;
}

function checkpointCrypto(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw invalid();
  return crypto;
}

async function checkpointFingerprint(envelope, crypto) {
  // Отдельная область хеширования не позволяет перепутать отметку с отметкой истории.
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      CHECKPOINT_HASH_DOMAIN,
      envelope.format,
      envelope.version,
      envelope.algorithm,
      envelope.datasetId,
      envelope.versionId,
      envelope.iv,
      envelope.ciphertext
    ])
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (digest.length !== 32) throw invalid();
  return {
    versionId: envelope.versionId,
    sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  };
}

function checkPayloadSize(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const tooLarge = bytes.byteLength > MAX_CHECKPOINT_BYTES;
  bytes.fill(0);
  if (tooLarge) throw invalid();
}

function restoredModel(history, model) {
  const { basePin, initialLocalPin, initialRemotePin, localPin, remotePin, section, id, origins } = model;
  if (!samePin(history.commonAncestor(initialLocalPin, initialRemotePin), basePin)) throw invalid();
  requireDescendant(history, initialLocalPin, localPin);
  requireDescendant(history, initialRemotePin, remotePin);
  const base = findRecord(history.publicSnapshot(basePin), section, id);
  const expected = {
    id: base.id,
    type: base.type,
    hasArchive: Object.hasOwn(base, 'archived'),
    archived: base.archived
  };
  checkIdentity(findRecord(history.publicSnapshot(initialLocalPin), section, id), expected);
  checkIdentity(findRecord(history.publicSnapshot(initialRemotePin), section, id), expected);
  checkIdentity(findRecord(history.publicSnapshot(localPin), section, id), expected);
  checkIdentity(findRecord(history.publicSnapshot(remotePin), section, id), expected);
  const baseline = copy(base.fields);
  let previousSource = initialRemotePin;
  const sourceRecords = new Map();
  for (const origin of origins) {
    // В модели облачная ветка продвигается только вперёд; порядок событий важен.
    if (!samePin(previousSource, origin.source)) {
      requireDescendant(history, previousSource, origin.source);
      requireDescendant(history, origin.source, remotePin);
    }
    let source = sourceRecords.get(origin.source.versionId);
    if (!source) {
      // Одна версия может быть источником тысяч полей: не копируем весь снимок тысячи раз.
      source = findRecord(history.publicSnapshot(origin.source), section, id);
      checkIdentity(source, expected);
      sourceRecords.set(origin.source.versionId, source);
    }
    selectedValueIntoBaseline(baseline, source.fields, origin.path);
    previousSource = origin.source;
  }
  rejectKnownRemoteDescendant(history, remotePin, localPin);
  return makeReview({ history, ...model, expected, baseline });
}

/**
 * Экспериментальный шифрованный checkpoint ОДНОГО просмотра. Принимает только созданную в
 * этой копии модуля модель; не принимает произвольный baseline. Ничего не пишет и не отправляет.
 * checkpointKey должен быть независимым случайным ключом устройства (TF1), не ключом набора;
 * безопасного постоянного хранения ключа/отпечатка и транзакции здесь пока нет.
 *
 * @param {{review: any, datasetId: string, deviceId: string, checkpointKey: string, cryptoSource?: Crypto}} options
 */
export async function sealFieldProvenanceCheckpoint(options) {
  const input = object(options, ['review', 'datasetId', 'deviceId', 'checkpointKey'], ['cryptoSource']);
  const state = reviewStates.get(input.review);
  if (!state || !isSyncId(input.datasetId) || !isSyncId(input.deviceId)) throw invalid();
  const identity = state.history.identity();
  if (identity.datasetId !== input.datasetId) throw invalid();
  rejectKnownRemoteDescendant(state.history, state.remotePin, state.localPin);
  const model = checkedModel(checkpointModel(state));
  const payload = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    datasetId: input.datasetId,
    deviceId: input.deviceId,
    model
  };
  checkPayloadSize(payload);
  const crypto = checkpointCrypto(input.cryptoSource);
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: input.checkpointKey,
    datasetId: input.datasetId,
    versionId: generateSyncId(crypto),
    cryptoSource: crypto
  });
  return { envelope, pin: await checkpointFingerprint(envelope, crypto) };
}

/**
 * Восстанавливает МОДЕЛЬ из зашифрованного checkpoint, не применяя изменения. Отпечаток
 * checkpoint, корень, все ранее известные версии, dataset и device передаются из независимого
 * доверенного источника; localPublicSnapshot — актуальная публичная проекция состояния.
 * Вызывающий код обязан предотвратить его изменение при проверке/будущей записи. Все входы
 * копируются до первого await. Проверка не доказывает ни запись на диск, ни свежесть облака.
 *
 * @param {{envelope: any, checkpointKey: string, expectedCheckpointPin: any, expectedDatasetId: string,
 * expectedDeviceId: string, expectedRootPin: any, expectedLocalPin: any, expectedRemotePin: any,
 * expectedKnownPins: any[], localPublicSnapshot: any, history: any, cryptoSource?: Crypto}} options
 */
export async function restoreFieldProvenanceCheckpoint(options) {
  const input = object(
    options,
    [
      'envelope',
      'checkpointKey',
      'expectedCheckpointPin',
      'expectedDatasetId',
      'expectedDeviceId',
      'expectedRootPin',
      'expectedLocalPin',
      'expectedRemotePin',
      'expectedKnownPins',
      'localPublicSnapshot',
      'history'
    ],
    ['cryptoSource']
  );
  requireHistory(input.history);
  if (!isSyncId(input.expectedDatasetId) || !isSyncId(input.expectedDeviceId)) throw invalid();
  const trustedCheckpoint = pin(input.expectedCheckpointPin);
  const trustedRoot = pin(input.expectedRootPin);
  const trustedLocal = pin(input.expectedLocalPin);
  const trustedRemote = pin(input.expectedRemotePin);
  if (!Array.isArray(input.expectedKnownPins) || input.expectedKnownPins.length > MAX_HISTORY_VERSIONS) throw invalid();
  const knownPins = array(input.expectedKnownPins, pin);
  if (new Set(knownPins.map(value => value.versionId)).size !== knownPins.length) throw invalid();
  const envelope = checkpointEnvelope(input.envelope);
  validateJsonSnapshot(input.localPublicSnapshot);
  const localPublic = copy(input.localPublicSnapshot);
  const identity = input.history.identity();
  if (
    identity.datasetId !== input.expectedDatasetId ||
    !samePin(identity.rootPin, trustedRoot) ||
    envelope.datasetId !== input.expectedDatasetId ||
    envelope.versionId !== trustedCheckpoint.versionId
  )
    throw invalid();
  // Отсутствие любой независимо известной версии означает возможное усечение/откат дерева.
  for (const known of knownPins) input.history.requirePin(known);
  input.history.requirePin(trustedRemote);
  if (!equal(localPublic, input.history.publicSnapshot(trustedLocal))) {
    throw new Error('Локальные данные изменились; требуется новый просмотр');
  }
  const crypto = checkpointCrypto(input.cryptoSource);
  if (!samePin(await checkpointFingerprint(envelope, crypto), trustedCheckpoint)) throw invalid();
  const payload = await decryptSnapshot({
    envelope,
    recoveryKey: input.checkpointKey,
    expectedDatasetId: input.expectedDatasetId,
    cryptoSource: crypto
  });
  const data = object(payload, ['format', 'version', 'datasetId', 'deviceId', 'model']);
  if (
    data.format !== CHECKPOINT_FORMAT ||
    data.version !== CHECKPOINT_VERSION ||
    data.datasetId !== input.expectedDatasetId ||
    data.deviceId !== input.expectedDeviceId
  )
    throw invalid();
  const model = checkedModel(data.model);
  if (!samePin(model.localPin, trustedLocal) || !samePin(model.remotePin, trustedRemote)) throw invalid();
  return restoredModel(input.history, model);
}

/**
 * Внутренняя связь модели с проверенной историей для бизнес-обёртки календаря. Только для
 * настоящего объекта модели; ничего не доказывает о доверии, диске, резервной копии или сети.
 */
export function fieldProvenanceContext(review) {
  const state = reviewStates.get(review);
  if (!state) throw invalid();
  return {
    history: state.history,
    localPin: { ...state.localPin },
    remotePin: { ...state.remotePin },
    section: state.section,
    id: state.id
  };
}
