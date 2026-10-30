// @ts-check
// Экспериментальная подготовка и наблюдение НЕЗАВЕРШЁННОЙ локальной операции для одной
// существующей записи календаря. Этот модуль НЕ пишет state.json, checkpoint, vault или
// облачные файлы, не подтверждает backup и не разрешает импорт. Только зашифрованное
// намерение можно отдельно сохранить в переданный Web Storage для испытаний.
//
// Пины и ключи должны поступать из независимого защищённого источника. Проверка переданного
// дерева не доказывает полноту облака. Кандидат содержит локальные секреты и предназначен
// исключительно для будущего локального писателя; его нельзя логировать или отправлять.

import {
  decryptSnapshot,
  encryptSnapshot,
  generateSyncId,
  isSyncId,
  validateEnvelope,
  validateJsonSnapshot
} from './envelope.js';
import { array, object } from './exportSchema.js';
import { isVerifiedHistory, MAX_HISTORY_VERSIONS } from './history.js';
import { restorePlannerCandidateCheckpoint } from './plannerCandidate.js';
import { buildPublicSnapshot } from './publicSnapshot.js';

const INTENT_FORMAT = 'tvinoferma-planner-commit-intent';
const INTENT_VERSION = 1;
const INTENT_PIN_DOMAIN = 'tvinoferma-planner-commit-intent-sha256-v1';
const CONTENT_DIGEST_DOMAIN = 'tvinoferma-planner-commit-content-sha256-v1';
const SLOT_FORMAT = 'tvinoferma-planner-commit-slot';
const SLOT_VERSION = 1;
const SLOT_PREFIX = 'tf-planner-commit-intent:';
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_JSON_DEPTH = 64;
const MAX_LOCAL_JSON_NODES = 500_000;
const MAX_INTENT_BYTES = 256 * 1024;
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];
const HEX256 = /^[0-9a-f]{64}(?![\s\S])/;
const encoder = new TextEncoder();
// Приватные данные не являются перечислимыми свойствами результата и не сериализуются
// случайным JSON.stringify. Маркер также не позволяет опубликовать произвольный объект.
const preparedIntents = new WeakMap();
// Только один JS-контекст и именно тот же объект Storage; не межвкладочный mutex.
const uncertainSlots = new WeakMap();

