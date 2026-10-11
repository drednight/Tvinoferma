import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Категории настроек: вид, ссылки и подсветка активной категории.
const html = readFileSync('index.html', 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');

describe('категории настроек: разметка', () => {
  it('каждая категория — карточка с обозначением, подписью и ссылкой на существующий раздел', () => {
    const items = [...doc.querySelectorAll('.settings-nav-item')];
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.querySelector('.settings-nav-icon'), item.textContent).not.toBeNull();
      expect(item.querySelector('.settings-nav-copy strong').textContent.length, item.textContent).toBeGreaterThan(3);
      expect(item.querySelector('.settings-nav-copy small').textContent.length, item.textContent).toBeGreaterThan(5);
      expect(doc.querySelector(item.getAttribute('href')), item.textContent).not.toBeNull();
    }
    expect(items[0].getAttribute('href')).toBe('#settings-app');
    expect(items.at(-1).getAttribute('href')).toBe('#danger-zone');
  });

  it('подсветка активной категории описана в стилях', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    expect(css).toMatch(/\.settings-nav-item\.is-active/);
    expect(css).toMatch(/\.settings-nav \{[^}]*grid-template-columns:/);
  });
});

describe('категории настроек: подсветка', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = body;
  });

  it('первая категория активна сразу, при выборе другой — активной становится она', async () => {
    const { bindSettings } = await import('../js/settings/settings.js');
    bindSettings();
    const items = [...document.querySelectorAll('.settings-nav-item')];
    expect(items[0].classList.contains('is-active')).toBe(true);
    items[3].click();
    expect(items[3].classList.contains('is-active')).toBe(true);
    expect(items[0].classList.contains('is-active')).toBe(false);
  });
});
