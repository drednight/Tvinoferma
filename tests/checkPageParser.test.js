import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseCheckPageHtml, checkPageLinks, readSavedSiteHtml } from '../js/modules/marathons/checkPageParser.js';
const html = readFileSync('tests/fixtures/check-page-jingxuan.html', 'utf8');
it('extracts the four Jingxuan quests, descriptions, goals and a single date range without personal marks', () => {
  const parsed = parseCheckPageHtml(html, { year: 2026 });
  expect(parsed.name).toBe('Активность «Покоритель Цзинсюаня»');
  expect(parsed.quests.map(q => q.title)).toEqual([
    'Путник на постоялом дворе',
    'Сдержать зло, утвердить добро',
    'Эфемерный сон кота',
    'Без остатка, без тревог'
  ]);
  expect(parsed.quests.every(q => q.goal === 1 && q.description.includes('золотой сундук'))).toBe(true);
  expect(parsed.stages[0]).toMatchObject({ startDate: '2026-11-11', endDate: '2026-12-06' });
  expect(JSON.stringify(parsed)).not.toMatch(/completed|user_id|account/);
});
it('does not run uploaded scripts and reports missing layouts or dates explicitly', () => {
  window.importScriptRan = false;
  const parsed = parseCheckPageHtml(
    html.replace(/Сроки проведения марафона:[^<]+/, '') + '<script>window.importScriptRan=true</script>'
  );
  expect(window.importScriptRan).toBe(false);
  expect(parsed.stages).toHaveLength(0);
  expect(() => parseCheckPageHtml('<h1>Login</h1>')).toThrow();
});
it('finds normalized same-site check links, rejects lookalikes and credentials, and keeps multiple choices separate', () => {
  const links = checkPageLinks(
    '<a href="../supermarathon.php/">Здесь</a><a href="//evil.test/supermarathon.php">bad</a><a href="https://pwonline.ru@evil.test/supermarathon.php">bad</a><a href="/supermarathon2.php">Вторая</a>'
  );
  expect(links).toEqual(['https://pwonline.ru/supermarathon.php', 'https://pwonline.ru/supermarathon2.php']);
  expect(
    checkPageLinks('<a href="/special.php">Сверка</a>', undefined, ['https://pwonline.ru/special.php'])
  ).toHaveLength(1);
});
it('decodes saved Windows-1251 HTML without executing it', async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('<meta charset="windows-1251">'),
    0xcf,
    0xf3,
    0xf2,
    0xed,
    0xe8,
    0xea
  ]);
  expect(await readSavedSiteHtml({ size: bytes.length, arrayBuffer: async () => bytes.buffer })).toContain('Путник');
});
