// @ts-check
// Local baseline + encrypted pending file. No plaintext public snapshot or key here.
import { object } from './exportSchema.js';
import { isSyncId } from './envelope.js';
import { copyCloudEnvelope, validGoogleId } from './providers/common.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
export const MAX_UNSETTLED_UPLOADS = 32;
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
function pinList(value) {
  if (!Array.isArray(value) || value.length > 127) throw new Error('Некорректные версии файлов');
  const pins = value.map(filePin);
  if (new Set(pins.map(pin => pin.versionId)).size !== pins.length) throw new Error('Повторная версия файла');
  return pins;
}
function receipt(value, provider) {
  const p = object(value, ['pin', 'parent', 'fileId', 'contentHash']);
  const pin = filePin(p.pin),
    parent = filePin(p.parent);
  if (
    pin.versionId === parent.versionId ||
    typeof p.contentHash !== 'string' ||
    !HASH.test(p.contentHash) ||
    (provider === 'google' ? !validGoogleId(p.fileId) : p.fileId !== null)
  )
    throw new Error('Некорректная ожидающая версия');
  return { ...p, pin, parent };
}
export function readSnapshotFileState(settings, provider, datasetId) {
  if (!hasSnapshotFileMode(settings)) return null;
  const map = object(settings.cloudSnapshotFiles, [], ['google', 'yandex']);
  if (!Object.hasOwn(map, provider)) return null;
  const row = object(map[provider], ['version', 'datasetId', 'acceptedPin', 'acceptedHash', 'pending'], ['unsettled']);
  if (
    ![1, 2].includes(row.version) ||
    (row.version === 2) !== Object.hasOwn(row, 'unsettled') ||
    row.datasetId !== datasetId ||
    (row.acceptedPin === null) !== (row.acceptedHash === null)
  )
    throw new Error('Привязка файла изменилась');
  const acceptedPin = row.acceptedPin === null ? null : filePin(row.acceptedPin);
  if (row.acceptedHash !== null && (typeof row.acceptedHash !== 'string' || !HASH.test(row.acceptedHash)))
    throw new Error('Некорректная основа файла');
  let pending = null;
  if (row.pending !== null) {
    const p = object(
      row.pending,
      ['phase', 'envelope', 'pin', 'parent', 'fileId', 'contentHash'],
      ['localHash', 'replacedHeads']
    );
    if (
      !['prepared', 'attempting'].includes(p.phase) ||
      (Object.hasOwn(p, 'localHash') && (typeof p.localHash !== 'string' || !HASH.test(p.localHash)))
    )
      throw new Error('Некорректная ожидающая отправка');
    const checked = receipt({ pin: p.pin, parent: p.parent, fileId: p.fileId, contentHash: p.contentHash }, provider);
    const envelope = copyCloudEnvelope(p.envelope, datasetId);
    if (checked.pin.versionId !== envelope.versionId) throw new Error('Некорректная ожидающая версия');
    const extra = Object.hasOwn(p, 'replacedHeads') ? { replacedHeads: pinList(p.replacedHeads) } : {};
    if (extra.replacedHeads?.some(pin => [checked.pin.versionId, checked.parent.versionId].includes(pin.versionId)))
      throw new Error('Некорректный выбор файла');
    pending = { ...p, ...checked, envelope, ...extra };
  }
  const unsettled = row.version === 2 ? row.unsettled : [];
  if (!Array.isArray(unsettled) || unsettled.length > MAX_UNSETTLED_UPLOADS)
    throw new Error('Слишком много неизвестных попыток');
  const checked = unsettled.map(item => receipt(item, provider));
  if (
    new Set(checked.map(item => item.pin.versionId)).size !== checked.length ||
    checked.some(item => item.pin.versionId === pending?.pin.versionId)
  )
    throw new Error('Повторная неизвестная попытка');
  return { ...row, acceptedPin, pending, ...(row.version === 2 ? { unsettled: checked } : {}) };
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
