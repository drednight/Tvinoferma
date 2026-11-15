import { it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
it('removes voice overlay entry points, native handlers, window permissions and network exception', () => {
  for (const path of [
    'game-overlay.html',
    'js/modules/gameMacros/panel.js',
    'js/modules/gameMacros/overlay.js',
    'src-tauri/src/lib.rs',
    'src-tauri/tauri.conf.json',
    'vite.config.js'
  ]) {
    expect(readFileSync(path, 'utf8')).not.toMatch(/teamspeak|127\.0\.0\.1:5899/i);
  }
  for (const path of [
    'teamspeak-overlay.html',
    'src-tauri/src/teamspeak.rs',
    'src-tauri/capabilities/teamspeak-overlay.json',
    'js/modules/teamspeak/model.js',
    'js/modules/teamspeak/overlay.js',
    'css/modules/teamspeakOverlay.css'
  ])
    expect(existsSync(path)).toBe(false);
  expect(readFileSync('game-overlay.html', 'utf8')).toContain('mouse-repeat-toggle');
  expect(readFileSync('game-overlay.html', 'utf8')).toContain('keyboard-repeat-toggle');
});
