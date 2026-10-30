// @ts-check
// Зашифрованный журнал отправки и одноразовых попыток. Его хранилище и сессия
// передаются отдельно; live caller проверяет сохранённый state, ключи и привязку.
// Протокол требует атомарного CAS и независимой устойчивой проверки записи после
// каждого изменения. Одного localStorage, чтения после setItem или фиктивного CAS
// недостаточно. После неизвестного исхода НЕЛЬЗЯ автоматически повторять отправку.
// Ключи, зашифрованные записи, аккаунты, ответы и исходные ошибки не журналируются.
import { decryptSnapshot, encryptSnapshot, generateSyncId, isSyncId } from './envelope.js';
import { verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';
import { object } from './exportSchema.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { isVerifiedCloudAdoption, isVerifiedConservativeAdoption } from './cloudReview.js';
import { isVerifiedConservativeAuthorization } from './conservativeMergeAuthorization.js';
import {
  historyEnvelopePin,
  sealHistoryVersion,
  sealHistoryChildWithPlannerTombstones,
  MAX_HISTORY_VERSIONS
} from './history.js';
import { copyCloudEnvelope, validGoogleId } from './providers/common.js';
import { validOAuthAccountKey, validOAuthClientId } from './providers/oauthCommon.js';

const FORMAT = 'tvinoferma-durable-outbox';
const VERSION = 2;
const ADOPTED_VERSION = 3;
// Принятая голова с сохранением известных предков и прежних квитанций.
const REBASED_VERSION = 4;
// v5 keeps the old encrypted, not-yet-attempted intent through a merge.
const RETAINED_VERSION = 5;
const MAX_RETAINED_INTENTS = 16;
const LEGACY_VERSION = 1;
const KEY_CONTEXT = 'tvinoferma-durable-outbox-key-v1';
const MAX_ENTRIES = 16;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_CHARS = 24 * 1024 * 1024;
// Запас для MIME-метаданных и границы в Google multipart с ограничением 5 MB.
const MAX_GOOGLE_ENVELOPE = 4_990_000;
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];

function invalid() {
  return new Error('Не удалось безопасно обработать журнал отправки');
}
function response(status) {
  return Object.freeze({ status });
}
function versionPin(value) {
  const pin = object(value, ['versionId', 'sha256']);
  if (!isSyncId(pin.versionId) || typeof pin.sha256 !== 'string' || !HEX.test(pin.sha256)) throw invalid();
  return { versionId: pin.versionId, sha256: pin.sha256 };
}
function sameVersionPin(left, right) {
  return left?.versionId === right?.versionId && left?.sha256 === right?.sha256;
}
function uniquePins(values) {
  const found = new Map();
  for (const value of values) {
    const pin = versionPin(value);
    const previous = found.get(pin.versionId);
    if (previous && !sameVersionPin(previous, pin)) throw invalid();
    found.set(pin.versionId, pin);
  }
  if (found.size > MAX_HISTORY_VERSIONS) throw invalid();
  return [...found.values()];
}
function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function masterBytes(value) {
  if (typeof value !== 'string' || !/^TF1-[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  let bytes;
  try {
    const binary = atob(value.slice(4).replaceAll('-', '+').replaceAll('_', '/') + '=');
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw invalid();
  }
  if (bytes.length !== 32 || `TF1-${bytesToBase64Url(bytes)}` !== value) throw invalid();
  return bytes;
}
function cryptoApi(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw invalid();
  return crypto;
}
async function journalKey(crypto, master, binding) {
  const raw = masterBytes(master);
  let derived;
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
    derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(KEY_CONTEXT),
          info: new TextEncoder().encode(JSON.stringify([binding.datasetId, binding.deviceId, binding.slotId]))
        },
        key,
        256
      )
    );
    if (derived.length !== 32) throw invalid();
    return `TF1-${bytesToBase64Url(derived)}`;
  } finally {
    raw.fill(0);
    derived?.fill(0);
  }
}
async function sha256(crypto, raw) {
  const bytes = new TextEncoder().encode(raw);
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (hash.length !== 32) throw invalid();
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}
function distinctId(crypto, previous = []) {
  const id = generateSyncId(crypto);
  if (previous.includes(id)) throw invalid();
  return id;
}
function validBinding(input) {
  return (
    ['google', 'yandex'].includes(input.provider) &&
    isSyncId(input.datasetId) &&
    isSyncId(input.deviceId) &&
    isSyncId(input.slotId) &&
    new Set([input.datasetId, input.deviceId, input.slotId]).size === 3 &&
    validOAuthClientId(input.provider, input.clientId) &&
    validOAuthAccountKey(input.accountKey) &&
    (input.provider === 'google' ? validGoogleId(input.folderId) : input.folderId === undefined)
  );
}
function bindingState(binding) {
  return {
    format: FORMAT,
    version: VERSION,
    provider: binding.provider,
    datasetId: binding.datasetId,
    deviceId: binding.deviceId,
    slotId: binding.slotId,
    clientId: binding.clientId,
    accountKey: binding.accountKey,
    folderId: binding.provider === 'google' ? binding.folderId : null,
    entries: [],
    confirmedReceipts: []
  };
}
function validParent(value, versionId) {
  if (value === null) return true;
  const parent = object(value, ['versionId', 'sha256']);
  return isSyncId(parent.versionId) && parent.versionId !== versionId && HEX.test(parent.sha256);
}

// Доказательство AES-GCM для конкретного ключа и базовая проверка формата истории.
// Это не доказывает полного облачного списка, общего предка или бизнес-валидности.
async function validateVersion(envelope, dataKey, binding, crypto) {
  if (envelope.version === 2) {
    // HMAC связывает капсулу с внутренним ключом, но не проверяет свежесть или оба секрета.
    await verifyPortableEnvelopeBinding({ envelope, dataKey, cryptoSource: crypto });
  }
  const payload = await decryptSnapshot({
    envelope,
    recoveryKey: dataKey,
    expectedDatasetId: binding.datasetId,
    cryptoSource: crypto
  });
  const history = object(
    payload,
    ['format', 'version', 'parent', 'publicSnapshot'],
    ['plannerDeletedIds', 'plannerTombstones']
  );
  const isDeletion = history.version === 2;
  const isTombstone = history.version === 3;
  const validIds = (values, allowEmpty) =>
    Array.isArray(values) &&
    (allowEmpty || values.length > 0) &&
    values.length <= 10_000 &&
    new Set(values).size === values.length &&
    values.every(id => isSyncId(id));
  const sorted = values => values.every((id, index) => index === 0 || values[index - 1] < id);
  if (
    history.format !== 'tvinoferma-public-history' ||
    ![1, 2, 3].includes(history.version) ||
    !validParent(history.parent, envelope.versionId) ||
    (isDeletion || isTombstone) !== Object.hasOwn(history, 'plannerDeletedIds') ||
    isTombstone !== Object.hasOwn(history, 'plannerTombstones') ||
    ((isDeletion || isTombstone) && (history.parent === null || !validIds(history.plannerDeletedIds, isTombstone))) ||
    (isTombstone &&
      (!validIds(history.plannerTombstones, false) ||
        !sorted(history.plannerTombstones) ||
        !sorted(history.plannerDeletedIds)))
  )
    throw invalid();
  const ids = publicSnapshotIdentityTypes(history.publicSnapshot);
  if (isTombstone) {
    const tombstones = new Set(history.plannerTombstones);
    if (history.plannerDeletedIds.some(id => !tombstones.has(id)) || history.plannerTombstones.some(id => ids.has(id)))
      throw invalid();
  }
  return {
    parent: history.parent,
    publicSnapshot: history.publicSnapshot,
    historyVersion: history.version,
    deletedIds: isDeletion || isTombstone ? [...history.plannerDeletedIds] : [],
    tombstones: isTombstone ? [...history.plannerTombstones] : []
  };
}

function checkAdjacentTombstones(before, after) {
  if (before.historyVersion === 3 && after.historyVersion !== 3) throw invalid();
  if (after.historyVersion !== 3) return;
  const expected = [...before.tombstones, ...after.deletedIds].sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(expected) !== JSON.stringify(after.tombstones))
    throw invalid();
  const oldIds = publicSnapshotIdentityTypes(before.publicSnapshot);
  const newIds = publicSnapshotIdentityTypes(after.publicSnapshot);
  const removed = new Set(after.deletedIds);
  for (const [id, type] of oldIds) {
    if (!newIds.has(id) && (type !== 'planner:plannerEntry' || !removed.has(id))) throw invalid();
    if (newIds.has(id) && newIds.get(id) !== type) throw invalid();
  }
  for (const id of removed) {
    const old = before.publicSnapshot.sections.planner.records.find(row => row.id === id);
    if (!old || old.fields.source.kind !== 'manual' || newIds.has(id)) throw invalid();
  }
}

