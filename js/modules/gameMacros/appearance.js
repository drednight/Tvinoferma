export const TEXT_PRESETS = { light: '#eef1ff', warm: '#f5e5c4', mint: '#bcefd8' };
export const KEY_PRESETS = { gold: '#f5cc76', blue: '#b7c2ff', white: '#ffffff' };
export const COMMAND_PRESETS = { mint: '#7de4b4', violet: '#c4a5ff', orange: '#ffb46b' };
export function normalizeAppearance(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    textColor: Object.hasOwn(TEXT_PRESETS, value.textColor) ? value.textColor : 'light',
    commandColor: Object.hasOwn(COMMAND_PRESETS, value.commandColor) ? value.commandColor : 'mint',
    keyColor: Object.hasOwn(KEY_PRESETS, value.keyColor) ? value.keyColor : 'gold',
    fontSize: Math.max(10, Math.min(24, Math.round(Number(value.fontSize) || 14))),
    hideHeader: value.hideHeader === true
  };
}
