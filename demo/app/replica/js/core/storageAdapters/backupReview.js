// @ts-check
// A review is a temporary in-memory token tied to the adapter, exact backup name
// and values it inspected. It is not a cross-process lock or a durable backup.
// Raw browser witnesses can contain passwords; never log or serialize them.

const REVIEW_FIELDS = [
  'schemaVersion',
  'characters',
  'archivedCharacters',
  'plannerEntries',
  'vaultReference',
  'currentState'
];
const VAULT_REFERENCES = new Set(['os-referenced', 'not-marked', 'unknown']);
const CURRENT_STATES = new Set(['readable', 'damaged', 'missing']);

function invalidReview() {
  return new Error('Не удалось проверить выбранную копию; обновите список и попробуйте снова');
}

function field(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalidReview();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalidReview();
  return descriptor.value;
}

function optionalCount(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalidReview();
  return value;
}

/** Validate the response without retaining arbitrary data or invoking getters. */
export function readBackupSummary(response) {
  const result = {
    schemaVersion: optionalCount(field(response, 'schemaVersion')),
    characters: optionalCount(field(response, 'characters')),
    archivedCharacters: optionalCount(field(response, 'archivedCharacters')),
    plannerEntries: optionalCount(field(response, 'plannerEntries')),
    vaultReference: field(response, 'vaultReference'),
    currentState: field(response, 'currentState')
  };
  if (!VAULT_REFERENCES.has(result.vaultReference) || !CURRENT_STATES.has(result.currentState)) throw invalidReview();
  return result;
}

/** Metadata only; absent markers do not prove that the OS vault contains no contacts. */
export function describeBrowserBackup(parsed, currentRaw) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidReview();
  const rawVersion = parsed.schemaVersion ?? parsed.version;
  let version = null;
  if (rawVersion == null) version = 1;
  else if (typeof rawVersion === 'number' || typeof rawVersion === 'string') {
    const number = Number(rawVersion);
    version = Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 1;
  }
  const count = value => (Array.isArray(value) ? value.length : null);
  const vault = parsed.secretsInVault;
  let currentState = 'missing';
  if (currentRaw !== null) {
    currentState = 'damaged';
    try {
      const current = JSON.parse(currentRaw);
      if (current && typeof current === 'object' && !Array.isArray(current)) currentState = 'readable';
    } catch {
      // A damaged current state can still be preserved and recovered from a backup.
    }
  }
  return readBackupSummary({
    schemaVersion: version,
    characters: count(parsed.characters),
    archivedCharacters: count(parsed.archivedCharacters),
    plannerEntries: count(parsed.plannerEntries),
    vaultReference:
      vault === true
        ? 'os-referenced'
        : !Object.hasOwn(parsed, 'secretsInVault') || vault === false
          ? 'not-marked'
          : 'unknown',
    currentState
  });
}

/** One-use, non-enumerable witness owned by exactly one adapter. */
export function createBackupReviewStore() {
  const witnesses = new WeakMap();
  return {
    remember(name, summary, witness) {
      if (typeof name !== 'string' || !name || witness == null) throw invalidReview();
      const checked = readBackupSummary(summary);
      const result = Object.freeze(Object.fromEntries(REVIEW_FIELDS.map(key => [key, checked[key]])));
      witnesses.set(result, { name, witness });
      return result;
    },
    take(name, review) {
      if (!review || typeof review !== 'object') throw invalidReview();
      const stored = witnesses.get(review);
      if (!stored || stored.name !== name) throw invalidReview();
      witnesses.delete(review);
      return stored.witness;
    },
    forget(review) {
      if (review && typeof review === 'object') witnesses.delete(review);
    }
  };
}
