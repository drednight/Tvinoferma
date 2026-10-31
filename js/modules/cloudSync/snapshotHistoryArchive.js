// @ts-check
// Offline encrypted history backup. This is NOT a key backup or permission to delete parents.
import { filePin } from './snapshotFileState.js';
import { object, array } from './exportSchema.js';
import { copyCloudEnvelope } from './providers/common.js';
import { createPairingCode, parsePairingCode } from './pairingCode.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';
import {
  isVerifiedHistory,
  historyEnvelopePin,
  verifyHistory,
  MAX_HISTORY_VERSIONS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_INPUT_VERSIONS,
  MAX_HISTORY_INPUT_CHARS
} from './history.js';
const FORMAT = 'tvinoferma-encrypted-history-archive';
export const MAX_HISTORY_ARCHIVE_BYTES = MAX_HISTORY_INPUT_CHARS + 256 * 1024;
const fail = () => new Error('Не удалось проверить зашифрованный архив истории');
const cryptoApi = source => source || globalThis.crypto;
async function digest(text, source) {
  return [...new Uint8Array(await cryptoApi(source).subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}
export function historyCapacity(envelopes, history = null) {
  if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > MAX_HISTORY_INPUT_VERSIONS) throw fail();
  if (history && !isVerifiedHistory(history)) throw fail();
  if (history) {
    const ids = new Set(history.pins().map(p => p.versionId));
    if (
      ids.size !== envelopes.length ||
      new Set(envelopes.map(e => e.versionId)).size !== ids.size ||
      envelopes.some(e => !ids.has(e.versionId))
    )
      throw fail();
  }
  const retired = new Set(history ? history.retiredPins().map(p => p.versionId) : []),
    active = envelopes.filter(e => !retired.has(e.versionId));
  const ciphertextChars = active.reduce(
    (sum, e) => sum + e.ciphertext.length + e.iv.length + (e.keyCapsule?.length || 0),
    0
  );
  if (active.length > MAX_HISTORY_VERSIONS || ciphertextChars > MAX_HISTORY_CHARS) throw fail();
  const heads = history?.observedHeads() || [],
    canRetire = heads.length === 1 && history.checkpoint(heads[0]) !== null,
    retiredVersions = envelopes.length - active.length;
  return Object.freeze({
    retiredVersions,
    versions: active.length,
    storedVersions: envelopes.length,
    maxVersions: MAX_HISTORY_VERSIONS,
    ciphertextChars,
    maxCiphertextChars: MAX_HISTORY_CHARS,
    remainingVersions: MAX_HISTORY_VERSIONS - active.length,
    nearLimit: active.length >= 96 || ciphertextChars >= MAX_HISTORY_CHARS * 0.75,
    protectedVersions: canRetire ? active.length : envelopes.length,
    deletableVersions: canRetire ? retiredVersions : 0
  });
}
function body(value) {
  const data = object(value, ['format', 'version', 'provider', 'createdAt', 'pairingCode', 'envelopes']);
  if (
    data.format !== FORMAT ||
    data.version !== 1 ||
    !['google', 'yandex'].includes(data.provider) ||
    typeof data.createdAt !== 'string' ||
    parseCloudModifiedTime(data.createdAt) !== data.createdAt
  )
    throw fail();
  const code = parsePairingCode(data.pairingCode);
  if (!Array.isArray(data.envelopes) || data.envelopes.length > MAX_HISTORY_INPUT_VERSIONS) throw fail();
  const envelopes = array(data.envelopes, e => copyCloudEnvelope(e, code.datasetId));
  if (
    !envelopes.length ||
    envelopes.reduce((sum, e) => sum + e.ciphertext.length + e.iv.length + (e.keyCapsule?.length || 0), 0) >
      MAX_HISTORY_INPUT_CHARS
  )
    throw fail();
  if (new Set(envelopes.map(e => e.versionId)).size !== envelopes.length) throw fail();
  envelopes.sort((a, b) => a.versionId.localeCompare(b.versionId));
  return {
    format: FORMAT,
    version: 1,
    provider: data.provider,
    createdAt: data.createdAt,
    pairingCode: createPairingCode({ datasetId: code.datasetId, keyPin: code.keyPin, rootPin: code.rootPin }),
    envelopes
  };
}
/** Only an already verified complete history can be archived. No state, key, tokens or local contacts. */
export async function createEncryptedHistoryArchive(options) {
  try {
    const input = object(options, ['provider', 'history', 'envelopes', 'keyPin'], ['createdAt', 'cryptoSource']);
    if (!isVerifiedHistory(input.history)) throw fail();
    const identity = input.history.identity();
    // Copy before await; do not allow replacement of encrypted bytes after approval.
    const data = body({
      format: FORMAT,
      version: 1,
      provider: input.provider,
      createdAt: input.createdAt ?? new Date().toISOString(),
      pairingCode: createPairingCode({
        datasetId: identity.datasetId,
        rootPin: identity.rootPin,
        keyPin: input.keyPin
      }),
      envelopes: input.envelopes
    });
    const pins = input.history.pins();
    if (pins.length !== data.envelopes.length) throw fail();
    for (const envelope of data.envelopes) {
      const pin = await historyEnvelopePin({
        envelope,
        expectedDatasetId: identity.datasetId,
        cryptoSource: input.cryptoSource
      });
      input.history.requirePin(pin);
    }
    const sha256 = await digest(JSON.stringify(data), input.cryptoSource),
      text = JSON.stringify({ ...data, sha256 });
    if (new TextEncoder().encode(text).byteLength > MAX_HISTORY_ARCHIVE_BYTES) throw fail();
    return Object.freeze({
      text,
      sha256,
      bytes: new TextEncoder().encode(text).byteLength,
      fileName: `tvinoferma-${input.provider}-${identity.datasetId}-${data.createdAt.replaceAll(':', '-')}.tf-history.json`
    });
  } catch {
    throw fail();
  }
}
/** Validates against independently trusted pairing code + dataKey, never the file's own claim of trust. */
export async function readEncryptedHistoryArchive(options) {
  try {
    const input = object(
      options,
      ['text', 'provider', 'expectedPairingCode', 'recoveryKey', 'knownPins'],
      ['cryptoSource']
    );
    if (
      typeof input.text !== 'string' ||
      input.text.length > MAX_HISTORY_ARCHIVE_BYTES ||
      new TextEncoder().encode(input.text).byteLength > MAX_HISTORY_ARCHIVE_BYTES
    )
      throw fail();
    const knownPins = array(input.knownPins, filePin);
    const raw = object(JSON.parse(input.text), [
      'format',
      'version',
      'provider',
      'createdAt',
      'pairingCode',
      'envelopes',
      'sha256'
    ]);
    const { sha256, ...rest } = raw,
      data = body(rest),
      expected = parsePairingCode(input.expectedPairingCode);
    if (
      data.provider !== input.provider ||
      data.pairingCode !==
        createPairingCode({ datasetId: expected.datasetId, rootPin: expected.rootPin, keyPin: expected.keyPin }) ||
      sha256 !== (await digest(JSON.stringify(data), input.cryptoSource))
    )
      throw fail();
    const history = await verifyHistory({
      envelopes: data.envelopes,
      expectedDatasetId: expected.datasetId,
      root: expected.rootPin,
      knownPins,
      recoveryKey: input.recoveryKey,
      cryptoSource: input.cryptoSource
    });
    return Object.freeze({
      history,
      envelopes: data.envelopes,
      status: 'archive_verified',
      sha256,
      capacity: historyCapacity(data.envelopes, history),
      heads: Object.freeze(history.observedHeads().map(pin => Object.freeze(pin)))
    });
  } catch {
    throw fail();
  }
}

/** Verification UI receives no decrypted snapshots or secrets. */
export async function verifyEncryptedHistoryArchive(options) {
  const opened = await readEncryptedHistoryArchive(options);
  return Object.freeze({
    status: opened.status,
    sha256: opened.sha256,
    capacity: opened.capacity,
    heads: opened.heads
  });
}
