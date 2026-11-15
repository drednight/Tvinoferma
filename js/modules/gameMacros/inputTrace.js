// Volatile diagnostic labels, never reconstruct chat text from individual key events.
export function inputLabel(vk) {
  if (!Number.isInteger(vk) || vk < 1 || vk > 0x104) return '';
  const mouse = ['ЛКМ', 'ПКМ', 'Средняя кнопка', 'Боковая 1', 'Боковая 2'];
  if (vk >= 0x100) return mouse[vk - 0x100] || '';
  if (vk >= 0x70 && vk <= 0x7b) return `F${vk - 0x6f}`;
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a)) return String.fromCharCode(vk);
  return (
    {
      16: 'Shift',
      17: 'Ctrl',
      18: 'Alt',
      160: 'Левый Shift',
      161: 'Правый Shift',
      162: 'Левый Ctrl',
      163: 'Правый Ctrl',
      164: 'Левый Alt',
      165: 'Правый Alt',
      13: 'Enter',
      27: 'Esc',
      32: 'Пробел',
      9: 'Tab',
      8: 'Backspace',
      37: '←',
      38: '↑',
      39: '→',
      40: '↓'
    }[vk] || `VK 0x${vk.toString(16).toUpperCase()}`
  );
}
export function formatMirrorInput(event) {
  const label = inputLabel(event?.vk);
  if (!label) return '';
  const count = Math.max(0, Math.min(29, Math.trunc(Number(event.recipients) || 0)));
  const age = Math.max(0, Math.min(60000, Math.round(Number(event.ageMs) || 0)));
  const repeat = Math.max(1, Math.min(1000, Math.trunc(Number(event.repetitions) || 1)));
  return `Повтор: ${label} · ${event.up ? 'отпускание' : 'нажатие'}${repeat > 1 ? ` ×${repeat}` : ''} · сообщений окнам: ${count} · возраст события ${age} мс. Обработка игрой не подтверждена.`;
}
