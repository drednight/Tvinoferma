// @ts-check
// Экспериментальная история неизменяемых публичных снимков. Никакой сети, файлов и state.
// Один родитель не моделирует частичное принятие ветки: НЕ использовать для публикации
// результатов частичного слияния, пока не разработано происхождение записей/полей.
// Корень и ранее известные отпечатки должны приходить из независимого доверенного хранилища.
import { parseHistoryCheckpoint } from './historyCheckpointSchema.js';
import { decryptSnapshot, encryptSnapshot, isSyncId, validateEnvelope } from './envelope.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { array, object } from './exportSchema.js';
import { parsePrivateSnapshot, retainsPrivateFields } from './privateSnapshot.js';
import { makePortableKeyCapsule, verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';

const PAYLOAD_FORMAT = 'tvinoferma-public-history';
const PAYLOAD_VERSION = 1;
// Версия 2 дополнительно несёт явные метки удаления записей календаря.
// Пока это только изолированный формат, не подключённый к приложению или облаку.
const PLANNER_DELETION_VERSION = 2;
// v3 carries cumulative tombstones in every descendant. Live publication is
// limited to explicitly confirmed removals of manual planner entries.
const PLANNER_TOMBSTONE_VERSION = 3;
const PRIVATE_TRANSFER_VERSION = 4;
// Explicit whole-file replacement, not a conservative merge or deletion inference.
const FILE_SNAPSHOT_VERSION = 5;
// Whole-file choice, not an entity merge. The other authenticated heads stay as backups.
const FILE_CHOICE_VERSION = 6;
const FILE_PRIVATE_PRUNE_VERSION = 7;
const FILE_CHECKPOINT_VERSION = 8;
const fileVersion = version =>
  [FILE_SNAPSHOT_VERSION, FILE_CHOICE_VERSION, FILE_PRIVATE_PRUNE_VERSION, FILE_CHECKPOINT_VERSION].includes(version);
function replacedFileHeads(value, allowEmpty = false) {
  const pins = validateList(value, MAX_HISTORY_VERSIONS - 1, copyPin);
  if ((!allowEmpty && !pins.length) || new Set(pins.map(pin => pin.versionId)).size !== pins.length)
    throw historyError();
  return pins.sort((a, b) => a.versionId.localeCompare(b.versionId));
}
const cumulativeVersion = version => [PLANNER_TOMBSTONE_VERSION, PRIVATE_TRANSFER_VERSION].includes(version);
const MAX_PLANNER_DELETIONS = 10_000;
const HASH_DOMAIN = 'tvinoferma-encrypted-envelope-sha256-v1';
const PORTABLE_HASH_DOMAIN = 'tvinoferma-encrypted-envelope-sha256-v2';
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];
export const MAX_HISTORY_VERSIONS = 128;
export const MAX_HISTORY_CHARS = 64 * 1024 * 1024;
// One extra full file while a checkpoint is verified before any old file is retired.
export const MAX_HISTORY_INPUT_VERSIONS = MAX_HISTORY_VERSIONS + 1;
export const MAX_HISTORY_INPUT_CHARS = MAX_HISTORY_CHARS + 32 * 1024 * 1024 + 256 * 1024;
// В JS `$` допускает позицию перед завершающим переводом строки; нужен именно конец.
const SHA256 = /^[0-9a-f]{64}(?![\s\S])/;
const verifiedHistories = new WeakSet();

/** Маркер созданного этим модулем объекта, не доказательство доверия к переданному корню. */
export function isVerifiedHistory(value) {
  return !!value && typeof value === 'object' && verifiedHistories.has(value);
}

function historyError() {
  return new Error('Некорректная или неподдерживаемая история синхронизации');
}

function copyPin(input) {
  const value = object(input, ['versionId', 'sha256']);
  if (!isSyncId(value.versionId) || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw historyError();
  }
  return { versionId: value.versionId, sha256: value.sha256 };
}

function samePin(left, right) {
  return left.versionId === right.versionId && left.sha256 === right.sha256;
}

function cryptoApi(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.subtle.digest !== 'function')
    throw new Error('Безопасная криптография недоступна');
  return crypto;
}

// Порядок полей и домен зафиксированы; порядок ключей во входном объекте роли не играет.
async function envelopePin(envelope, crypto) {
  const fields = ENVELOPE_FIELDS.map(key => envelope[key]);
  const canonical = JSON.stringify(
    envelope.version === 2 ? [PORTABLE_HASH_DOMAIN, ...fields, envelope.keyCapsule] : [HASH_DOMAIN, ...fields]
  );
  const bytes = new TextEncoder().encode(canonical);
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (hash.length !== 32) throw new Error('Безопасная криптография недоступна');
    return {
      versionId: envelope.versionId,
      sha256: [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
    };
  } finally {
    bytes.fill(0);
  }
}

function validatePublic(snapshot) {
  try {
    return publicSnapshotIdentityTypes(snapshot);
  } catch {
    throw historyError();
  }
}

/**
 * Шифрует ОДИН подготовленный публичный снимок вместе с отпечатком его родителя.
 * Этот v1-путь не добавляет контакты/пароли; ручная передача использует v4. Вызывающий обязан использовать
 * allowlist-экспорт; текстовые поля могут содержать секреты, структурная проверка этого
 * не обнаружит. Проверка не заменяет импортные схемы. Результат ещё не помещён в очередь
 * и не сохранён. Корень задаётся parent: null; сам родитель здесь не проверяется.
 * keyBundle/keyPin добавляются вместе, чтобы восстановление использовало тот же файл и очередь.
 * @param {{publicSnapshot: any, parent: any, recoveryKey: string, datasetId: string, versionId: string, keyBundle?: any, keyPin?: any, cryptoSource?: Crypto}} options
 */
