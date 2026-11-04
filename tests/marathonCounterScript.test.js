import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync('src-tauri/src/scripts/marathon_progress.js', 'utf8');
function parse(text) {
  document.body.innerHTML =
    '<div class="container"><section class="quest"><h3>Task</h3><span class="counter"></span></section></div>';
  document.querySelector('.counter').textContent = text;
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
    q: (key, root = document) =>
      root.querySelector(
        { 'marathon.container': '.container', 'marathon.questTitle': 'h3', 'marathon.progressValue': '.counter' }[key]
      ),
    qa: (key, root) => [...root.querySelectorAll(key === 'marathon.quest' ? '.quest' : '.description')]
  };
  window.eval(source);
  return JSON.parse(decodeURIComponent(location.hash.slice('#TF_MARATHON_DATA_'.length)));
}
it('reads a genuine zero without adding one credit', () => {
  expect(parse('0 / 25')).toMatchObject({ error: null, data: [{ completed: 0, total: 25 }] });
});
it('does not parse leading instructions or malformed numbers as a completion', () => {
  for (const text of ['1 награда / 25', '1.5 / 25', '-1 / 25']) expect(parse(text).error).toBe('no_progress_found');
});
