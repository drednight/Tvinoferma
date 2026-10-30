// @ts-check
// Экспериментальная история неизменяемых публичных снимков. Никакой сети, файлов и state.
// Один родитель не моделирует частичное принятие ветки: НЕ использовать для публикации
// результатов частичного слияния, пока не разработано происхождение записей/полей.
// Корень и ранее известные отпечатки должны приходить из независимого доверенного хранилища.
import { decryptSnapshot, encryptSnapshot, isSyncId, validateEnvelope } from './envelope.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { array, object } from './exportSchema.js';
import { makePortableKeyCapsule, verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';

const PAYLOAD_FORMAT = 'tvinoferma-public-history';
const PAYLOAD_VERSION = 1;
// Версия 2 дополнительно несёт явные метки удаления записей календаря.
// Пока это только изолированный формат, не подключённый к приложению или облаку.
const PLANNER_DELETION_VERSION = 2;
const MAX_PLANNER_DELETIONS = 10_000;
const HASH_DOMAIN = 'tvinoferma-encrypted-envelope-sha256-v1';
const PORTABLE_HASH_DOMAIN = 'tvinoferma-encrypted-envelope-sha256-v2';
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];
export const MAX_HISTORY_VERSIONS = 128;
const MAX_HISTORY_CHARS = 64 * 1024 * 1024;
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
 * Отдельный раздел контактов/паролей не поддерживается. Вызывающий обязан использовать
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

