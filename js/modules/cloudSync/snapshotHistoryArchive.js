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
  MAX_HISTORY_CHARS
} from './history.js';
const FORMAT = 'tvinoferma-encrypted-history-archive';
export const MAX_HISTORY_ARCHIVE_BYTES = MAX_HISTORY_CHARS + 256 * 1024;
const fail = () => new Error('Не удалось проверить зашифрованный архив истории');
const cryptoApi = source => source || globalThis.crypto;
async function digest(text, source) {
  return [...new Uint8Array(await cryptoApi(source).subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}
export function historyCapacity(envelopes) {
  if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > MAX_HISTORY_VERSIONS) throw fail();
  const ciphertextChars = envelopes.reduce(
    (sum, e) => sum + e.ciphertext.length + e.iv.length + (e.keyCapsule?.length || 0),
    0
  );
  if (!envelopes.length || envelopes.length > MAX_HISTORY_VERSIONS || ciphertextChars > MAX_HISTORY_CHARS) throw fail();
  return Object.freeze({
    versions: envelopes.length,
    maxVersions: MAX_HISTORY_VERSIONS,
    ciphertextChars,
    maxCiphertextChars: MAX_HISTORY_CHARS,
    remainingVersions: MAX_HISTORY_VERSIONS - envelopes.length,
    nearLimit: envelopes.length >= 96 || ciphertextChars >= MAX_HISTORY_CHARS * 0.75,
    protectedVersions: envelopes.length,
    deletableVersions: 0
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
  if (!Array.isArray(data.envelopes) || data.envelopes.length > MAX_HISTORY_VERSIONS) throw fail();
  const envelopes = array(data.envelopes, e => copyCloudEnvelope(e, code.datasetId));
  historyCapacity(envelopes);
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
export async function verifyEncryptedHistoryArchive(options) {
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
      status: 'archive_verified',
      sha256,
      capacity: historyCapacity(data.envelopes),
      heads: Object.freeze(history.observedHeads().map(pin => Object.freeze(pin)))
    });
  } catch {
    throw fail();
  }
}
