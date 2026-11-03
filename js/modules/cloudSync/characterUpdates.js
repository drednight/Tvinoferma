import { latestCoinCheck } from './coinCheckPolicy.js';
import { sameJsonValue as same } from './valueEquality.js';
import { exportCharacter } from './characterExport.js';
import { parsePrivateSnapshot } from './privateSnapshot.js';
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
export function characterUpdateReview(localState, cloud, account, privateSnapshot = null) {
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
  const privateRows = privateSnapshot ? parsePrivateSnapshot(privateSnapshot, cloud).records : [];
  const privateById = new Map(privateRows.map(r => [r.characterId, r]));
  const originals = allCharacters(localState),
    originalById = new Map(originals.map(c => [c.id, c]));
  const byName = new Map();
  for (const c of originals) {
    const key = JSON.stringify([name(c.nick), c.class]);
    const rows = byName.get(key) || [];
    rows.push(c);
    byName.set(key, rows);
  }
  const partySyncIds = new Map([...localState.parties, ...localState.archivedParties].map(p => [p.id, p.syncId]));
  const extraLabels = {
    partyIds: 'Состав групп',
    mainPartyId: 'Главная группа',
    partyOrder: 'Порядок в группах',
    statsHistory: 'История характеристик',
    coinHistory: 'История монет',
    marathonData: 'Марафоны',
    coinsParserV: 'Версия проверки монет',
    createdAt: 'Дата создания',
    updatedAt: 'Дата изменения'
  };
  // Keep values confined to this call. Only identity decisions/field names leave it.
  const recordIds = new Set(cloud.sections.characters.records.map(c => c.id));
  const candidateIds = c => {
    const row = privateById.get(c.id);
    if (!row) return [];
    const populated = Object.entries(row.fields).filter(([, v]) => v !== '');
    if (!populated.some(([k]) => ['email', 'recoveryEmail', 'phone'].includes(k))) return [];
    return (byName.get(JSON.stringify([name(c.fields.nick), c.fields.class])) || [])
      .filter(
        l =>
          name(l.nick) === name(c.fields.nick) &&
          l.class === c.fields.class &&
          (!l.syncId || l.syncId === c.id || !recordIds.has(l.syncId)) &&
          populated.every(([k, v]) => l.contacts?.[k] === v)
      )
      .map(l => l.id);
  };
  const records = cloud.sections.characters.records;
  const candidatesByCloud = new Map(records.map(c => [c.id, candidateIds(c)])),
    candidateUse = new Map();
  for (const ids of candidatesByCloud.values())
    for (const id of ids) candidateUse.set(id, (candidateUse.get(id) || 0) + 1);
  return {
    locals,
    records: records.map(c => {
      const remembered = matches.find(m => m.cloudId === c.id && locals.some(l => l.id === m.localId));
      const identity = locals.filter(l => l.syncId === c.id),
        candidates = candidatesByCloud.get(c.id);
      const contactMatch = candidates.length === 1 && candidateUse.get(candidates[0]) === 1 ? candidates[0] : '';
      const matchedLocalId =
        identity.length === 1 ? identity[0].id : identity.length > 1 ? '' : remembered?.localId || contactMatch;
      const local = originalById.get(matchedLocalId);
      const row = privateById.get(c.id);
      const privateFields = row ? Object.keys(row.fields) : [];
      const privateEqual = !row || (local && privateFields.every(k => local.contacts?.[k] === row.fields[k]));
      let publicEqual = false,
        otherPublicDifferences = [];
      if (local) {
        try {
          // An in-memory comparison projection only; never assigns/repairs stored IDs.
          const projected = exportCharacter(
            { ...local, syncId: c.id },
            { syncId: c.id, partySyncIds, archived: localState.archivedCharacters.includes(local) }
          );
          const effective = structuredClone(c);
          effective.fields.lastCoinUpdate = latestCoinCheck(local.lastCoinUpdate, c.fields.lastCoinUpdate);
          publicEqual = same(projected, effective);
          otherPublicDifferences = Object.entries(extraLabels)
            .filter(([key]) => !same(projected.fields[key], c.fields[key]))
            .map(([, label]) => label);
          if (projected.archived !== c.archived) otherPublicDifferences.push('Архивность');
        } catch {
          otherPublicDifferences = ['Привязки или дополнительные данные требуют общей сверки'];
        }
      }
      return {
        id: c.id,
        nick: c.fields.nick,
        archived: c.archived,
        fields: fields(c.fields),
        matchedLocalId,
        matchReason: identity.length === 1 ? 'identity' : remembered ? 'remembered' : contactMatch ? 'contacts' : null,
        identical: publicEqual && !!privateEqual,
        otherPublicDifferences,
        privateFields,
        privateEqual: !!privateEqual,
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
    const selected = choice.fields.filter(k => k !== 'lastCoinUpdate' && !same(local[k], remote.fields[k]));
    const lastCheck = latestCoinCheck(local.lastCoinUpdate, remote.fields.lastCoinUpdate);
    if (!same(local.lastCoinUpdate, lastCheck)) {
      local.lastCoinUpdate = lastCheck;
      selected.push('lastCoinUpdate');
    }
    for (const key of selected) if (key !== 'lastCoinUpdate') local[key] = structuredClone(remote.fields[key]);
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