export async function sealHistoryVersion(options) {
  const input = object(
    options,
    ['publicSnapshot', 'parent', 'recoveryKey', 'datasetId', 'versionId'],
    ['cryptoSource', 'keyBundle', 'keyPin']
  );
  if (!isSyncId(input.datasetId) || !isSyncId(input.versionId)) throw historyError();
  const parent = input.parent === null ? null : copyPin(input.parent);
  if (parent?.versionId === input.versionId) throw historyError();
  validatePublic(input.publicSnapshot);
  let publicSnapshot;
  try {
    // После структурной проверки отклоняем Proxy и фиксируем копию до шифрования.
    publicSnapshot = structuredClone(input.publicSnapshot);
  } catch {
    throw historyError();
  }
  validatePublic(publicSnapshot);
  if (Object.hasOwn(input, 'keyBundle') !== Object.hasOwn(input, 'keyPin')) throw historyError();
  const capsule = Object.hasOwn(input, 'keyBundle')
    ? await makePortableKeyCapsule({
        bundle: input.keyBundle,
        pin: input.keyPin,
        dataKey: input.recoveryKey,
        datasetId: input.datasetId,
        cryptoSource: input.cryptoSource
      })
    : undefined;
  // Снимок и родитель уже скопированы; encryptSnapshot ограничивает размер.
  const payload = { format: PAYLOAD_FORMAT, version: PAYLOAD_VERSION, parent, publicSnapshot };
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: input.recoveryKey,
    datasetId: input.datasetId,
    versionId: input.versionId,
    ...(capsule === undefined ? {} : { keyCapsule: capsule }),
    cryptoSource: input.cryptoSource
  });
  const pin = await envelopePin(envelope, cryptoApi(input.cryptoSource));
  return { envelope, pin };
}

function snapshotEnvelope(value) {
  // Копируем через дескрипторы и не вызываем getters в непроверенных облачных объектах.
  const data = object(value, ENVELOPE_FIELDS, ['keyCapsule']);
  if (
    typeof data.ciphertext !== 'string' ||
    typeof data.iv !== 'string' ||
    (Object.hasOwn(data, 'keyCapsule') && typeof data.keyCapsule !== 'string')
  )
    throw historyError();
  const fields = Object.hasOwn(data, 'keyCapsule')
    ? ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'keyCapsule', 'iv', 'ciphertext']
    : ENVELOPE_FIELDS;
  return Object.fromEntries(fields.map(key => [key, data[key]]));
}

/**
 * Только отпечаток точного конверта истории для локального журнала. Не читает
 * содержимое, не проверяет GCM и не доказывает, что версия была на диске.
 * @param {{envelope:any,expectedDatasetId:string,cryptoSource?:Crypto}} options
 */
export async function historyEnvelopePin(options) {
  const input = object(options, ['envelope', 'expectedDatasetId'], ['cryptoSource']);
  if (!isSyncId(input.expectedDatasetId)) throw historyError();
  const envelope = snapshotEnvelope(input.envelope);
  validateEnvelope(envelope);
  if (envelope.datasetId !== input.expectedDatasetId) throw historyError();
  return envelopePin(envelope, cryptoApi(input.cryptoSource));
}

function validateList(value, max, convert) {
  if (!Array.isArray(value) || value.length > max) throw historyError();
  return array(value, convert);
}

function plannerDeletedIds(value, allowEmpty = false) {
  const ids = validateList(value, MAX_PLANNER_DELETIONS, id => {
    if (!isSyncId(id)) throw historyError();
    return id;
  });
  if ((!allowEmpty && !ids.length) || new Set(ids).size !== ids.length) throw historyError();
  return ids;
}
function sortedPlannerIds(value, allowEmpty = false) {
  const ids = plannerDeletedIds(value, allowEmpty);
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) throw historyError();
  return ids;
}

function plannerIds(snapshot) {
  return new Set(snapshot.sections.planner.records.map(record => record.id));
}

// Метка не выводится из пустого списка: набор явно передан автором версии, а здесь
// проверяется, что он точно совпадает с изменением между родителем и ребёнком.
function checkPlannerDeletionTransition(parentIds, childIds, deleted) {
  const removed = [...parentIds].filter(id => !childIds.has(id));
  const declared = new Set(deleted);
  if (removed.length !== declared.size || removed.some(id => !declared.has(id))) throw historyError();
}

/**
 * Создаёт отдельную экспериментальную версию с явно указанными удалениями календаря.
 * Подтверждение здесь — параметр вызывающего кода, а не доказательство волеизъявления
 * человека или сохранения файла. История, резервная копия и фактическая запись не меняются.
 * Старые приложения не понимают этот формат; не публиковать его до согласования протокола.
 * @param {{history: any, publicSnapshot: any, parent: any, deletedIds: string[], confirmedDeletion: boolean,
 * recoveryKey: string, datasetId: string, versionId: string, keyBundle?: any, keyPin?: any, cryptoSource?: Crypto}} options
 */