function plannerDeletedIds(value) {
  const ids = validateList(value, MAX_PLANNER_DELETIONS, id => {
    if (!isSyncId(id)) throw historyError();
    return id;
  });
  if (!ids.length || new Set(ids).size !== ids.length) throw historyError();
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
  const knownPins = validateList(input.knownPins, MAX_HISTORY_VERSIONS, copyPin);
  if (new Set(knownPins.map(pin => pin.versionId)).size !== knownPins.length) throw historyError();
  const envelopes = validateList(input.envelopes, MAX_HISTORY_VERSIONS, snapshotEnvelope);
  if (!envelopes.length) throw new Error('Не найдена доверенная корневая версия');
  // До декодирования base64 ограничиваем общий объём и отклоняем повторные ID.
  let total = 0;
  const ids = new Set();
  for (const envelope of envelopes) {
    total += envelope.ciphertext.length + envelope.iv.length + (envelope.keyCapsule?.length || 0);
    if (total > MAX_HISTORY_CHARS) throw new Error('История синхронизации слишком большая');
    validateEnvelope(envelope);
    if (envelope.datasetId !== input.expectedDatasetId || ids.has(envelope.versionId)) throw historyError();
    ids.add(envelope.versionId);
  }
  const crypto = cryptoApi(input.cryptoSource);
  /** @type {Map<string, {pin: {versionId: string, sha256: string}, parent: {versionId: string, sha256: string} | null, publicSnapshot: any, plannerIds: Set<string>, deletedIds: string[], version: number}>} */
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
      const wrapper = object(payload, ['format', 'version', 'parent', 'publicSnapshot'], ['plannerDeletedIds']);
      if (wrapper.format !== PAYLOAD_FORMAT || ![PAYLOAD_VERSION, PLANNER_DELETION_VERSION].includes(wrapper.version))
        throw historyError();
      const isDeletionVersion = wrapper.version === PLANNER_DELETION_VERSION;
      if (isDeletionVersion !== Object.hasOwn(wrapper, 'plannerDeletedIds')) throw historyError();
      const deletedIds = isDeletionVersion ? plannerDeletedIds(wrapper.plannerDeletedIds) : [];
      const parent = wrapper.parent === null ? null : copyPin(wrapper.parent);
      if (parent?.versionId === pin.versionId || (isDeletionVersion && parent === null)) throw historyError();
      const currentIds = validatePublic(wrapper.publicSnapshot);
      for (const [id, type] of currentIds) {
        if (identities.has(id) && identities.get(id) !== type) throw historyError();
        identities.set(id, type);
      }
      nodes.set(pin.versionId, {
        pin,
        parent,
        publicSnapshot: wrapper.publicSnapshot,
        plannerIds: plannerIds(wrapper.publicSnapshot),
        deletedIds,
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
  for (const known of knownPins) {
    const node = nodes.get(known.versionId);
    if (!node || !samePin(node.pin, known)) throw new Error('Не найдена или изменилась ранее известная версия');
  }
  for (const node of nodes.values()) {
    if (node.pin.versionId !== root.versionId && node.parent === null) throw historyError();
    if (node.parent && !nodes.has(node.parent.versionId)) throw new Error('В истории отсутствует родительская версия');
  }

  // Однородительское дерево не допускает циклы и отдельные корни.
  const connected = new Set([root.versionId]);
  for (const node of nodes.values()) {
    const visited = new Set();
    let current = node;
    while (!connected.has(current.pin.versionId)) {
      if (visited.has(current.pin.versionId)) throw new Error('Обнаружен цикл в истории синхронизации');
      visited.add(current.pin.versionId);
      if (!current.parent) throw historyError();
      current = nodes.get(current.parent.versionId);
    }
    for (const id of visited) connected.add(id);
  }
  for (const node of nodes.values()) {
    if (node.parent && !samePin(node.parent, nodes.get(node.parent.versionId).pin)) {
      throw new Error('Родительская версия не совпадает с её отпечатком');
    }
    if (node.version === PLANNER_DELETION_VERSION) {
      const parent = node.parent && nodes.get(node.parent.versionId);
      if (!parent) throw historyError();
      checkPlannerDeletionTransition(parent.plannerIds, node.plannerIds, node.deletedIds);
    }
  }

  // После метки этот ID не может вновь появиться в её потомке без отдельного
  // протокола восстановления. Другая ветка дерева по-прежнему может содержать запись.
  const inheritedDeletions = new Map();
  const collectDeletions = node => {
    if (inheritedDeletions.has(node.pin.versionId)) return inheritedDeletions.get(node.pin.versionId);
    const before = node.parent ? collectDeletions(nodes.get(node.parent.versionId)) : new Set();
    for (const id of node.plannerIds) if (before.has(id)) throw historyError();
    const after = node.deletedIds.length ? new Set([...before, ...node.deletedIds]) : before;
    inheritedDeletions.set(node.pin.versionId, after);
    return after;
  };
  for (const node of nodes.values()) collectDeletions(node);

  const get = pinValue => {
    const pin = copyPin(pinValue);
    const node = nodes.get(pin.versionId);
    if (!node || !samePin(node.pin, pin)) throw new Error('Версия не найдена или её отпечаток изменился');
    return node;
  };
  const parentIds = new Set([...nodes.values()].filter(node => node.parent).map(node => node.parent.versionId));
  const view = Object.freeze({
    /** Проверенные идентификаторы; доверие к ним и защита от отката остаются у вызывающего кода. */
    identity() {
      return { datasetId: input.expectedDatasetId, rootPin: { ...root } };
    },
    /** Требует точного присутствия ранее известного отпечатка без копирования снимка. */
    requirePin(pinValue) {
      get(pinValue);
      return true;
    },
    /** Все проверенные версии только переданного набора, без обещания полноты облака. */
    pins() {
      return [...nodes.values()].map(node => ({ ...node.pin })).sort((a, b) => a.versionId.localeCompare(b.versionId));
    },
    /** Только вершины переданного набора; они не обязательно являются актуальными на диске. */
    observedHeads() {
      return [...nodes.values()]
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
    /** Независимая копия данных только для предварительного сравнения, не для импорта. */
    publicSnapshot(pinValue) {
      return structuredClone(get(pinValue).publicSnapshot);
    }
  });
  verifiedHistories.add(view);
  return view;
}
