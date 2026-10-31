// @ts-check
// Per-action consent only. No secret values in returned metadata or diagnostics.
import { vaultStatus } from '../../core/secrets.js';
import { object, array } from './exportSchema.js';
import { PRIVATE_FIELDS, parsePrivateSnapshot } from './privateSnapshot.js';
export function privateSourceAvailable(snapshot) {
  const vault = vaultStatus();
  return !vault.blocked && (!snapshot.settings.security.useVault || (vault.checked && vault.ready));
}
export function privateConsent(input, fields) {
  return (
    Array.isArray(fields) &&
    fields.length > 0 &&
    new Set(fields).size === fields.length &&
    fields.every(field => PRIVATE_FIELDS.includes(field)) &&
    input.contactsSourceConfirmed === true &&
    (!fields.includes('password') || input.acknowledgePasswordRisk === true)
  );
}
export function privatePairs(value, allowed) {
  const pairs = array(value, row => object(row, ['characterId', 'field']));
  if (
    !pairs.length ||
    new Set(pairs.map(row => JSON.stringify([row.characterId, row.field]))).size !== pairs.length ||
    pairs.some(
      row =>
        !allowed.some(
          item => item.characterId === row.characterId && item.field === row.field && item.selectable !== false
        )
    )
  )
    throw new Error('Не подтверждён выбор контактов');
  return pairs;
}
export function selectPrivateDelta(delta, publicSnapshot, selections) {
  const rows = new Map();
  for (const { characterId, field } of selections) {
    const source = delta.records.find(row => row.characterId === characterId);
    if (!source || !Object.hasOwn(source.fields, field)) throw new Error('Не подтверждён выбор контактов');
    if (!rows.has(characterId)) rows.set(characterId, { characterId, fields: {} });
    rows.get(characterId).fields[field] = source.fields[field];
  }
  return parsePrivateSnapshot({ schemaVersion: 1, records: [...rows.values()] }, publicSnapshot);
}
export function prunePrivateSnapshot(prior, publicSnapshot) {
  if (!prior) return { snapshot: null, ids: [] };
  const ids = new Set(publicSnapshot.sections.characters.records.map(row => row.id));
  const records = prior.records.filter(row => ids.has(row.characterId));
  return {
    snapshot: records.length ? parsePrivateSnapshot({ schemaVersion: 1, records }, publicSnapshot) : null,
    ids: prior.records
      .filter(row => !ids.has(row.characterId))
      .map(row => row.characterId)
      .sort()
  };
}
