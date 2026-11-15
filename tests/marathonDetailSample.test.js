import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
const source = readFileSync('src-tauri/src/scripts/marathon_detail.js', 'utf8');
const selectors = JSON.parse(readFileSync('src-tauri/src/scripts/selectors.json', 'utf8')).selectors;
it('native detail parser reads the uploaded single-stage layout and its common dates', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T08:00:00Z'));
  try {
    document.body.innerHTML = readFileSync('tests/fixtures/check-page-jingxuan.html', 'utf8');
    for (const el of document.querySelectorAll('*'))
      Object.defineProperty(el, 'innerText', {
        get() {
          return this.textContent;
        },
        configurable: true
      });
    window.__TF = {
      isChallenge: () => false,
      has: () => false,
      q: (key, root = document) => root.querySelector(selectors[key][0]),
      qa: (key, root = document) => [...root.querySelectorAll(selectors[key][0])]
    };
    window.eval(source);
    const payload = JSON.parse(decodeURIComponent(location.hash.slice('#TF_DETAIL_V4_'.length)));
    expect(payload.error).toBeNull();
    expect(payload.data.quests).toHaveLength(4);
    expect(payload.data.stages[0]).toMatchObject({ startDate: '2026-11-11', endDate: '2026-12-06' });
  } finally {
    vi.useRealTimers();
  }
});
