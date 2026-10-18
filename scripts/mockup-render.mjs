// scripts/mockup-render.mjs
// Снимки прототипов интерфейса (docs/prototypes, docs/mockups) и машинная проверка вёрстки.
//
// Стенд поднимает dev-сервер Vite (или берёт уже работающий), открывает прототип в headless
// Edge, снимает его целиком или по селектору и проверяет то же, что и scripts/ui-shots.mjs:
// переполнение, слишком мелкий текст, кнопки без доступного имени, обрезанный текст.
// Дополнительно для прототипов: подключены ли токены темы и не записаны ли цвета инлайном
// вместо переменных.
//
// Запуск:
//   npm run mockups                                  все прототипы, тёмная тема
//   npm run mockups -- docs/prototypes/finance-layouts.html
//   npm run mockups -- finance --clip .variant --format webp
//
// Требуется установленный Microsoft Edge (или Chrome) — приложение живёт в WebView2,
// поэтому снимки в Edge ближе всего к тому, что видит пользователь.
// В приложении только тёмная тема (color-scheme: dark), --theme light пока ничего не меняет.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUED_FLAGS = ['out', 'url', 'theme', 'clip', 'format', 'width', 'height', 'cdp-port'];

/** Разбор аргументов: `--имя значение` и `--имя` без значения; остальное — файлы. */
const flags = {};
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const item = args[i];
  const match = item.match(/^--([a-z-]+)$/);
  if (!match) {
    positionals.push(item);
    continue;
  }
  const name = match[1];
  const next = args[i + 1];
  if (VALUED_FLAGS.includes(name) && next !== undefined && !next.startsWith('--')) {
    flags[name] = next;
    i++;
  } else {
    flags[name] = true;
  }
}
const arg = (name, fallback) => (flags[name] === undefined ? fallback : flags[name]);
const flag = name => flags[name] === true;

// Прототипы живут здесь. docs/screenshots — снимки настоящего приложения, их не трогаем.
const PROTOTYPE_DIRS = ['docs/prototypes', 'docs/mockups'];
const OUT = resolve(ROOT, arg('out', 'docs/mockups/shots'));
const URL_BASE = arg('url', 'http://localhost:1420');
const THEME = arg('theme', 'dark');
const CLIP = arg('clip', '');
const FORMAT = arg('format', 'png');
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '960'));
const CDP_PORT = Number(arg('cdp-port', '9334'));
const KEEP = flag('keep');
const STRICT = flag('strict');
const MAX_SHOT_HEIGHT = 12000;

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  const found = BROWSERS.find(p => p && existsSync(p));
  if (!found) throw new Error('Не найден Edge/Chrome. Укажите путь через BROWSER_PATH');
  return found;
}

