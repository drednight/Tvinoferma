import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Категории настроек: вид, ссылки и подсветка активной категории.
const html = readFileSync('index.html', 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');

describe('категории настроек: разметка', () => {
  it('каждая категория — карточка с обозначением, подписью и ссылкой на существующий раздел', () => {
    const items = [...doc.querySelectorAll('.settings-nav-item')];
    expect(items).toHaveLength(7); // 7-я категория — «Предложения» (#settings-feedback)
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

  it('пункт при наведении не подчёркивается: карточка и так показывает наведение рамкой', () => {
    // Пункт — это ссылка, а для ссылок в приложении действует общее правило
    // «подчёркивать при наведении» (base.css). Без отдельного правила под текстом
    // и иконкой появлялась линия, и карточка выглядела сломанной
    const css = readFileSync('css/core/layout.css', 'utf8');
    // Регекс нечувствителен к переносам строк: layout.css форматирует prettier, правила многострочные
    expect(css).toMatch(
      /\.settings-nav-item:hover,\s*\.settings-nav-item\.is-active:hover\s*\{\s*text-decoration:\s*none;\s*\}/
    );
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

  it('открыт ровно один раздел: остальные скрыты, а не висят под ним', async () => {
    const { bindSettings } = await import('../js/settings/settings.js');
    bindSettings();
    const groups = [...document.querySelectorAll('.settings-body > .settings-group')];
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.filter(g => !g.hidden)).toHaveLength(1);
    expect(groups.find(g => !g.hidden).id).toBe('settings-app');
    document.querySelectorAll('.settings-nav-item')[1].click();
    expect(groups.filter(g => !g.hidden).map(g => g.id)).toEqual(['settings-sync']);
  });

  it('ссылка на панель внутри раздела открывает этот раздел', async () => {
    const { bindSettings } = await import('../js/settings/settings.js');
    bindSettings();
    // Справочник и гайд ведут и на раздел, и на панель внутри него — второй случай
    // раньше просто прокручивал к панели, а теперь панель может быть в скрытом разделе
    location.hash = '#settings-notifications';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const groups = [...document.querySelectorAll('.settings-body > .settings-group')];
    expect(groups.filter(g => !g.hidden).map(g => g.id)).toEqual(['settings-app']);
    expect(document.getElementById('settings-notifications')).not.toBeNull();
  });

  it('панель из справочника переключает раздел сама', async () => {
    const { bindSettings } = await import('../js/settings/settings.js');
    bindSettings();
    // Справочник шлёт событие перед переходом к панели: иначе панель скрыта и искать негде
    window.dispatchEvent(new CustomEvent('tf:open-section', { detail: { id: 'settings-data' } }));
    const groups = [...document.querySelectorAll('.settings-body > .settings-group')];
    expect(groups.filter(g => !g.hidden).map(g => g.id)).toEqual(['settings-data']);
  });
});