function invalid() {
  return new Error('Не удалось подготовить или проверить локальную операцию синхронизации');
}
function missing() {
  return new Error('Не найдена доверенная служебная отметка; требуется проверка данных');
}
function pin(value) {
  const data = object(value, ['versionId', 'sha256']);
  if (!isSyncId(data.versionId) || typeof data.sha256 !== 'string' || !HEX256.test(data.sha256)) throw invalid();
  return { versionId: data.versionId, sha256: data.sha256 };
}
function samePin(left, right) {
  return left.versionId === right.versionId && left.sha256 === right.sha256;
}
function pins(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HISTORY_VERSIONS) throw invalid();
  const result = array(value, pin);
  if (new Set(result.map(item => item.versionId)).size !== result.length) throw invalid();
  return result;
}
function containsPin(list, required) {
  return list.some(item => samePin(item, required));
}
function cryptoProvider(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.subtle.digest !== 'function' || typeof crypto.getRandomValues !== 'function')
    throw invalid();
  return crypto;
}
function checkpointEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_BYTES) throw invalid();
  let result;
  try {
    result = JSON.parse(raw);
    validateEnvelope(result);
  } catch {
    throw invalid();
  }
  return result;
}
function intentEnvelope(value) {
  const data = object(value, ENVELOPE_FIELDS);
  if (typeof data.ciphertext !== 'string' || data.ciphertext.length > Math.ceil((MAX_INTENT_BYTES + 16) / 3) * 4)
    throw invalid();
  const result = Object.fromEntries(ENVELOPE_FIELDS.map(key => [key, data[key]]));
  try {
    validateEnvelope(result);
  } catch {
    throw invalid();
  }
  return result;
}
function validRaw(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_BYTES) throw invalid();
  // TextEncoder заменяет одиночные суррогаты: не допускаем, чтобы разные строки
  // получили один отпечаток. Экранированные последовательности JSON остаются обычным текстом.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid();
  }
}
// JSON.parse не сообщает о повторных ключах и может округлить большие числа.
// Сначала он проверяет синтаксис, затем этот ограниченный проход проверяет именно
// лексемы: одинаковые имена после обработки escape и числа, меняющие десятичное
// значение при переводе в JS Number, недопустимы. Это не парсер произвольного языка.
function normalizedNumber(token) {
  if (token.length > 1024) throw invalid();
  const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parts) throw invalid();
  const exponent = Number(parts[4] || '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw invalid();
  let digits = (parts[2] + (parts[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  let power = exponent - (parts[3]?.length || 0);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    power++;
  }
  return `${parts[1]}${digits}e${power}`;
}
function checkLosslessJsonTokens(raw) {
  /** @type {(Set<string>|null)[]} */
  const containers = [];
  let index = 0;
  let nodes = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      if (++nodes > MAX_LOCAL_JSON_NODES) throw invalid();
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index++] === '"') break;
      }
      let next = index;
      while (next < raw.length && ' \t\r\n'.includes(raw[next])) next++;
      if (raw[next] === ':') {
        const keys = containers.at(-1);
        if (!(keys instanceof Set)) throw invalid();
        const name = JSON.parse(raw.slice(start, index));
        if (keys.has(name)) throw invalid();
        keys.add(name);
      }
    } else if (char === '{' || char === '[') {
      if (++nodes > MAX_LOCAL_JSON_NODES || containers.length >= MAX_LOCAL_JSON_DEPTH) throw invalid();
      containers.push(char === '{' ? new Set() : null);
      index++;
    } else if (char === '}' || char === ']') {
      if (!containers.length || (char === '}' ? containers.at(-1) === null : containers.at(-1) !== null))
        throw invalid();
      containers.pop();
      index++;
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      if (++nodes > MAX_LOCAL_JSON_NODES) throw invalid();
      const start = index++;
      while (index < raw.length && /[0-9.eE+-]/.test(raw[index])) index++;
      const token = raw.slice(start, index);
      const value = Number(token);
      if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid();
      const roundTrip = JSON.stringify(value);
      if (token !== roundTrip && normalizedNumber(token) !== normalizedNumber(roundTrip)) throw invalid();
    } else if (char === 't' || char === 'f' || char === 'n') {
      if (++nodes > MAX_LOCAL_JSON_NODES) throw invalid();
      index += char === 'f' ? 5 : 4;
    } else index++;
  }
  if (containers.length) throw invalid();
}
function stateFromRaw(raw) {
  validRaw(raw);
  try {
    const snapshot = JSON.parse(raw);
    validateJsonSnapshot(snapshot);
    checkLosslessJsonTokens(raw);
    return snapshot;
  } catch {
    throw invalid();
  }
}
function publicState(snapshot, history, localPin) {
  const selections = history.publicSnapshot(localPin).sections.preferences.selections;
  return buildPublicSnapshot(snapshot, { settingsSelections: selections });
}
function checkHistory(history, datasetId, rootPin, localBeforePin, remotePin, knownPins) {
  if (!isVerifiedHistory(history)) throw invalid();
  const identity = history.identity();
  if (identity.datasetId !== datasetId || !samePin(identity.rootPin, rootPin)) throw invalid();
  if (![rootPin, localBeforePin, remotePin].every(item => containsPin(knownPins, item))) throw invalid();
  for (const known of knownPins) history.requirePin(known);
  history.requirePin(localBeforePin);
  history.requirePin(remotePin);
}
function targetHistory(history, beforePin, afterPin, remotePin) {
  history.requirePin(afterPin);
  const line = history.lineage(afterPin);
  // Для операции допускаем только непосредственного потомка просмотренного состояния.
  if (line.length < 2 || !samePin(line[line.length - 2], beforePin) || samePin(beforePin, afterPin)) throw invalid();
  return history.observedHeads().some(head => !samePin(head, afterPin) && !samePin(head, remotePin));
}
function selectedPaths(value) {
  validateJsonSnapshot({ selected: value });
  return array(value, path =>
    array(path, part => {
      if (typeof part !== 'string') throw invalid();
      return part;
    })
  );
}
function digestHex(bytes) {
  if (bytes.length !== 32) throw invalid();
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function contentDigest(raw, component, datasetId, deviceId, transactionId, crypto) {
  validRaw(raw);
  const header = encoder.encode(JSON.stringify([CONTENT_DIGEST_DOMAIN, datasetId, deviceId, transactionId, component]));
  const body = encoder.encode(raw);
  if (body.length > MAX_RAW_BYTES) {
    header.fill(0);
    body.fill(0);
    throw invalid();
  }
  const bytes = new Uint8Array(header.length + 1 + body.length);
  bytes.set(header);
  bytes.set(body, header.length + 1);
  try {
    return digestHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  } finally {
    header.fill(0);
    body.fill(0);
    bytes.fill(0);
  }
}

async function intentPin(envelope, crypto) {
  const bytes = encoder.encode(JSON.stringify([INTENT_PIN_DOMAIN, ...ENVELOPE_FIELDS.map(key => envelope[key])]));
  try {
    return {
      versionId: envelope.versionId,
      sha256: digestHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    };
  } finally {
    bytes.fill(0);
  }
}

function modelPayload(value) {
  const data = object(value, [
    'format',
    'version',
    'datasetId',
    'deviceId',
    'transactionId',
    'rootPin',
    'localBeforePin',
    'localAfterPin',
    'remotePin',
    'knownPins',
    'checkpointBeforePin',
    'checkpointAfterPin',
    'stateBeforeDigest',
    'stateAfterDigest',
    'checkpointBeforeDigest',
    'checkpointAfterDigest'
  ]);
  if (
    data.format !== INTENT_FORMAT ||
    data.version !== INTENT_VERSION ||
    !isSyncId(data.datasetId) ||
    !isSyncId(data.deviceId) ||
    !isSyncId(data.transactionId)
  )
    throw invalid();
  for (const field of ['stateBeforeDigest', 'stateAfterDigest', 'checkpointBeforeDigest', 'checkpointAfterDigest']) {
    if (typeof data[field] !== 'string' || !HEX256.test(data[field])) throw invalid();
  }
  if (data.stateBeforeDigest === data.stateAfterDigest || data.checkpointBeforeDigest === data.checkpointAfterDigest)
    throw invalid();
  const rootPin = pin(data.rootPin);
  const localBeforePin = pin(data.localBeforePin);
  const remotePin = pin(data.remotePin);
  const knownPins = pins(data.knownPins);
  if (![rootPin, localBeforePin, remotePin].every(item => containsPin(knownPins, item))) throw invalid();
  return {
    format: INTENT_FORMAT,
    version: INTENT_VERSION,
    datasetId: data.datasetId,
    deviceId: data.deviceId,
    transactionId: data.transactionId,
    rootPin,
    localBeforePin,
    localAfterPin: pin(data.localAfterPin),
    remotePin,
    knownPins,
    checkpointBeforePin: pin(data.checkpointBeforePin),
    checkpointAfterPin: pin(data.checkpointAfterPin),
    stateBeforeDigest: data.stateBeforeDigest,
    stateAfterDigest: data.stateAfterDigest,
    checkpointBeforeDigest: data.checkpointBeforeDigest,
    checkpointAfterDigest: data.checkpointAfterDigest
  };
}

/**
 * Готовит намерение для выбранных полей ОДНОЙ существующей записи календаря.
 * Нужны точный JSON исходного состояния и checkpoint, независимо доверенные отметки,
 * проверенная история с непосредственным новым локальным потомком и отдельные случайные
 * ключи checkpoint и намерения. Результат ничего не сохраняет и не подтверждает backup.
 * Потребуется также независимость обоих ключей от общего ключа набора; этот модуль не
 * получает общий ключ и не может доказать независимость. Создание/удаление не поддержано.
 *
 * @param {{stateBeforeRaw: string, checkpointBeforeRaw: string, expectedCheckpointBeforePin: any,
 * history: any, datasetId: string, deviceId: string, rootPin: any, localBeforePin: any,
 * localAfterPin: any, remotePin: any, expectedKnownPins: any[], selected: string[][],
 * checkpointKey: string, intentKey: string, cryptoSource?: Crypto}} options
 */
export async function preparePlannerCommitIntent(options) {
  const input = object(
    options,
    [
      'stateBeforeRaw',
      'checkpointBeforeRaw',
      'expectedCheckpointBeforePin',
      'history',
      'datasetId',
      'deviceId',
      'rootPin',
      'localBeforePin',
      'localAfterPin',
      'remotePin',
      'expectedKnownPins',
      'selected',
      'checkpointKey',
      'intentKey'
    ],
    ['cryptoSource']
  );
  if (!isSyncId(input.datasetId) || !isSyncId(input.deviceId) || input.checkpointKey === input.intentKey)
    throw invalid();
  // Все входы, включая путь выбора и исходный JSON, фиксируются до первого await.
  const rootPin = pin(input.rootPin);
  const beforePin = pin(input.localBeforePin);
  const afterPin = pin(input.localAfterPin);
  const remotePin = pin(input.remotePin);
  const checkpointBeforePin = pin(input.expectedCheckpointBeforePin);
  const knownPins = pins(input.expectedKnownPins);
  const selected = selectedPaths(input.selected);
  const snapshot = stateFromRaw(input.stateBeforeRaw);
  const beforeCheckpoint = checkpointEnvelope(input.checkpointBeforeRaw);
  const crypto = cryptoProvider(input.cryptoSource);
  checkHistory(input.history, input.datasetId, rootPin, beforePin, remotePin, knownPins);
  if (targetHistory(input.history, beforePin, afterPin, remotePin)) {
    throw new Error('Обнаружена другая известная ветка; требуется новый просмотр');
  }
  const beforePublic = publicState(snapshot, input.history, beforePin);
  const review = await restorePlannerCandidateCheckpoint({
    envelope: beforeCheckpoint,
    checkpointKey: input.checkpointKey,
    expectedCheckpointPin: checkpointBeforePin,
    expectedDatasetId: input.datasetId,
    expectedDeviceId: input.deviceId,
    expectedRootPin: rootPin,
    expectedLocalPin: beforePin,
    expectedRemotePin: remotePin,
    expectedKnownPins: knownPins,
    localPublicSnapshot: beforePublic,
    history: input.history,
    cryptoSource: crypto
  });
  const proposal = /** @type {any} */ (review.plan({ snapshot, selected }));
  if (proposal.status !== 'prepared') return Object.freeze({ status: 'blocked', reason: 'review_required' });
  const nextReview = proposal.bindModel({ history: input.history, localPin: afterPin, remotePin });
  const checkpoint = await nextReview.sealCheckpoint({
    datasetId: input.datasetId,
    deviceId: input.deviceId,
    checkpointKey: input.checkpointKey,
    cryptoSource: crypto
  });
  const stateAfterRaw = JSON.stringify(proposal.candidateState());
  const checkpointAfterRaw = JSON.stringify(checkpoint.envelope);
  validRaw(stateAfterRaw);
  const transactionId = generateSyncId(crypto);
  // Не держим несколько больших копий чувствительных строк для digest одновременно.
  const stateBeforeDigest = await contentDigest(
    input.stateBeforeRaw,
    'state',
    input.datasetId,
    input.deviceId,
    transactionId,
    crypto
  );
  const stateAfterDigest = await contentDigest(
    stateAfterRaw,
    'state',
    input.datasetId,
    input.deviceId,
    transactionId,
    crypto
  );
  const checkpointBeforeDigest = await contentDigest(
    input.checkpointBeforeRaw,
    'checkpoint',
    input.datasetId,
    input.deviceId,
    transactionId,
    crypto
  );
  const checkpointAfterDigest = await contentDigest(
    checkpointAfterRaw,
    'checkpoint',
    input.datasetId,
    input.deviceId,
    transactionId,
    crypto
  );
  const payload = modelPayload({
    format: INTENT_FORMAT,
    version: INTENT_VERSION,
    datasetId: input.datasetId,
    deviceId: input.deviceId,
    transactionId,
    rootPin,
    localBeforePin: beforePin,
    localAfterPin: afterPin,
    remotePin,
    knownPins,
    checkpointBeforePin,
    checkpointAfterPin: checkpoint.pin,
    stateBeforeDigest,
    stateAfterDigest,
    checkpointBeforeDigest,
    checkpointAfterDigest
  });
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const exceedsLimit = payloadBytes.length > MAX_INTENT_BYTES;
  payloadBytes.fill(0);
  if (exceedsLimit) throw invalid();
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: input.intentKey,
    datasetId: input.datasetId,
    versionId: transactionId,
    cryptoSource: crypto
  });
  const fingerprint = await intentPin(envelope, crypto);
  const result = Object.freeze({
    status: 'prepared',
    envelope: () => structuredClone(envelope),
    pin: () => ({ ...fingerprint }),
    // Только для будущего локального сохранения: содержит реальные локальные секреты.
    candidateStateJson: () => stateAfterRaw,
    checkpointAfterJson: () => checkpointAfterRaw,
    checkpointAfterPin: () => ({ ...checkpoint.pin })
  });
  preparedIntents.set(result, { envelope, fingerprint, datasetId: input.datasetId, deviceId: input.deviceId });
  return result;
}