/** Все .html прототипов, кроме папки со снимками. */
function allPrototypes() {
  const files = [];
  for (const dir of PROTOTYPE_DIRS) {
    const abs = resolve(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (extname(name) !== '.html' || !statSync(full).isFile()) continue;
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * Аргументы позиционные: путь от корня, либо имя файла («finance», «calendar-variants»).
 * Имя ищем в папках прототипов — сначала точное совпадение, потом по вхождению.
 */
function resolveTargets(wanted) {
  const all = allPrototypes();
  if (!wanted.length) return { out: all, missing: [] };

  const out = [];
  const missing = [];
  for (const item of wanted) {
    const asPath = resolve(ROOT, item);
    if (existsSync(asPath) && statSync(asPath).isFile()) {
      out.push(asPath);
      continue;
    }
    const key = basename(item)
      .replace(/\.html$/i, '')
      .toLowerCase();
    const exact = all.find(f => basename(f).toLowerCase() === `${key}.html`);
    const loose = all.find(f => basename(f).toLowerCase().includes(key));
    if (exact) out.push(exact);
    else if (loose) out.push(loose);
    else missing.push(item);
  }
  return { out: [...new Set(out)], missing };
}

/** Минимальный CDP-клиент поверх встроенного в Node WebSocket — тот же, что в ui-shots.mjs. */
function cdp(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve: ok, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : ok(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((ok, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve: ok, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function devServerAlive(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDevServer(url, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await devServerAlive(url)) return;
    await sleep(700);
  }
  throw new Error(`Dev-сервер не ответил за ${timeoutMs} мс: ${url}`);
}

/**
 * Проверки страницы. Почти те же, что в scripts/ui-shots.mjs, но про прототип:
 * вместо содержимого разделов приложения — структура страницы, токены темы и цвета инлайном.
 * Вызывается в браузере, поэтому здесь только текст выражения.
 */
const AUDIT = `(() => {
  const out = { overflow: [], tiny: [], unlabeled: [], truncated: [], inlineColors: [], tokens: '', variants: 0, nodes: 0, height: 0 };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const docW = document.documentElement.clientWidth;

  out.tokens = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  out.nodes = document.querySelectorAll('body *').length;
  out.variants = document.querySelectorAll('.variant').length;
  out.height = Math.round(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));

  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    out.overflow.push({ what: 'document', scrollWidth: document.documentElement.scrollWidth, inner: window.innerWidth });
  }

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > docW + 1 || r.left < -1) && out.overflow.length < 20) {
      out.overflow.push({ what: label(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const s = getComputedStyle(el);
    const fs = parseFloat(s.fontSize);
    if (fs && fs < 11 && el.textContent.trim() && el.children.length === 0 && out.tiny.length < 15) {
      out.tiny.push({ what: label(el), fontSize: fs, text: el.textContent.trim().slice(0, 40) });
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (!name && out.unlabeled.length < 15) out.unlabeled.push(label(el));
    }
    const inline = el.getAttribute('style') || '';
    if (inline && /#[0-9a-f]{3,8}\\b|rgba?\\(/i.test(inline) && out.inlineColors.length < 10) {
      out.inlineColors.push({ what: label(el), style: inline.slice(0, 70) });
    }
  }

  out.truncated = [...document.querySelectorAll('h1, h2, h3, strong, b, .stat-value, .tag, .tab')]
    .filter((el) => visible(el) && el.scrollWidth > el.clientWidth + 2)
    .map((el) => label(el) + ' — ' + el.textContent.trim().slice(0, 30))
    .slice(0, 15);

  return out;
})()`;

async function main() {
  const { out: targets, missing } = resolveTargets(positionals);
  if (!targets.length) {
    throw new Error(
      'Прототипы не найдены. Положите .html в ' + PROTOTYPE_DIRS.join(' или ') + ' или укажите файл аргументом.'
    );
  }
  for (const item of missing || []) console.warn('[mockup-render] не найдено:', item);

  mkdirSync(OUT, { recursive: true });
  const profileDir = join(ROOT, 'node_modules/.cache/mockup-render-profile');
  rmSync(profileDir, { recursive: true, force: true });

  if (THEME !== 'dark') {
    console.warn(
      '[mockup-render] в приложении только тёмная тема (color-scheme: dark) — атрибут data-theme ничего не переключает'
    );
  }
  if (!['png', 'webp'].includes(FORMAT)) throw new Error('--format: только png или webp');

  const devAlreadyRunning = await devServerAlive(URL_BASE);
  /** @type {import('node:child_process').ChildProcess | null} */
  let dev = null;
  const stopDev = () => {
    if (!dev) return; // чужой сервер не трогаем: его запустил пользователь
    try {
      dev.kill();
    } catch {
      /* уже остановлен */
    }
    if (process.platform === 'win32' && dev.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* уже остановлен */
      }
    }
  };
  process.on('exit', stopDev);
  process.on('SIGINT', () => {
    stopDev();
    process.exit(130);
  });

  if (devAlreadyRunning) {
    console.log('[mockup-render] dev-сервер уже работает, снимаем с него:', URL_BASE);
  } else {
    console.log('[mockup-render] старт Vite…');
    // Vite запускаем самим Node, а не через npx с shell: на Windows оболочка становится
    // родителем процесса, kill() берёт только её, а порт остаётся занят (то же, что в ui-shots).
    const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    dev = spawn(process.execPath, [viteBin, '--port', '1420', '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore'
    });
  }

  let browser = null;
  const rows = [];
  try {
    await waitForDevServer(URL_BASE);
    console.log('[mockup-render] Vite готов:', URL_BASE);

    browser = spawn(
      findBrowser(),
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profileDir}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        '--hide-scrollbars=false',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--force-device-scale-factor=1',
        '--force-color-profile=srgb',
        // Доп. флаги браузера, например в контейнере: BROWSER_ARGS="--no-sandbox --disable-gpu"
        ...(process.env.BROWSER_ARGS ? process.env.BROWSER_ARGS.split(' ').filter(Boolean) : []),
        'about:blank'
      ],
      { stdio: 'ignore' }
    );

    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const list = await res.json();
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        await sleep(500);
      }
    }
    if (!target) throw new Error('Не удалось подключиться к браузеру по CDP');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('CDP WebSocket не открылся')), { once: true });
    });
    const send = cdp(ws);
    await send('Page.enable');
    await send('Runtime.enable');

    // Ошибки страницы собираем до загрузки модулей прототипа.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__tfErrors = [];
        window.addEventListener('error', (e) => window.__tfErrors.push('error: ' + (e.message || e.type)));
        window.addEventListener('unhandledrejection', (e) => window.__tfErrors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));`
    });

    for (const file of targets) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const url = `${URL_BASE}/${rel}`;
      await send('Page.navigate', { url });
      await waitForRender(send);
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(THEME)}; true`,
        returnByValue: true
      });
      await sleep(150);

      const errors = await send('Runtime.evaluate', { expression: 'window.__tfErrors || []', returnByValue: true });
      const audited = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
      const audit = audited.result.value;
      if (!audit) throw new Error('Аудит не отработал на ' + rel);

      const shots = await capture(send, audit, basename(file, '.html'));

      rows.push({
        rel,
        url,
        shots,
        errors: errors.result.value || [],
        audit,
        problems:
          (errors.result.value || []).length +
          audit.overflow.length +
          audit.tiny.length +
          audit.unlabeled.length +
          audit.truncated.length +
          audit.inlineColors.length +
          (audit.tokens ? 0 : 1)
      });
    }

    report(rows);
    ws.close();

    if (STRICT && rows.some(r => r.problems > 0)) process.exitCode = 1;
    if (KEEP && !devAlreadyRunning) console.log('[mockup-render] dev-сервер оставлен работать:', URL_BASE);
  } finally {
    stopDev();
    if (browser) {
      try {
        browser.kill();
      } catch {
        /* уже остановлен */
      }
    }
    // Профиль браузера освобождается не мгновенно; временная папка не критична для результата
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(400);
      }
    }
  }
}

