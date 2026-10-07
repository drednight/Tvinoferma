// scripts/ui-shots.mjs
// Снимки интерфейса Твинофермы без Tauri: поднимает dev-сервер Vite, открывает его в headless Edge,
// кладёт в localStorage демонстрационные данные (tests/fixtures/ui-demo-state.json) и фотографирует вкладки.
//
// Запуск: node scripts/ui-shots.mjs [--out docs/screenshots] [--url http://localhost:1420] [--theme dark]
// Для гайдов: node scripts/ui-shots.mjs --guides (WebP в public/assets/guides).
// Требуется установленный Microsoft Edge (или Chrome) — приложение живёт в WebView2, поэтому снимки
// в Edge ближе всего к тому, что видит пользователь.
//
// Данные в снимках вымышленные: ников и паролей реальных игроков тут нет.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const GUIDES = args.includes('--guides');
const OUT = resolve(ROOT, arg('out', GUIDES ? 'public/assets/guides' : 'docs/screenshots'));
const URL_BASE = arg('url', 'http://localhost:1420');
const THEME = arg('theme', 'dark');
const ONLY = arg('only', '').split(',').filter(Boolean);
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '960'));
const PORT = 9333;

const TABS = GUIDES ? [
  ['characters', 'characters'],
  ['parties', 'parties'],
  ['today', 'today'],
  ['marathons', 'marathons'],
  ['characters', 'scripts', 'scripts'],
  ['characters', 'character-form', 'character-form'],
  ...['promo-dialog', 'transfer-dialog', 'shop-dialog', 'sync-task'].map(name => ['characters', name, name]),
  ['characters', 'character-profile', 'character-profile'],
  ['marathons', 'marathon-wizard', 'marathon-wizard'],
  ['today', 'planner-entry', 'planner-entry'],
  ['settings', 'gamecenters', 'gamecenters'],
  ['settings', 'settings-app', '#settings-app'],
  ['settings', 'settings-data', '#settings-data'],
  ['settings', 'settings-sync', '#settings-sync'],
  ['settings', 'settings-updates', '#settings-update-panel'],
  ['settings', 'settings-security', '#settings-security'],
  ['settings', 'settings-danger', '#danger-zone'],
] : [
  ['today', 'today'],
  ['characters', 'characters'],
  ['parties', 'parties'],
  ['marathons', 'marathons'],
  ['settings', 'settings']
];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  // Путь можно задать переменной окружения: BROWSER_PATH=/usr/bin/chromium node scripts/ui-shots.mjs
  const fromEnv = process.env.BROWSER_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const found = BROWSERS.find((p) => existsSync(p));
  if (!found) throw new Error('Не найден Edge/Chrome. Укажите путь вручную в scripts/ui-shots.mjs');
  return found;
}

function demoState() {
  const fixture = join(ROOT, 'tests/fixtures/ui-demo-state.json');
  const data = JSON.parse(readFileSync(fixture, 'utf8'));
  data.settings ||= {};
  data.settings.ui = { ...data.settings.ui, onboardingSeen: true };
  // Фикстура учебная: назначаем задания участникам и приводим дату сверки к текущему формату.
  for (const m of data.marathons || []) {
    if (m.kind === 'series') continue;
    if (typeof m.lastSync === 'string') m.lastSync = { at: m.lastSync, changes: [], errors: [] };
    for (const id of m.participantIds || []) {
      if (!m.assignments?.[id]) {
        m.assignments ||= {};
        m.assignments[id] = (m.tasks || []).map(t => t.id);
      }
    }
  }
  return JSON.stringify(data);
}

/** Минимальный CDP-клиент поверх встроенного в Node WebSocket. */
function cdp(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function waitForDevServer(url, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(700);
  }
  throw new Error(`Dev-сервер не ответил за ${timeoutMs} мс: ${url}`);
}

