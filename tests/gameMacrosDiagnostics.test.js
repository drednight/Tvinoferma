import { it, expect } from 'vitest';
import { backgroundReport } from '../js/modules/gameMacros/diagnostics.js';
it('distinguishes window responsiveness from game key acceptance and detects insufficient 25 ms health budget', () => {
  const text = backgroundReport({
    schema: 1,
    scanSender: 48,
    scanTarget: 48,
    health: [
      { timeoutMs: 25, ok: false, error: 1460, elapsedUs: 25000 },
      { timeoutMs: 100, ok: true, error: 0, elapsedUs: 51000 }
    ]
  }).join('\n');
  expect(text).toContain('25 мс может быть недостаточно');
  expect(text).toContain('не доказывает, что она обрабатывает WM_KEY');
  expect(text).toContain('Клавиши не отправлялись');
});
it('shows press and release separately including a failed release and unknown native code', () => {
  const text = backgroundReport({
    schema: 1,
    inputSent: true,
    method: 'post',
    messages: [
      { phase: 'down', vk: 66, ok: true, error: 0 },
      { phase: 'up', vk: 66, ok: false, error: 0 }
    ]
  }).join('\n');
  expect(text).toContain('Нажатие: VK=0x42');
  expect(text).toContain('Отпускание: VK=0x42');
  expect(text).toContain('Windows приняла — нет, код 0');
  expect(text).toContain('не доказывает DirectInput/Raw Input');
});
it('reports window, layout and privilege obstacles without forwarding arbitrary response fields', () => {
  const text = backgroundReport({
    schema: 1,
    minimized: true,
    integrityAllowed: false,
    scanSender: 48,
    scanTarget: 49,
    title: 'secret',
    path: '/home/private',
    senderLayout: 'secret',
    class: 'secret/private'
  }).join('\n');
  expect(text).toContain('Проверка прав не пройдена');
  expect(text).toContain('вручную разверните');
  expect(text).toContain('разные scan-code');
  expect(text).not.toContain('secret');
});
it('bounds message output and handles old builds explicitly', () => {
  expect(backgroundReport(null)[0]).toContain('обновите приложение');
  expect(
    backgroundReport({ schema: 1, inputSent: true, messages: Array(50).fill({ phase: 'down' }) }).filter(s =>
      s.startsWith('Нажатие:')
    )
  ).toHaveLength(8);
});