export async function sealHistoryVersionWithPlannerDeletions(options) {
  const input = object(
    options,
    ['history', 'publicSnapshot', 'parent', 'deletedIds', 'confirmedDeletion', 'recoveryKey', 'datasetId', 'versionId'],
    ['cryptoSource', 'keyBundle', 'keyPin']
  );
  if (!isVerifiedHistory(input.history) || input.confirmedDeletion !== true) throw historyError();
  if (!isSyncId(input.datasetId) || !isSyncId(input.versionId)) throw historyError();
  if (input.history.identity().datasetId !== input.datasetId) throw historyError();
  const parent = copyPin(input.parent);
  if (parent.versionId === input.versionId) throw historyError();
  const deleted = plannerDeletedIds(input.deletedIds);
  validatePublic(input.publicSnapshot);
  let snapshot;
  try {
    snapshot = structuredClone(input.publicSnapshot);
  } catch {
    throw historyError();
  }
  validatePublic(snapshot);
  const parentSnapshot = input.history.publicSnapshot(parent);
  checkPlannerDeletionTransition(plannerIds(parentSnapshot), plannerIds(snapshot), deleted);
  const payload = {
    format: PAYLOAD_FORMAT,
    version: PLANNER_DELETION_VERSION,
    parent,
    publicSnapshot: snapshot,
    plannerDeletedIds: deleted
  };
  if (Object.hasOwn(input, 'keyBundle') !== Object.hasOwn(input, 'keyPin')) throw historyError();
  const capsule = Object.hasOwn(input, 'keyBundle')
    ? await makePortableKeyCapsule({
        bundle: input.keyBundle,
        pin: input.keyPin,
        dataKey: input.recoveryKey,
        datasetId: input.datasetId,
        cryptoSource: input.cryptoSource
      })
    : undefined;
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: input.recoveryKey,
    datasetId: input.datasetId,
    versionId: input.versionId,
    ...(capsule === undefined ? {} : { keyCapsule: capsule }),
    cryptoSource: input.cryptoSource
  });
  return { envelope, pin: await envelopePin(envelope, cryptoApi(input.cryptoSource)) };
}

/**
 * Internal building block for the explicitly confirmed planner-deletion
 * protocol. The caller MUST authenticate the parent snapshot and cumulative
 * tombstones against its trusted queue or verified history. No I/O is performed.
 * @param {{publicSnapshot:any,parent:any,parentSnapshot:any,previousTombstones:string[],deletedIds:string[],
 * confirmedDeletion:boolean,recoveryKey:string,datasetId:string,versionId:string,
 * keyBundle?:any,keyPin?:any,cryptoSource?:Crypto,privateSnapshot?:any}} options
 */
export async function sealHistoryChildWithPlannerTombstones(options) {
  const input = object(
    options,
    [
      'publicSnapshot',
      'parent',
      'parentSnapshot',
      'previousTombstones',
      'deletedIds',
      'confirmedDeletion',
      'recoveryKey',
      'datasetId',
      'versionId'
    ],
    ['cryptoSource', 'keyBundle', 'keyPin', 'privateSnapshot']
  );
  if (!isSyncId(input.datasetId) || !isSyncId(input.versionId) || typeof input.confirmedDeletion !== 'boolean')
    throw historyError();
  const parent = copyPin(input.parent);
  if (parent.versionId === input.versionId) throw historyError();
  const previous = sortedPlannerIds(input.previousTombstones, true);
  const removed = sortedPlannerIds(input.deletedIds, true);
  if (
    (!previous.length && !removed.length && !input.privateSnapshot) ||
    (removed.length && input.confirmedDeletion !== true)
  )
    throw historyError();
  const all = [...previous, ...removed].sort();
  if (new Set(all).size !== all.length || all.length > MAX_PLANNER_DELETIONS) throw historyError();
  if (Object.hasOwn(input, 'keyBundle') !== Object.hasOwn(input, 'keyPin')) throw historyError();
  let snapshot, prior;
  try {
    validatePublic(input.publicSnapshot);
    validatePublic(input.parentSnapshot);
    snapshot = structuredClone(input.publicSnapshot);
    prior = structuredClone(input.parentSnapshot);
  } catch {
    throw historyError();
  }
  const before = validatePublic(prior);
  const after = validatePublic(snapshot);
  checkPlannerDeletionTransition(plannerIds(prior), plannerIds(snapshot), removed);
  const removedSet = new Set(removed);
  for (const [id, type] of before) {
    if (!after.has(id) && (type !== 'planner:plannerEntry' || !removedSet.has(id))) throw historyError();
    if (after.has(id) && after.get(id) !== type) throw historyError();
  }
  for (const id of all) if (after.has(id)) throw historyError();
  // Клановые события имеют внешнюю идентичность и требуют отдельного протокола.
  for (const id of removed) {
    const record = prior.sections.planner.records.find(value => value.id === id);
    if (!record || record.fields.source.kind !== 'manual') throw historyError();
  }
  const capsule = Object.hasOwn(input, 'keyBundle')
    ? await makePortableKeyCapsule({
        bundle: input.keyBundle,
        pin: input.keyPin,
        dataKey: input.recoveryKey,
        datasetId: input.datasetId,
        cryptoSource: input.cryptoSource
      })
    : undefined;
  const payload = {
    format: PAYLOAD_FORMAT,
    version: input.privateSnapshot ? PRIVATE_TRANSFER_VERSION : PLANNER_TOMBSTONE_VERSION,
    parent,
    publicSnapshot: snapshot,
    plannerDeletedIds: removed,
    plannerTombstones: all,
    ...(input.privateSnapshot ? { privateSnapshot: parsePrivateSnapshot(input.privateSnapshot, snapshot) } : {})
  };
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: input.recoveryKey,
    datasetId: input.datasetId,
    versionId: input.versionId,
    ...(capsule === undefined ? {} : { keyCapsule: capsule }),
    cryptoSource: input.cryptoSource
  });
  return { envelope, pin: await envelopePin(envelope, cryptoApi(input.cryptoSource)) };
}

