import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Категории настроек: вид, ссылки и подсветка активной категории.
const html = readFileSync('index.html', 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');

describe('категории настроек: разметка', () => {
  it('каждая категория — карточка с обозначением, подписью и ссылкой на существующий раздел', () => {
    const items = [...doc.querySelectorAll('.settings-nav-item')];
    expect(items).toHaveLength(7); // «Состояние парсеров» живёт внутри «Синхронизации»: отдельного раздела нет
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

  it('разделитель занимает доступную высоту, а пункты собраны компактно и прокручиваются при нехватке места', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    const menu = css.match(/\.settings-nav \{([^}]*)\}/)?.[1] || '';
    expect(menu).toMatch(/height:\s*max\(0px,\s*calc\(100vh\s*-\s*var\(--topbar-h/);
    expect(menu).toMatch(/grid-auto-rows:\s*minmax\(66px,\s*auto\)/);
    expect(menu).toMatch(/align-content:\s*start/);
    expect(menu).toMatch(/gap:\s*0/);
    expect(menu).toMatch(/padding:\s*2px 0/);
    expect(menu).toMatch(/overflow-y:\s*auto/);
    expect(menu).toMatch(/border-right:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/border-bottom:\s*1px solid var\(--border\)/); // разделитель при узком окне
    const hover = css.match(/\.settings-nav-item:hover \{([^}]*)\}/)?.[1] || '';
    expect(hover).toMatch(/background:\s*var\(--surface-2\)/);
    expect(hover).not.toMatch(/transform\s*:/); // верхний пункт не вылезает за область прокрутки
    expect(hover).not.toMatch(/box-shadow\s*:/);
    expect(doc.querySelector('#settings-optimization')).toBeNull();
    expect(doc.querySelector('#settings-sync #parser-health-panel')).not.toBeNull();
  });

  it('пункты немного выше и разделены тонкой линией, в том числе активный', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    const item = css.match(/\.settings-nav-item \{([^}]*)\}/)?.[1] || '';
    expect(item).toMatch(/min-height:\s*66px/);
    expect(css).toMatch(/\.settings-nav-item:not\(:last-child\)\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/);
    expect(css).not.toMatch(/\.settings-nav-item\.is-active\s*\{[^}]*border-bottom/);
    // На узком экране пункты стоят сеткой, поэтому границы нужны и между колонками.
    expect(css).toMatch(
      /@media\s*\(max-width:\s*980px\)\s*\{\s*\.settings-nav-item\s*\{[^}]*border:\s*1px solid var\(--border\)/
    );
    expect(css).toMatch(/\.settings-nav-item\.is-active\s*\{[^}]*border-right:\s*3px solid var\(--accent\)/);
  });

  it('активная вкладка отмечается правой границей, без псевдоэлементов', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    const item = css.match(/\.settings-nav-item \{([^}]*)\}/)?.[1] || '';
    const active = css.match(/\.settings-nav-item\.is-active \{([^}]*)\}/)?.[1] || '';
    expect(item).toMatch(/border-right:\s*3px solid transparent/);
    expect(active).toMatch(/border-right-color:\s*var\(--accent\)/);
    expect(`${css}\n${readFileSync('css/core/newStyle.css', 'utf8')}`).not.toMatch(
      /\.settings-nav-item[^\s,{]*::(?:before|after)/
    );
  });

  it('меню нового интерфейса примыкает к боковой панели, не сдвигая содержимое', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    const shell = readFileSync('css/core/newStyle.css', 'utf8');
    expect(css).toMatch(/\.settings-layout \{[^}]*--settings-nav-width:\s*272px/);
    expect(shell).toMatch(/--next-content-inset:\s*32px/);
    expect(shell).toMatch(/@media\s*\(max-width:\s*680px\)[\s\S]*--next-content-inset:\s*16px/);
    expect(shell).toMatch(
      /@media\s*\(min-width:\s*981px\)\s*\{\s*body\[data-ui-style='next'\] \.page\[data-section='settings'\] \.settings-layout\s*\{[^}]*margin-left:\s*calc\(-1 \* var\(--next-content-inset\)\);[^}]*grid-template-columns:\s*calc\(var\(--settings-nav-width\) \+ var\(--next-content-inset\)\)/
    );
    expect(shell).toMatch(
      /@media\s*\(min-width:\s*681px\) and \(max-width:\s*980px\)\s*\{\s*body\[data-ui-style='next'\] \.page\[data-section='settings'\] \.settings-nav\s*\{[^}]*margin-left:\s*calc\(-1 \* var\(--next-content-inset\)\)/
    );
  });

  it('при наведении пункт не подчёркивается', () => {
    // Пункт — это ссылка, а для ссылок в приложении действует общее правило
    // «подчёркивать при наведении» (base.css). Подсветки фона здесь достаточно.
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
    expect(items[0].getAttribute('aria-current')).toBe('true');
    items[3].click();
    expect(items[3].classList.contains('is-active')).toBe(true);
    expect(items[3].getAttribute('aria-current')).toBe('true');
    expect(items[0].classList.contains('is-active')).toBe(false);
    expect(items[0].hasAttribute('aria-current')).toBe(false);
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

  it('в узком окне переключение раздела не прокручивает меню за шапку', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      const { bindSettings } = await import('../js/settings/settings.js');
      const nav = document.querySelector('.settings-nav');
      const settingsBody = document.querySelector('.settings-body');
      nav.scrollIntoView = vi.fn();
      settingsBody.scrollIntoView = vi.fn();
      bindSettings();
      nav.querySelector('[href="#settings-sync"]').click();
      expect(nav.scrollIntoView).toHaveBeenCalledOnce();
      expect(settingsBody.scrollIntoView).not.toHaveBeenCalled();
      expect(document.querySelector('#settings-sync').hidden).toBe(false);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
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
