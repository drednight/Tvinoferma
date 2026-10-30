import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const guard = readFileSync('demo/app/guard.js', 'utf8');

describe('изоляция полной копии демо', () => {
  it('останавливает программное создание ссылок на экспорт даже вне iframe', () => {
    const dom = new JSDOM('<div id="demo-guard-message"></div>', {
      url: 'https://example.test/demo/app/index.html',
      runScripts: 'outside-only'
    });
    try {
      dom.window.eval(guard);
      expect(dom.window.__DEMO_GUARD_READY__).toBe(true);
      expect(() => dom.window.URL.createObjectURL(new dom.window.Blob(['private']))).toThrow(
        'Сохранение файлов в демо отключено.'
      );
      expect(dom.window.document.getElementById('demo-guard-message').textContent).toContain(
        'Сохранение файлов в демо отключено.'
      );
      expect(Object.getOwnPropertyDescriptor(dom.window.URL, 'createObjectURL').writable).toBe(false);
    } finally {
      dom.window.close();
    }
  });
});
