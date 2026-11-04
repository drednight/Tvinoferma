import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { expect, it } from 'vitest';

const readme = readFileSync('README.md', 'utf8');
const images = [...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)\)/g)]
  .map(match => match[1] || match[2])
  .filter(src => !/^(https?:|data:)/.test(src));

it('includes actual screenshot files for every local README image', () => {
  expect(images.length).toBeGreaterThanOrEqual(10);
  for (const src of new Set(images)) {
    const path = resolve(src);
    expect(relative(process.cwd(), path).startsWith('..'), src).toBe(false);
    expect(existsSync(path), `Missing README image: ${src}`).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.length, src).toBeGreaterThan(500);
    if (src.endsWith('.webp')) {
      expect(bytes.toString('ascii', 0, 4), src).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 12), src).toBe('WEBP');
    }
  }
});
it('links the current calendar, tools, settings and browser profile screenshots', () => {
  for (const name of [
    'today',
    'characters',
    'character-profile',
    'parties',
    'marathons',
    'calendar',
    'tools',
    'settings',
    'browser',
    'command-palette'
  ]) {
    expect(images).toContain(`docs/screenshots/${name}.webp`);
  }
  expect(readme).toContain('на вымышленных данных');
});
