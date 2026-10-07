import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { ensureMainParty, isInParty, setMainParty, setMembership } from '../parties/membership.js';
import { toast } from '../../core/ui.js';

function rollback(previous) {
  state.characters = previous.characters;
  state.archivedCharacters = previous.archivedCharacters;
  state.parties = previous.parties;
  state.archivedParties = previous.archivedParties;
}

function snapshot() {
  return {
    characters: state.characters,
    archivedCharacters: state.archivedCharacters,
    parties: state.parties,
    archivedParties: state.archivedParties
  };
}

async function refreshArchiveViews() {
  const [{ renderCharacters }, { renderParties }] = await Promise.all([
    import('../characters/list.js'),
    import('../parties/index.js')
  ]);
  renderCharacters();
  renderParties();
}

export async function archiveCharacters(ids) {
  const selected = new Set(ids);
  const moving = state.characters.filter(char => selected.has(char.id));
  if (!moving.length) return 0;
  const previous = snapshot();
  state.characters = state.characters.filter(char => !selected.has(char.id));
  state.archivedCharacters = [...state.archivedCharacters, ...moving];
  try {
    await persist();
  } catch (error) {
    rollback(previous);
    throw error;
  }
  await refreshArchiveViews();
  toast(`В архив перемещено персонажей: ${moving.length}`, 'success');
  return moving.length;
}

export async function restoreCharacter(id) {
  const char = state.archivedCharacters.find(item => item.id === id);
  if (!char) return false;
  const previous = snapshot();
  state.archivedCharacters = state.archivedCharacters.filter(item => item.id !== id);
  state.characters = [...state.characters, char];
  try {
    await persist();
  } catch (error) {
    rollback(previous);
    throw error;
  }
  await refreshArchiveViews();
  toast(`Персонаж «${char.nick}» восстановлен`, 'success');
  return true;
}

export async function archiveParty(id) {
  const party = state.parties.find(item => item.id === id);
  if (!party) return false;
  const previous = snapshot();
  const memberLinks = [];
  const detach = char => {
    if (!isInParty(char, id)) return char;
    memberLinks.push({
      characterId: char.id,
      isMain: char.mainPartyId === id,
      order: Number.isFinite(Number(char.partyOrder?.[id])) ? Number(char.partyOrder[id]) : null
    });
    const next = { ...char, partyOrder: { ...(char.partyOrder || {}) } };
    setMembership(next, id, false);
    delete next.partyOrder[id];
    next.updatedAt = new Date().toISOString();
    return next;
  };
  state.characters = state.characters.map(detach);
  state.archivedCharacters = state.archivedCharacters.map(detach);
  state.parties = state.parties.filter(item => item.id !== id);
  state.archivedParties = [...state.archivedParties, { ...party, memberLinks }];
  try {
    await persist();
  } catch (error) {
    rollback(previous);
    throw error;
  }
  await refreshArchiveViews();
  toast(`Пати «${party.name}» перемещена в архив`, 'success');
  return true;
}

export async function restoreParty(id) {
  const party = state.archivedParties.find(item => item.id === id);
  if (!party) return false;
  if (state.parties.some(item => item.name.trim().toLowerCase() === party.name.trim().toLowerCase())) {
    throw new Error(`Пати с названием «${party.name}» уже есть. Сначала переименуйте активную пати.`);
  }
  const previous = snapshot();
  const links = new Map((party.memberLinks || []).map(link => [link.characterId, link]));
  const restoreMembership = char => {
    const link = links.get(char.id);
    if (!link) return char;
    const next = { ...char, partyOrder: { ...(char.partyOrder || {}) } };
    setMembership(next, id, true);
    if (link.isMain) setMainParty(next, id);
    if (link.order !== null && link.order !== undefined) next.partyOrder[id] = link.order;
    next.updatedAt = new Date().toISOString();
    ensureMainParty(next);
    return next;
  };
  state.characters = state.characters.map(restoreMembership);
  state.archivedCharacters = state.archivedCharacters.map(restoreMembership);
  const { memberLinks, ...activeParty } = party;
  state.archivedParties = state.archivedParties.filter(item => item.id !== id);
  state.parties = [...state.parties, activeParty];
  try {
    await persist();
  } catch (error) {
    rollback(previous);
    throw error;
  }
  await refreshArchiveViews();
  toast(`Пати «${party.name}» восстановлена`, 'success');
  return true;
}
