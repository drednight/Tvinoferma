// @ts-check
// Самостоятельные полные копии. В отличие от прежней истории, fingerprint из
// капсулы здесь — проверка самосогласованности, НЕ независимо доверенный pin.
// Доверие при первом открытии: выбранный OAuth-аккаунт + пароль + явное принятие.
// Пароль не удостоверяет автора, свежесть или отсутствие отката облака.
import { createKeyBundle, openKeyBundle } from './keyBundle.js';
import { decryptSnapshot, encryptSnapshot, generateSyncId, isSyncId } from './envelope.js';
import {
  inspectPortableEnvelope,
  makePortableKeyCapsule,
  verifyPortableEnvelopeBinding
} from './portableKeyCapsule.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { buildPrivateDelta, parsePrivateSnapshot, PRIVATE_FIELDS } from './privateSnapshot.js';
import { object, array, text } from './exportSchema.js';
import { filePin } from './snapshotFileState.js';

import { STANDALONE_DATASET_ID, STANDALONE_FORMAT, MAX_STANDALONE_COPIES } from './standaloneFileConstants.js';
export { STANDALONE_DATASET_ID, STANDALONE_FORMAT };
const MAX_ARCHIVES = MAX_STANDALONE_COPIES;
export function standaloneContents(value) {
  const root = object(value, ['format', 'version', 'createdAt', 'publicSnapshot', 'privateSnapshot', 'supersedes']);
  if (
    root.format !== STANDALONE_FORMAT ||
    root.version !== 1 ||
    typeof root.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(root.createdAt) ||
    !Number.isFinite(Date.parse(root.createdAt))
  )
    throw new Error('Неподдерживаемый полный файл');
  comparePublicSnapshots({ local: root.publicSnapshot, cloud: root.publicSnapshot });
  const supersedes = array(root.supersedes, filePin);
  if (supersedes.length > MAX_ARCHIVES || new Set(supersedes.map(row => row.versionId)).size !== supersedes.length)
    throw new Error('Некорректный список резервных копий');
  return {
    ...root,
    supersedes,
    privateSnapshot:
      root.privateSnapshot === null ? null : parsePrivateSnapshot(root.privateSnapshot, root.publicSnapshot)
  };
}
export async function standaloneEnvelopeHash(envelope, cryptoSource = globalThis.crypto) {
  const inspected = await inspectPortableEnvelope({ envelope, cryptoSource });
  if (inspected.envelope.datasetId !== STANDALONE_DATASET_ID) throw new Error('Это файл прежнего режима');
  const bytes = new TextEncoder().encode(JSON.stringify(inspected.envelope));
  const digest = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** @param {any} options */
export async function sealStandaloneFile(options) {
  const {
    snapshot,
    password,
    unlocked,
    cryptoSource = globalThis.crypto,
    supersedes = [],
    fields = [],
    acknowledgePasswordRisk = false,
    contactsSourceConfirmed = false,
    settingsSelections = [],
    now = () => new Date().toISOString()
  } = options;
  const selected = array(fields, field => {
    if (!PRIVATE_FIELDS.includes(field)) throw new Error('Неизвестная категория контактов');
    return field;
  });
  if (new Set(selected).size !== selected.length) throw new Error('Повторная категория контактов');
  if (selected.length && !contactsSourceConfirmed) throw new Error('Подтвердите полноту выбранных контактов');
  if (selected.includes('password') && !acknowledgePasswordRisk) throw new Error('Подтвердите риск передачи паролей');
  const publicSnapshot = buildPublicSnapshot(snapshot, { settingsSelections });
  const contents = standaloneContents({
    format: STANDALONE_FORMAT,
    version: 1,
    createdAt: now(),
    publicSnapshot,
    privateSnapshot:
      selected.length && [...snapshot.characters, ...snapshot.archivedCharacters].length
        ? buildPrivateDelta(snapshot, publicSnapshot, selected)
        : null,
    // Это только список известных резервных копий. Они НЕ нужны для открытия.
    supersedes
  });
  const key =
    unlocked ||
    (await createKeyBundle({
      datasetId: STANDALONE_DATASET_ID,
      primary: { kind: 'password', secret: password },
      backup: { kind: 'generated' },
      cryptoSource
    }));
  const capsule = await makePortableKeyCapsule({
    bundle: key.bundle,
    pin: key.pin,
    dataKey: key.dataKey,
    datasetId: STANDALONE_DATASET_ID,
    cryptoSource
  });
  const envelope = await encryptSnapshot({
    snapshot: contents,
    keyCapsule: capsule,
    recoveryKey: key.dataKey,
    datasetId: STANDALONE_DATASET_ID,
    versionId: generateSyncId(cryptoSource),
    cryptoSource
  });
  // Случайная запасная обёртка совместима с v2, но её секрет не хранится и не
  // выдаётся за пользовательскую резервную копию. Старые ключи не меняются.
  return { envelope, contents, unlocked: { bundle: key.bundle, pin: key.pin, dataKey: key.dataKey } };
}
/** @param {any} options */
export async function openStandaloneFile({ envelope, password, unlocked, cryptoSource = globalThis.crypto }) {
  const inspected = await inspectPortableEnvelope({ envelope, cryptoSource });
  if (inspected.envelope.datasetId !== STANDALONE_DATASET_ID) throw new Error('Это файл прежнего режима');
  let key;
  if (unlocked && unlocked.bundle.bundleId === inspected.bundle.bundleId) {
    await verifyPortableEnvelopeBinding({
      envelope,
      dataKey: unlocked.dataKey,
      expectedPin: unlocked.pin,
      cryptoSource
    });
    key = unlocked;
  } else {
    const opened = await openKeyBundle({
      bundle: inspected.bundle,
      expectedDatasetId: STANDALONE_DATASET_ID,
      expectedPin: inspected.pin,
      role: 'main',
      secret: text(password),
      cryptoSource
    });
    key = { bundle: inspected.bundle, pin: inspected.pin, dataKey: opened.dataKey };
  }
  const contents = standaloneContents(
    await decryptSnapshot({
      envelope,
      recoveryKey: key.dataKey,
      expectedDatasetId: STANDALONE_DATASET_ID,
      cryptoSource
    })
  );
  if (contents.supersedes.some(pin => pin.versionId === envelope.versionId)) throw new Error('Файл ссылается на себя');
  return { contents, unlocked: key };
}
export function validateStandaloneKeyRecord(value) {
  const row = object(value, ['bundleId', 'dataKey']);
  if (!isSyncId(row.bundleId) || typeof row.dataKey !== 'string' || !/^TF1-[A-Za-z0-9_-]{43}$/.test(row.dataKey))
    throw new Error('Защищённый ключ недоступен');
  return row;
}
