export function chord(value) {
  if (/^CTRL\+WHEEL(UP|DOWN)$/i.test(String(value))) return String(value).toUpperCase();
  const parts = String(value || '')
    .toUpperCase()
    .replace(/\s/g, '')
    .split('+');
  const key = parts.pop();
  if (
    !/^(F([1-9]|1[0-9]|2[0-4])|NUMPAD[0-9]|BACKSPACE|ESC|END|PAGEUP|PAGEDOWN|INSERT|DELETE|CAPSLOCK|NUMLOCK|SCROLLLOCK|MULTIPLY|ADD|SUBTRACT|DECIMAL|DIVIDE|SEMICOLON|EQUALS|COMMA|MINUS|PERIOD|SLASH|BACKQUOTE|BRACKETLEFT|BACKSLASH|BRACKETRIGHT|QUOTE|[A-Z0-9]|LEFT|RIGHT|UP|DOWN|SPACE|ENTER|TAB|PAUSE|HOME)$/.test(
      key || ''
    )
  )
    return '';
  if (parts.some(p => !['CTRL', 'ALT', 'SHIFT'].includes(p)) || new Set(parts).size !== parts.length) return '';
  return [...['CTRL', 'ALT', 'SHIFT'].filter(p => parts.includes(p)), key].join('+');
}
export function steps(text) {
  const rows = String(text || '')
    .split(/\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!rows.length || rows.length > 20) throw new Error('Нужно от 1 до 20 шагов.');
  return rows.map(row => {
    if (/^wait\s+\d+$/i.test(row)) {
      const ms = Number(row.split(/\s+/)[1]);
      if (ms < 50 || ms > 3000) throw new Error('Пауза — от 50 до 3000 мс.');
      return { wait: ms };
    }
    const key = chord(row);
    if (!key || key.includes('WHEEL'))
      throw new Error('Недопустимая клавиша. Пример: SHIFT+1, F7 или wait 200, каждый шаг с новой строки.');
    return { key };
  });
}
