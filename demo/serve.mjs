// demo/serve.mjs
// Минимальный статический сервер для лаборатории окон скриптов (demo/tools-modals.html).
// Без зависимостей: node demo/serve.mjs (или npm run demo) → http://localhost:1420/
// Корень перенаправляет на демо, чтобы не открывать основное приложение (ему нужен Vite/Tauri).
// Только для локального просмотра демо — в сборку приложения не попадает.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 1420);
// Можно открыть нужную лабораторию сразу в предпросмотре, не меняя стандартный адрес.
const entry = /^\/demo\/[a-z0-9/._-]+\.html$/i.test(process.env.DEMO_ENTRY || '')
  ? process.env.DEMO_ENTRY
  : '/demo/tools-modals.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.gs': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    // Opaque-origin iframe загружает публичные модули и шрифты по CORS. Не открываем
    // произвольные файлы репозитория (в частности .git и локальные настройки) другим сайтам.
    const corsPath = pathname.replace(/^\/(?:Tvinoferma|dist)(?=\/)/, '');
    if (
      !/(?:^|\/)\./.test(corsPath) &&
      /^\/(?:demo|js|css|assets)\/[^?#]+\.(?:js|mjs|css|woff2?|png|webp|svg)$/i.test(corsPath)
    ) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(302, { Location: entry });
      res.end();
      return;
    }
    // Как Vite: public/assets доступен в браузере по /assets — общие иконки классов.
    const assetPath = pathname.startsWith('/assets/') ? `/public${pathname}` : pathname;
    const file = join(ROOT, normalize(assetPath));
    // Защита от выхода за корень репозитория (../../etc)
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Лаборатория Твинофермы: http://localhost:${PORT}${entry}`);
});