/** Ждём readyState и шрифты: иначе снимок может сняться до отрисовки. */
async function waitForRender(send) {
  for (let i = 0; i < 80; i++) {
    const { result } = await send('Runtime.evaluate', {
      expression: `document.readyState === 'complete' && document.body !== null && document.body.children.length > 0`,
      returnByValue: true
    });
    if (result.value) {
      await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
      await sleep(200);
      return;
    }
    await sleep(200);
  }
  console.warn('[mockup-render] страница не сообщила о готовности — снимаем как есть');
}

/**
 * Снимки: либо по селектору (по одному файлу на каждое совпадение — удобно фотографировать
 * каждый вариант отдельно), либо страница целиком.
 */
async function capture(send, audit, name) {
  const clips = [];
  if (CLIP) {
    const found = await send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll(${JSON.stringify(CLIP)})).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.floor(r.left + scrollX), y: Math.floor(r.top + scrollY), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      })`,
      returnByValue: true
    });
    const list = (found.result.value || []).filter(r => r.width > 0 && r.height > 0);
    if (!list.length) console.warn('[mockup-render] селектор не нашёл элементов:', CLIP);
    else clips.push(...list);
  }
  if (!clips.length) {
    const metrics = await send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const height = Math.min(Math.ceil(size.height), MAX_SHOT_HEIGHT);
    if (size.height > MAX_SHOT_HEIGHT) {
      console.warn(`[mockup-render] страница выше ${MAX_SHOT_HEIGHT}px — снимок обрезан снизу`);
    }
    clips.push({ x: 0, y: 0, width: Math.ceil(size.width), height });
  }

  const shots = [];
  for (const [i, clip] of clips.entries()) {
    const shot = await send('Page.captureScreenshot', {
      format: FORMAT,
      quality: FORMAT === 'webp' ? 92 : undefined,
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 }
    });
    const suffix = clips.length > 1 ? `.${i + 1}` : '';
    const path = join(OUT, `${name}.${THEME}${suffix}.${FORMAT}`);
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    shots.push({ path: relative(ROOT, path).split(sep).join('/'), width: clip.width, height: clip.height });
  }
  return shots;
}

function report(rows) {
  const totalShots = rows.reduce((n, r) => n + r.shots.length, 0);
  console.log(
    `\n[mockup-render] ${rows.length} файл(ов), ${WIDTH}×${HEIGHT}, тема ${THEME}, ${FORMAT} → ${relative(ROOT, OUT).split(sep).join('/')}\n`
  );

  for (const row of rows) {
    console.log(row.rel);
    for (const shot of row.shots) console.log(`  снимок: ${shot.path}  ${shot.width}×${shot.height}`);
    const a = row.audit;
    console.log(
      `  токены темы: ${a.tokens ? 'подключены' : 'НЕ подключены — variables.css не загружен'} · узлов ${a.nodes} · вариантов ${a.variants} · высота ${a.height}px`
    );
    console.log(`  открыть: ${row.url}`);
    console.log(
      `  ошибок страницы: ${row.errors.length} · выходит за окно: ${a.overflow.length} · текст <11px: ${a.tiny.length} · кнопки без подписи: ${a.unlabeled.length} · обрезанный текст: ${a.truncated.length} · цвета инлайном: ${a.inlineColors.length}`
    );
    const detail = [
      ...row.errors.map(e => ['ошибка страницы', e]),
      ...a.overflow.map(o => ['выходит за окно', `${o.what} (${o.left}…${o.right})`]),
      ...a.tiny.map(o => ['мелкий текст', `${o.what} ${o.fontSize}px — «${o.text}»`]),
      ...a.unlabeled.map(o => ['кнопка без подписи', o]),
      ...a.truncated.map(o => ['обрезанный текст', o]),
      ...a.inlineColors.map(o => ['цвет инлайном', `${o.what} — ${o.style}`])
    ];
    for (const [what, text] of detail.slice(0, 25)) console.log(`    · ${what}: ${text}`);
    if (detail.length > 25) console.log(`    · … ещё ${detail.length - 25}`);
    console.log('');
  }

  const problems = rows.reduce((n, r) => n + r.problems, 0);
  console.log(`ИТОГ: снимков ${totalShots}, проблем ${problems}`);
  if (!problems) console.log('Вёрстка чистая: токены на месте, переполнений и мелкого текста нет.');
}

main().catch(e => {
  console.error('[mockup-render] ошибка:', e.message);
  process.exitCode = 1;
});
