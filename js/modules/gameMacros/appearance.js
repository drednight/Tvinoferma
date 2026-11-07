const EXTRA_PRESETS = {
  pink: '#ffb3d9',
  cyan: '#83e8f5',
  lime: '#d4ee85',
  coral: '#ff9e9e',
  silver: '#cbd5e1',
  lavender: '#d8c4ff'
};
export const TEXT_PRESETS = { light: '#eef1ff', warm: '#f5e5c4', mint: '#bcefd8', ...EXTRA_PRESETS };
export const KEY_PRESETS = { gold: '#f5cc76', blue: '#b7c2ff', white: '#ffffff', ...EXTRA_PRESETS };
export const COMMAND_PRESETS = { mint: '#7de4b4', violet: '#c4a5ff', orange: '#ffb46b', ...EXTRA_PRESETS };
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
