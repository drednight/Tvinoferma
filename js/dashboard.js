import { state } from './state.js';
import { formatNumber } from './utils.js';

export function updateKPI(characters) {
  const totalCoins = characters.reduce((sum, c) => sum + (Number(c.ancientCoins) || 0), 0);
  const noParty = characters.filter((c) => !c.party).length;

  document.getElementById('kpi-characters').textContent = formatNumber(characters.length);
  document.getElementById('kpi-coins').textContent = formatNumber(totalCoins);
  document.getElementById('kpi-parties').textContent = formatNumber(state.parties.length);
  document.getElementById('kpi-no-party').textContent = formatNumber(noParty);
}