/** Уже поднят ли dev-сервер по этому адресу (например, запущен `npm run tauri dev`). */
async function devServerAlive(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profileDir = join(ROOT, 'node_modules/.cache/ui-shots-profile');
  rmSync(profileDir, { recursive: true, force: true });

  // Порт может быть занят уже запущенным `npm run tauri dev` — тогда свой сервер не поднимаем,
  // а снимаем снимки с того, что работает. Иначе стенд падал бы с «Port 1420 is already in use».
  const devAlreadyRunning = await devServerAlive(URL_BASE);
  /** @type {import('node:child_process').ChildProcess | null} */
  let dev = null;
  const stopDev = () => {
    if (!dev) return;   // чужой сервер не трогаем: его запустил пользователь
    try { dev.kill(); } catch { /* уже остановлен */ }
    if (process.platform === 'win32' && dev.pid) {
      try { spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* уже остановлен */ }
    }
  };
  process.on('exit', stopDev);
  process.on('SIGINT', () => { stopDev(); process.exit(130); });

  if (devAlreadyRunning) {
    console.log('[ui-shots] dev-сервер уже работает, снимаем с него:', URL_BASE);
  } else {
    console.log('[ui-shots] старт Vite…');
    // Запускаем Vite самим Node, а не через `npx` с shell: на Windows оболочка `cmd.exe` становится
    // родителем процесса, `kill()` убивает только её, а Vite продолжает держать порт 1420 после
    // завершения скрипта. Тогда следующий запуск (`npm run tauri dev`) падает с «Port already in use».
    const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    dev = spawn(process.execPath, [viteBin, '--port', '1420', '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore'
    });
  }

  let browser = null;
  try {
    await waitForDevServer(URL_BASE);
    console.log('[ui-shots] Vite готов:', URL_BASE);

    browser = spawn(findBrowser(), [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
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
    ], { stdio: 'ignore' });

    let targets = null;
    for (let i = 0; i < 60 && !targets; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await res.json();
        targets = list.find((t) => t.type === 'page' && String(t.url).startsWith(URL_BASE)) || list.find((t) => t.type === 'page');
      } catch {
        await sleep(500);
      }
    }
    if (!targets?.webSocketDebuggerUrl) throw new Error('Не удалось подключиться к браузеру по CDP');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('CDP WebSocket не открылся')), { once: true });
    });
    const send = cdp(ws);
    await send('Page.enable');
    await send('Runtime.enable');

    // Ждём, пока приложение действительно загрузится. Проверять появление `.empty-state` нельзя:
    // он есть в статической разметке раздела «Марафоны», поэтому ожидание завершалось бы сразу,
    // до чтения данных. Признак готовности — отрисованный список персонажей или счётчик в навигации.
    const settle = async () => {
      for (let i = 0; i < 60; i++) {
        const { result } = await send('Runtime.evaluate', {
          expression: `(() => {
            const grid = document.getElementById('character-grid');
            const counter = document.querySelector('.tab-count:not([hidden])');
            const runtime = document.getElementById('storage-runtime')?.textContent || '';
            const booted = runtime && runtime !== 'Загрузка...';
            return (!!grid && grid.children.length > 0) || !!counter || booted;
          })()`,
          returnByValue: true
        });
        if (result.value) { await sleep(400); return; }
        await sleep(300);
      }
      console.warn('[ui-shots] приложение не отрисовалось за отведённое время');
    };

    // Данные и сбор ошибок устанавливаются ДО загрузки модулей приложения.
    // Иначе первый пустой boot() мог сохраниться поверх фикстуры прямо перед перезагрузкой.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('tvinoferma_state_v1', ${JSON.stringify(demoState())});
        window.__tfErrors = [];
        window.addEventListener('error', (e) => window.__tfErrors.push('error: ' + (e.message || e.type)));
        window.addEventListener('unhandledrejection', (e) => window.__tfErrors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));`
    });
    await send('Page.navigate', { url: URL_BASE });
    await sleep(1500);
    await settle();

    await send('Runtime.evaluate', { expression: `import('/js/core/ui.js').then(({ closeModal }) => { closeModal(); return true; })`, awaitPromise: true });

    // Ошибки страницы: приложение должно не только отрисоваться, но и работать без сбоев
    const errs = await send('Runtime.evaluate', { expression: 'window.__tfErrors || []', returnByValue: true });
    if (errs.result.value?.length) {
      throw new Error(`Ошибки страницы: ${JSON.stringify(errs.result.value)}`);
    } else {
      console.log('[ui-shots] ошибок страницы нет');
    }

    // Состояние после загрузки: видно, прочитались ли демонстрационные данные
    const boot = await send('Runtime.evaluate', {
      expression: `(() => {
        const raw = localStorage.getItem('tvinoferma_state_v1');
        let chars = 0;
        try { chars = JSON.parse(raw || '{}').characters?.length ?? 0; } catch {}
        return {
          fixtureChars: chars,
          cards: document.querySelectorAll('.character-card').length,
          gridText: (document.querySelector('#character-grid')?.textContent || '').trim().slice(0, 60),
          storageMode: document.querySelector('#storage-runtime')?.textContent || ''
        };
      })()`,
      returnByValue: true
    });
    console.log('[ui-shots] состояние:', JSON.stringify(boot.result.value));
    const expectedChars = JSON.parse(demoState()).characters.length;
    if (boot.result.value?.fixtureChars !== expectedChars || boot.result.value?.cards !== expectedChars) throw new Error('Демонстрационные персонажи не загрузились');

    if (THEME !== 'dark') {
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(THEME)}; true`,
        returnByValue: true
      });
      await sleep(200);
    }

    const formShots = {
      ...Object.fromEntries(['promo-dialog', 'transfer-dialog', 'shop-dialog', 'sync-task'].map(name => [name, `import('/scripts/ui-demo-scripts.mjs').then(({ openScriptPreview }) => openScriptPreview('${name}'))`])),
      'character-form': `import('/js/modules/characters/formEditor.js').then(({ openCharacterForm }) => openCharacterForm())`,
      'character-profile': `(async () => { const { state } = await import('/js/core/state.js'); const { openCharacterProfile } = await import('/js/modules/characters/profileView.js'); openCharacterProfile(state.characters[0]); })()`,
      'marathon-wizard': `import('/js/modules/marathons/wizard.js').then(({ openMarathonWizard }) => { openMarathonWizard(); document.querySelector('[data-src="manual"]').click(); document.querySelector('[data-act="next"]').click(); })`,
      'planner-entry': `(async () => { const { mskDate } = await import('/js/core/msk.js'); const { openPlannerDay } = await import('/js/modules/dashboard/plannerView.js'); openPlannerDay(mskDate()); document.querySelector('[data-planner-add]').click(); })()`,
      'gamecenters': `import('/js/modules/launcher/gcSettingsModal.js').then(({ openGameCentersModal }) => openGameCentersModal())`,
    };
    for (const [tab, file, target] of TABS.filter(([, file]) => !ONLY.length || ONLY.includes(file))) {
      await send('Runtime.evaluate', {
        expression: `import('/js/core/ui.js').then(({ closeModal }) => { document.querySelectorAll('.tf-close').forEach(button => button.click()); closeModal(); window.__tfShotCleanup?.(); window.__tfShotCleanup = null; return true; })`,
        awaitPromise: true
      });
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.topbar').style.visibility = ''; document.querySelector('.tab[data-tab="${tab}"]')?.click(); window.scrollTo(0, 0); true`,
        returnByValue: true
      });
      await sleep(700);
      let clip;
      if (formShots[target]) {
        const opened = await send('Runtime.evaluate', { expression: formShots[target], awaitPromise: true });
        if (opened.exceptionDetails) throw new Error(`Не удалось открыть ${target}: ${opened.exceptionDetails.text}`);
        await sleep(600);
        const measured = await send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector('.modal-container'); if (!el) throw new Error('Форма не открылась'); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }; })()`, returnByValue: true
        });
        if (measured.exceptionDetails || !measured.result?.value) throw new Error(`Форма ${target} не открылась`);
        clip = measured.result.value;
      } else if (target === 'scripts') {
        await send('Runtime.evaluate', { expression: `document.getElementById('fab-main-btn')?.click(); document.querySelector('[data-fab-action="scripts"]')?.click(); true` });
        await sleep(400);
      } else if (target) {
        const region = await send('Runtime.evaluate', {
          expression: `(() => {
            document.querySelectorAll('[data-section="settings"] details').forEach(el => { el.open = false; });
            const el = document.querySelector(${JSON.stringify(target)});
            if (!el) throw new Error('Не найден раздел снимка: ' + ${JSON.stringify(target)});
            if (el.tagName === 'DETAILS') el.open = true;
            // В группе данных показываем действия резервного копирования; в приложении — запуск игры.
            el.querySelector('#settings-backups, #settings-launcher, #log-hub-panel')?.setAttribute('open', '');
            document.querySelector('.topbar').style.visibility = 'hidden';
            const r = el.getBoundingClientRect();
            return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 };
          })()`, returnByValue: true
        });
        clip = region.result.value;
        if (!clip?.width || !clip?.height) throw new Error('Пустой раздел снимка: ' + target);
        await sleep(500); // toggle панелей успевает отрисовать журнал и изменить высоту блока
        const measured = await send('Runtime.evaluate', {
          expression: `(() => { const r = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }; })()`,
          returnByValue: true
        });
        clip = measured.result.value;
      }
      const shot = await send('Page.captureScreenshot', { format: GUIDES ? 'webp' : 'png', ...(GUIDES ? { quality: 90 } : {}), captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) });
      const path = join(OUT, `${file}.${GUIDES ? 'webp' : 'png'}`);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      console.log('[ui-shots]', path.replace(ROOT + '\\', ''));
    }

    if (GUIDES) { ws.close(); return; }

    // Аудит вёрстки: переполнения, наложения, слишком мелкий текст, недоступные кнопки.
    // Проверка машинная — она не заменяет взгляд, но ловит то, что легко пропустить на снимке.
    const audit = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = { overflow: [], overlap: [], tiny: [], unlabeled: [], contrast: [] };
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
        };
        const label = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');

        // Горизонтальное переполнение окна
        if (document.documentElement.scrollWidth > window.innerWidth + 1) {
          out.overflow.push({ what: 'document', scrollWidth: document.documentElement.scrollWidth, inner: window.innerWidth });
        }

        for (const el of document.querySelectorAll('body *')) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          // Элемент вылезает за правый/левый край окна
          if (r.right > window.innerWidth + 1 || r.left < -1) {
            out.overflow.push({ what: label(el), left: Math.round(r.left), right: Math.round(r.right) });
            if (out.overflow.length > 25) break;
          }
          const s = getComputedStyle(el);
          // Слишком мелкий текст
          const fs = parseFloat(s.fontSize);
          if (fs && fs < 11 && el.textContent.trim() && el.children.length === 0) {
            out.tiny.push({ what: label(el), fontSize: fs, text: el.textContent.trim().slice(0, 40) });
            if (out.tiny.length > 15) break;
          }
          // Кнопка без доступного имени
          if (el.tagName === 'BUTTON' && visible(el)) {
            const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
            if (!name) out.unlabeled.push(label(el));
          }
        }

        // Наложение подписей состояния на ник в карточке (частая ошибка при узких карточках)
        for (const card of document.querySelectorAll('.character-card')) {
          const nick = card.querySelector('.char-nick');
          const side = card.querySelector('.card-head-side');
          if (!nick || !side) continue;
          const a = nick.getBoundingClientRect(), b = side.getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 2 && overlapY > 2) {
            out.overlap.push({ card: card.dataset.charId, nick: nick.textContent.trim(), overlapX: Math.round(overlapX) });
          }
        }

        // Обрезанный текст (многоточие) там, где он нежелателен
        out.truncated = [...document.querySelectorAll('.stat-value, .tab, .section-head h2, .pt-title h3, .mr-card-title')]
          .filter(el => el.scrollWidth > el.clientWidth + 2)
          .map(label).slice(0, 15);

        // Сколько чего отрисовано в каждом разделе: снимок не должен быть пустым
        out.content = {
          characters: document.querySelectorAll('.character-card').length,
          parties: document.querySelectorAll('.pt-card').length,
          marathons: document.querySelectorAll('.mr-card').length,
          settingsPanels: document.querySelectorAll('.settings-col > .panel').length,
          tabCounters: [...document.querySelectorAll('.tab-count')].map(el => el.hidden ? null : el.textContent),
          // Экран «Сегодня»: сколько строк требуют внимания и сколько марафонов идёт
          todayCards: document.querySelectorAll('[data-today] .today-card').length,
          todayAttention: document.querySelectorAll('[data-today] .today-row').length,
          // Календарь: ячейки со шкалой дня и блоки записей по времени (должны быть видны,
          // иначе раскладка по времени сломалась и записи снова идут просто списком)
          plannerDays: document.querySelectorAll('.planner-day:not(.is-empty)').length,
          plannerScales: document.querySelectorAll('.planner-day-scale').length,
          plannerBlocks: document.querySelectorAll('.planner-block').length,
          plannerChips: document.querySelectorAll('.planner-chip').length,
          // Вид «Неделя»: колонки дней, блоки на общей шкале, часы оси и линия «сейчас»
          weekDays: document.querySelectorAll('.cal-day').length,
          weekBlocks: document.querySelectorAll('.cal-block').length,
          weekHours: document.querySelectorAll('.cal-hour').length,
          weekNowLine: document.querySelectorAll('.cal-now').length,
          weekTitle: (document.querySelector('[data-planner] .planner-nav strong')?.textContent || '').trim()
        };

        // Геометрия календаря: блоки записи должны стоять на шкале ПО ВРЕМЕНИ, а не подряд сверху.
        // Сравниваем объявленные проценты, а не пиксели: сутки в ячейке занимают десятки пикселей,
        // поэтому два блока в 30 минутах друг от друга физически отличаются меньше чем на пиксель —
        // это предел разрешения мини-шкалы, а не ошибка раскладки. Точные минуты видны в окне дня.
        out.calendar = { checked: [], problems: [] };
        for (const day of document.querySelectorAll('.planner-day:not(.is-empty)')) {
          const blocks = [...day.querySelectorAll('.planner-block')];
          if (blocks.length < 2) continue;
          const scale = day.querySelector('.planner-day-scale');
          const scaleBox = scale.getBoundingClientRect();
          const tops = blocks.map(b => parseFloat(String(b.style.top)) || 0);
          const date = day.dataset.plannerDate;
          // Позиции в процентах должны быть разными И совпадать с порядком по времени начала
          const titles = blocks.map(b => (b.getAttribute('title') || '').slice(0, 5));
          out.calendar.checked.push({ date, blocks: blocks.length, tops, titles });

          if (new Set(tops).size < 2) {
            out.calendar.problems.push('день ' + date + ': блоки объявлены на одной позиции — раскладка по времени не работает');
          }
          // Верх блока должен расти вместе со временем начала
          for (let i = 1; i < blocks.length; i++) {
            if (tops[i] < tops[i - 1]) {
              out.calendar.problems.push('день ' + date + ': блоки идут не по порядку времени');
              break;
            }
          }
          for (const b of blocks) {
            const r = b.getBoundingClientRect();
            if (r.top < scaleBox.top - 1 || r.bottom > scaleBox.bottom + 1) {
              out.calendar.problems.push('день ' + date + ': блок выходит за шкалу дня');
              break;
            }
          }
          const chip = day.querySelector('.planner-chip');
          if (chip && chip.getBoundingClientRect().bottom > scaleBox.top + 1) {
            out.calendar.problems.push('день ' + date + ': плашка «весь день» накладывается на шкалу');
          }
          if (out.calendar.checked.length >= 6) break;
        }

        // Геометрия вида «Неделя»: у блоков разное время начала — значит, разный верх,
        // и он совпадает с порядком по времени. Высота — по длительности, не одинаковая.
        out.week = { checked: [], problems: [] };
        for (const day of document.querySelectorAll('.cal-day')) {
          const blocks = [...day.querySelectorAll('.cal-block')];
          if (blocks.length < 2) continue;
          const tops = blocks.map(b => parseFloat(String(b.style.top)) || 0);
          const heights = blocks.map(b => parseFloat(String(b.style.height)) || 0);
          const times = blocks.map(b => (b.getAttribute('title') || '').slice(0, 5));
          out.week.checked.push({ blocks: blocks.length, tops, heights, times });
          if (new Set(tops).size < 2) {
            out.week.problems.push('неделя: блоки стоят на одной высоте — раскладка по времени не работает');
          }
          for (let i = 1; i < blocks.length; i++) {
            if (tops[i] < tops[i - 1]) { out.week.problems.push('неделя: блоки идут не по порядку времени'); break; }
          }
          if (new Set(heights).size < 2 && blocks.length >= 2) {
            out.week.problems.push('неделя: у блоков одинаковая высота — длительность не учитывается');
          }
        }
        // Ось времени должна быть ровно 24 часа, а блоки — не вылезать за сутки
        if (document.querySelectorAll('.cal-hour').length && document.querySelectorAll('.cal-hour').length !== 24) {
          out.week.problems.push('неделя: ось времени не 24 часа');
        }
        const trackH = document.querySelector('.cal-day-track')?.getBoundingClientRect().height || 0;
        for (const b of document.querySelectorAll('.cal-block')) {
          const r = b.getBoundingClientRect();
          if (r.bottom > (document.querySelector('.cal-day-track')?.getBoundingClientRect().bottom || Infinity) + 1) {
            out.week.problems.push('неделя: блок выходит за пределы суток');
            break;
          }
        }
        out.week.trackHeight = Math.round(trackH);
        // Неделя не должна прокручиваться: сутки видны целиком. Проверяем, что внутренней
        // прокрутки нет ни у сетки, ни у страницы внутри блока календаря.
        const calWeek = document.querySelector('.cal-week');
        if (calWeek) {
          const cs = getComputedStyle(calWeek);
          if (calWeek.scrollHeight > calWeek.clientHeight + 1 && cs.overflowY === 'auto') {
            out.week.problems.push('неделя: появилась вертикальная прокрутка');
          }
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
            out.week.problems.push('неделя: у блока календаря задана прокрутка по вертикали');
          }
          out.week.calWeekHeight = Math.round(calWeek.getBoundingClientRect().height);
          out.week.overflowY = cs.overflowY;
        }
        // Марафон должен идти сплошной полосой: одна полоса шире одного дня
        out.week.spans = [...document.querySelectorAll('.cal-span')].map(s => {
          const r = s.getBoundingClientRect();
          const dayW = (document.querySelector('.cal-day')?.getBoundingClientRect().width) || 1;
          return {
            title: (s.getAttribute('title') || '').slice(0, 40),
            isMarathon: s.classList.contains('is-marathon'),
            daysWide: Math.round(r.width / dayW * 10) / 10,
            height: Math.round(r.height)
          };
        });
        const marathonSpans = out.week.spans.filter(s => s.isMarathon);
        if (!marathonSpans.length) out.week.problems.push('неделя: марафон не показан сплошной полосой');
        for (const s of marathonSpans) {
          if (s.daysWide < 2) out.week.problems.push('неделя: полоса марафона не тянется через дни');
        }

        return out;
      })()`,
      returnByValue: true
    });

    const a = audit.result.value;
    console.log('\n[ui-shots] аудит вёрстки:');    const report = (key, title) => console.log(`  ${title}: ${a[key]?.length ?? 0}`, (a[key]?.length ? JSON.stringify(a[key], null, 1) : ''));
    report('overflow', 'выходят за окно');
    report('overlap', 'наложения в карточках');
    report('tiny', 'текст мельче 11px');
    report('unlabeled', 'кнопки без подписи');
    report('truncated', 'обрезанный текст');
    console.log('  содержимое разделов:', JSON.stringify(a.content));
    console.log('  календарь, блоки по времени:', JSON.stringify(a.calendar?.checked ?? []));
    console.log(`  проблемы раскладки календаря: ${a.calendar?.problems?.length ?? 0}`, a.calendar?.problems?.length ? JSON.stringify(a.calendar.problems, null, 1) : '');
    console.log('  неделя, блоки:', JSON.stringify(a.week?.checked ?? []));
    console.log('  неделя, полосы «весь день»:', JSON.stringify(a.week?.spans ?? []));
    console.log(`  высота суток: ${a.week?.trackHeight ?? 0}px, высота календаря: ${a.week?.calWeekHeight ?? 0}px, overflow-y: ${a.week?.overflowY ?? '?'}`);
    console.log(`  проблемы вида «Неделя»: ${a.week?.problems?.length ?? 0}`, a.week?.problems?.length ? JSON.stringify(a.week.problems, null, 1) : '');
    if (THEME !== 'dark') console.log('  тема:', THEME);

    // Дополнительно — командная палитра (Ctrl+K): она должна открываться и искать команды
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.tab[data-tab="characters"]')?.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`,
      returnByValue: true
    });
    await sleep(700);
    const palette = await send('Runtime.evaluate', {
      expression: `(() => {
        const open = !!document.querySelector('.cp-overlay');
        const items = document.querySelectorAll('.cp-item').length;
        const input = document.querySelector('.cp-input');
        if (input) {
          input.value = 'проверить';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const filtered = document.querySelectorAll('.cp-item').length;
        const active = document.querySelector('.cp-item.is-active');
        return { open, items, filtered, active: active ? active.textContent.trim().slice(0, 40) : null };
      })()`,
      returnByValue: true
    });
    console.log('[ui-shots] командная палитра:', JSON.stringify(palette.result.value));
    const palShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, 'command-palette.png'), Buffer.from(palShot.data, 'base64'));
    console.log('[ui-shots]', join(OUT, 'command-palette.png').replace(ROOT + '\\', ''));
    // Закрываем палитру, чтобы она не попала на снимок профиля
    await send('Runtime.evaluate', {
      expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`,
      returnByValue: true
    });
    await sleep(300);

    // Дополнительно — раскрытый профиль персонажа (самый насыщенный экран)
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.tab[data-tab="characters"]')?.click();
        document.querySelector('.character-card')?.click(); true`,
      returnByValue: true
    });
    await sleep(900);
    const modal = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, 'character-profile.png'), Buffer.from(modal.data, 'base64'));
    console.log('[ui-shots]', join(OUT, 'character-profile.png').replace(ROOT + '\\', ''));
    ws.close();
  } finally {
    stopDev();
    if (browser) { try { browser.kill(); } catch { /* уже остановлен */ } }
    // Профиль браузера освобождается не мгновенно; его временная папка не критична для результата
    for (let i = 0; i < 10; i++) {
      try { rmSync(profileDir, { recursive: true, force: true }); break; } catch { await sleep(400); }
    }
  }
}

main().catch((e) => {
  console.error('[ui-shots] ошибка:', e.message);
  process.exitCode = 1;
});
