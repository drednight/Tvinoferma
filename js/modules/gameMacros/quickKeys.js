/** Add a modifier without duplicating it or sending any input to the game. */
export function addQuickModifier(value, modifier) {
  const parts = String(value || '')
    .toUpperCase()
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.includes(modifier)) parts.unshift(modifier);
  return parts.join('+') + (parts.every(part => ['CTRL', 'ALT', 'SHIFT'].includes(part)) ? '+' : '');
}
export function quickKeysHtml() {
  return `<span class="gm-quick-keys" role="group" aria-label="Быстрый ввод модификаторов">${['SHIFT', 'CTRL', 'ALT'].map(key => `<button type="button" class="btn ghost small" data-quick-modifier="${key}">${key}</button>`).join('')}</span>`;
}
export function applyQuickModifier(input, modifier) {
  input.value = addQuickModifier(input.value, modifier);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
