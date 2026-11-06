// Literal command mapping from the user-provided StanislavFist AHK v2 script.
// Credentials, config.ini account indices and unchecked screen coordinates are NOT imported.
export const AHK_PRESETS_VERSION = 1;
export const AHK_PRESETS = [
  {
    id: 'ahk-optimize',
    name: 'ПЛ: большой клиент + оптимизация остальных',
    action: 'optimize',
    target: 'all',
    hotkey: 'F11'
  },
  { id: 'ahk-next', name: 'Следующее окно', action: 'next', target: 'all', hotkey: 'CTRL+WHEELDOWN' },
  { id: 'ahk-previous', name: 'Предыдущее окно', action: 'previous', target: 'all', hotkey: 'CTRL+WHEELUP' },
  {
    id: 'ahk-assist',
    name: 'Ассист — кроме ПЛ',
    action: 'sequence',
    target: 'others',
    hotkey: 'CTRL+X',
    sequence: 'SHIFT+1\nwait 60\nF7'
  },
  { id: 'ahk-follow', name: 'Следование — кроме ПЛ', action: 'follow', target: 'others', hotkey: 'CTRL+F' },
  { id: 'ahk-f1', name: 'F1 — всей пати', action: 'sequence', target: 'all', hotkey: 'CTRL+F1', sequence: 'F1' },
  { id: 'ahk-f6f1', name: 'F6 — кроме ПЛ, затем F1 — всем', action: 'f6f1', target: 'all', hotkey: 'CTRL+F6' },
  {
    id: 'ahk-buff',
    name: 'Баф — выбранная пати',
    action: 'sequence',
    target: 'all',
    scope: 'party',
    hotkey: 'CTRL+F2',
    sequence: 'F8'
  },
  {
    id: 'ahk-resurrect',
    name: 'Быстрый рес — все распознанные окна',
    action: 'click',
    target: 'all',
    scope: 'managed',
    hotkey: 'CTRL+R'
  },
  {
    id: 'ahk-scroll-res',
    name: 'Рес за свиток — все распознанные окна',
    action: 'click',
    target: 'all',
    scope: 'managed',
    hotkey: 'CTRL+T'
  },
  {
    id: 'ahk-game-option',
    name: 'Игровая оптимизация Ctrl+F9',
    action: 'sequence',
    target: 'all',
    sequence: 'CTRL+F9'
  },
  { id: 'ahk-launch', name: 'Запустить PW для выбранной пати', action: 'launch', target: 'all' },
  { id: 'ahk-pause', name: 'Пауза / продолжить макросы', action: 'pause', target: 'all' }
];
export function installAhkPresets(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  if (input.ahkPresetsVersion >= AHK_PRESETS_VERSION) return input;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const existing = new Set(commands.map(row => row?.id));
  return {
    ...input,
    enabled: false,
    ahkPresetsVersion: AHK_PRESETS_VERSION,
    commands: [...commands, ...AHK_PRESETS.filter(row => !existing.has(row.id))]
  };
}

export function installMirrorPreset(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  if (input.mirrorPresetVersion === 2) return input;
  const commands = [...(Array.isArray(input.commands) ? input.commands : [])];
  for (const [action, id, name] of [
    ['mirror', 'keyboard-mirror', 'Повтор клавиатуры — вкл / выкл'],
    ['mouse-mirror', 'mouse-mirror', 'Повтор мыши — вкл / выкл']
  ]) {
    if (action === 'mirror' && input.mirrorPresetVersion === 1) continue;
    if (commands.length < 64 && !commands.some(c => c?.action === action)) {
      let availableId = id;
      for (let suffix = 1; commands.some(c => c?.id === availableId); suffix++) availableId = `${id}-${suffix}`;
      commands.push({
        id: availableId,
        name,
        action,
        scope: 'managed',
        target: 'all',
        hotkey: ''
      });
    }
  }
  return {
    ...input,
    mirrorPresetVersion:
      commands.length < 64 || commands.some(c => c?.action === 'mouse-mirror') ? 2 : input.mirrorPresetVersion,
    commands
  };
}