/**
 * Расшифровывает переданный набор и проверяет дерево ссылок, отпечаток доверенного корня
 * и все ранее известные отпечатки. Это НЕ подтверждение полноты облачного списка: сервис
 * может скрывать неизвестные ветки или откатить его. Известные версии можно передать в
 * knownPins; для защиты от отката они должны храниться отдельно и надёжно.
 *
 * Результат относится только к переданным данным. Ошибки, пропущенные родители,
 * циклы, разные данные с одним ID и несовпадения отпечатков блокируют всю проверку.
 * @param {{envelopes: any[], expectedDatasetId: string, recoveryKey: string, root: any, knownPins: any[], cryptoSource?: Crypto}} options
 */
export async function verifyHistory(options) {
  const input = object(
    options,
    ['envelopes', 'expectedDatasetId', 'recoveryKey', 'root', 'knownPins'],
    ['cryptoSource']
  );
  if (!isSyncId(input.expectedDatasetId)) throw historyError();
  const root = copyPin(input.root);
  const knownPins = validateList(input.knownPins, MAX_HISTORY_INPUT_VERSIONS, copyPin);
  if (new Set(knownPins.map(pin => pin.versionId)).size !== knownPins.length) throw historyError();
  const envelopes = validateList(input.envelopes, MAX_HISTORY_INPUT_VERSIONS, snapshotEnvelope);
  if (!envelopes.length) throw new Error('Не найдена доверенная корневая версия');
  // До декодирования base64 ограничиваем общий объём и отклоняем повторные ID.
  let total = 0;
  const ids = new Set();
  for (const envelope of envelopes) {
    total += envelope.ciphertext.length + envelope.iv.length + (envelope.keyCapsule?.length || 0);
    if (total > MAX_HISTORY_INPUT_CHARS) throw new Error('История синхронизации слишком большая');
    validateEnvelope(envelope);
    if (envelope.datasetId !== input.expectedDatasetId || ids.has(envelope.versionId)) throw historyError();
    ids.add(envelope.versionId);
  }
  const crypto = cryptoApi(input.cryptoSource);
  /** @type {Map<string, {pin: {versionId: string, sha256: string}, parent: {versionId: string, sha256: string} | null, publicSnapshot: any, privateSnapshot: any, plannerIds: Set<string>, deletedIds: string[], tombstones: string[]|null, version: number, replacedHeads: any[], privatePrunedIds: string[], checkpoint:any}>} */
  const nodes = new Map();
  const identities = new Map();
  // Все входные значения скопированы до первого await; чужие изменения не подменят проверку.
  for (const envelope of envelopes) {
    const pin = await envelopePin(envelope, crypto);
    let payload;
    try {
      if (envelope.version === 2) {
        // HMAC проверяет связь капсулы с dataKey, но не свежесть и не доверенный pin.
        await verifyPortableEnvelopeBinding({ envelope, dataKey: input.recoveryKey, cryptoSource: crypto });
      }
      payload = await decryptSnapshot({
        envelope,
        recoveryKey: input.recoveryKey,
        expectedDatasetId: input.expectedDatasetId,
        cryptoSource: crypto
      });
      const wrapper = object(
        payload,
        ['format', 'version', 'parent', 'publicSnapshot'],
        ['plannerDeletedIds', 'plannerTombstones', 'privateSnapshot', 'replacedHeads', 'privatePrunedIds', 'checkpoint']
      );
      if (
        wrapper.format !== PAYLOAD_FORMAT ||
        ![
          PAYLOAD_VERSION,
          PLANNER_DELETION_VERSION,
          PLANNER_TOMBSTONE_VERSION,
          PRIVATE_TRANSFER_VERSION,
          FILE_SNAPSHOT_VERSION,
          FILE_CHOICE_VERSION,
          FILE_PRIVATE_PRUNE_VERSION,
          FILE_CHECKPOINT_VERSION
        ].includes(wrapper.version)
      )
        throw historyError();
      if (
        [FILE_CHOICE_VERSION, FILE_PRIVATE_PRUNE_VERSION].includes(wrapper.version) !==
          Object.hasOwn(wrapper, 'replacedHeads') ||
        (wrapper.version === FILE_PRIVATE_PRUNE_VERSION) !== Object.hasOwn(wrapper, 'privatePrunedIds')
      )
        throw historyError();
      if ((wrapper.version === FILE_CHECKPOINT_VERSION) !== Object.hasOwn(wrapper, 'checkpoint')) throw historyError();
      const checkpoint =
        wrapper.version === FILE_CHECKPOINT_VERSION ? parseHistoryCheckpoint(wrapper.checkpoint) : null;
      if (
        checkpoint &&
        (checkpoint.retiredPins.some(p => [root.versionId, pin.versionId].includes(p.versionId)) ||
          !samePin(wrapper.parent, root))
      )
        throw historyError();
      const replacedHeads = [FILE_CHOICE_VERSION, FILE_PRIVATE_PRUNE_VERSION].includes(wrapper.version)
        ? replacedFileHeads(wrapper.replacedHeads, wrapper.version === FILE_PRIVATE_PRUNE_VERSION)
        : [];
      const privatePrunedIds =
        wrapper.version === FILE_PRIVATE_PRUNE_VERSION ? plannerDeletedIds(wrapper.privatePrunedIds) : [];
      if (wrapper.version === FILE_PRIVATE_PRUNE_VERSION && !privatePrunedIds.length) throw historyError();
      const isDeletionVersion = wrapper.version === PLANNER_DELETION_VERSION;
      const isTombstoneVersion = cumulativeVersion(wrapper.version);
      if (
        !fileVersion(wrapper.version) &&
        (wrapper.version === PRIVATE_TRANSFER_VERSION) !== Object.hasOwn(wrapper, 'privateSnapshot')
      )
        throw historyError();
      if (
        (isDeletionVersion || isTombstoneVersion) !== Object.hasOwn(wrapper, 'plannerDeletedIds') ||
        isTombstoneVersion !== Object.hasOwn(wrapper, 'plannerTombstones')
      )
        throw historyError();
      const deletedIds = isTombstoneVersion
        ? sortedPlannerIds(wrapper.plannerDeletedIds, true)
        : isDeletionVersion
          ? plannerDeletedIds(wrapper.plannerDeletedIds)
          : [];
      const tombstones = isTombstoneVersion
        ? sortedPlannerIds(wrapper.plannerTombstones, wrapper.version === PRIVATE_TRANSFER_VERSION)
        : null;
      const parent = wrapper.parent === null ? null : copyPin(wrapper.parent);
      if (
        parent?.versionId === pin.versionId ||
        ((isDeletionVersion || isTombstoneVersion || fileVersion(wrapper.version)) && parent === null)
      )
        throw historyError();
      const currentIds = validatePublic(wrapper.publicSnapshot);
      for (const [id, type] of currentIds) {
        if (identities.has(id) && identities.get(id) !== type) throw historyError();
        identities.set(id, type);
      }
      nodes.set(pin.versionId, {
        pin,
        parent,
        replacedHeads,
        privatePrunedIds,
        checkpoint,
        publicSnapshot: wrapper.publicSnapshot,
        privateSnapshot: Object.hasOwn(wrapper, 'privateSnapshot')
          ? parsePrivateSnapshot(wrapper.privateSnapshot, wrapper.publicSnapshot)
          : null,
        plannerIds: plannerIds(wrapper.publicSnapshot),
        deletedIds,
        tombstones,
        version: wrapper.version
      });
    } catch {
      // Ошибки не содержат расшифрованных значений, ключей и подписанных ссылок.
      throw new Error('Не удалось проверить зашифрованную историю');
    }
  }
  const rootNode = nodes.get(root.versionId);
  if (!rootNode || !samePin(rootNode.pin, root) || rootNode.parent !== null) {
    throw new Error('Не найдена или изменилась доверенная корневая версия');
  }
  // A v8 record is a dataKey-authenticated retirement statement. Missing old pins
  // may be acknowledged by it, but their unavailable snapshots are never fabricated.
  const retired = new Map();
  for (const node of nodes.values())
    if (node.checkpoint) {
      for (const pin of node.checkpoint.retiredPins) {
        const existing = nodes.get(pin.versionId),
          prior = retired.get(pin.versionId);
        if ((existing && !samePin(existing.pin, pin)) || (prior && !samePin(prior, pin))) throw historyError();
        retired.set(pin.versionId, pin);
      }
      for (const row of node.checkpoint.identities) {
        if (identities.has(row.id) && identities.get(row.id) !== row.type) throw historyError();
        identities.set(row.id, row.type);
      }
      const registry = new Map(node.checkpoint.identities.map(row => [row.id, row.type])),
        declared = new Map(node.checkpoint.retiredPins.map(p => [p.versionId, p]));
      for (const target of [
        rootNode,
        node,
        ...node.checkpoint.retiredPins.map(pin => nodes.get(pin.versionId)).filter(Boolean)
      ]) {
        for (const [id, type] of validatePublic(target.publicSnapshot))
          if (registry.get(id) !== type) throw historyError();
        for (const row of target.checkpoint?.identities || [])
          if (registry.get(row.id) !== row.type) throw historyError();
        for (const pin of target.checkpoint?.retiredPins || [])
          if (!samePin(declared.get(pin.versionId), pin)) throw historyError();
      }
      const source = nodes.get(node.checkpoint.source.versionId);
      if (
        source &&
        (JSON.stringify(source.publicSnapshot) !== JSON.stringify(node.publicSnapshot) ||
          JSON.stringify(source.privateSnapshot) !== JSON.stringify(node.privateSnapshot))
      )
        throw historyError();
    }
  // Retirement cannot hide a conflicting checkpoint or a cyclic declaration.
  const checking = new Set(),
    checked = new Set();
  const checkRetirement = node => {
    if (checked.has(node.pin.versionId)) return;
    if (checking.has(node.pin.versionId)) throw historyError();
    checking.add(node.pin.versionId);
    for (const pin of node.checkpoint?.retiredPins || []) {
      const target = nodes.get(pin.versionId);
      if (target?.checkpoint) checkRetirement(target);
    }
    checking.delete(node.pin.versionId);
    checked.add(node.pin.versionId);
  };
  for (const node of nodes.values()) checkRetirement(node);
  const active = [...nodes.values()].filter(node => !retired.has(node.pin.versionId));
  const activeIds = new Set(active.map(node => node.pin.versionId));
  const activeEnvelopes = envelopes.filter(e => activeIds.has(e.versionId));
  if (
    active.length > MAX_HISTORY_VERSIONS ||
    activeEnvelopes.reduce((n, e) => n + e.ciphertext.length + e.iv.length + (e.keyCapsule?.length || 0), 0) >
      MAX_HISTORY_CHARS
  )
    throw historyError();
  if (!retired.size && (envelopes.length > MAX_HISTORY_VERSIONS || total > MAX_HISTORY_CHARS)) throw historyError();
  for (const known of knownPins) {
    const node = nodes.get(known.versionId);
    if (
      !(node ? samePin(node.pin, known) : retired.has(known.versionId) && samePin(retired.get(known.versionId), known))
    )
      throw new Error('Не найдена или изменилась ранее известная версия');
  }
  for (const node of active) {
    if (node.pin.versionId !== root.versionId && node.parent === null) throw historyError();
    if (node.parent && !nodes.has(node.parent.versionId)) throw new Error('В истории отсутствует родительская версия');
  }

  // Однородительское дерево не допускает циклы и отдельные корни.
  const connected = new Set([root.versionId]);
  for (const node of active) {
    const visited = new Set();
    let current = node;
    while (!connected.has(current.pin.versionId)) {
      if (visited.has(current.pin.versionId)) throw new Error('Обнаружен цикл в истории синхронизации');
      visited.add(current.pin.versionId);
      if (!current.parent) throw historyError();
      current = nodes.get(current.parent.versionId);
      if (!current) throw historyError();
    }
    for (const id of visited) connected.add(id);
  }
  for (const node of active) {
    if (node.parent && !samePin(node.parent, nodes.get(node.parent.versionId).pin)) {
      throw new Error('Родительская версия не совпадает с её отпечатком');
    }
    if ([PLANNER_DELETION_VERSION, PLANNER_TOMBSTONE_VERSION, PRIVATE_TRANSFER_VERSION].includes(node.version)) {
      const parent = node.parent && nodes.get(node.parent.versionId);
      if (!parent) throw historyError();
      checkPlannerDeletionTransition(parent.plannerIds, node.plannerIds, node.deletedIds);
      if (cumulativeVersion(node.version)) {
        const previousIds = validatePublic(parent.publicSnapshot);
        const currentIds = validatePublic(node.publicSnapshot);
        const removed = new Set(node.deletedIds);
        for (const [id, type] of previousIds) {
          if (!currentIds.has(id) && (type !== 'planner:plannerEntry' || !removed.has(id))) throw historyError();
        }
        for (const id of node.deletedIds) {
          const record = parent.publicSnapshot.sections.planner.records.find(row => row.id === id);
          if (!record || record.fields.source.kind !== 'manual') throw historyError();
        }
      }
    }
    const parentNode = node.parent && nodes.get(node.parent.versionId);
    if (parentNode && node.version !== FILE_CHECKPOINT_VERSION) {
      const removed = new Set(node.privatePrunedIds);
      const currentIds = validatePublic(node.publicSnapshot);
      const expected = (parentNode.privateSnapshot?.records || [])
        .filter(row => !currentIds.has(row.characterId))
        .map(row => row.characterId)
        .sort();
      if (
        node.version === FILE_PRIVATE_PRUNE_VERSION &&
        JSON.stringify(expected) !== JSON.stringify([...removed].sort())
      )
        throw historyError();
      const prior = parentNode.privateSnapshot
        ? {
            ...parentNode.privateSnapshot,
            records: parentNode.privateSnapshot.records.filter(row => !removed.has(row.characterId))
          }
        : null;
      if (!retainsPrivateFields(prior?.records.length ? prior : null, node.privateSnapshot)) throw historyError();
    }
    if (
      (cumulativeVersion(parentNode?.version) && !cumulativeVersion(node.version) && !fileVersion(node.version)) ||
      (parentNode?.version === PRIVATE_TRANSFER_VERSION &&
        ![
          PRIVATE_TRANSFER_VERSION,
          FILE_SNAPSHOT_VERSION,
          FILE_CHOICE_VERSION,
          FILE_PRIVATE_PRUNE_VERSION,
          FILE_CHECKPOINT_VERSION
        ].includes(node.version)) ||
      (fileVersion(parentNode?.version) && !fileVersion(node.version))
    )
      throw historyError();
  }

  const dependencies = node => [...(node.parent ? [node.parent] : []), ...node.replacedHeads];
  const reachable = new Map();
  const visiting = new Set();
  const ancestors = node => {
    const id = node.pin.versionId;
    if (reachable.has(id)) return reachable.get(id);
    if (visiting.has(id)) throw historyError();
    visiting.add(id);
    const before = new Set((node.checkpoint?.retiredPins || []).map(p => p.versionId));
    for (const ref of dependencies(node)) {
      const target = nodes.get(ref.versionId);
      if (!target || !samePin(target.pin, ref)) throw historyError();
      before.add(ref.versionId);
      for (const earlier of ancestors(target)) before.add(earlier);
    }
    visiting.delete(id);
    reachable.set(id, before);
    return before;
  };
  for (const node of active) ancestors(node);
  for (const node of active) {
    const refs = dependencies(node);
    // A choice must acknowledge independent heads, not self, duplicate or ancestor pins.
    if (new Set(refs.map(pin => pin.versionId)).size !== refs.length) throw historyError();
    for (const ref of refs)
      for (const other of refs)
        if (ref !== other && reachable.get(ref.versionId).has(other.versionId)) throw historyError();
  }

  // После метки этот ID не может вновь появиться в её потомке без отдельного
  // протокола восстановления. Другая ветка дерева по-прежнему может содержать запись.
  const inheritedDeletions = new Map();
  const collectDeletions = node => {
    if (inheritedDeletions.has(node.pin.versionId)) return inheritedDeletions.get(node.pin.versionId);
    const before =
      !fileVersion(node.version) && node.parent ? collectDeletions(nodes.get(node.parent.versionId)) : new Set();
    for (const id of node.plannerIds) if (before.has(id)) throw historyError();
    const after = node.deletedIds.length ? new Set([...before, ...node.deletedIds]) : before;
    if (cumulativeVersion(node.version)) {
      const expected = [...after].sort();
      if (
        !node.tombstones ||
        expected.length !== node.tombstones.length ||
        expected.some((id, index) => id !== node.tombstones[index])
      )
        throw historyError();
    }
    inheritedDeletions.set(node.pin.versionId, after);
    return after;
  };
  for (const node of active) collectDeletions(node);

  const get = pinValue => {
    const pin = copyPin(pinValue);
    const node = nodes.get(pin.versionId);
    if (!node || !samePin(node.pin, pin)) throw new Error('Версия не найдена или её отпечаток изменился');
    return node;
  };
  const parentIds = new Set(active.flatMap(node => dependencies(node).map(pin => pin.versionId)));
  const view = Object.freeze({
    /** Проверенные идентификаторы; доверие к ним и защита от отката остаются у вызывающего кода. */
    identity() {
      return { datasetId: input.expectedDatasetId, rootPin: { ...root } };
    },
    checkpoint(pinValue) {
      return structuredClone(get(pinValue).checkpoint);
    },
    retiredPins() {
      return [...retired.values()].map(p => ({ ...p }));
    },
    identityRegistry() {
      return [...identities].map(([id, type]) => ({ id, type }));
    },
    hasSnapshot(pinValue) {
      const p = copyPin(pinValue);
      return nodes.has(p.versionId) && samePin(nodes.get(p.versionId).pin, p);
    },
    isFileSnapshot(pinValue) {
      return fileVersion(get(pinValue).version);
    },
    privatePrunedIds(pinValue) {
      return [...get(pinValue).privatePrunedIds];
    },
    replacedHeads(pinValue) {
      return get(pinValue).replacedHeads.map(pin => ({ ...pin }));
    },
    covers(descendant, ancestor) {
      const node = get(descendant),
        pin = copyPin(ancestor),
        before = nodes.get(pin.versionId)?.pin || retired.get(pin.versionId);
      if (!before || !samePin(pin, before)) throw new Error('Версия не найдена или её отпечаток изменился');
      return samePin(node.pin, pin) || !!reachable.get(node.pin.versionId)?.has(pin.versionId);
    },
    /** Требует точного присутствия ранее известного отпечатка без копирования снимка. */
    requirePin(pinValue) {
      const pin = copyPin(pinValue),
        found = nodes.get(pin.versionId)?.pin || retired.get(pin.versionId);
      if (!found || !samePin(pin, found)) throw new Error('Версия не найдена или её отпечаток изменился');
      return true;
    },
    /** Все проверенные версии только переданного набора, без обещания полноты облака. */
    pins() {
      return [...nodes.values()].map(node => ({ ...node.pin })).sort((a, b) => a.versionId.localeCompare(b.versionId));
    },
    /** Только вершины переданного набора; они не обязательно являются актуальными на диске. */
    observedHeads() {
      return active
        .filter(node => !parentIds.has(node.pin.versionId))
        .map(node => ({ ...node.pin }))
        .sort((a, b) => a.versionId.localeCompare(b.versionId));
    },
    /** Ближайший общий предок в проверенном дереве, не доказательство поэлементного принятия. */
    commonAncestor(leftPin, rightPin) {
      let left = get(leftPin);
      const ancestors = new Set();
      while (left) {
        ancestors.add(left.pin.versionId);
        left = left.parent ? nodes.get(left.parent.versionId) : null;
      }
      let right = get(rightPin);
      while (right && !ancestors.has(right.pin.versionId)) {
        right = right.parent ? nodes.get(right.parent.versionId) : null;
      }
      if (!right) throw historyError();
      return { ...right.pin };
    },
    /** От корня до указанной версии включительно; не доказывает полноту облака. */
    lineage(pinValue) {
      const result = [];
      let current = get(pinValue);
      while (current) {
        result.push({ ...current.pin });
        current = current.parent ? nodes.get(current.parent.versionId) : null;
      }
      return result.reverse();
    },
    /** Одна публичная запись календаря или null; её отсутствие само по себе не удаление. */
    plannerRecord(pinValue, id) {
      if (!isSyncId(id)) throw historyError();
      const record = get(pinValue).publicSnapshot.sections.planner.records.find(row => row.id === id);
      return record ? structuredClone(record) : null;
    },
    /** Независимая копия порядка; она не доказывает принятия перестановки. */
    plannerOrder(pinValue) {
      return [...get(pinValue).publicSnapshot.sections.planner.order];
    },
    /** Только явные метки в этой версии. Пустой список не доказывает отсутствия старых удалений. */
    plannerDeletions(pinValue) {
      return [...get(pinValue).deletedIds];
    },
    /** This version carries the cumulative v3 protocol; legacy v2 is read-only. */
    usesPlannerTombstones(pinValue) {
      return cumulativeVersion(get(pinValue).version);
    },
    /** Все проверенные метки на линии выбранной версии; не доказательство полноты облака. */
    plannerTombstones(pinValue) {
      const node = get(pinValue);
      const known = inheritedDeletions.get(node.pin.versionId);
      if (!known) throw historyError();
      return [...known].sort();
    },
    /** Независимая копия данных только для предварительного сравнения, не для импорта. */
    privateSnapshot(pinValue) {
      return structuredClone(get(pinValue).privateSnapshot);
    },
    publicSnapshot(pinValue) {
      return structuredClone(get(pinValue).publicSnapshot);
    }
  });
  verifiedHistories.add(view);
  return view;
}