/**
 * Наблюдение после возможного сбоя. Входы — реально прочитанные строки, а отметка намерения,
 * корень, исходная/облачная версия и все ранее известные версии — из независимого доверенного
 * хранилища. Результат не меняет данные и ВСЕГДА требует отдельного решения; он не доказывает
 * backup, атомарность, свежесть облака или успешное сохранение на физический диск.
 *
 * @param {{envelope: any, expectedIntentPin: any, stateRaw: string, checkpointRaw: string,
 * history: any, datasetId: string, deviceId: string, rootPin: any, localBeforePin: any,
 * remotePin: any, expectedCheckpointBeforePin: any, expectedKnownPins: any[], checkpointKey: string,
 * intentKey: string, cryptoSource?: Crypto}} options
 */
export async function inspectPlannerCommitIntent(options) {
  const input = object(
    options,
    [
      'envelope',
      'expectedIntentPin',
      'stateRaw',
      'checkpointRaw',
      'history',
      'datasetId',
      'deviceId',
      'rootPin',
      'localBeforePin',
      'remotePin',
      'expectedCheckpointBeforePin',
      'expectedKnownPins',
      'checkpointKey',
      'intentKey'
    ],
    ['cryptoSource']
  );
  if (!isSyncId(input.datasetId) || !isSyncId(input.deviceId) || input.checkpointKey === input.intentKey)
    throw invalid();
  const envelope = intentEnvelope(input.envelope);
  const expectedIntent = pin(input.expectedIntentPin);
  const rootPin = pin(input.rootPin);
  const beforePin = pin(input.localBeforePin);
  const remotePin = pin(input.remotePin);
  const checkpointBeforePin = pin(input.expectedCheckpointBeforePin);
  const knownPins = pins(input.expectedKnownPins);
  validRaw(input.stateRaw);
  validRaw(input.checkpointRaw);
  const crypto = cryptoProvider(input.cryptoSource);
  checkHistory(input.history, input.datasetId, rootPin, beforePin, remotePin, knownPins);
  if (envelope.datasetId !== input.datasetId || !samePin(await intentPin(envelope, crypto), expectedIntent))
    throw invalid();
  let payload;
  try {
    payload = modelPayload(
      await decryptSnapshot({
        envelope,
        recoveryKey: input.intentKey,
        expectedDatasetId: input.datasetId,
        cryptoSource: crypto
      })
    );
  } catch {
    throw invalid();
  }
  if (
    payload.datasetId !== input.datasetId ||
    payload.deviceId !== input.deviceId ||
    payload.transactionId !== envelope.versionId ||
    !samePin(payload.rootPin, rootPin) ||
    !samePin(payload.localBeforePin, beforePin) ||
    !samePin(payload.remotePin, remotePin) ||
    !samePin(payload.checkpointBeforePin, checkpointBeforePin) ||
    payload.knownPins.some(item => !containsPin(knownPins, item))
  )
    throw invalid();
  const otherKnownBranches = targetHistory(input.history, beforePin, payload.localAfterPin, remotePin);
  const stateDigest = await contentDigest(
    input.stateRaw,
    'state',
    input.datasetId,
    input.deviceId,
    payload.transactionId,
    crypto
  );
  const checkpointDigest = await contentDigest(
    input.checkpointRaw,
    'checkpoint',
    input.datasetId,
    input.deviceId,
    payload.transactionId,
    crypto
  );
  const state =
    stateDigest === payload.stateBeforeDigest ? 'before' : stateDigest === payload.stateAfterDigest ? 'after' : 'other';
  const checkpoint =
    checkpointDigest === payload.checkpointBeforeDigest
      ? 'before'
      : checkpointDigest === payload.checkpointAfterDigest
        ? 'after'
        : 'other';
  if (state === 'other' || checkpoint === 'other') {
    return Object.freeze({ status: 'unrecognized', otherKnownBranches, action: 'manual_review' });
  }

  // При несовпадающей паре проверяем подлинность checkpoint относительно его версии,
  // НЕ объявляя прочитанное состояние сохранённым или подходящим к этому checkpoint.
  const checkpointLocal = checkpoint === 'before' ? beforePin : payload.localAfterPin;
  const checkpointPin = checkpoint === 'before' ? checkpointBeforePin : payload.checkpointAfterPin;
  const localPublic =
    state === checkpoint
      ? publicState(stateFromRaw(input.stateRaw), input.history, checkpointLocal)
      : input.history.publicSnapshot(checkpointLocal);
  const restored = await restorePlannerCandidateCheckpoint({
    envelope: checkpointEnvelope(input.checkpointRaw),
    checkpointKey: input.checkpointKey,
    expectedCheckpointPin: checkpointPin,
    expectedDatasetId: input.datasetId,
    expectedDeviceId: input.deviceId,
    expectedRootPin: rootPin,
    expectedLocalPin: checkpointLocal,
    expectedRemotePin: remotePin,
    expectedKnownPins: knownPins,
    localPublicSnapshot: localPublic,
    history: input.history,
    cryptoSource: crypto
  });
  const status =
    state === 'before'
      ? checkpoint === 'before'
        ? 'pair_matches_before'
        : 'checkpoint_ahead'
      : checkpoint === 'before'
        ? 'state_ahead'
        : 'pair_matches_after';
  return Object.freeze({
    status,
    otherKnownBranches,
    // Число допустимо только при согласованной паре. Данные и пути в журнал не выводятся.
    pendingCount: state === checkpoint ? restored.changes().length : null,
    action: 'manual_review'
  });
}

