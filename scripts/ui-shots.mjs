// scripts/ui-shots.mjs
// Снимки интерфейса Твинофермы без Tauri: поднимает dev-сервер Vite, открывает его в headless Edge,
// кладёт в localStorage демонстрационные данные (tests/fixtures/ui-demo-state.json) и фотографирует вкладки.
//
// Запуск: node scripts/ui-shots.mjs [--out docs/screenshots] [--url http://localhost:1420] [--theme dark]
// Требуется установленный Microsoft Edge (или Chrome) — приложение живёт в WebView2, поэтому снимки
// в Edge ближе всего к тому, что видит пользователь.
//
// Данные в снимках вымышленные: ников и паролей реальных игроков тут нет.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = resolve(ROOT, arg('out', 'docs/screenshots'));
const URL_BASE = arg('url', 'http://localhost:1420');
const THEME = arg('theme', 'dark');
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '960'));
const PORT = 9333;

const TABS = [
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
  const found = BROWSERS.find((p) => existsSync(p));
  if (!found) throw new Error('Не найден Edge/Chrome. Укажите путь вручную в scripts/ui-shots.mjs');
  return found;
}

function demoState() {
  const fixture = join(ROOT, 'tests/fixtures/ui-demo-state.json');
  return readFileSync(fixture, 'utf8');
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profileDir = join(ROOT, 'node_modules/.cache/ui-shots-profile');
  rmSync(profileDir, { recursive: true, force: true });

  console.log('[ui-shots] старт Vite…');
  const dev = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', '1420', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });
  const stopDev = () => { try { dev.kill(); } catch { /* уже остановлен */ } };
  process.on('exit', stopDev);

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
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      URL_BASE
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

    // Демо-данные кладём в localStorage того же origin и перезагружаем страницу
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('tvinoferma_state_v1', ${JSON.stringify(demoState())});
        window.__tfErrors = [];
        window.addEventListener('error', (e) => window.__tfErrors.push('error: ' + (e.message || e.type)));
        window.addEventListener('unhandledrejection', (e) => window.__tfErrors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
        true`,
      returnByValue: true
    });
    await send('Page.navigate', { url: URL_BASE });
    await sleep(1500);
    await settle();

    // Ошибки страницы: приложение должно не только отрисоваться, но и работать без сбоев
    const errs = await send('Runtime.evaluate', { expression: 'window.__tfErrors || []', returnByValue: true });
    if (errs.result.value?.length) {
      console.log('[ui-shots] ошибки страницы:', JSON.stringify(errs.result.value, null, 1));
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

    if (THEME !== 'dark') {
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(THEME)}; true`,
        returnByValue: true
      });
      await sleep(200);
    }

    for (const [tab, file] of TABS) {
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.tab[data-tab="${tab}"]')?.click(); window.scrollTo(0, 0); true`,
        returnByValue: true
      });
      await sleep(700);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = join(OUT, `${file}.png`);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      console.log('[ui-shots]', path.replace(ROOT + '\\', ''));
    }

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
          todayAttention: document.querySelectorAll('[data-today] .today-row').length
        };

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
