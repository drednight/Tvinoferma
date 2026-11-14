import { it, expect } from 'vitest';
import { updateRepeatButton } from '../js/modules/gameMacros/repeatButton.js';
it('renders independent compact on/off states with full accessible device/action names', () => {
  const keys = document.createElement('button'),
    mouse = document.createElement('button');
  const data = { mirrorKeys: true, mirrorMouse: false, mirroring: true };
  updateRepeatButton(keys, 'keyboard', data);
  updateRepeatButton(mouse, 'mouse', data);
  expect(keys.textContent).toBe('⌨ ВКЛ');
  expect(keys.dataset.state).toBe('on');
  expect(keys.getAttribute('aria-label')).toBe('Выключить повтор клавиатуры');
  expect(mouse.textContent).toBe('🖱 ВЫКЛ');
  expect(mouse.dataset.state).toBe('off');
  expect(mouse.getAttribute('aria-pressed')).toBe('false');
  expect(mouse.title).toBe('Включить повтор мыши');
});
it('distinguishes selected but suspended modes from active repetition without a long caption', () => {
  const button = document.createElement('button');
  updateRepeatButton(button, 'mouse', { mirrorMouse: true, mirroring: false });
  expect(button.textContent).toBe('🖱 ВКЛ Ⅱ');
  expect(button.dataset.state).toBe('paused');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.title).toContain('сейчас не работает');
  updateRepeatButton(button, 'mouse', { mirrorMouse: true, mirroring: true });
  expect(button.dataset.state).toBe('on');
  expect(button.title).not.toContain('приостановлен');
});
it('marks pending connections separately and clears busy state when they finish', () => {
  const button = document.createElement('button');
  updateRepeatButton(button, 'keyboard', { mirrorKeys: false, mirrorPending: true });
  expect(button.textContent).toBe('⌨ ВЫКЛ …');
  expect(button.dataset.state).toBe('pending');
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.title).toContain('обновление');
  updateRepeatButton(button, 'keyboard', { mirrorKeys: true, mirroring: true });
  expect(button.getAttribute('aria-busy')).toBe('false');
  expect(button.textContent).toBe('⌨ ВКЛ');
});
