import { partyMembers } from './model.js';

// Keep duplicate/ambiguous matches out of the picker; never guess which window owns a character.
export function selectableRecipients(rows) {
  const counts = new Map();
  for (const row of rows) if (row.known && row.charId) counts.set(row.charId, (counts.get(row.charId) || 0) + 1);
  return rows.filter(row => row.known && row.charId && counts.get(row.charId) === 1);
}

// Recommendation is informational only. The user must explicitly choose a party/leader.
export function leaderChoices(state, config, rows) {
  const available = new Set(rows.map(row => row.charId));
  const selected = new Set(
    rows.filter(row => !config.excludedCommandCharacters.includes(row.charId)).map(row => row.charId)
  );
  const options = [];
  for (const party of state.parties || []) {
    const members = partyMembers(state, party.id);
    const leader = config.leaders[party.id];
    for (const char of members.filter(char => available.has(char.id)))
      options.push({
        partyId: party.id,
        partyName: party.name,
        charId: char.id,
        nick: char.nick,
        current: leader === char.id
      });
  }
  const currentParty = (state.parties || []).find(party => party.id === config.partyId);
  const currentChar = (state.characters || []).find(char => char.id === config.leaders[config.partyId]);
  const currentLeader =
    currentParty && currentChar && partyMembers(state, currentParty.id).some(char => char.id === currentChar.id)
      ? { partyName: currentParty.name, nick: currentChar.nick }
      : null;
  return { options, currentLeader, ...leaderSuggestion(options, selected) };
}

export function leaderSuggestion(options, selected) {
  const parties = new Map();
  for (const choice of options) {
    if (!selected.has(choice.charId)) continue;
    const party = parties.get(choice.partyId) || { partyId: choice.partyId, name: choice.partyName, count: 0 };
    party.count++;
    if (choice.current) party.leaderId = choice.charId;
    parties.set(choice.partyId, party);
  }
  const candidates = [...parties.values()].filter(party => party.leaderId);
  const max = Math.max(0, ...candidates.map(candidate => candidate.count));
  const top = candidates.filter(candidate => candidate.count === max);
  return { suggestion: top.length === 1 ? top[0] : null, tie: top.length > 1 };
}
