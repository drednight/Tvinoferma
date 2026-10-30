// @ts-check
// Private transfer is MANUAL per batch, never a remembered auto-export policy.
// Values may exist only inside encrypted history/queue or guarded local state.
// Do not log inputs, results, IDs, field values or original errors.
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { array, object, text } from './exportSchema.js';

export const PRIVATE_FIELDS = Object.freeze(['email', 'recoveryEmail', 'phone', 'password']);
function invalid() {
  return new Error('Не удалось безопасно подготовить передачу контактов');
}
export function parsePrivateSnapshot(value, publicSnapshot) {
  validateJsonSnapshot(value);
  const root = object(value, ['schemaVersion', 'records']);
  if (root.schemaVersion !== 1) throw invalid();
  const ids = publicSnapshotIdentityTypes(publicSnapshot);
  const seen = new Set();
  const records = array(root.records, item => {
    const row = object(item, ['characterId', 'fields']);
    if (!isSyncId(row.characterId) || seen.has(row.characterId) || ids.get(row.characterId) !== 'characters:character')
      throw invalid();
    seen.add(row.characterId);
    const fields = object(row.fields, [], [...PRIVATE_FIELDS]);
    const keys = PRIVATE_FIELDS.filter(key => Object.hasOwn(fields, key));
    if (!keys.length) throw invalid();
    return {
      characterId: row.characterId,
      fields: Object.fromEntries(
        keys.map(key => {
          const value = text(fields[key]);
          if (value.length > 100_000) throw invalid();
          return [key, value];
        })
      )
    };
  });
  if (!records.length || records.length > 10_000) throw invalid();
  return { schemaVersion: 1, records: records.sort((a, b) => a.characterId.localeCompare(b.characterId)) };
}
export function mergePrivateSnapshots(prior, delta, publicSnapshot) {
  if (!prior && !delta) return null;
  const rows = new Map(
    (prior ? parsePrivateSnapshot(prior, publicSnapshot).records : []).map(row => [row.characterId, row])
  );
  if (delta)
    for (const row of parsePrivateSnapshot(delta, publicSnapshot).records) {
      const old = rows.get(row.characterId);
      rows.set(row.characterId, { characterId: row.characterId, fields: { ...old?.fields, ...row.fields } });
    }
  return parsePrivateSnapshot({ schemaVersion: 1, records: [...rows.values()] }, publicSnapshot);
}
export function buildPrivateDelta(snapshot, publicSnapshot, fields) {
  const chosen = array(fields, key => {
    if (!PRIVATE_FIELDS.includes(key)) throw invalid();
    return key;
  });
  if (!chosen.length || new Set(chosen).size !== chosen.length) throw invalid();
  return parsePrivateSnapshot(
    {
      schemaVersion: 1,
      records: [...snapshot.characters, ...snapshot.archivedCharacters].map(char => ({
        characterId: char.syncId,
        fields: Object.fromEntries(chosen.map(key => [key, text(object(char.contacts, [...PRIVATE_FIELDS])[key])]))
      }))
    },
    publicSnapshot
  );
}
export function privateDifferences(value, publicSnapshot, localState, fields) {
  validateJsonSnapshot(localState);
  buildPublicSnapshot(localState, { settingsSelections: publicSnapshot.sections.preferences.selections });
  const permitted = new Set(
    array(fields, key => {
      if (!PRIVATE_FIELDS.includes(key)) throw invalid();
      return key;
    })
  );
  const local = new Map([...localState.characters, ...localState.archivedCharacters].map(row => [row.syncId, row]));
  if (!value) return [];
  const result = [];
  for (const row of parsePrivateSnapshot(value, publicSnapshot).records) {
    const char = local.get(row.characterId);
    for (const field of PRIVATE_FIELDS) {
      if (!permitted.has(field) || !Object.hasOwn(row.fields, field)) continue;
      const incoming = row.fields[field];
      const current = char ? text(object(char.contacts, [...PRIVATE_FIELDS])[field]) : null;
      if (current === incoming) continue;
      result.push({
        characterId: row.characterId,
        field,
        label: char?.nick || 'Персонаж отсутствует на этом ПК',
        selectable: !!char,
        clears: incoming === '',
        localPresent: current !== null && current !== '',
        cloudPresent: incoming !== ''
      });
    }
  }
  return result;
}
export function applyPrivateSelection(value, publicSnapshot, localState, selections) {
  validateJsonSnapshot(localState);
  buildPublicSnapshot(localState, { settingsSelections: publicSnapshot.sections.preferences.selections });
  const candidate = structuredClone(localState);
  const local = new Map([...candidate.characters, ...candidate.archivedCharacters].map(row => [row.syncId, row]));
  const source = new Map(parsePrivateSnapshot(value, publicSnapshot).records.map(row => [row.characterId, row.fields]));
  const seen = new Set();
  const selected = array(selections, item => object(item, ['characterId', 'field']));
  if (!selected.length) throw invalid();
  for (const row of selected) {
    const key = JSON.stringify([row.characterId, row.field]);
    const target = local.get(row.characterId);
    const incoming = source.get(row.characterId);
    if (
      seen.has(key) ||
      !PRIVATE_FIELDS.includes(row.field) ||
      !target ||
      !incoming ||
      !Object.hasOwn(incoming, row.field)
    )
      throw invalid();
    seen.add(key);
    object(target.contacts, [...PRIVATE_FIELDS]);
    target.contacts[row.field] = incoming[row.field];
  }
  return candidate;
}

// Absence is never a private-field deletion. Clearing is an explicitly present
// empty string, and is separately warned/selected in the manual UI.
export function retainsPrivateFields(before, after) {
  if (!before) return true;
  if (!after) return false;
  const next = new Map(after.records.map(row => [row.characterId, row.fields]));
  return before.records.every(row => {
    const fields = next.get(row.characterId);
    return !!fields && Object.keys(row.fields).every(key => Object.hasOwn(fields, key));
  });
}
