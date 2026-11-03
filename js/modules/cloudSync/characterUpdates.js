// Explicit, non-deleting character reconciliation. Not a full snapshot merge.
// Does not rewrite syncIds, local IDs, memberships, launcher settings or vault.
import { normalizeState } from '../../core/state.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { isSyncId, validateJsonSnapshot } from './envelope.js';
export const CHARACTER_UPDATE_FIELDS = Object.freeze({
  nick: 'Ник',
  class: 'Класс',
  level: 'Уровень',
  sky: 'Небо',
  favorite: 'Избранный',
  notes: 'Заметки',
  tags: 'Теги',
  stats: 'Характеристики',
  dungeonPasses: 'Пропуски данжей',
  ancientCoins: 'Древние монеты',
  lastCoinUpdate: 'Дата проверки монет'
});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allCharacters = s => [...s.characters, ...s.archivedCharacters];
function invalid() {
  return new Error('character_update_invalid');
}
function fields(c) {
  return Object.fromEntries(Object.keys(CHARACTER_UPDATE_FIELDS).map(k => [k, structuredClone(c[k])]));
}
export function readCharacterMatches(settings, account) {
  const data = settings.cloudCharacterMatches;
  if (data === undefined) return [];
  validateJsonSnapshot(data);
  if (
    !data ||
    data.version !== 1 ||
    Object.keys(data).sort().join(',') !== 'accounts,version' ||
    !Array.isArray(data.accounts) ||
    data.accounts.length > 16
  )
    throw invalid();
  const accounts = new Set();
  for (const row of data.accounts) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !== 'account,matches' ||
      !/^[a-f0-9]{64}$/.test(row.account) ||
      accounts.has(row.account) ||
      !Array.isArray(row.matches) ||
      row.matches.length > 4096
    )
      throw invalid();
    accounts.add(row.account);
    const remote = new Set(),
      local = new Set();
    for (const m of row.matches) {
      if (
        !m ||
        typeof m !== 'object' ||
        Array.isArray(m) ||
        Object.keys(m).sort().join(',') !== 'cloudId,localId' ||
        typeof m.cloudId !== 'string' ||
        !isSyncId(m.cloudId) ||
        typeof m.localId !== 'string' ||
        !m.localId ||
        m.localId.length > 512 ||
        remote.has(m.cloudId) ||
        local.has(m.localId)
      )
        throw invalid();
      remote.add(m.cloudId);
      local.add(m.localId);
    }
  }
  return structuredClone(data.accounts.find(row => row.account === account)?.matches || []);
}
export function characterUpdateReview(localState, cloud, account) {
  publicSnapshotIdentityTypes(cloud);
  const matches = readCharacterMatches(localState.settings, account);
  const locals = allCharacters(localState).map(c => ({
    id: c.id,
    syncId: c.syncId || null,
    nick: c.nick,
    archived: localState.archivedCharacters.includes(c),
    fields: fields(c)
  }));
  if (new Set(locals.map(c => c.id)).size !== locals.length) throw invalid();
  const name = s => String(s).trim().toLocaleLowerCase('ru');
  return {
    locals,
    records: cloud.sections.characters.records.map(c => {
      const remembered = matches.find(m => m.cloudId === c.id && locals.some(l => l.id === m.localId));
      const identity = locals.filter(l => l.syncId === c.id);
      return {
        id: c.id,
        nick: c.fields.nick,
        archived: c.archived,
        fields: fields(c.fields),
        matchedLocalId: identity.length === 1 ? identity[0].id : identity.length > 1 ? '' : remembered?.localId || '',
        suggestedLocalIds: locals.filter(l => name(l.nick) === name(c.fields.nick)).map(l => l.id)
      };
    })
  };
}
export function prepareCharacterUpdates({ localState, cloud, account, selections }) {
  validateJsonSnapshot(localState);
  const view = characterUpdateReview(localState, cloud, account);
  if (!Array.isArray(selections) || !selections.length || selections.length > 4096) throw invalid();
  validateJsonSnapshot({ selections });
  const candidate = structuredClone(localState),
    usedLocal = new Set(),
    usedCloud = new Set(),
    changes = [];
  let saved = readCharacterMatches(localState.settings, account);
  for (const choice of selections) {
    if (
      !choice ||
      Object.keys(choice).sort().join(',') !== 'cloudId,fields,localId' ||
      !Array.isArray(choice.fields) ||
      new Set(choice.fields).size !== choice.fields.length ||
      choice.fields.some(k => !own(CHARACTER_UPDATE_FIELDS, k)) ||
      usedLocal.has(choice.localId) ||
      usedCloud.has(choice.cloudId)
    )
      throw invalid();
    const remote = view.records.find(c => c.id === choice.cloudId),
      local = allCharacters(candidate).find(c => c.id === choice.localId);
    if (!local || !remote) throw invalid();
    // A strong existing syncId may never be reassigned to a different local row.
    const identities = view.locals.filter(c => c.syncId === choice.cloudId);
    if (identities.length > 1 || (identities.length === 1 && identities[0].id !== local.id)) throw invalid();
    usedLocal.add(local.id);
    usedCloud.add(remote.id);
    // Matching never archives/restores a character or changes party membership.
    const selected = choice.fields.filter(k => !same(local[k], remote.fields[k]));
    for (const key of selected) local[key] = structuredClone(remote.fields[key]);
    changes.push({ cloudId: remote.id, localId: local.id, fields: selected });
    saved = saved.filter(m => m.cloudId !== remote.id && m.localId !== local.id);
    saved.push({ cloudId: remote.id, localId: local.id });
  }
  const prior = localState.settings.cloudCharacterMatches || { version: 1, accounts: [] };
  candidate.settings.cloudCharacterMatches = {
    version: 1,
    accounts: [...prior.accounts.filter(row => row.account !== account), { account, matches: saved }]
  };
  readCharacterMatches(candidate.settings, account);
  // Do not weaken normalization checks: selected public values must survive reload.
  // Unrelated sections are not materialized or repaired (including duplicate parties).
  const normalized = normalizeState(candidate);
  if (!same(readCharacterMatches(normalized.settings, account), readCharacterMatches(candidate.settings, account)))
    throw invalid();
  for (const change of changes) {
    const expected = allCharacters(candidate).find(c => c.id === change.localId);
    const reloaded = allCharacters(normalized).find(c => c.id === change.localId);
    if (!reloaded || change.fields.some(k => !same(expected[k], reloaded[k]))) throw invalid();
    for (const key of ['id', 'syncId', 'launch', 'contacts', 'partyIds', 'mainPartyId', 'isLoggedIn']) {
      const before = allCharacters(localState).find(c => c.id === change.localId);
      if (!same(before[key], expected[key]) || !same(expected[key], reloaded[key])) throw invalid();
    }
  }
  validateJsonSnapshot(candidate);
  return { candidate, changes };
}
