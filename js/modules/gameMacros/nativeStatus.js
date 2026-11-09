// Boolean state replies are not error flags. Preserve an explicit failed report as blocked.
export function nativeResultStatus(command, result) {
  if (command === 'game_macro_input_idle' && typeof result === 'boolean') return result ? 'idle' : 'waiting';
  if (command === 'game_macro_mirror' && typeof result === 'boolean') return result ? 'active' : 'inactive';
  return result?.ok === false || result === false ? 'blocked' : 'ok';
}
