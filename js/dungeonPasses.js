import { state } from './state.js';
import { persist } from './storage.js';
import { nowISO, toInt } from './utils.js';
import { renderCharacters } from './characters.js';

export function changePass(characterId, passKey, delta) {
  const character = state.characters.find((c) => c.id === characterId);
  if (!character) return;

  if (!character.dungeonPasses) {
    character.dungeonPasses = { weapon: 0, armor: 0, relic: 0 };
  }

  const current = toInt(character.dungeonPasses[passKey], 0);
  character.dungeonPasses[passKey] = Math.max(0, current + delta);
  character.updatedAt = nowISO();

  persist();
  renderCharacters();
}