// Подтверждения идут только через окно в стиле приложения.
// Системные `window.confirm`/`alert` выглядят чужеродно и не подчиняются теме, поэтому их
// использования в коде быть не должно: этот тест следит, чтобы они не вернулись.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Все js-файлы интерфейса: рекурсивный обход без зависимости от Node-версии glob. */
function jsFiles(dir = 'js') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path.replace(/\\/g, '/')] : [];
  });
}

const JS_FILES = jsFiles();

describe('подтверждения в стиле приложения', () => {
  it('есть что проверять', () => {
    expect(JS_FILES.length).toBeGreaterThan(20);
  });

  it.each(JS_FILES.filter(f => !f.endsWith('core/ui.js')))('%s: без window.confirm', (file) => {
    const src = readFileSync(file, 'utf8');
    // Разрешаем упоминание в комментариях, но не вызов
    const calls = [...src.matchAll(/(?<![\w.])(?:window\.)?confirm\s*\(/g)]
      .filter(m => !/^\s*(\/\/|\*)/.test(src.slice(Math.max(0, m.index - 40), m.index).split('\n').pop() || ''));
    expect(calls, 'вызов confirm').toEqual([]);
  });

  it('confirmDialog больше не используется: он удалён как источник системных окон', () => {
    const offenders = JS_FILES.filter(f => !f.endsWith('core/ui.js'))
      .filter(f => /confirmDialog/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('confirmModal экспортируется из core/ui.js и возвращает Promise', async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="modal-root"></div>';
    const { confirmModal } = await import('../js/core/ui.js');
    const result = confirmModal({ title: 'Проверка', text: 'Текст' });
    expect(result).toBeInstanceOf(Promise);
    // Подтверждаем, чтобы окно не осталось висеть
    document.querySelector('[data-act="ok"]').click();
    expect(await result).toBe(true);
  });

  it('confirmDialog остался только как напоминание и падает при вызове', async () => {
    vi.resetModules();
    const { confirmDialog } = await import('../js/core/ui.js');
    expect(() => confirmDialog()).toThrow(/confirmModal/);
  });

  it('окно подтверждения поддерживает опасный вид и отмену', async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="modal-root"></div>';
    const { confirmModal } = await import('../js/core/ui.js');
    const p = confirmModal({ title: 'Удалить?', text: 'Точно?', okText: 'Удалить', danger: true });
    const okBtn = document.querySelector('[data-act="ok"]');
    expect(okBtn.className).toContain('danger');
    expect(okBtn.textContent).toBe('Удалить');
    document.querySelector('[data-act="cancel"]').click();
    expect(await p).toBe(false);
  });
});

describe('alert в коде', () => {
  it('в интерфейсе не осталось системных alert', () => {
    const allowed = ['core/ui.js', 'core/storageAdapters/localStorageAdapter.js'];
    const offenders = JS_FILES
      .filter(f => !allowed.some(a => f.endsWith(a)))
      .filter(f => /(?<![\w.])window\.alert\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
