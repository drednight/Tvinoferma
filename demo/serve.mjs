// demo/serve.mjs
// Минимальный статический сервер для лаборатории окон скриптов (demo/tools-modals.html).
// Без зависимостей: node demo/serve.mjs (или npm run demo) → http://localhost:1420/
// Корень перенаправляет на демо, чтобы не открывать основное приложение (ему нужен Vite/Tauri).
// Только для локального просмотра демо — в сборку приложения не попадает.

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 1420);
// Можно открыть нужную лабораторию сразу в предпросмотре, не меняя стандартный адрес.
const entry = /^\/demo\/[a-z0-9/._-]+\.html(?:\?show=(?:statistics|cloud-sync))?$/i.test(process.env.DEMO_ENTRY || '')
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
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.gs': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

// Только ресурсы, необходимые лаборатории. Сервер слушает 0.0.0.0 для preview,
// поэтому запрет доступа к .git и произвольным файлам нужен и без CORS.
const IMAGE_TYPES = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2']);
const ROUTES = [
  { prefix: '/demo/', dir: resolve(ROOT, 'demo'), extensions: new Set(['.html', '.js', '.css', ...IMAGE_TYPES]) },
  { prefix: '/js/', dir: resolve(ROOT, 'js'), extensions: new Set(['.js']) },
  { prefix: '/css/', dir: resolve(ROOT, 'css'), extensions: new Set(['.css']) },
  { prefix: '/assets/', dir: resolve(ROOT, 'public/assets'), extensions: IMAGE_TYPES }
];

const notFound = res => {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404 Not Found');
};

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    // Проверяем до нормализации URL: иначе ../ и закодированные точки исчезнут.
    const pathname = decodeURIComponent((req.url || '').split('?')[0]);
    if (
      !pathname.startsWith('/') ||
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.includes('%') ||
      pathname.split('/').some(part => part.startsWith('.'))
    ) {
      notFound(res);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(302, { Location: entry });
      res.end();
      return;
    }
    const route = ROUTES.find(candidate => pathname.startsWith(candidate.prefix));
    const extension = extname(pathname).toLowerCase();
    if (!route || !route.extensions.has(extension)) {
      notFound(res);
      return;
    }
    const base = await realpath(route.dir);
    const requested = resolve(base, pathname.slice(route.prefix.length));
    const file = await realpath(requested).catch(() => null);
    // Не следуем по символическим ссылкам, даже на скрытый файл внутри каталога.
    if (!file || file !== requested || !file.startsWith(base + sep)) {
      notFound(res);
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      notFound(res);
      return;
    }
    const body = req.method === 'HEAD' ? null : await readFile(file);
    const headers = {
      'Content-Type': MIME[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    // Opaque-origin iframe должен загружать только опубликованные модули и стили.
    if (extension !== '.html') headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    notFound(res);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Лаборатория Твинофермы: http://localhost:${PORT}${entry}`);
});
