// Временный стенд: снимает макеты календаря (docs/mockups/calendar-variants.html) в PNG.
// Запускается отдельным Vite на своём порту, чтобы не мешать рабочему dev-серверу.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = 'http://localhost:1421';
const PORT = 9336;
const OUT = join(ROOT, 'docs/mockups');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function cdp(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    waiting.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

mkdirSync(OUT, { recursive: true });
const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const dev = spawn(process.execPath, [viteBin, '--port', '1421', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
const stop = () => {
  try { dev.kill(); } catch { /* уже */ }
  if (process.platform === 'win32' && dev.pid) {
    try { spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* уже */ }
  }
};
process.on('exit', stop);

const profileDir = join(ROOT, 'node_modules/.cache/mockup-profile');
rmSync(profileDir, { recursive: true, force: true });
let browser = null;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL_BASE)).ok) break; } catch { /* ждём */ }
    await sleep(700);
  }
  browser = spawn(BROWSERS.find(p => existsSync(p)), [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1440,2400', '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run',
    `${URL_BASE}/docs/mockups/calendar-variants.html`
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { await sleep(500); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', () => fail(new Error('ws')), { once: true }); });
  const send = cdp(ws);
  await send('Runtime.enable');
  await sleep(1200);

  const shots = [
    ['#col1', 'calendar-week-a.png'],
    ['.variant:nth-of-type(2)', 'calendar-mini-b.png']
  ];
  for (const [sel, file] of shots) {
    const box = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(sel === '.variant:nth-of-type(2)' ? '.variant:nth-of-type(2) .card' : sel === '#col1' ? '.variant:nth-of-type(1) .card' : sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
      })()`,
      returnByValue: true
    });
    const b = box.result.value;
    if (!b) { console.warn('не найден селектор', sel); continue; }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
      captureBeyondViewport: true
    });
    writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'));
    console.log('[mockup]', file, `${b.w}x${b.h}`);
  }
  ws.close();
} finally {
  stop();
  if (browser) { try { browser.kill(); } catch { /* уже */ } }
}
