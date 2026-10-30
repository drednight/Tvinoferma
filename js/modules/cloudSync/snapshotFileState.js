// @ts-check
// Local baseline + encrypted pending file. No plaintext public snapshot or key here.
import { object } from './exportSchema.js';
import { isSyncId } from './envelope.js';
import { copyCloudEnvelope, validGoogleId } from './providers/common.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
export function filePin(value) {
  const pin = object(value, ['versionId', 'sha256']);
  if (!isSyncId(pin.versionId) || typeof pin.sha256 !== 'string' || !HASH.test(pin.sha256))
    throw new Error('Некорректная версия файла');
  return { ...pin };
}
export function sameFilePin(a, b) {
  return !!a && !!b && a.versionId === b.versionId && a.sha256 === b.sha256;
}
export function hasSnapshotFileMode(settings, provider = null) {
  if (!Object.hasOwn(settings, 'cloudSnapshotFiles')) return false;
  if (provider === null) return true;
  const map = settings.cloudSnapshotFiles;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return true;
  return Object.hasOwn(map, provider);
}
export function readSnapshotFileState(settings, provider, datasetId) {
  if (!hasSnapshotFileMode(settings)) return null;
  const map = object(settings.cloudSnapshotFiles, [], ['google', 'yandex']);
  if (!Object.hasOwn(map, provider)) return null;
  const row = object(map[provider], ['version', 'datasetId', 'acceptedPin', 'acceptedHash', 'pending']);
  if (row.version !== 1 || row.datasetId !== datasetId || (row.acceptedPin === null) !== (row.acceptedHash === null))
    throw new Error('Привязка файла изменилась');
  const acceptedPin = row.acceptedPin === null ? null : filePin(row.acceptedPin);
  if (row.acceptedHash !== null && (typeof row.acceptedHash !== 'string' || !HASH.test(row.acceptedHash)))
    throw new Error('Некорректная основа файла');
  let pending = null;
  if (row.pending !== null) {
    const p = object(row.pending, ['phase', 'envelope', 'pin', 'parent', 'fileId', 'contentHash']);
    if (
      !['prepared', 'attempting'].includes(p.phase) ||
      typeof p.contentHash !== 'string' ||
      !HASH.test(p.contentHash) ||
      (provider === 'google' ? !validGoogleId(p.fileId) : p.fileId !== null)
    )
      throw new Error('Некорректная ожидающая отправка');
    const envelope = copyCloudEnvelope(p.envelope, datasetId),
      pin = filePin(p.pin),
      parent = filePin(p.parent);
    if (pin.versionId !== envelope.versionId || pin.versionId === parent.versionId)
      throw new Error('Некорректная ожидающая версия');
    pending = { ...p, envelope, pin, parent };
  }
  return { ...row, acceptedPin, pending };
}
export function withSnapshotFileState(settings, provider, row) {
  const map =
    settings.cloudSnapshotFiles === undefined ? {} : object(settings.cloudSnapshotFiles, [], ['google', 'yandex']);
  const next = { ...settings, cloudSnapshotFiles: { ...map, [provider]: structuredClone(row) } };
  readSnapshotFileState(next, provider, row.datasetId);
  return next;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonical(value[key])])
  );
}
/** Semantic public hash: record declaration order is not a user-visible order. */
export async function snapshotFileHash(snapshot, cryptoSource = globalThis.crypto) {
  publicSnapshotIdentityTypes(snapshot);
  const copy = structuredClone(snapshot);
  for (const section of ['characters', 'parties', 'marathons', 'planner', 'finance'])
    copy.sections[section].records.sort((a, b) => a.id.localeCompare(b.id));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(copy)));
  try {
    const hash = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', bytes));
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}
