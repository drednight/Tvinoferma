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

it('reports activation and reverse notification failures separately without claiming success', () => {
  const text = backgroundReport({
    schema: 1,
    activityTest: true,
    inputSent: true,
    foregroundChanged: true,
    steps: [
      { phase: 'activate-app', ok: true, error: 0, before: '0x123', after: '0x123' },
      { phase: 'key-down', skipped: true },
      { phase: 'restore-window', ok: false, error: 1460, before: '0x456', after: '0x456' },
      { phase: 'restore-app', ok: true, error: 0, before: '0x456', after: '0x456' }
    ]
  }).join('\n');
  expect(text).toContain('Условие «без активации» нарушено');
  expect(text).toContain('restore-window: Windows подтвердила — нет, код 1460');
  expect(text).toContain('key-down: пропущено');
  expect(text).toContain('не гарантия обработки игрой');
  expect(text).not.toContain('Клавиши не отправлялись');
});
it('explains activity preflight refusal without presenting it as a successful input test', () => {
  const text = backgroundReport({
    schema: 1,
    activityTest: true,
    refused: true,
    inputSent: false,
    foregroundChanged: false
  }).join('\n');
  expect(text).toContain('Тест отклонён до уведомлений');
  expect(text).toContain('Попытка B — нет');
});
it('labels the actual activity key and distinguishes active recipients from notification tests', () => {
  const text = backgroundReport({
    schema: 1,
    activityTest: true,
    vk: 0x77,
    holdMs: 40,
    notificationsSent: false,
    inputSent: true
  }).join('\n');
  expect(text).toContain('Попытка F8 — да');
  expect(text).toContain('Цель уже активна');
  expect(text).toContain('40 мс');
  expect(text).not.toContain('Попытка B');
});
it('includes chord modifiers and reverse modifier release without truncating restore steps', () => {
  const text = backgroundReport({
    schema: 1,
    activityTest: true,
    vk: 0x31,
    modifiers: [17, 16],
    inputSent: true,
    steps: [
      { phase: 'activate-app', ok: true },
      { phase: 'activate-window', ok: true },
      { phase: 'modifier-down', wparam: 17, ok: true },
      { phase: 'modifier-down', wparam: 16, ok: true },
      { phase: 'key-down', ok: true },
      { phase: 'key-up', ok: true },
      { phase: 'modifier-up', wparam: 16, ok: true },
      { phase: 'modifier-up', wparam: 17, ok: false, error: 1460 },
      { phase: 'restore-window', ok: true },
      { phase: 'restore-app', ok: true }
    ]
  }).join('\n');
  expect(text).toContain('Попытка CTRL+SHIFT+1');
  expect(text).toContain('modifier-up VK=0x11');
  expect(text).toContain('restore-app');
  expect(text).toContain('1460');
});