function storageMethods(storage) {
  if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) throw invalid();
  try {
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw invalid();
  } catch {
    throw invalid();
  }
}
function isUncertain(storage, key) {
  return uncertainSlots.get(storage)?.has(key) === true;
}
function markUncertain(storage, key) {
  let slots = uncertainSlots.get(storage);
  if (!slots) {
    slots = new Set();
    uncertainSlots.set(storage, slots);
  }
  slots.add(key);
}

/**
 * Публикует только зашифрованное намерение в переданный Storage. Независимый отпечаток
 * должен быть надёжно сохранён ДО вызова; это функция не проверяет. Повтор, замена и
 * очистка слота намеренно не поддержаны. После неясного исхода повтор запрещён в этом
 * JS-контексте. Это не межвкладочный CAS, fsync или backend приложения.
 * @param {{storage: Storage, prepared: any, expectedIntentPin: any}} options
 */
export function publishPlannerCommitIntent(options) {
  const input = object(options, ['storage', 'prepared', 'expectedIntentPin']);
  storageMethods(input.storage);
  const prepared = preparedIntents.get(input.prepared);
  const expected = pin(input.expectedIntentPin);
  if (!prepared || !samePin(prepared.fingerprint, expected)) throw invalid();
  const key = SLOT_PREFIX + prepared.deviceId;
  if (isUncertain(input.storage, key)) throw new Error('Исход записи неизвестен; требуется проверка перед повтором');
  let current;
  try {
    current = input.storage.getItem(key);
  } catch {
    throw new Error('Не удалось прочитать служебное хранилище');
  }
  if (current !== null) throw new Error('Найдена незавершённая операция; сначала требуется проверка');
  const raw = JSON.stringify({
    format: SLOT_FORMAT,
    version: SLOT_VERSION,
    datasetId: prepared.datasetId,
    deviceId: prepared.deviceId,
    envelope: prepared.envelope
  });
  try {
    input.storage.setItem(key, raw);
    if (input.storage.getItem(key) !== raw) throw invalid();
  } catch {
    markUncertain(input.storage, key);
    throw new Error('Исход записи служебной отметки неизвестен; требуется проверка');
  }
  return Object.freeze({ status: 'published_for_test' });
}