/** A full public file, including absences and order. Caller obtains explicit replacement consent.
 * The encrypted prior versions stay on disk as backups. Not used by the old outbox.
 * @param {{publicSnapshot:any,parent:any,recoveryKey:string,datasetId:string,versionId:string,keyBundle:any,keyPin:any,privateSnapshot?:any,replacedHeads?:any[],privatePrunedIds?:string[],cryptoSource?:Crypto}} options
 */
export async function sealFileSnapshot(options) {
  const input = object(
    options,
    ['publicSnapshot', 'parent', 'recoveryKey', 'datasetId', 'versionId', 'keyBundle', 'keyPin'],
    ['privateSnapshot', 'cryptoSource', 'replacedHeads', 'privatePrunedIds']
  );
  const parent = copyPin(input.parent);
  const privatePrunedIds = input.privatePrunedIds === undefined ? [] : plannerDeletedIds(input.privatePrunedIds);
  if (input.privatePrunedIds !== undefined && !privatePrunedIds.length) throw historyError();
  const replacedHeads = input.replacedHeads === undefined ? [] : replacedFileHeads(input.replacedHeads);
  if (replacedHeads.some(pin => pin.versionId === parent.versionId || pin.versionId === input.versionId))
    throw historyError();
  if (!isSyncId(input.datasetId) || !isSyncId(input.versionId) || parent.versionId === input.versionId)
    throw historyError();
  validatePublic(input.publicSnapshot);
  const publicSnapshot = structuredClone(input.publicSnapshot);
  const privateSnapshot = input.privateSnapshot ? parsePrivateSnapshot(input.privateSnapshot, publicSnapshot) : null;
  const keyCapsule = await makePortableKeyCapsule({
    bundle: input.keyBundle,
    pin: input.keyPin,
    dataKey: input.recoveryKey,
    datasetId: input.datasetId,
    cryptoSource: input.cryptoSource
  });
  const envelope = await encryptSnapshot({
    snapshot: {
      format: PAYLOAD_FORMAT,
      version: privatePrunedIds.length
        ? FILE_PRIVATE_PRUNE_VERSION
        : replacedHeads.length
          ? FILE_CHOICE_VERSION
          : FILE_SNAPSHOT_VERSION,
      ...(privatePrunedIds.length
        ? { privatePrunedIds, replacedHeads }
        : replacedHeads.length
          ? { replacedHeads }
          : {}),
      parent,
      publicSnapshot,
      ...(privateSnapshot ? { privateSnapshot } : {})
    },
    recoveryKey: input.recoveryKey,
    datasetId: input.datasetId,
    versionId: input.versionId,
    keyCapsule,
    cryptoSource: input.cryptoSource
  });
  return {
    envelope,
    pin: await historyEnvelopePin({ envelope, expectedDatasetId: input.datasetId, cryptoSource: input.cryptoSource })
  };
}