function baseFor(value) {
  if (value === null) return null;
  const base = object(value, ['pin', 'anchorId']);
  const pin = versionPin(base.pin);
  if (!isSyncId(base.anchorId) || base.anchorId === pin.versionId) throw invalid();
  return { pin, anchorId: base.anchorId };
}
function sameBase(left, right) {
  return left === null || right === null
    ? left === null && right === null
    : left.anchorId === right.anchorId && sameVersionPin(left.pin, right.pin);
}
function isRebased(version) {
  return version === REBASED_VERSION || version === RETAINED_VERSION;
}
function sameRetainedIntents(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (item, index) => sameVersionPin(item.pin, expected[index].pin) && item.row.phase === expected[index].phase
    )
  );
}
function priorConfirmedBeforeAdoption(current, view) {
  if (!view.adopted || !isRebased(current.state.version)) return null;
  const lineage = view.adopted.row.lineage;
  const receipt = current.state.confirmedReceipts.slice(0, view.adopted.row.priorReceiptCount).at(-1);
  const candidates = [view.adopted.row.previousBase?.pin, receipt].filter(Boolean);
  candidates.sort(
    (left, right) =>
      lineage.findIndex(value => sameVersionPin(value, left)) - lineage.findIndex(value => sameVersionPin(value, right))
  );
  return candidates.at(-1) || null;
}
function entryFor(value, binding, version) {
  const row = object(
    value,
    ['envelope', 'phase', 'fileId', 'attemptId'],
    ['anchorId', 'lineage', 'priorReceiptCount', 'previousBase', 'retainedPending']
  );
  const envelope = copyCloudEnvelope(row.envelope, binding.datasetId);
  if (binding.provider === 'google' && JSON.stringify(envelope).length > MAX_GOOGLE_ENVELOPE) throw invalid();
  if (!['queued', 'prepared', 'attempting', 'confirmed', 'adopted'].includes(row.phase)) throw invalid();
  if (row.phase === 'adopted') {
    if (
      ![ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(version) ||
      row.fileId !== null ||
      row.attemptId !== null ||
      !isSyncId(row.anchorId)
    )
      throw invalid();
    if (version === ADOPTED_VERSION) {
      if (['lineage', 'priorReceiptCount', 'previousBase', 'retainedPending'].some(key => Object.hasOwn(row, key)))
        throw invalid();
      return { envelope, phase: row.phase, fileId: null, attemptId: null, anchorId: row.anchorId };
    }
    if (
      !Array.isArray(row.lineage) ||
      !row.lineage.length ||
      row.lineage.length > MAX_HISTORY_VERSIONS ||
      !Number.isSafeInteger(row.priorReceiptCount) ||
      row.priorReceiptCount < 0 ||
      !Object.hasOwn(row, 'previousBase')
    )
      throw invalid();
    const lineage = row.lineage.map(versionPin);
    if (
      new Set(lineage.map(pin => pin.versionId)).size !== lineage.length ||
      lineage.at(-1).versionId !== envelope.versionId ||
      lineage.some(pin => pin.versionId === row.anchorId)
    )
      throw invalid();
    if ((version === RETAINED_VERSION) !== Object.hasOwn(row, 'retainedPending')) throw invalid();
    let retainedPending = null;
    if (version === RETAINED_VERSION) {
      if (
        !Array.isArray(row.retainedPending) ||
        !row.retainedPending.length ||
        row.retainedPending.length > MAX_RETAINED_INTENTS
      )
        throw invalid();
      retainedPending = row.retainedPending.map(value => entryFor(value, binding, VERSION));
      if (retainedPending.some(value => !['queued', 'prepared'].includes(value.phase))) throw invalid();
    }
    const previousBase = baseFor(row.previousBase);
    if (
      previousBase &&
      (!lineage.some(pin => sameVersionPin(pin, previousBase.pin)) ||
        [binding.datasetId, binding.deviceId, binding.slotId].includes(previousBase.anchorId))
    )
      throw invalid();
    return {
      envelope,
      phase: row.phase,
      fileId: null,
      attemptId: null,
      anchorId: row.anchorId,
      lineage,
      priorReceiptCount: row.priorReceiptCount,
      previousBase,
      ...(retainedPending ? { retainedPending } : {})
    };
  }
  if (
    ['anchorId', 'lineage', 'priorReceiptCount', 'previousBase', 'retainedPending'].some(key => Object.hasOwn(row, key))
  )
    throw invalid();
  if (row.phase === 'queued') {
    if (row.fileId !== null || row.attemptId !== null) throw invalid();
  } else {
    if (binding.provider === 'google' ? !validGoogleId(row.fileId) : row.fileId !== null) throw invalid();
    if (row.phase === 'prepared' ? row.attemptId !== null : !isSyncId(row.attemptId)) throw invalid();
  }
  return { envelope, phase: row.phase, fileId: row.fileId, attemptId: row.attemptId };
}
function finalEntry(row) {
  return row.phase === 'confirmed' || row.phase === 'adopted';
}
function receiptFor(value, binding) {
  const row = object(value, ['versionId', 'sha256', 'fileId', 'attemptId']);
  if (
    !isSyncId(row.versionId) ||
    typeof row.sha256 !== 'string' ||
    !HEX.test(row.sha256) ||
    (binding.provider === 'google' ? !validGoogleId(row.fileId) : row.fileId !== null) ||
    !isSyncId(row.attemptId)
  )
    throw invalid();
  return { versionId: row.versionId, sha256: row.sha256, fileId: row.fileId, attemptId: row.attemptId };
}
function checkState(value, binding) {
  const state = object(
    value,
    [
      'format',
      'version',
      'provider',
      'datasetId',
      'deviceId',
      'slotId',
      'clientId',
      'accountKey',
      'folderId',
      'entries'
    ],
    ['confirmedReceipts']
  );
  if (
    state.format !== FORMAT ||
    ![LEGACY_VERSION, VERSION, ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(state.version) ||
    (state.version === LEGACY_VERSION && Object.hasOwn(state, 'confirmedReceipts')) ||
    (state.version !== LEGACY_VERSION && !Object.hasOwn(state, 'confirmedReceipts')) ||
    state.provider !== binding.provider ||
    state.datasetId !== binding.datasetId ||
    state.deviceId !== binding.deviceId ||
    state.slotId !== binding.slotId ||
    state.clientId !== binding.clientId ||
    state.accountKey !== binding.accountKey ||
    state.folderId !== (binding.provider === 'google' ? binding.folderId : null) ||
    !Array.isArray(state.entries) ||
    state.entries.length > MAX_ENTRIES ||
    (state.version !== LEGACY_VERSION &&
      (!Array.isArray(state.confirmedReceipts) || state.confirmedReceipts.length > MAX_HISTORY_VERSIONS))
  )
    throw invalid();
  const entries = state.entries.map(row => entryFor(row, binding, state.version));
  const adopted = entries.filter(row => row.phase === 'adopted');
  if (
    ([ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(state.version) &&
      (adopted.length !== 1 || entries[0].phase !== 'adopted')) ||
    (![ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(state.version) && adopted.length)
  )
    throw invalid();
  const confirmedReceipts =
    state.version === LEGACY_VERSION ? [] : state.confirmedReceipts.map(row => receiptFor(row, binding));
  const versions = new Set();
  const attempts = new Set();
  const fileIds = new Set();
  for (const row of entries) {
    if (versions.has(row.envelope.versionId)) throw invalid();
    versions.add(row.envelope.versionId);
    if (row.fileId !== null) {
      if (fileIds.has(row.fileId)) throw invalid();
      fileIds.add(row.fileId);
    }
    if (row.attemptId !== null) {
      if (attempts.has(row.attemptId)) throw invalid();
      attempts.add(row.attemptId);
    }
  }
  for (const row of confirmedReceipts) {
    if (versions.has(row.versionId) || attempts.has(row.attemptId)) throw invalid();
    versions.add(row.versionId);
    attempts.add(row.attemptId);
    if (row.fileId !== null) {
      if (fileIds.has(row.fileId)) throw invalid();
      fileIds.add(row.fileId);
    }
  }
  if (adopted.length && (versions.has(adopted[0].anchorId) || attempts.has(adopted[0].anchorId))) throw invalid();
  if (isRebased(state.version)) {
    const base = adopted[0];
    if (base.priorReceiptCount > confirmedReceipts.length) throw invalid();
    const ancestors = new Map(base.lineage.map((pin, index) => [pin.versionId, { pin, index }]));
    if (state.version === RETAINED_VERSION) {
      for (const retained of base.retainedPending) {
        const id = retained.envelope.versionId;
        if (
          versions.has(id) ||
          attempts.has(id) ||
          ancestors.has(id) ||
          id === base.anchorId ||
          (base.previousBase && id === base.previousBase.anchorId) ||
          (retained.fileId !== null && fileIds.has(retained.fileId))
        )
          throw invalid();
        versions.add(id);
        if (retained.fileId !== null) fileIds.add(retained.fileId);
      }
    }
    let previousIndex = -1;
    for (const receipt of confirmedReceipts.slice(0, base.priorReceiptCount)) {
      const found = ancestors.get(receipt.versionId);
      if (!found || !sameVersionPin(found.pin, receipt) || found.index <= previousIndex) throw invalid();
      previousIndex = found.index;
    }
    if (
      confirmedReceipts.slice(base.priorReceiptCount).some(receipt => ancestors.has(receipt.versionId)) ||
      entries.slice(1).some(row => ancestors.has(row.envelope.versionId)) ||
      [...attempts].some(id => ancestors.has(id))
    )
      throw invalid();
    if (
      base.previousBase &&
      (base.previousBase.anchorId === base.anchorId ||
        versions.has(base.previousBase.anchorId) ||
        attempts.has(base.previousBase.anchorId) ||
        ancestors.has(base.previousBase.anchorId))
    )
      throw invalid();
  }
  const clean = {
    ...bindingState(binding),
    version: [ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(state.version) ? state.version : VERSION,
    entries,
    confirmedReceipts
  };
  if (new TextEncoder().encode(JSON.stringify(clean)).length > MAX_STATE_BYTES) throw invalid();
  return clean;
}
function storeReply(value) {
  const reply = object(value, ['status'], ['slotId', 'datasetId', 'deviceId', 'revisionId', 'sha256', 'record']);
  if (!['empty', 'ready', 'pending', 'blocked'].includes(reply.status)) throw invalid();
  if (reply.status !== 'ready') {
    if (Object.keys(reply).length !== 1) throw invalid();
    return reply;
  }
  if (
    Object.keys(reply).length !== 7 ||
    !isSyncId(reply.slotId) ||
    !isSyncId(reply.datasetId) ||
    !isSyncId(reply.deviceId) ||
    !isSyncId(reply.revisionId) ||
    typeof reply.sha256 !== 'string' ||
    !HEX.test(reply.sha256) ||
    typeof reply.record !== 'string' ||
    reply.record.length > MAX_RECORD_CHARS
  )
    throw invalid();
  return reply;
}
function parseRecord(raw, binding, revisionId) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
    const envelope = copyCloudEnvelope(object(parsed, ENVELOPE_FIELDS), binding.datasetId);
    if (envelope.versionId !== revisionId || JSON.stringify(envelope) !== raw) throw invalid();
    return envelope;
  } catch {
    throw invalid();
  }
}

/**
 * CAS-хранилище должно возвращать `empty`, `ready`, `pending` или `blocked` из read(),
 * а install()/compareExchange() должны выполнять атомарное сравнение и сохранять
 * зашифрованную строку вместе с независимой контрольной отметкой. `pending` блокирует
 * автоматическую работу. Обёртка не доказывает fsync, защищённость хранилища, отсутствие
 * отката или корректность реального провайдера. `empty` не доказывает первый запуск.
 *
 * session должна относиться к тому же ранее подтверждённому аккаунту и набору и выполнять
 * собственную повторную проверку аккаунта. Доверие к session и store здесь не устанавливается.
 * Перед подключением к приложению нужны native-реализация store, ключи, backup и восстановление.
 * @param {{provider:'google'|'yandex',datasetId:string,deviceId:string,slotId:string,
 * clientId:string,accountKey:string,folderId?:string,dataKey:string,
 * store:{read:()=>Promise<any>,install:(args:any)=>Promise<any>,compareExchange:(args:any)=>Promise<any>},
 * session:{generateFileId:()=>Promise<any>,upload:(args:any)=>Promise<any>,verify:(args:any)=>Promise<any>},
 * cryptoSource?:Crypto}} options
 */
export function createDurableCloudOutbox(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'datasetId', 'deviceId', 'slotId', 'clientId', 'accountKey', 'dataKey', 'store', 'session'],
      ['folderId', 'cryptoSource']
    );
    if (
      !validBinding(input) ||
      !input.store ||
      typeof input.store.read !== 'function' ||
      typeof input.store.install !== 'function' ||
      typeof input.store.compareExchange !== 'function' ||
      !input.session ||
      typeof input.session.upload !== 'function' ||
      typeof input.session.verify !== 'function' ||
      (input.provider === 'google' && typeof input.session.generateFileId !== 'function')
    )
      throw invalid();
    const check = masterBytes(input.dataKey);
    check.fill(0);
  } catch {
    throw invalid();
  }
  const binding = Object.freeze({
    provider: input.provider,
    datasetId: input.datasetId,
    deviceId: input.deviceId,
    slotId: input.slotId,
    clientId: input.clientId,
    accountKey: input.accountKey,
    ...(input.provider === 'google' ? { folderId: input.folderId } : {})
  });
  const { store, session, dataKey } = input;
  const crypto = cryptoApi(input.cryptoSource);
  const keyPromise = journalKey(crypto, dataKey, binding);
  // Отклонение не должно породить unhandled rejection, если первый вызов будет позднее.
  keyPromise.catch(() => {});
  let active = false;
  let blocked = false;

  async function read() {
    const reply = storeReply(await store.read());
    if (reply.status !== 'ready') return { status: reply.status };
    if (
      reply.slotId !== binding.slotId ||
      reply.datasetId !== binding.datasetId ||
      reply.deviceId !== binding.deviceId ||
      (await sha256(crypto, reply.record)) !== reply.sha256
    )
      throw invalid();
    const envelope = parseRecord(reply.record, binding, reply.revisionId);
    const decoded = await decryptSnapshot({
      envelope,
      recoveryKey: await keyPromise,
      expectedDatasetId: binding.datasetId,
      cryptoSource: crypto
    });
    return { status: 'ready', receipt: reply, state: checkState(decoded, binding) };
  }
  async function write(previous, state, initial = false) {
    const clean = checkState(state, binding);
    const revisionId = distinctId(crypto, [
      binding.datasetId,
      binding.deviceId,
      binding.slotId,
      ...(previous ? [previous.receipt.revisionId] : []),
      ...clean.entries.map(row => row.envelope.versionId),
      ...clean.entries.flatMap(row => row.retainedPending?.map(item => item.envelope.versionId) || []),
      ...clean.entries.map(row => row.attemptId).filter(Boolean),
      ...clean.entries.map(row => row.anchorId).filter(Boolean),
      ...clean.entries.flatMap(row => row.lineage?.map(pin => pin.versionId) || []),
      ...clean.entries.map(row => row.previousBase?.anchorId).filter(Boolean),
      ...clean.confirmedReceipts.flatMap(row => [row.versionId, row.attemptId])
    ]);
    const encrypted = await encryptSnapshot({
      snapshot: clean,
      recoveryKey: await keyPromise,
      datasetId: binding.datasetId,
      versionId: revisionId,
      cryptoSource: crypto
    });
    const record = JSON.stringify(copyCloudEnvelope(encrypted, binding.datasetId));
    if (record.length > MAX_RECORD_CHARS) throw invalid();
    const expectedDigest = await sha256(crypto, record);
    const common = {
      slotId: binding.slotId,
      datasetId: binding.datasetId,
      deviceId: binding.deviceId,
      revisionId,
      record
    };
    let result;
    try {
      result = previous
        ? await store.compareExchange({
            ...common,
            expectedRevisionId: previous.receipt.revisionId,
            expectedSha256: previous.receipt.sha256
          })
        : initial
          ? await store.installInitial(common)
          : await store.install(common);
      const checked = object(result, ['status']);
      if (!['installed', 'swapped', 'occupied', 'mismatch', 'blocked'].includes(checked.status)) throw invalid();
      if (checked.status === 'occupied' || checked.status === 'mismatch') return { status: 'changed' };
      if (checked.status === 'blocked') return { status: 'journal_blocked' };
      if (checked.status !== (previous ? 'swapped' : 'installed')) throw invalid();
      const verified = await read();
      if (
        verified.status !== 'ready' ||
        verified.receipt.revisionId !== revisionId ||
        verified.receipt.sha256 !== expectedDigest ||
        verified.receipt.record !== record
      )
        throw invalid();
      return verified;
    } catch {
      // Исключение, таймаут или утерянный ответ после начала записи не доказывают,
      // что она не произошла. Этот экземпляр больше не начинает операции.
      blocked = true;
      return { status: 'journal_uncertain' };
    }
  }
  async function run(work) {
    if (blocked) return response('journal_uncertain');
    if (active) return response('busy');
    active = true;
    try {
      return await work();
    } catch {
      blocked = true;
      return response('journal_blocked');
    } finally {
      active = false;
    }
  }
  function unavailable(value) {
    if (value.status === 'empty') return response('not_initialized');
    if (value.status === 'pending' || value.status === 'blocked') return response('journal_blocked');
    return response(value.status);
  }

  // Пустая очередь восстановленного ПК сама по себе не является доказательством
  // принятия полей. Версия v3 содержит только отдельно согласованную точную базу.
  async function linearView(current, rootPin, keyPin) {
    const receipts = current.state.confirmedReceipts;
    const rows = current.state.entries;
    if (!rows.length) return null;
    const versions = [];
    async function verified(row) {
      if (row.envelope.version !== 2) throw invalid();
      await verifyPortableEnvelopeBinding({
        envelope: row.envelope,
        dataKey,
        expectedPin: keyPin,
        cryptoSource: crypto
      });
      const contents = await validateVersion(row.envelope, dataKey, binding, crypto);
      // v2 is an isolated legacy deletion format without a persistent cumulative
      // marker; only v1 or the fully retained v3 format is safe for a live queue.
      if (![1, 3].includes(contents.historyVersion)) throw invalid();
      const pin = await historyEnvelopePin({
        envelope: row.envelope,
        expectedDatasetId: binding.datasetId,
        cryptoSource: crypto
      });
      return { row, pin, contents };
    }
    let adopted = null;
    let start = 0;
    let priorReceiptCount = 0;
    let parent;
    if (rows[0].phase === 'adopted') {
      adopted = await verified(rows[0]);
      if (sameVersionPin(adopted.pin, rootPin) ? adopted.contents.parent !== null : adopted.contents.parent === null)
        throw invalid();
      if (isRebased(current.state.version)) {
        const lineage = adopted.row.lineage;
        if (
          !sameVersionPin(lineage[0], rootPin) ||
          !sameVersionPin(lineage.at(-1), adopted.pin) ||
          (lineage.length > 1 && !sameVersionPin(lineage.at(-2), adopted.contents.parent))
        )
          throw invalid();
        priorReceiptCount = adopted.row.priorReceiptCount;
      }
      versions.push(adopted);
      start = 1;
      parent =
        receipts.length > priorReceiptCount
          ? { versionId: receipts[receipts.length - 1].versionId, sha256: receipts[receipts.length - 1].sha256 }
          : adopted.pin;
    } else {
      if (receipts.length && !sameVersionPin(receipts[0], rootPin)) throw invalid();
      parent = receipts.length
        ? { versionId: receipts[receipts.length - 1].versionId, sha256: receipts[receipts.length - 1].sha256 }
        : null;
    }
    let foundPending = false;
    let firstPendingPhase = null;
    let pendingCount = 0;
    for (const row of rows.slice(start)) {
      const version = await verified(row);
      if (parent === null) {
        if (version.contents.parent !== null || !sameVersionPin(version.pin, rootPin)) throw invalid();
      } else if (!sameVersionPin(version.contents.parent, parent)) throw invalid();
      const previous = versions.at(-1);
      if (previous && sameVersionPin(version.contents.parent, previous.pin))
        checkAdjacentTombstones(previous.contents, version.contents);
      if (row.phase === 'confirmed') {
        if (foundPending) throw invalid();
      } else {
        if (row.phase === 'adopted') throw invalid();
        foundPending = true;
        pendingCount++;
        if (pendingCount === 1) firstPendingPhase = row.phase;
        // Одновременно могут быть только начатая и одна ещё не начатая версия.
        if (pendingCount > 2 || (pendingCount === 2 && (row.phase !== 'queued' || firstPendingPhase === 'queued')))
          throw invalid();
      }
      versions.push(version);
      parent = version.pin;
    }
    if (receipts.length > priorReceiptCount && rows[start]?.phase !== 'confirmed') throw invalid();
    const confirmed = versions.filter(version => version.row.phase === 'confirmed').at(-1) || adopted;
    const tail = versions.at(-1);
    const retained = [];
    if (current.state.version === RETAINED_VERSION) {
      const lineage = new Map(adopted.row.lineage.map(pin => [pin.versionId, pin.sha256]));
      for (const row of adopted.row.retainedPending) {
        const item = await verified(row);
        const parent = item.contents.parent;
        if (!parent || lineage.get(parent.versionId) !== parent.sha256) throw invalid();
        retained.push(item);
      }
    }
    return { versions, adopted, confirmed, tail, pendingCount, priorReceiptCount, retained };
  }

  async function sendCurrent(current) {
    if (current.status !== 'ready') return unavailable(current);
    let index = current.state.entries.findIndex(row => !finalEntry(row));
    if (index < 0) return response('idle');
    let row = current.state.entries[index];
    if (row.phase === 'attempting') return response('needs_verification');
    if (row.phase === 'queued') {
      let fileId = null;
      if (binding.provider === 'google') {
        let generated;
        try {
          generated = object(await session.generateFileId(), ['status'], ['fileId']);
        } catch {
          return response('unavailable');
        }
        if (generated.status !== 'generated' || !validGoogleId(generated.fileId)) return response('unavailable');
        fileId = generated.fileId;
      }
      const entries = current.state.entries.slice();
      entries[index] = { ...row, phase: 'prepared', fileId };
      current = await write(current, { ...current.state, entries });
      if (current.status !== 'ready') return response(current.status);
      index = current.state.entries.findIndex(item => !finalEntry(item));
      row = current.state.entries[index];
      if (!row || row.phase !== 'prepared') throw invalid();
    }
    const attemptId = distinctId(crypto, [
      binding.datasetId,
      binding.deviceId,
      binding.slotId,
      current.receipt.revisionId,
      ...current.state.entries.map(item => item.envelope.versionId),
      ...current.state.entries.flatMap(item => item.retainedPending?.map(row => row.envelope.versionId) || []),
      ...current.state.entries.map(item => item.attemptId).filter(Boolean),
      ...current.state.entries.map(item => item.anchorId).filter(Boolean),
      ...current.state.entries.flatMap(item => item.lineage?.map(pin => pin.versionId) || []),
      ...current.state.entries.map(item => item.previousBase?.anchorId).filter(Boolean),
      ...current.state.confirmedReceipts.flatMap(item => [item.versionId, item.attemptId])
    ]);
    const entries = current.state.entries.slice();
    entries[index] = { ...row, phase: 'attempting', attemptId };
    current = await write(current, { ...current.state, entries });
    if (current.status !== 'ready') return response(current.status);
    // Первый и единственный вызов записи разрешён только ПОСЛЕ подтверждённой
    // устойчивой записи phase=attempting. Никаких повторов при потере ответа.
    let uploadStatus = 'unknown';
    try {
      const result = object(
        await session.upload({
          envelope: row.envelope,
          ...(binding.provider === 'google' ? { fileId: row.fileId } : {})
        }),
        ['status']
      );
      uploadStatus = result.status;
    } catch {
      // Запрос мог дойти до диска.
    }
    if (['not_sent', 'account_unavailable', 'account_mismatch'].includes(uploadStatus)) {
      // Только доверенный транспорт может удостоверить, что операция записи
      // вообще не начиналась. Если другой участник изменил журнал после нас,
      // не отменяем его состояние и не делаем предположений об отправке.
      const latest = await read();
      if (
        latest.status !== 'ready' ||
        latest.receipt.revisionId !== current.receipt.revisionId ||
        latest.receipt.sha256 !== current.receipt.sha256 ||
        latest.state.entries[index]?.phase !== 'attempting' ||
        latest.state.entries[index]?.attemptId !== attemptId
      )
        return response('changed');
      const deferred = latest.state.entries.slice();
      deferred[index] = { ...latest.state.entries[index], phase: 'prepared', attemptId: null };
      const saved = await write(latest, { ...latest.state, entries: deferred });
      if (saved.status !== 'ready') return response(saved.status);
      return response(uploadStatus === 'account_mismatch' ? 'account_mismatch' : 'deferred');
    }
    return response('needs_verification');
  }

  return Object.freeze({
    /** Только явная подготовка НОВОГО журнала; empty не удостоверяет отсутствие старых данных. */
    async initialize(confirmedNew) {
      if (confirmedNew !== true) throw invalid();
      return run(async () => {
        const before = await read();
        if (before.status === 'ready') return response('already_initialized');
        if (before.status !== 'empty') return unavailable(before);
        const saved = await write(null, bindingState(binding));
        return response(saved.status === 'ready' ? 'initialized' : saved.status);
      });
    },
    /**
     * Первое намерение и корень сохраняются одним CAS. Закреплять root pin или
     * выполнять сетевую запись до этого нельзя: пустая очередь не доказывает,
     * какая именно случайная ciphertext-версия создавалась перед перезапуском.
     * Неизвестный результат требует остановки, а не создания другого корня.
     * @param {unknown} envelope
     * @param {boolean} confirmedNew
     */
    async initializeWithRoot(envelope, confirmedNew) {
      if (confirmedNew !== true) throw invalid();
      if (typeof store.installInitial !== 'function') return response('initial_guard_unavailable');
      let copy;
      try {
        copy = copyCloudEnvelope(envelope, binding.datasetId);
        if (copy.version !== 2 || (binding.provider === 'google' && JSON.stringify(copy).length > MAX_GOOGLE_ENVELOPE))
          throw invalid();
      } catch {
        throw invalid();
      }
      return run(async () => {
        try {
          const verified = await validateVersion(copy, dataKey, binding, crypto);
          if (verified.parent !== null) return response('invalid_root');
        } catch {
          return response('invalid_root');
        }
        const rootPin = await historyEnvelopePin({
          envelope: copy,
          expectedDatasetId: binding.datasetId,
          cryptoSource: crypto
        });
        const before = await read();
        if (before.status === 'ready') return response('already_initialized');
        if (before.status !== 'empty') return unavailable(before);
        const initial = bindingState(binding);
        initial.entries = [{ envelope: copy, phase: 'queued', fileId: null, attemptId: null }];
        const saved = await write(null, initial, true);
        return saved.status === 'ready' ? Object.freeze({ status: 'initialized', rootPin }) : response(saved.status);
      });
    },
    /**
     * Пустой журнал после восстановления УЖЕ проверенного облачного root.
     * Первоначальную установку по-прежнему выполняет native под общим lock;
     * сам этот метод не подтверждает код сверки или подлинность облака.
     * @param {boolean} confirmedRecovery
     */
    async initializeRecovered(confirmedRecovery) {
      if (confirmedRecovery !== true) throw invalid();
      if (typeof store.installInitial !== 'function') return response('initial_guard_unavailable');
      return run(async () => {
        const before = await read();
        if (before.status === 'ready') return response('already_initialized');
        if (before.status !== 'empty') return unavailable(before);
        const saved = await write(null, bindingState(binding), true);
        return response(saved.status === 'ready' ? 'initialized' : saved.status);
      });
    },
    /**
     * Продолжение первичной настройки возможно только с единственным корнем,
     * который ещё ни разу не пытались отправить. Сам конверт не показывается.
     */
    async pendingInitializationRoot(expectedKeyPin) {
      if (!expectedKeyPin) throw invalid();
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (current.state.confirmedReceipts.length || current.state.entries.length !== 1)
          return response('not_initial_root');
        const [entry] = current.state.entries;
        if (entry.phase !== 'queued' || entry.envelope.version !== 2) return response('not_initial_root');
        try {
          await verifyPortableEnvelopeBinding({
            envelope: entry.envelope,
            dataKey,
            expectedPin: expectedKeyPin,
            cryptoSource: crypto
          });
          const verified = await validateVersion(entry.envelope, dataKey, binding, crypto);
          if (verified.parent !== null) return response('not_initial_root');
        } catch {
          return response('invalid_root');
        }
        return Object.freeze({
          status: 'ready',
          rootPin: await historyEnvelopePin({
            envelope: entry.envelope,
            expectedDatasetId: binding.datasetId,
            cryptoSource: crypto
          })
        });
      });
    },
    /** Пустая очередь без квитанций подходит для продолжения восстановления. */
    async recoveryInitializationEmpty() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        return response(
          current.state.entries.length === 0 && current.state.confirmedReceipts.length === 0 ? 'empty' : 'not_empty'
        );
      });
    },
    /**
     * Проверяет единственный root перед ПЕРВОЙ отправкой или сверкой неизвестного
     * результата. Возвращает только фазу и признак совпадения со снимком памяти;
     * локальная запись и независимое подтверждение сохранения проверяются caller.
     * @param {{expectedKeyPin:any,expectedRootPin:any,publicSnapshot?:any}} value
     */
    async inspectInitialRoot(value) {
      const request = object(value, ['expectedKeyPin', 'expectedRootPin'], ['publicSnapshot']);
      const expected = object(request.expectedRootPin, ['versionId', 'sha256']);
      if (!isSyncId(expected.versionId) || typeof expected.sha256 !== 'string' || !HEX.test(expected.sha256))
        throw invalid();
      let local = null;
      if (Object.hasOwn(request, 'publicSnapshot')) {
        publicSnapshotIdentityTypes(request.publicSnapshot);
        local = JSON.stringify(structuredClone(request.publicSnapshot));
      }
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (current.state.confirmedReceipts.length || current.state.entries.length !== 1)
          return response('not_initial_root');
        const [entry] = current.state.entries;
        if (entry.envelope.version !== 2) return response('not_initial_root');
        try {
          await verifyPortableEnvelopeBinding({
            envelope: entry.envelope,
            dataKey,
            expectedPin: request.expectedKeyPin,
            cryptoSource: crypto
          });
          const verified = await validateVersion(entry.envelope, dataKey, binding, crypto);
          const pin = await historyEnvelopePin({
            envelope: entry.envelope,
            expectedDatasetId: binding.datasetId,
            cryptoSource: crypto
          });
          if (verified.parent !== null || pin.versionId !== expected.versionId || pin.sha256 !== expected.sha256)
            return response('invalid_root');
          return Object.freeze({
            status: 'ready',
            phase: entry.phase,
            snapshotMatches: local === null ? null : local === JSON.stringify(verified.publicSnapshot)
          });
        } catch {
          return response('invalid_root');
        }
      });
    },
    /**
     * Записывает принятую облачную основу. Существующие подтверждённые локальные
     * версии должны входить в проверенную линию; неподтверждённые не удаляются.
     * Это НЕ квитанция отправки. Capability выдаёт только проверенное сравнение;
     * привязку к сохранённому state и снятие маркера подтверждает отдельный caller.
     * При потере ответа повтор возможен лишь после перечитывания того же основания.
     * A non-exact merge additionally requires a saved-state capability. Only
     * matching, not-yet-attempted intents may be retained encrypted in v5;
     * an attempted or unverified upload is never discarded or retried here.
     * @param {{proof:any,expectedRootPin:any,expectedKeyPin:any,authorization?:any}} value
     */
    async adoptReviewedBase(value) {
      const request = object(value, ['proof', 'expectedRootPin', 'expectedKeyPin'], ['authorization']);
      const root = versionPin(request.expectedRootPin);
      const proof = request.proof;
      const conservative = isVerifiedConservativeAdoption(proof);
      if (
        !(
          isVerifiedCloudAdoption(proof) ||
          (conservative && isVerifiedConservativeAuthorization(request.authorization, proof))
        ) ||
        proof.status !== 'ready_for_adoption' ||
        proof.provider !== binding.provider ||
        proof.datasetId !== binding.datasetId ||
        !sameVersionPin(proof.rootPin, root) ||
        !request.expectedKeyPin
      )
        throw invalid();
      const copy = copyCloudEnvelope(proof.envelope, binding.datasetId);
      return run(async () => {
        await verifyPortableEnvelopeBinding({
          envelope: copy,
          dataKey,
          expectedPin: request.expectedKeyPin,
          cryptoSource: crypto
        });
        const contents = await validateVersion(copy, dataKey, binding, crypto);
        if (![1, 3].includes(contents.historyVersion)) return response('unsupported_version');
        const pin = await historyEnvelopePin({
          envelope: copy,
          expectedDatasetId: binding.datasetId,
          cryptoSource: crypto
        });
        if (!sameVersionPin(pin, proof.pin)) return response('changed');
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const lineage = proof.lineage.map(versionPin);
        if (!lineage.length || !sameVersionPin(lineage[0], root) || !sameVersionPin(lineage.at(-1), pin))
          return response('changed');
        const ancestors = new Map(lineage.map(value => [value.versionId, value.sha256]));
        let previousBase = null;
        let retainedPending = [];
        let receipts = current.state.confirmedReceipts.slice();
        if (current.state.entries.length || receipts.length) {
          const view = await linearView(current, root, request.expectedKeyPin);
          if (!view || !view.confirmed) return response('queue_not_empty');
          const marker = conservative ? request.authorization.marker : null;
          const alreadyAdopted =
            conservative && view.adopted && sameVersionPin(view.adopted.pin, pin) && sameVersionPin(view.tail.pin, pin);
          if (!conservative && view.retained.length) return response('queue_not_empty');
          if (conservative && !alreadyAdopted && !sameRetainedIntents(view.retained, marker.retainedIntents))
            return response('merge_base_mismatch');
          if (!alreadyAdopted) retainedPending = view.retained.map(item => structuredClone(item.row));
          if (view.pendingCount) {
            if (
              !conservative ||
              !marker.pendingPin ||
              view.pendingCount !== 1 ||
              !['queued', 'prepared'].includes(view.tail.row.phase) ||
              view.tail.row.phase !== marker.pendingPhase ||
              !sameVersionPin(view.tail.pin, marker.pendingPin) ||
              JSON.stringify(view.tail.contents.publicSnapshot) !== JSON.stringify(proof.retainedSnapshot())
            )
              return response('queue_not_empty');
            retainedPending.push(structuredClone(view.tail.row));
            if (retainedPending.length > MAX_RETAINED_INTENTS) return response('retained_intent_limit');
          } else if (conservative && !alreadyAdopted && marker.pendingPin) return response('merge_base_mismatch');
          if (conservative) {
            const prior = view.adopted && isRebased(current.state.version) ? view.adopted.row.previousBase : null;
            if (alreadyAdopted) {
              const expectedRetained = [...marker.retainedIntents];
              if (marker.pendingPin) expectedRetained.push({ pin: marker.pendingPin, phase: marker.pendingPhase });
              const retainedMatches = sameRetainedIntents(view.retained, expectedRetained);
              if (
                !retainedMatches ||
                !sameVersionPin(priorConfirmedBeforeAdoption(current, view), marker.basePin) ||
                !sameBase(prior, marker.previousBase)
              )
                return response('merge_base_mismatch');
            } else {
              const currentBase = view.adopted ? { pin: view.adopted.pin, anchorId: view.adopted.row.anchorId } : null;
              if (
                current.receipt.revisionId !== marker.queueRevisionId ||
                !sameVersionPin(view.confirmed.pin, marker.basePin) ||
                !sameBase(currentBase, marker.previousBase)
              )
                return response('merge_base_mismatch');
            }
          }
          const known = [
            ...(view.adopted ? (isRebased(current.state.version) ? view.adopted.row.lineage : [view.adopted.pin]) : []),
            ...receipts.map(row => ({ versionId: row.versionId, sha256: row.sha256 })),
            ...view.versions.filter(version => version.row.phase === 'confirmed').map(version => version.pin)
          ];
          if (known.some(value => ancestors.get(value.versionId) !== value.sha256))
            return response('local_lineage_not_ancestor');
          previousBase = view.adopted ? { pin: { ...view.adopted.pin }, anchorId: view.adopted.row.anchorId } : null;
          if (sameVersionPin(view.tail.pin, pin)) {
            if (view.adopted && sameVersionPin(view.adopted.pin, pin)) {
              return Object.freeze({
                status: 'already_adopted',
                anchorId: view.adopted.row.anchorId,
                pin: Object.freeze(pin),
                previousBase: isRebased(current.state.version) ? view.adopted.row.previousBase : null
              });
            }
            return Object.freeze({ status: 'already_head', pin: Object.freeze(pin), adoptedBase: previousBase });
          }
          for (const version of view.versions.filter(value => value.row.phase === 'confirmed')) {
            receipts.push({ ...version.pin, fileId: version.row.fileId, attemptId: version.row.attemptId });
          }
          if (receipts.length > MAX_HISTORY_VERSIONS) return response('history_limit');
        } else if (conservative) {
          return response('no_local_lineage');
        }
        const anchorId = distinctId(crypto, [
          binding.datasetId,
          binding.deviceId,
          binding.slotId,
          current.receipt.revisionId,
          ...lineage.map(value => value.versionId),
          ...retainedPending.map(item => item.envelope.versionId),
          ...receipts.flatMap(value => [value.versionId, value.attemptId]),
          ...current.state.entries.map(value => value.previousBase?.anchorId).filter(Boolean),
          ...(previousBase ? [previousBase.anchorId] : [])
        ]);
        // Даже пустая восстановленная очередь должна сохранить всю принятую
        // линию: иначе офлайн-предел и ранее известные предки будут потеряны.
        // Старые очереди v3 по-прежнему читаются, но новые основы пишутся в v4.
        const entry = {
          envelope: copy,
          phase: 'adopted',
          fileId: null,
          attemptId: null,
          anchorId,
          lineage,
          priorReceiptCount: receipts.length,
          previousBase,
          ...(retainedPending.length ? { retainedPending } : {})
        };
        const next = {
          ...current.state,
          version: retainedPending.length ? RETAINED_VERSION : REBASED_VERSION,
          entries: [entry],
          confirmedReceipts: receipts
        };
        const saved = await write(current, next);
        return saved.status === 'ready'
          ? Object.freeze({ status: 'adopted', anchorId, pin: Object.freeze(pin), previousBase })
          : response(saved.status);
      });
    },
    /**
     * Локальная линейная ветка от закреплённого корня. Пины и revisionId служат
     * для повторной сверки перед записью, а не подтверждают полноту списка диска.
     * Восстановленный ПК с пустой очередью намеренно не получает родителя.
     * @param {{expectedRootPin:any,expectedKeyPin:any,publicSnapshot?:any}} value
     */
    async inspectLinearHead(value) {
      const request = object(value, ['expectedRootPin', 'expectedKeyPin'], ['publicSnapshot']);
      const root = versionPin(request.expectedRootPin);
      if (!request.expectedKeyPin) throw invalid();
      let local = null;
      if (Object.hasOwn(request, 'publicSnapshot')) {
        publicSnapshotIdentityTypes(request.publicSnapshot);
        local = JSON.stringify(structuredClone(request.publicSnapshot));
      }
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const view = await linearView(current, root, request.expectedKeyPin);
        if (!view) return response('no_local_lineage');
        const firstPending = view.versions.find(version => !finalEntry(version.row)) || null;
        const pins = view.adopted
          ? isRebased(current.state.version)
            ? [...view.adopted.row.lineage]
            : [{ ...view.adopted.pin }]
          : [];
        pins.push(...current.state.confirmedReceipts.map(row => ({ versionId: row.versionId, sha256: row.sha256 })));
        pins.push(...view.versions.filter(version => version.row.phase === 'confirmed').map(version => version.pin));
        const knownPins = uniquePins(pins);
        // v4 сохраняет прежнюю принятую основу и квитанции до переноса.
        // Это позволяет после прерывания проверить, какая подтверждённая локальная
        // версия была непосредственной основой до принятия новой головы.
        const priorConfirmedPin = priorConfirmedBeforeAdoption(current, view);
        return Object.freeze({
          status: 'ready',
          priorConfirmedPin: priorConfirmedPin
            ? Object.freeze({ versionId: priorConfirmedPin.versionId, sha256: priorConfirmedPin.sha256 })
            : null,
          revisionId: current.receipt.revisionId,
          confirmedPin: view.confirmed ? Object.freeze({ ...view.confirmed.pin }) : null,
          confirmedPins: Object.freeze(knownPins.map(pin => Object.freeze({ ...pin }))),
          adoptedBase: view.adopted
            ? Object.freeze({ pin: Object.freeze({ ...view.adopted.pin }), anchorId: view.adopted.row.anchorId })
            : null,
          previousBase:
            view.adopted && isRebased(current.state.version) && view.adopted.row.previousBase
              ? Object.freeze({
                  pin: Object.freeze({ ...view.adopted.row.previousBase.pin }),
                  anchorId: view.adopted.row.previousBase.anchorId
                })
              : null,
          tailPin: Object.freeze({ ...view.tail.pin }),
          tailPhase: view.tail.row.phase,
          tailMatches: local === null ? null : local === JSON.stringify(view.tail.contents.publicSnapshot),
          nextPin: firstPending ? Object.freeze({ ...firstPending.pin }) : null,
          nextPhase: firstPending?.row.phase || null,
          pendingCount: view.pendingCount,
          retainedIntents: Object.freeze(
            view.retained.map(item => Object.freeze({ pin: Object.freeze({ ...item.pin }), phase: item.row.phase }))
          ),
          retainedPendingPin: view.retained.length ? Object.freeze({ ...view.retained[0].pin }) : null,
          retainedPendingPhase: view.retained[0]?.row.phase || null,
          settingsSelections: Object.freeze([...view.tail.contents.publicSnapshot.sections.preferences.selections])
        });
      });
    },
    /** Authenticated PUBLIC intent for a narrowly validated post-apply repair.
     * The snapshot can contain personal text: never serialize the result or log it.
     */
    async readConservativeIntent(value) {
      const request = object(value, ['expectedRootPin', 'expectedKeyPin', 'expectedRevisionId', 'pin']);
      const root = versionPin(request.expectedRootPin);
      const expected = versionPin(request.pin);
      if (!request.expectedKeyPin || !isSyncId(request.expectedRevisionId)) throw invalid();
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (current.receipt.revisionId !== request.expectedRevisionId) return response('changed');
        const view = await linearView(current, root, request.expectedKeyPin);
        if (!view) return response('no_local_lineage');
        const candidates = [...view.versions, ...view.retained].filter(
          item => sameVersionPin(item.pin, expected) && ['queued', 'prepared'].includes(item.row.phase)
        );
        if (candidates.length !== 1) return response('intent_unavailable');
        const snapshot = structuredClone(candidates[0].contents.publicSnapshot);
        return Object.freeze({ status: 'ready', snapshot: () => structuredClone(snapshot) });
      });
    },
    /** Read-only preview; approval is valid only for this parent and queue revision. */
    async inspectPlannerDeletions(value) {
      const request = object(value, ['expectedRootPin', 'expectedKeyPin', 'publicSnapshot', 'expectedRevisionId']);
      const root = versionPin(request.expectedRootPin);
      if (!request.expectedKeyPin || !isSyncId(request.expectedRevisionId)) throw invalid();
      const currentIds = publicSnapshotIdentityTypes(request.publicSnapshot);
      const snapshot = structuredClone(request.publicSnapshot);
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (current.receipt.revisionId !== request.expectedRevisionId) return response('changed');
        const view = await linearView(current, root, request.expectedKeyPin);
        if (!view || !view.confirmed) return response('root_unconfirmed');
        if (view.retained.length) return response('retained_intent_pending');
        const replace = view.tail.row.phase === 'queued';
        const base = replace ? view.versions[view.versions.length - 2] : view.tail;
        if (!base || (replace && !sameVersionPin(view.tail.contents.parent, base.pin))) throw invalid();
        if (base.row.phase === 'attempting' || view.tail.row.phase === 'attempting')
          return response('verification_pending');
        if (
          JSON.stringify(snapshot.sections.preferences.selections) !==
          JSON.stringify(base.contents.publicSnapshot.sections.preferences.selections)
        )
          return response('selection_changed');
        if (base.contents.tombstones.some(id => currentIds.has(id))) return response('deleted_identity_resurrection');
        const missing = [];
        for (const [id, type] of publicSnapshotIdentityTypes(base.contents.publicSnapshot)) {
          if (!currentIds.has(id)) {
            if (type !== 'planner:plannerEntry') return response('other_deletions_need_review');
            missing.push(id);
          } else if (currentIds.get(id) !== type) return response('identity_conflict');
        }
        if (!missing.length) return response('no_deletions');
        if (missing.length > 10_000) return response('other_deletions_need_review');
        const byId = new Map(base.contents.publicSnapshot.sections.planner.records.map(record => [record.id, record]));
        const records = [];
        for (const id of missing.sort()) {
          const record = byId.get(id);
          if (!record || record.fields.source.kind !== 'manual') return response('other_deletions_need_review');
          records.push(Object.freeze({ id, label: String(record.fields.title || 'Запись календаря') }));
        }
        return Object.freeze({
          status: 'deletion_review',
          revisionId: current.receipt.revisionId,
          parentPin: Object.freeze({ ...base.pin }),
          records: Object.freeze(records)
        });
      });
    },
    /**
     * Готовит потомка последней локальной версии и сохраняет только шифротекст.
     * Вызывающий код обязан подтвердить точное сохранение state и отсутствие
     * неразрешённого выборочного применения. Этот метод не выполняет сеть.
     * Незагруженную последнюю версию можно заменить; начатую попытку — никогда.
     * Исчезновение сущности блокируется, кроме отдельно подтверждённых ручных
     * записей календаря. Их v3-метки сохраняются во всех следующих потомках.
     * @param {{expectedRootPin:any,expectedKeyPin:any,keyBundle:any,publicSnapshot:any,expectedRevisionId?:string,plannerDeletionApproval?:{parentPin:any,ids:string[]}}} value
     */
    async queueLinearSnapshot(value) {
      const request = object(
        value,
        ['expectedRootPin', 'expectedKeyPin', 'keyBundle', 'publicSnapshot'],
        ['expectedRevisionId', 'plannerDeletionApproval']
      );
      const root = versionPin(request.expectedRootPin);
      let approval = null;
      if (request.plannerDeletionApproval !== undefined) {
        const value = object(request.plannerDeletionApproval, ['parentPin', 'ids']);
        const ids = value.ids;
        if (
          !request.expectedRevisionId ||
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 10_000 ||
          ids.some((id, index) => !isSyncId(id) || (index > 0 && ids[index - 1] >= id))
        )
          throw invalid();
        approval = { parentPin: versionPin(value.parentPin), ids: [...ids] };
      }
      if (
        !request.expectedKeyPin ||
        !request.keyBundle ||
        (request.expectedRevisionId !== undefined && !isSyncId(request.expectedRevisionId))
      )
        throw invalid();
      const currentIds = publicSnapshotIdentityTypes(request.publicSnapshot);
      const snapshot = structuredClone(request.publicSnapshot);
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (request.expectedRevisionId && current.receipt.revisionId !== request.expectedRevisionId)
          return response('changed');
        const view = await linearView(current, root, request.expectedKeyPin);
        if (!view) return response('no_local_lineage');
        if (!view.confirmed) return response('root_unconfirmed');
        const oldSelections = view.tail.contents.publicSnapshot.sections.preferences.selections;
        if (JSON.stringify(snapshot.sections.preferences.selections) !== JSON.stringify(oldSelections))
          return response('selection_changed');
        if (
          JSON.stringify(snapshot) === JSON.stringify(view.tail.contents.publicSnapshot) &&
          !(view.retained.length && view.pendingCount === 0)
        )
          return response('unchanged');
        const replace = view.tail.row.phase === 'queued';
        if (!replace && view.pendingCount >= 2) return response('queue_full');
        const base = replace ? view.versions[view.versions.length - 2] : view.tail;
        if (!base || (replace && !sameVersionPin(view.tail.contents.parent, base.pin))) throw invalid();
        if (replace && JSON.stringify(snapshot) === JSON.stringify(base.contents.publicSnapshot)) {
          const saved = await write(current, { ...current.state, entries: current.state.entries.slice(0, -1) });
          return response(saved.status === 'ready' ? 'discarded_unpublished' : saved.status);
        }
        const oldIds = publicSnapshotIdentityTypes(base.contents.publicSnapshot);
        const removed = [];
        for (const [id, type] of oldIds) {
          if (!currentIds.has(id)) {
            if (type !== 'planner:plannerEntry') return response('deletions_need_review');
            removed.push(id);
          } else if (currentIds.get(id) !== type) return response('identity_conflict');
        }
        removed.sort();
        if (removed.length && view.retained.length) return response('retained_intent_pending');
        if (base.contents.tombstones.some(id => currentIds.has(id))) return response('deleted_identity_resurrection');
        if (
          removed.some(id => {
            const record = base.contents.publicSnapshot.sections.planner.records.find(row => row.id === id);
            return !record || record.fields.source.kind !== 'manual';
          })
        )
          return response('deletions_need_review');
        const priorApproval =
          replace &&
          view.tail.contents.historyVersion === 3 &&
          JSON.stringify(view.tail.contents.deletedIds) === JSON.stringify(removed) &&
          JSON.stringify(view.tail.contents.tombstones) ===
            JSON.stringify([...base.contents.tombstones, ...removed].sort());
        if (
          approval &&
          (!sameVersionPin(approval.parentPin, base.pin) || JSON.stringify(approval.ids) !== JSON.stringify(removed))
        )
          return response('deletion_review_changed');
        if (removed.length && !approval && !priorApproval) return response('deletions_need_review');
        if (approval && !removed.length) return response('deletion_review_changed');
        // В v4 принятые облачные предки не обязательно имеют локальные квитанции.
        // Считаем уникальные известные версии вместе с ожидающими, иначе после
        // длинной принятой линии можно поставить в очередь заведомо 129-ю версию.
        const confirmedPins = uniquePins([
          ...(isRebased(current.state.version) ? view.adopted.row.lineage : []),
          ...current.state.confirmedReceipts.map(row => ({ versionId: row.versionId, sha256: row.sha256 })),
          ...view.versions.filter(version => finalEntry(version.row)).map(version => version.pin)
        ]);
        const total = confirmedPins.length + view.pendingCount + (replace ? 0 : 1);
        if (total > MAX_HISTORY_VERSIONS) return response('history_limit');
        const versionId = distinctId(crypto, [
          binding.datasetId,
          binding.deviceId,
          binding.slotId,
          current.receipt.revisionId,
          ...current.state.entries.map(row => row.envelope.versionId),
          ...current.state.entries.flatMap(row => row.retainedPending?.map(item => item.envelope.versionId) || []),
          ...current.state.entries.map(row => row.attemptId).filter(Boolean),
          ...current.state.entries.map(row => row.anchorId).filter(Boolean),
          ...current.state.entries.flatMap(row => row.lineage?.map(pin => pin.versionId) || []),
          ...current.state.entries.map(row => row.previousBase?.anchorId).filter(Boolean),
          ...current.state.confirmedReceipts.flatMap(row => [row.versionId, row.attemptId])
        ]);
        const commonSeal = {
          publicSnapshot: snapshot,
          parent: base.pin,
          recoveryKey: dataKey,
          datasetId: binding.datasetId,
          versionId,
          keyBundle: request.keyBundle,
          keyPin: request.expectedKeyPin,
          cryptoSource: crypto
        };
        const sealed =
          base.contents.tombstones.length || removed.length
            ? await sealHistoryChildWithPlannerTombstones({
                ...commonSeal,
                parentSnapshot: base.contents.publicSnapshot,
                previousTombstones: base.contents.tombstones,
                deletedIds: removed,
                confirmedDeletion: !!approval || priorApproval
              })
            : await sealHistoryVersion(commonSeal);
        const entries = current.state.entries.slice();
        if (replace) entries.pop();
        const receipts = current.state.confirmedReceipts.slice();
        // Оставляем последний подтверждённый конверт как локальную точку
        // продолжения; остальные превращаем в подтверждённые отпечатки.
        const confirmedCount = entries.filter(row => row.phase === 'confirmed').length;
        if (confirmedCount > 1) {
          for (const version of view.versions.filter(value => value.row.phase === 'confirmed').slice(0, -1)) {
            receipts.push({ ...version.pin, fileId: version.row.fileId, attemptId: version.row.attemptId });
          }
          entries.splice(view.adopted ? 1 : 0, confirmedCount - 1);
        }
        if (entries.length >= MAX_ENTRIES) return response('queue_full');
        entries.push({ envelope: sealed.envelope, phase: 'queued', fileId: null, attemptId: null });
        const next = { ...current.state, entries, confirmedReceipts: receipts };
        try {
          checkState(next, binding);
        } catch {
          return response('queue_full');
        }
        const saved = await write(current, next);
        return saved.status === 'ready'
          ? Object.freeze({ status: replace ? 'coalesced' : 'queued', pin: Object.freeze({ ...sealed.pin }) })
          : response(saved.status);
      });
    },
    /** Подтверждённый сохранённый локальный снимок должен подготовить вызывающий код. */
    async enqueue(envelope) {
      let copy;
      try {
        copy = copyCloudEnvelope(envelope, binding.datasetId);
        if (binding.provider === 'google' && JSON.stringify(copy).length > MAX_GOOGLE_ENVELOPE) throw invalid();
      } catch {
        throw invalid();
      }
      return run(async () => {
        // Проверяем шифрование ДО изменения журнала. При другой истории/ключе
        // исходные данные и детали ошибки не выходят наружу.
        try {
          await validateVersion(copy, dataKey, binding, crypto);
        } catch {
          return response('invalid_version');
        }
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (
          current.state.entries.some(row => row.envelope.versionId === copy.versionId) ||
          current.state.confirmedReceipts.some(row => row.versionId === copy.versionId)
        )
          return response('duplicate');
        if (current.state.entries.length >= MAX_ENTRIES) return response('full');
        const next = {
          ...current.state,
          entries: [...current.state.entries, { envelope: copy, phase: 'queued', fileId: null, attemptId: null }]
        };
        try {
          checkState(next, binding);
        } catch {
          return response('full');
        }
        const saved = await write(current, next);
        return response(saved.status === 'ready' ? 'queued' : saved.status);
      });
    },
    /** Первая неподтверждённая версия не пропускается ради более новых. */
    async sendNext() {
      return run(async () => sendCurrent(await read()));
    },
    /**
     * Отправляет ровно ту версию и из той revision журнала, для которых caller
     * непосредственно перед этим проверил наблюдаемые головы облака. Даже эта
     * сверка не исключает параллельную запись на другом ПК после чтения списка.
     * @param {{expectedRootPin:any,expectedKeyPin:any,expectedConfirmedPin:any,expectedNextPin:any,expectedRevisionId:string}} value
     */
    async sendLinearNext(value) {
      const request = object(value, [
        'expectedRootPin',
        'expectedKeyPin',
        'expectedConfirmedPin',
        'expectedNextPin',
        'expectedRevisionId'
      ]);
      const root = versionPin(request.expectedRootPin);
      const expectedConfirmed = versionPin(request.expectedConfirmedPin);
      const expectedNext = versionPin(request.expectedNextPin);
      if (!request.expectedKeyPin || !isSyncId(request.expectedRevisionId)) throw invalid();
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (current.receipt.revisionId !== request.expectedRevisionId) return response('changed');
        const view = await linearView(current, root, request.expectedKeyPin);
        const pending = view?.versions.find(version => !finalEntry(version.row));
        if (!view?.confirmed || !pending) return response('changed');
        if (!sameVersionPin(view.confirmed.pin, expectedConfirmed) || !sameVersionPin(pending.pin, expectedNext))
          return response('changed');
        return sendCurrent(current);
      });
    },
    /** Только чтение и точная сверка; отсутствие не разрешает повторную отправку. */
    async verifyNext() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const index = current.state.entries.findIndex(row => !finalEntry(row));
        if (index < 0) return response('idle');
        const row = current.state.entries[index];
        if (row.phase !== 'attempting') return response('not_attempted');
        let result;
        try {
          result = object(
            await session.verify({
              envelope: row.envelope,
              ...(binding.provider === 'google' ? { fileId: row.fileId } : {})
            }),
            ['status']
          );
        } catch {
          return response('unavailable');
        }
        if (result.status === 'mismatch') return response('needs_review');
        if (result.status !== 'verified') return response('unavailable');
        const entries = current.state.entries.slice();
        entries[index] = { ...row, phase: 'confirmed' };
        let version = current.state.version;
        if (version === RETAINED_VERSION) {
          // Only after the new merged child is verified can the previous encrypted
          // queued/prepared intent be released in the SAME CAS as confirmation.
          const { retainedPending: _retainedPending, ...adopted } = entries[0];
          entries[0] = adopted;
          version = REBASED_VERSION;
        }
        const saved = await write(current, { ...current.state, version, entries });
        // Совпадение в облаке не является доказательством дальнейшей сохранности.
        return response(saved.status === 'ready' ? 'confirmed' : saved.status);
      });
    },
    /**
     * Сокращает только подтверждённые точной сверкой записи, сохраняя их ID,
     * отпечаток истории и адрес для обнаружения повтора. Облако не изменяется.
     * Внешний доверенный pin и политика общей истории по-прежнему обязательны.
     */
    async compactConfirmed() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const allConfirmed = current.state.entries.filter(row => row.phase === 'confirmed');
        // Для принятой основы последняя собственная подтверждённая версия нужна
        // как проверяемый родитель. Общая compaction не должна убирать её.
        const confirmed = [ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(current.state.version)
          ? allConfirmed.slice(0, -1)
          : allConfirmed;
        if (!confirmed.length) return response('idle');
        if (current.state.confirmedReceipts.length + confirmed.length > MAX_HISTORY_VERSIONS)
          return response('receipt_limit');
        const receipts = [];
        for (const row of confirmed) {
          const pin = await historyEnvelopePin({
            envelope: row.envelope,
            expectedDatasetId: binding.datasetId,
            cryptoSource: crypto
          });
          receipts.push({ ...pin, fileId: row.fileId, attemptId: row.attemptId });
        }
        const next = {
          ...current.state,
          entries: current.state.entries.filter(row => !confirmed.includes(row)),
          confirmedReceipts: [...current.state.confirmedReceipts, ...receipts]
        };
        const saved = await write(current, next);
        return saved.status === 'ready'
          ? Object.freeze({ status: 'compacted', count: confirmed.length })
          : response(saved.status);
      });
    },
    /** Пины локальных подтверждений; они не доказывают полноту или свежесть облака. */
    async confirmedPins() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const adopted = current.state.entries.find(row => row.phase === 'adopted');
        const pins = [];
        if (adopted) {
          if (isRebased(current.state.version)) pins.push(...adopted.lineage);
          else
            pins.push(
              await historyEnvelopePin({
                envelope: adopted.envelope,
                expectedDatasetId: binding.datasetId,
                cryptoSource: crypto
              })
            );
        }
        pins.push(...current.state.confirmedReceipts.map(row => ({ versionId: row.versionId, sha256: row.sha256 })));
        for (const row of current.state.entries) {
          if (row.phase === 'confirmed')
            pins.push(
              await historyEnvelopePin({
                envelope: row.envelope,
                expectedDatasetId: binding.datasetId,
                cryptoSource: crypto
              })
            );
        }
        if (new Set(pins.map(pin => pin.versionId)).size > MAX_HISTORY_VERSIONS) return response('receipt_limit');
        return Object.freeze({ status: 'ready', pins: Object.freeze(uniquePins(pins).map(pin => Object.freeze(pin))) });
      });
    },
    async status() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const counts = { queued: 0, prepared: 0, attempting: 0, confirmed: 0 };
        if ([ADOPTED_VERSION, REBASED_VERSION, RETAINED_VERSION].includes(current.state.version)) counts['adopted'] = 0;
        for (const row of current.state.entries) counts[row.phase]++;
        return Object.freeze({ status: 'ready', counts: Object.freeze(counts) });
      });
    }
  });
}
