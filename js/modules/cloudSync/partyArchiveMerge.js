// @ts-check
// Pure, narrow replay of archiveParty/restoreParty using PUBLIC sync IDs.
// This is not deletion support. Callers validate identities before using it.
import { reviewSnapshotDependencies } from './reviewDependencies.js';

const MEMBERSHIP = ['partyIds', 'mainPartyId', 'partyOrder'];
const rows = (snapshot, section) => new Map(snapshot.sections[section].records.map(row => [row.id, row]));
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
function membership(fields) {
  return Object.fromEntries(MEMBERSHIP.map(key => [key, structuredClone(fields[key])]));
}
function moves(before, after) {
  const next = rows(after, 'parties');
  return [...rows(before, 'parties')]
    .filter(([id, row]) => next.has(id) && next.get(id).archived !== row.archived)
    .map(([id]) => id);
}
function ensureMain(f) {
  if (!f.partyIds.includes(f.mainPartyId)) f.mainPartyId = f.partyIds[0] || null;
}

/**
 * Check exact relationship effects of the application's archive/restore action.
 * Return a next snapshot with JUST those proven effects masked for retains().
 * Multiple moves sharing a character are ambiguous without an operation log.
 * @param {any} before @param {any} after
 */
export function checkedPartyArchiveTransition(before, after) {
  const changed = moves(before, after);
  if (!changed.length) return { snapshot: after, moved: changed };
  if (changed.length > 1000) return null;
  if (reviewSnapshotDependencies(before).issues.length || reviewSnapshotDependencies(after).issues.length) return null;
  const originalChars = rows(before, 'characters');
  const originalParties = rows(before, 'parties');
  const expected = structuredClone(before);
  const chars = rows(expected, 'characters');
  const parties = rows(expected, 'parties');
  const nextChars = rows(after, 'characters');
  const nextParties = rows(after, 'parties');
  const affected = new Set();
  for (const id of changed) {
    const party = parties.get(id);
    const links = party.archived
      ? structuredClone(party.fields.memberLinks)
      : [...chars.values()]
          .filter(char => char.fields.partyIds.includes(id))
          .map(char => ({
            characterId: char.id,
            isMain: char.fields.mainPartyId === id,
            order: Object.hasOwn(char.fields.partyOrder, id) ? char.fields.partyOrder[id] : null
          }));
    for (const link of links) {
      if (affected.has(link.characterId) || !chars.has(link.characterId) || !nextChars.has(link.characterId))
        return null;
      affected.add(link.characterId);
      const f = chars.get(link.characterId).fields;
      if (!party.archived) {
        f.partyIds = f.partyIds.filter(value => value !== id);
        delete f.partyOrder[id];
      } else {
        if (!f.partyIds.includes(id)) f.partyIds.push(id);
        if (link.isMain) f.mainPartyId = id;
        if (link.order !== null) f.partyOrder[id] = link.order;
      }
      ensureMain(f);
    }
    if (!equal(nextParties.get(id).fields.memberLinks, party.archived ? [] : links)) return null;
  }
  for (const id of affected)
    if (!equal(membership(chars.get(id).fields), membership(nextChars.get(id).fields))) return null;
  // A new/previously unrelated member must not silently disappear into archive.
  for (const id of changed) {
    for (const char of nextChars.values()) {
      if (
        char.fields.partyIds.includes(id) &&
        !originalChars.get(char.id)?.fields.partyIds.includes(id) &&
        !affected.has(char.id)
      )
        return null;
    }
  }
  const masked = structuredClone(after);
  for (const char of masked.sections.characters.records) {
    if (affected.has(char.id)) Object.assign(char.fields, membership(originalChars.get(char.id).fields));
  }
  for (const party of masked.sections.parties.records) {
    if (changed.includes(party.id))
      party.fields.memberLinks = structuredClone(originalParties.get(party.id).fields.memberLinks);
  }
  return { snapshot: masked, moved: changed };
}

