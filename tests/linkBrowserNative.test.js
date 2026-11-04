import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps external browser windows outside the main-window capability and remote ACL', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  expect(capability.windows).toEqual(['main']);
  expect(capability.remote).toBeUndefined();
});
it('mounts a text-only navigation bar once, never a login or password helper', () => {
  const script = readFileSync('src-tauri/src/scripts/link_browser.js', 'utf8');
  document.body.innerHTML = '';
  window.eval(script);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window.eval(script);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  expect(document.querySelectorAll('#tf-link-nav')).toHaveLength(1);
  expect([...document.querySelectorAll('#tf-link-nav button')].map(b => b.getAttribute('aria-label'))).toEqual([
    'Назад',
    'Вперёд',
    'Обновить'
  ]);
  expect(document.querySelector('input,form')).toBeNull();
  expect(script).not.toContain('__TAURI');
});
