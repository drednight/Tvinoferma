// Local portable contact file. The random recovery key is NEVER included in the file.
// Existing authenticated envelope only: no passwords, cloud, persistence or auto-apply.
import {
  encryptSnapshot,
  decryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../modules/cloudSync/envelope.js';
import { array, boolean, object, text } from '../modules/cloudSync/exportSchema.js';

const FORMAT = 'tvinoferma-contact-backup';
const MAX_ROWS = 5000;
export const MAX_CONTACT_FILE_BYTES = 8 * 1024 * 1024;
const fields = ['email', 'password', 'recoveryEmail', 'phone'];
const invalid = () => new Error('Некорректная или неподдерживаемая копия контактов');

function bounded(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw invalid();
  return value;
}

/** Validate a complete, versioned snapshot before encryption and after decryption. */
export function validateContactSnapshot(input) {
  try {
    const snapshot = object(input, ['format', 'version', 'createdAt', 'characters']);
    if (
      snapshot.format !== FORMAT ||
      snapshot.version !== 1 ||
      typeof snapshot.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.createdAt))
    )
      throw invalid();
    const ids = new Set();
    const characters = array(snapshot.characters, value => {
      const row = object(value, ['id', 'nick', 'archived', 'contacts']);
      const id = bounded(text(row.id), 256, true);
      const identity = id.toLowerCase();
      if (ids.has(identity)) throw invalid();
      ids.add(identity);
      const contacts = object(row.contacts, fields);
      return {
        id,
        nick: bounded(text(row.nick), 256),
        archived: boolean(row.archived),
        contacts: Object.fromEntries(fields.map(field => [field, bounded(text(contacts[field]), 65536)]))
      };
    });
    if (!characters.length || characters.length > MAX_ROWS) throw invalid();
    return { format: FORMAT, version: 1, createdAt: snapshot.createdAt, characters };
  } catch {
    throw invalid();
  }
}

export function contactSnapshotFromState(snapshot, at = new Date().toISOString()) {
  if (!Array.isArray(snapshot?.characters) || !Array.isArray(snapshot?.archivedCharacters)) throw invalid();
  const rows = (list, archived) =>
    list.map(c => ({
      id: c.id,
      nick: c.nick,
      archived,
      contacts: Object.fromEntries(fields.map(field => [field, c.contacts?.[field]]))
    }));
  return validateContactSnapshot({
    format: FORMAT,
    version: 1,
    createdAt: at,
    characters: [...rows(snapshot.characters, false), ...rows(snapshot.archivedCharacters, true)]
  });
}

/** Returns a secret key separately from the encrypted file; neither is stored here. */
export async function encryptContactFile(snapshot, cryptoSource) {
  const data = validateContactSnapshot(snapshot);
  const recoveryKey = generateRecoveryKey(cryptoSource);
  const datasetId = generateSyncId(cryptoSource);
  const envelope = await encryptSnapshot({
    snapshot: data,
    recoveryKey,
    datasetId,
    versionId: generateSyncId(cryptoSource),
    cryptoSource
  });
  const file = JSON.stringify({ format: FORMAT, version: 1, envelope });
  if (new TextEncoder().encode(file).byteLength > MAX_CONTACT_FILE_BYTES) throw invalid();
  // Detect implementation/format problems before offering the file. This does not verify a saved file.
  const check = await decryptContactFile(file, recoveryKey, cryptoSource);
  if (JSON.stringify(check) !== JSON.stringify(data)) throw invalid();
  return { file, recoveryKey, count: data.characters.length };
}

/** Authenticates/decrypts in memory only. Never modifies application state or vault. */
export async function decryptContactFile(file, recoveryKey, cryptoSource) {
  try {
    if (
      typeof file !== 'string' ||
      file.length > MAX_CONTACT_FILE_BYTES ||
      new TextEncoder().encode(file).byteLength > MAX_CONTACT_FILE_BYTES
    )
      throw invalid();
    const parsed = object(JSON.parse(file), ['format', 'version', 'envelope']);
    if (parsed.format !== FORMAT || parsed.version !== 1) throw invalid();
    const envelope = object(parsed.envelope, [
      'format',
      'version',
      'algorithm',
      'datasetId',
      'versionId',
      'iv',
      'ciphertext'
    ]);
    const snapshot = await decryptSnapshot({
      envelope,
      recoveryKey,
      expectedDatasetId: envelope.datasetId,
      cryptoSource
    });
    return validateContactSnapshot(snapshot);
  } catch {
    throw new Error('Не удалось открыть копию: неверный ключ, повреждённый или неподдерживаемый файл');
  }
}