/** Residents keep relative order. Transfers may be appended or normalized by party.order. */
export function partyArchiveOrderTransition(before, after) {
  const next = rows(after, 'parties');
  return ['active', 'archived'].every(bucket => {
    const staying = before.sections.parties.order[bucket].filter(
      id => next.get(id)?.archived === (bucket === 'archived')
    );
    const keep = new Set(staying);
    const order = after.sections.parties.order[bucket];
    if (
      !equal(
        order.filter(id => keep.has(id)),
        staying
      )
    )
      return false;
    return (
      staying.every((id, i) => order[i] === id) ||
      order.every((id, i) => !i || next.get(order[i - 1]).fields.order <= next.get(id).fields.order)
    );
  });
}

/**
 * Mask a coupled relationship group during ordinary field merge, then apply ONE
 * chosen group's exact values. Independent notes/stats/party names still merge.
 * Both snapshots are writable clones. Missing/new members or overlapping groups
 * fail closed; no relationship is inferred from a disappearing ID.
 * @param {any} base @param {any} local @param {any} cloud @param {any} choices
 */
export function preparePartyArchiveGroups(base, local, cloud, choices) {
  const changed = [...new Set([...moves(base, local), ...moves(base, cloud)])];
  if (changed.length > 1000) return null;
  const snapshots = [base, local, cloud];
  const charMaps = snapshots.map(snapshot => rows(snapshot, 'characters'));
  const partyMaps = snapshots.map(snapshot => rows(snapshot, 'parties'));
  const groups = [];
  const conflicts = [];
  const used = new Set();
  for (const id of changed) {
    const affected = new Set();
    for (let i = 0; i < 3; i++) {
      for (const char of charMaps[i].values())
        if (char.fields.partyIds.includes(id) || Object.hasOwn(char.fields.partyOrder, id)) affected.add(char.id);
      for (const link of partyMaps[i].get(id).fields.memberLinks) affected.add(link.characterId);
    }
    if ([...affected].some(charId => used.has(charId) || charMaps.some(map => !map.has(charId)))) return null;
    for (const charId of affected) used.add(charId);
    const views = snapshots.map((_, i) => ({
      archived: partyMaps[i].get(id).archived,
      memberLinks: structuredClone(partyMaps[i].get(id).fields.memberLinks),
      characters: [...affected].map(charId => ({ id: charId, ...membership(charMaps[i].get(charId).fields) }))
    }));
    let chosen;
    if (equal(views[1], views[2]) || equal(views[0], views[2])) chosen = views[1];
    else if (equal(views[0], views[1])) chosen = views[2];
    else {
      if (!choices)
        conflicts.push({ section: 'parties', id, path: ['fields', 'memberLinks'], reason: 'party-archive-membership' });
      chosen = choices?.cloudRecords.some(row => row.section === 'parties' && row.id === id) ? views[2] : views[1];
    }
    groups.push({ id, chosen });
    for (let i = 1; i < 3; i++) {
      partyMaps[i].get(id).archived = views[0].archived;
      partyMaps[i].get(id).fields.memberLinks = structuredClone(views[0].memberLinks);
      for (const char of views[0].characters) Object.assign(charMaps[i].get(char.id).fields, membership(char));
    }
  }
  return {
    conflicts,
    changed: changed.length > 0,
    apply(merged) {
      const parties = rows(merged, 'parties'),
        chars = rows(merged, 'characters');
      for (const { id, chosen } of groups) {
        parties.get(id).archived = chosen.archived;
        parties.get(id).fields.memberLinks = structuredClone(chosen.memberLinks);
        for (const char of chosen.characters) Object.assign(chars.get(char.id).fields, membership(char));
      }
    }
  };
}

/** Same local-first tie breaking and order normalization as applyPublicSnapshot. */
export function mergedPartyArchiveOrder(local, cloud, merged) {
  const parties = rows(merged, 'parties');
  return Object.fromEntries(
    ['active', 'archived'].map(bucket => {
      const ids = [
        ...new Set([
          ...local.sections.parties.order[bucket],
          ...cloud.sections.parties.order[bucket],
          ...parties.keys()
        ])
      ].filter(id => parties.get(id)?.archived === (bucket === 'archived'));
      ids.sort((a, b) => parties.get(a).fields.order - parties.get(b).fields.order);
      return [bucket, ids];
    })
  );
}