/**
 * Читает зашифрованное намерение только с независимо переданным точным отпечатком.
 * Отсутствующий, повреждённый или неподходящий слот никогда не заменяется пустым.
 * Никаких исправлений, очистки и записи состояния эта функция не выполняет.
 * @param {{storage: Storage, datasetId: string, deviceId: string, expectedIntentPin: any, cryptoSource?: Crypto}} options
 */
export async function readPublishedPlannerCommitIntent(options) {
  const input = object(options, ['storage', 'datasetId', 'deviceId', 'expectedIntentPin'], ['cryptoSource']);
  storageMethods(input.storage);
  if (!isSyncId(input.datasetId) || !isSyncId(input.deviceId)) throw invalid();
  const expected = pin(input.expectedIntentPin);
  const crypto = cryptoProvider(input.cryptoSource);
  let raw;
  try {
    raw = input.storage.getItem(SLOT_PREFIX + input.deviceId);
  } catch {
    throw new Error('Не удалось прочитать служебное хранилище');
  }
  if (raw === null) throw missing();
  if (typeof raw !== 'string' || raw.length > Math.ceil((MAX_INTENT_BYTES + 16) / 3) * 4 + 2048) throw invalid();
  let slot;
  try {
    slot = object(JSON.parse(raw), ['format', 'version', 'datasetId', 'deviceId', 'envelope']);
  } catch {
    throw invalid();
  }
  if (
    slot.format !== SLOT_FORMAT ||
    slot.version !== SLOT_VERSION ||
    slot.datasetId !== input.datasetId ||
    slot.deviceId !== input.deviceId
  )
    throw invalid();
  const envelope = intentEnvelope(slot.envelope);
  if (envelope.datasetId !== input.datasetId || !samePin(await intentPin(envelope, crypto), expected)) throw invalid();
  return envelope;
}
