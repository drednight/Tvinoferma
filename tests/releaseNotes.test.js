// Текст «Что нового» для latest.json и описания релиза (scripts/release-notes.mjs).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import { buildNotes, extractSection, normalizeVersion, plainText, shortItems } from '../scripts/release-notes.mjs';

const SAMPLE = `# История изменений

## [Unreleased]

### Добавлено

- **Черновик** следующего релиза.

## [1.2.0] — 2026-11-01

### Кратко

- Новый **экран** с \`кнопкой\` и [ссылкой](https://example.com).
- Исправлено зависание.

### Добавлено

- **Длинный заголовок пункта, который понятен сам по себе** и подробности, которых в окне обновления быть не должно.
  - вложенный пункт

## [1.1.0] — 2026-10-07

### Исправлено

- **Порядок данжей сбивался после полуночи по Москве, когда компьютер стоял в другом часовом поясе**. Подробности ниже.
- **Короткий:** пояснение, которое нужно оставить.
`;

describe('normalizeVersion', () => {
  it('убирает префикс v и не принимает ветки', () => {
    expect(normalizeVersion('v1.1.0')).toBe('1.1.0');
    expect(normalizeVersion('1.1.0')).toBe('1.1.0');
    expect(normalizeVersion('main')).toBeNull();
    expect(normalizeVersion('')).toBeNull();
  });
});

describe('extractSection', () => {
  it('берёт только раздел своей версии', () => {
    const s = extractSection(SAMPLE, '1.2.0').join('\n');
    expect(s).toContain('Новый **экран**');
    expect(s).not.toContain('Черновик');
    expect(s).not.toContain('Порядок данжей');
  });
  it('нет раздела — null; «Unreleased» версией не считается', () => {
    expect(extractSection(SAMPLE, '9.9.9')).toBeNull();
    expect(extractSection(SAMPLE, '1.20')).toBeNull();
  });
  it('работает с переводами строк Windows', () => {
    expect(extractSection(SAMPLE.replace(/\n/g, '\r\n'), '1.1.0').join('\n')).toContain('Короткий');
  });
});

describe('plainText', () => {
  it('убирает разметку', () => {
    expect(plainText('Новый **экран** с `кнопкой` и [ссылкой](https://x.y)')).toBe('Новый экран с кнопкой и ссылкой');
  });
});

describe('buildNotes', () => {
  it('«Кратко» — приоритет; разметка убрана, подробности не попадают', () => {
    const t = buildNotes(SAMPLE, '1.2.0');
    expect(t).toContain('Что нового в 1.2.0');
    expect(t).toContain('- Новый экран с кнопкой и ссылкой.');
    expect(t).toContain('- Исправлено зависание.');
    expect(t).not.toContain('Длинный заголовок');
    expect(t).not.toContain('вложенный');
    expect(t).not.toContain('**');
    expect(t).toContain('CHANGELOG.md');
  });

  it('без «Кратко» — жирные заголовки пунктов; короткий заголовок берётся с пояснением', () => {
    const items = shortItems(extractSection(SAMPLE, '1.1.0'));
    expect(items).toHaveLength(2);
    expect(items[0].length).toBeLessThanOrEqual(161);
    expect(items[0]).not.toContain('Подробности ниже');
    expect(items[1]).toBe('Короткий: пояснение, которое нужно оставить.');
  });

  it('нет раздела версии — ошибка с подсказкой про [Unreleased]', () => {
    expect(() => buildNotes(SAMPLE, '1.3.0')).toThrow(/Unreleased/);
  });

  it('пустой раздел — ошибка', () => {
    expect(() => buildNotes('## [1.0.0] — 2026-01-01\n\nТолько текст.\n', '1.0.0')).toThrow(/пуст/);
  });

  it('очень длинный список обрезается', () => {
    const many = Array.from({ length: 80 }, (_, i) => `- Пункт номер ${i} с достаточно длинным описанием изменения`).join('\n');
    const t = buildNotes(`## [2.0.0] — 2026-01-01\n\n### Кратко\n\n${many}\n`, '2.0.0');
    expect(t.length).toBeLessThan(3400);
    expect(t).toContain('- …');
  });
});

describe('репозиторий', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

  it('в CHANGELOG.md есть раздел текущей версии — иначе релиз остался бы без «Что нового»', () => {
    expect(() => buildNotes(changelog, pkg.version)).not.toThrow();
  });

  it('в окне обновления текст влезает в лимит и без markdown', () => {
    const t = buildNotes(changelog, pkg.version);
    expect(t.length).toBeLessThan(4000);
    expect(t).not.toMatch(/\*\*|`/);
  });

  it('workflow подставляет текст из CHANGELOG в releaseBody', () => {
    const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
    expect(wf).toContain('scripts/release-notes.mjs');
    expect(wf).toMatch(/releaseBody:\s*\$\{\{\s*steps\.notes\.outputs\.body\s*\}\}/);
  });
});
