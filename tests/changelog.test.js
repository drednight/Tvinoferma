// tests/changelog.test.js
// «История обновлений» в «Настройки → Обновления»: разбор CHANGELOG.md и HTML аккордеона.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChangelog, renderHistoryHtml } from '../js/desktop/changelog.js';

const real = readFileSync('CHANGELOG.md', 'utf8');

describe('разбор CHANGELOG.md', () => {
  it('настоящий файл: выпуски сверху вниз, версии и даты на месте', () => {
    const releases = parseChangelog(real);
    expect(releases.length).toBeGreaterThanOrEqual(15);
    expect(releases[0].version).toBe('Unreleased');
    expect(releases[0].date).toBe('');
    const v220 = releases.find(r => r.version === '2.2.0');
    expect(v220?.date).toBe('2026-10-20');
    // Порядок файла сохранён: более свежие раньше
    const idx = v => releases.findIndex(r => r.version === v);
    expect(idx('2.2.0')).toBeLessThan(idx('2.1.0'));
    expect(idx('2.1.0')).toBeLessThan(idx('1.0.0'));
  });

  it('у каждого выпуска есть изменения; секции с одним заголовком склеены', () => {
    const releases = parseChangelog(real);
    for (const r of releases) {
      const n = r.sections.reduce((a, s) => a + s.items.length, 0);
      expect(n, r.version).toBeGreaterThan(0);
      const titles = r.sections.map(s => s.title);
      expect(new Set(titles).size, r.version).toBe(titles.length);
    }
    // В 2.2.0 «### Улучшения» встречалось дважды — стало одной секцией
    const v220 = releases.find(r => r.version === '2.2.0');
    expect(v220?.sections.filter(s => s.title === 'Улучшения')).toHaveLength(1);
  });

  it('вступительный абзац попадает в lead, вступление самого файла — нет', () => {
    const releases = parseChangelog(real);
    const v211 = releases.find(r => r.version === '2.1.1');
    expect(v211?.lead).toContain('Исправление входа в GameCenter');
    for (const r of releases) expect(r.lead).not.toContain('Keep a Changelog');
  });

  it('синтетика: пустой текст, только вступление, пункты без секций', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Заголовок\n\nОбщий текст до выпусков.')).toEqual([]);
    const r = parseChangelog(
      '## [1.0.0] — 2026-01-02\n\n- пункт без секции\n## [Unreleased]\nlead-абзац\n### Добавлено\n- новое'
    );
    expect(r).toHaveLength(2);
    expect(r[0].sections).toEqual([{ title: '', items: ['пункт без секции'] }]);
    expect(r[1].lead).toBe('lead-абзац');
    expect(r[1].sections).toEqual([{ title: 'Добавлено', items: ['новое'] }]);
  });
});

describe('HTML истории', () => {
  it('карточка на выпуск: все свёрнуты, версия, дата и число записей', () => {
    const html = renderHistoryHtml(parseChangelog(real));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [...doc.querySelectorAll('details.update-history-item')];
    expect(items.length).toBeGreaterThanOrEqual(15);
    // Все выпуски свёрнуты: в списке видно последние пять, более старые — за прокруткой
    expect(items[0].hasAttribute('open')).toBe(false);
    expect(items[1].hasAttribute('open')).toBe(false);
    expect(items[0].querySelector('.uh-ver').textContent).toBe('🚧 В разработке');
    const v220 = items.find(d => d.querySelector('.uh-ver').textContent.includes('2.2.0'));
    expect(v220?.querySelector('.uh-date').textContent).toBe('2026-10-20');
    expect(v220?.querySelector('.uh-count').textContent).toMatch(/запис/);
    expect(v220?.querySelectorAll('.uh-ul li').length).toBeGreaterThan(5);
    expect(v220?.querySelector('.uh-h').textContent).toMatch(/Улучшения|Исправления/);
  });

  it('все выпуски остаются в списке, который ограничен пятью заголовками и прокручивается', () => {
    const css = readFileSync('css/core/layout.css', 'utf8');
    const list = css.match(/\.update-history-list \{([^}]*)\}/)?.[1] || '';
    expect(list).toMatch(/--history-row:\s*48px/);
    expect(list).toMatch(/max-height:\s*calc\(5\s*\*\s*var\(--history-row\)/);
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/\.update-history-item \{[^}]*flex:\s*0 0 auto/);
    const doc = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    const region = doc.querySelector('#update-history-list');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe('История обновлений');
    expect(renderHistoryHtml(parseChangelog(real)).match(/class="update-history-item"/g)).toHaveLength(
      parseChangelog(real).length
    );
  });

  it('версии и текст экранируются', () => {
    const html = renderHistoryHtml([
      { version: '<b>x</b>', date: '', lead: '', sections: [{ title: 'T<script>', items: ['<img src=x>'] }] }
    ]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });

  it('пустая история — понятная подпись', () => {
    expect(renderHistoryHtml([])).toContain('История обновлений пуста');
  });
});
