import { openOverlay } from '../marathons/overlay.js';
import { chord } from './keySyntax.js';

export const KEYBOARD_ROWS = [
  Array.from({ length: 12 }, (_, i) => `F${i + 13}`),
  ['ESC', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)],
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
    onClose: () => {
      document.removeEventListener('keydown', capture, true);
      document.removeEventListener('mousedown', captureMouse, true);
    }
  });
  ov.el.classList.add('gm-keyboard-picker');
  ov.body.innerHTML =
    '<p>Одна клавиша (например F8) или Ctrl / Alt / Shift + клавиша. Выбор не отправляет ввод в игру. Левые/правые модификаторы и Enter цифрового блока здесь объединены. Win и служебные клавиши без поддержки не назначаются.</p><div class="gm-keyboard" role="group" aria-label="Полная клавиатура"></div><p><button type="button" class="btn" data-record>● Распознать физическую клавишу</button></p><p data-capture-status role="status">Для захвата щёлкните кнопку и нажмите клавишу в этом окне. Зарегистрированное глобальное сочетание Windows может не попасть в окно — предварительно выключите сочетания макросов. Некоторые Fn/мультимедийные клавиши не передают стандартный код.</p><output data-key-preview></output>';
  const preview = ov.body.querySelector('output');
  const grid = ov.body.querySelector('.gm-keyboard');
  const refresh = () => {
    preview.textContent = selected || 'Выберите основную клавишу';
    grid
      .querySelectorAll('[data-key]')
      .forEach(b =>
        b.setAttribute(
          'aria-pressed',
          String(b.dataset.modifier ? mods.has(b.dataset.modifier) : b.dataset.key === selected.split('+').at(-1))
        )
      );
  };
  const main = document.createElement('div'),
    nav = document.createElement('div'),
    num = document.createElement('div');
  main.className = 'gm-keyboard-main';
  nav.className = 'gm-keyboard-nav';
  num.className = 'gm-keyboard-num';
  grid.append(main, nav, num);
  for (const [rowIndex, row] of KEYBOARD_ROWS.entries()) {
    const line = document.createElement('div');
    line.className = 'gm-keyboard-row';
    for (const key of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';
      b.textContent = labels[key] || key.replace('NUMPAD', 'Num ');
      b.title = key;
      b.dataset.key = key;
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
    if (rowIndex < 7) main.append(line);
    else {
      const target = rowIndex === 7 ? nav : num;
      for (const b of [...line.children]) {
        target.append(b);
        const key = b.dataset.key;
        const navMap = {
          PRINTSCREEN: [1, 1],
          SCROLLLOCK: [1, 2],
          PAUSE: [1, 3],
          INSERT: [2, 1],
          HOME: [2, 2],
          PAGEUP: [2, 3],
          DELETE: [3, 1],
          END: [3, 2],
          PAGEDOWN: [3, 3],
          UP: [5, 2],
          LEFT: [6, 1],
          DOWN: [6, 2],
          RIGHT: [6, 3]
        };
        const numMap = {
          NUMLOCK: [1, 1],
          DIVIDE: [1, 2],
          MULTIPLY: [1, 3],
          SUBTRACT: [1, 4],
          NUMPAD7: [2, 1],
          NUMPAD8: [2, 2],
          NUMPAD9: [2, 3],
          ADD: [2, 4],
          NUMPAD4: [3, 1],
          NUMPAD5: [3, 2],
          NUMPAD6: [3, 3],
          NUMPAD1: [4, 1],
          NUMPAD2: [4, 2],
          NUMPAD3: [4, 3],
          ENTER: [4, 4],
          NUMPAD0: [5, 1],
          DECIMAL: [5, 3]
        };
        const pos = (rowIndex === 7 ? navMap : numMap)[key];
        if (pos) {
          b.style.gridRow = String(pos[0]);
          b.style.gridColumn = String(pos[1]);
        }
        if (target === num && ['ADD', 'ENTER'].includes(key)) b.style.gridRow += ' / span 2';
        if (target === num && key === 'NUMPAD0') b.style.gridColumn = '1 / span 2';
      }
    }
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
  function captureMouse(event) {
    if (!recording || event.target.closest('button')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ov.body.querySelector('[data-capture-status]').textContent =
      `Кнопка мыши ${event.button + 1} получена. Прямой запуск этой кнопкой пока не поддерживается. Если ПО мыши назначает ей F13–F24, нажмите её снова с таким назначением — будет сохранена клавиша. Выбор не изменён.`;
  }
  document.addEventListener('mousedown', captureMouse, true);
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
      value:
        input.tagName === 'TEXTAREA'
          ? input.value
              .slice(0, input.selectionStart ?? input.value.length)
              .split('\n')
              .at(-1) + input.value.slice(input.selectionStart ?? input.value.length).split('\n')[0]
          : input.value,
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