/** Explicit compaction: authenticates retirement, NOT a cryptographic ancestry proof for removed ciphertext.
 * @param {{history:any,source:any,archiveSha256:string,recoveryKey:string,datasetId:string,versionId:string,keyBundle:any,keyPin:any,cryptoSource?:Crypto}} options */
export async function sealHistoryCheckpoint(options) {
  const input = object(
    options,
    ['history', 'source', 'archiveSha256', 'recoveryKey', 'datasetId', 'versionId', 'keyBundle', 'keyPin'],
    ['cryptoSource']
  );
  if (!isVerifiedHistory(input.history)) throw historyError();
  const identity = input.history.identity(),
    source = copyPin(input.source);
  if (
    identity.datasetId !== input.datasetId ||
    !input.history.isFileSnapshot(source) ||
    input.history.observedHeads().length !== 1 ||
    !samePin(input.history.observedHeads()[0], source)
  )
    throw historyError();
  const pins = new Map(
    [...input.history.retiredPins(), ...input.history.pins()]
      .filter(p => p.versionId !== identity.rootPin.versionId)
      .map(p => [p.versionId, p])
  );
  const checkpoint = parseHistoryCheckpoint({
    source,
    retiredPins: [...pins.values()],
    identities: input.history.identityRegistry(),
    archiveSha256: input.archiveSha256
  });
  const privateSnapshot = input.history.privateSnapshot(source),
    publicSnapshot = input.history.publicSnapshot(source);
  const envelope = await encryptSnapshot({
    snapshot: {
      format: PAYLOAD_FORMAT,
      version: FILE_CHECKPOINT_VERSION,
      parent: identity.rootPin,
      publicSnapshot,
      checkpoint,
      ...(privateSnapshot ? { privateSnapshot } : {})
    },
    recoveryKey: input.recoveryKey,
    datasetId: input.datasetId,
    versionId: input.versionId,
    cryptoSource: input.cryptoSource,
    keyCapsule: await makePortableKeyCapsule({
      bundle: input.keyBundle,
      pin: input.keyPin,
      dataKey: input.recoveryKey,
      datasetId: input.datasetId,
      cryptoSource: input.cryptoSource
    })
  });
  return Object.freeze({ envelope, pin: await envelopePin(envelope, cryptoApi(input.cryptoSource)) });
}
