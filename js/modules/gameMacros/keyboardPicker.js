import { openOverlay } from '../marathons/overlay.js';
import { chord } from './keySyntax.js';

export const KEYBOARD_ROWS = [
  ['ESC', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)],
  ['BACKQUOTE', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'MINUS', 'EQUALS', 'BACKSPACE'],
  ['TAB', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', 'BRACKETLEFT', 'BRACKETRIGHT', 'BACKSLASH'],
  ['CAPSLOCK', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'SEMICOLON', 'QUOTE', 'ENTER'],
  ['SHIFT', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'COMMA', 'PERIOD', 'SLASH', 'SHIFT'],
  ['CTRL', 'WINLEFT', 'ALT', 'SPACE', 'ALT', 'WINRIGHT', 'CONTEXTMENU', 'CTRL'],
  [
    'PRINTSCREEN',
    'SCROLLLOCK',
    'PAUSE',
    'INSERT',
    'HOME',
    'PAGEUP',
    'DELETE',
    'END',
    'PAGEDOWN',
    'LEFT',
    'UP',
    'DOWN',
    'RIGHT'
  ],
  [
    'NUMLOCK',
    'DIVIDE',
    'MULTIPLY',
    'SUBTRACT',
    'NUMPAD7',
    'NUMPAD8',
    'NUMPAD9',
    'ADD',
    'NUMPAD4',
    'NUMPAD5',
    'NUMPAD6',
    'NUMPAD1',
    'NUMPAD2',
    'NUMPAD3',
    'NUMPAD0',
    'DECIMAL',
    'ENTER'
  ]
];
const labels = {
  BACKQUOTE: '` ~',
  MINUS: '− _',
  EQUALS: '= +',
  BRACKETLEFT: '[ {',
  BRACKETRIGHT: '] }',
  BACKSLASH: '\\ |',
  SEMICOLON: '; :',
  QUOTE: '\' "',
  COMMA: ', <',
  PERIOD: '. >',
  SLASH: '/ ?',
  LEFT: '←',
  RIGHT: '→',
  UP: '↑',
  DOWN: '↓',
  SPACE: 'Пробел',
  PRINTSCREEN: 'PrtSc',
  BACKSPACE: 'Backspace',
  DIVIDE: 'Num /',
  MULTIPLY: 'Num *',
  SUBTRACT: 'Num −',
  ADD: 'Num +',
  DECIMAL: 'Num .'
};
export function capturedChord(event) {
  const code = event.code || '';
  const aliases = {
    Escape: 'ESC',
    ControlLeft: 'CTRL',
    ControlRight: 'CTRL',
    AltLeft: 'ALT',
    AltRight: 'ALT',
    ShiftLeft: 'SHIFT',
    ShiftRight: 'SHIFT',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    NumpadAdd: 'ADD',
    NumpadSubtract: 'SUBTRACT',
    NumpadMultiply: 'MULTIPLY',
    NumpadDivide: 'DIVIDE',
    NumpadDecimal: 'DECIMAL',
    NumpadEnter: 'ENTER'
  };
  const key = aliases[code] || code.replace(/^Key|^Digit/, '').toUpperCase();
  if (['CTRL', 'ALT', 'SHIFT'].includes(key) || event.metaKey || event.isComposing) return '';
  return chord(
    [event.ctrlKey && 'CTRL', event.altKey && 'ALT', event.shiftKey && 'SHIFT', key].filter(Boolean).join('+')
  );
}
export function openKeyboardPicker({ value = '', onChoose }) {
  let recording = false,
    selected = chord(value),
    mods = new Set(selected.split('+').slice(0, -1));
  const ov = openOverlay({
    title: 'Клавиатура — выбор клавиши или сочетания',
    wide: true,
    onClose: () => document.removeEventListener('keydown', capture, true)
  });
  ov.el.classList.add('gm-keyboard-picker');
  ov.body.innerHTML =
    '<p>Одна клавиша (например F8) или Ctrl / Alt / Shift + клавиша. Выбор не отправляет ввод в игру. Левые/правые модификаторы и Enter цифрового блока здесь объединены. Win и служебные клавиши без поддержки не назначаются.</p><div class="gm-keyboard" role="group" aria-label="Полная клавиатура"></div><p><button type="button" class="btn" data-record>● Распознать физическую клавишу</button></p><p data-capture-status role="status">Для захвата щёлкните кнопку и нажмите клавишу в этом окне. Зарегистрированное глобальное сочетание Windows может не попасть в окно — предварительно выключите сочетания макросов. Некоторые Fn/мультимедийные клавиши не передают стандартный код.</p><output data-key-preview></output>';
  const preview = ov.body.querySelector('output');
  const grid = ov.body.querySelector('.gm-keyboard');
  const refresh = () => {
    preview.textContent = selected || 'Выберите основную клавишу';
    grid
      .querySelectorAll('[data-modifier]')
      .forEach(b => b.setAttribute('aria-pressed', String(mods.has(b.dataset.modifier))));
  };
  for (const row of KEYBOARD_ROWS) {
    const line = document.createElement('div');
    line.className = 'gm-keyboard-row';
    for (const key of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';
      b.textContent = labels[key] || key.replace('NUMPAD', 'Num ');
      b.title = key;
      if (['WINLEFT', 'WINRIGHT', 'CONTEXTMENU'].includes(key)) {
        b.disabled = true;
        b.textContent = key === 'CONTEXTMENU' ? 'Menu' : 'Win';
        b.title = 'Служебная клавиша — назначение не поддерживается';
      }
      if (['CTRL', 'ALT', 'SHIFT'].includes(key)) b.dataset.modifier = key;
      b.onclick = () => {
        recording = false;
        if (b.dataset.modifier) {
          if (mods.has(key)) mods.delete(key);
          else mods.add(key);
          const base = selected.split('+').at(-1);
          selected = base ? chord([...mods, base].join('+')) : '';
        } else selected = chord([...mods, key].join('+'));
        refresh();
      };
      line.append(b);
    }
    grid.append(line);
  }
  function capture(event) {
    if (!recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const token = capturedChord(event);
    ov.body.querySelector('[data-capture-status]').textContent = token
      ? `Распознано: ${token}. Нажмите «Использовать».`
      : `Код: ${event.code || 'неизвестен'}. Основная клавиша не поддерживается или нажат только модификатор. Назначение не изменено.`;
    if (token) {
      selected = token;
      mods = new Set(token.split('+').slice(0, -1));
      recording = false;
      refresh();
    }
  }
  document.addEventListener('keydown', capture, true);
  ov.body.querySelector('[data-record]').onclick = () => {
    recording = true;
    ov.body.querySelector('[data-capture-status]').textContent = 'Ожидаем клавишу в этом окне…';
  };
  ov.foot.innerHTML =
    '<button class="btn ghost" data-cancel>Отмена</button><button class="btn primary" data-apply>Использовать</button>';
  ov.foot.querySelector('[data-cancel]').onclick = () => ov.close();
  ov.foot.querySelector('[data-apply]').onclick = () => {
    if (!selected) return;
    onChoose(selected);
    ov.close();
  };
  refresh();
  return ov;
}
export function keyboardButton(input, apply) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost';
  b.textContent = '⌨ Полная клавиатура…';
  b.onclick = () =>
    openKeyboardPicker({
      value: input.value,
      onChoose: token => {
        if (apply) apply(token);
        else {
          input.value = token;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
  return b;
}
