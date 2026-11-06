import { expect, it } from 'vitest';
import { inputLabel, formatMirrorInput } from '../js/modules/gameMacros/inputTrace.js';
it('labels function keys, modifiers and all mouse buttons without assembling chat text', () => {
  expect(inputLabel(0x78)).toBe('F9');
  expect(inputLabel(0xa2)).toBe('Левый Ctrl');
  expect(inputLabel(0x100)).toBe('ЛКМ');
  expect(inputLabel(0x104)).toBe('Боковая 2');
  for (const code of [null, NaN, -1, 0, 0x105, 'F9']) expect(inputLabel(code)).toBe('');
});
it('reports delivery count, release, coalesced repeats and latency without claiming game success', () => {
  const text = formatMirrorInput({ vk: 0x78, up: true, recipients: 9, ageMs: 17, repetitions: 3 });
  expect(text).toContain('F9');
  expect(text).toContain('отпускание ×3');
  expect(text).toContain('окнам: 9');
  expect(text).toContain('17 мс');
  expect(text).toContain('не подтверждена');
  expect(formatMirrorInput({ vk: 0 })).toBe('');
});
