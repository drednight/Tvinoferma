import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PASS_TYPES } from '../js/core/constants.js';

const PUBLIC = join(import.meta.dirname, '..', 'public');

describe('иконки допусков в данжи', () => {
  it('каждая иконка — существующий WebP небольшого размера', () => {
    for (const pt of PASS_TYPES) {
      expect(pt.img, pt.key).toMatch(/^\/assets\/icons\/dungeons\/pass-[a-z]+\.webp$/);
      const file = join(PUBLIC, pt.img);
      expect(existsSync(file), pt.img).toBe(true);
      const head = readFileSync(file).subarray(0, 12);
      expect(head.toString('ascii', 0, 4), pt.img).toBe('RIFF');
      expect(head.toString('ascii', 8, 12), pt.img).toBe('WEBP');
      expect(statSync(file).size, pt.img).toBeLessThan(50 * 1024);
    }
  });

  it('старые PNG не остались в проекте', () => {
    for (const pt of PASS_TYPES) {
      expect(existsSync(join(PUBLIC, pt.img.replace(/\.webp$/, '.png'))), pt.key).toBe(false);
    }
  });
});
