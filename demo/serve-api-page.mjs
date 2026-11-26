// demo/serve-api-page.mjs
// Живой предпросмотр страницы внешнего API без сборки Rust/Tauri.
//
//   node demo/serve-api-page.mjs        →  http://127.0.0.1:47831/
//
// Что раздаётся:
//   * статика — те же файлы, что вшивает в себя приложение (`src-tauri/src/external_api/web/*`),
//     читаются с диска на каждый запрос, поэтому правка видна после F5;
//   * `/api/v1/*` — настоящий мост приложения (`js/modules/externalApi/bridge.js`) поверх
//     демонстрационного состояния. Не подделка ответов: те же обработчики, что у живого
//     приложения, включая права (scopes), аудит-журнал, ошибки 401/403/404/422 и запись
//     данных. Поэтому «▶ Выполнить» в карточке справочника даёт тот же ответ, что и в приложении.
//
// Чего здесь нет: окон игры и Tauri. `GET /windows` отдаёт пустой список, запуск
// персонажа завершается ошибкой — это предпросмотр страницы, а не игра.
//
// Токен для «Подключения» печатается в консоль при старте (и берётся из
// TF_API_PREVIEW_TOKEN). Права — из TF_API_PREVIEW_SCOPES, по умолчанию все три.
// Только для локального просмотра; в сборку приложения не попадает.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = resolve(ROOT, 'src-tauri/src/external_api/web');
const PORT = Number(process.env.PORT || 47831);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.TF_API_PREVIEW_TOKEN || 'a'.repeat(64);
const SCOPES = (() => {
  const wanted = String(process.env.TF_API_PREVIEW_SCOPES || 'read,modify,launchClose')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return {
    read: wanted.includes('read'),
    modify: wanted.includes('modify'),
    launchClose: wanted.includes('launchClose')
  };
})();

const HTML = ['index.html', 'text/html; charset=utf-8'];
const FILES = {
  // Те же адреса, что отдаёт Rust: страница сама решает, какой раздел показать.
  '/': HTML,
  '/index.html': HTML,
  '/docs': HTML,
  '/docs/': HTML,
  '/recipes': HTML,
  '/recipes/': HTML,
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/docs.js': ['docs.js', 'text/javascript; charset=utf-8'],
  '/errors.js': ['errors.js', 'text/javascript; charset=utf-8'],
  '/actions.js': ['actions.js', 'text/javascript; charset=utf-8'],
  '/recipes.js': ['recipes.js', 'text/javascript; charset=utf-8']
};

// Граф модулей приложения (taskLog и др.) трогает `document` на этапе импорта,
// поэтому перед импортом моста подставляем jsdom-окно. Сам браузер человеку не нужен.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: `http://127.0.0.1:${PORT}/`,
  pretendToBeVisual: true
});
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'crypto'
]) {
  if (!dom.window[name]) continue;
  // В Node 22 `navigator` — глобальный getter, обычное присваивание падает.
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16);

const { state } = await import('../js/core/state.js');
const { answer } = await import('../js/modules/externalApi/bridge.js');

const DAY = new Date().toISOString().slice(0, 10);
state.settings = {
  ...(state.settings || {}),
  // Имена настроек — как в приложении: allow*, а не read/modify.
  externalApi: {
    enabled: true,
    token: TOKEN,
    allowRead: SCOPES.read,
    allowModify: SCOPES.modify,
    allowLaunchClose: SCOPES.launchClose
  }
};
state.characters = [
  {
    id: 'Mag_1',
    nick: 'Маг',
    class: 'Маг',
    level: 100,
    favorite: true,
    partyIds: ['p-osnova'],
    mainPartyId: 'p-osnova',
    gold: 1250,
    ancientCoins: 120,
    stats: { physAttack: 12000, magAttack: 9600, critChance: 18, hp: 24500 },
    dungeonPasses: { weapon: 3, armor: 1, relic: 0 },
    isLoggedIn: true
  },
  {
    id: 'Luchnik_2',
    nick: 'Лучник',
    class: 'Лучник',
    level: 98,
    partyIds: ['p-osnova'],
    mainPartyId: 'p-osnova',
    gold: 80,
    ancientCoins: 40,
    stats: { physAttack: 14400, hp: 19800 },
    dungeonPasses: { weapon: 0, armor: 2, relic: 1 },
    isLoggedIn: false
  },
  {
    id: 'Zhrets_3',
    nick: 'Жрец',
    class: 'Жрец',
    level: 92,
    partyIds: ['p-farm'],
    gold: 1500,
    ancientCoins: 0,
    stats: { magAttack: 7200 },
    dungeonPasses: {},
    isLoggedIn: true
  }
];
state.parties = [
  { id: 'p-osnova', name: 'Основа', color: '#6e8ef8', memberIds: ['Mag_1', 'Luchnik_2'] },
  { id: 'p-farm', name: 'Фарм', color: null, memberIds: ['Zhrets_3'] }
];
state.plannerEntries = [
  {
    id: 'pe_1',
    title: 'Ежедневка',
    date: DAY,
    time: '',
    durationMinutes: 60,
    kind: 'task',
    priority: 'normal',
    recurrence: 'daily',
    status: 'todo'
  },
  {
    id: 'pe_2',
    title: 'Подземелье оружия',
    date: DAY,
    time: '20:00',
    durationMinutes: 30,
    kind: 'event',
    priority: 'high',
    recurrence: 'none',
    status: 'done'
  }
];
state.finance = {
  operations: [
    { id: 'fo_1', date: DAY, currency: 'gold', kind: 'out', amount: 250, counterparty: 'Аукцион', note: 'расходники' },
    {
      id: 'fo_2',
      date: DAY,
      currency: 'ancient',
      kind: 'in',
      amount: 30,
      counterparty: 'Марафон',
      note: 'награда',
      characterId: 'Mag_1'
    }
  ]
};
state.marathons = [
  {
    id: 'm1',
    kind: 'single',
    title: 'Осенний марафон',
    description: 'Отметки за ежедневные вход и подземелья.',
    startDate: DAY,
    endDate: '2026-12-31',
    tasks: [
      { id: 't1', title: 'Вход в игру', reward: '30 монет' },
      { id: 't2', title: 'Подземелье оружия', reward: '10 припасов' }
    ],
    marks: { Mag_1: { t1: 3, t2: 1 } }
  }
];

// Аудит-журнал в приложении ведёт Rust — он видит сырые запросы до моста. Здесь
// его ведёт этот сервер: та же форма записи, что страница показывает во вкладке
// «Аудит», чтобы вкладка была живой, а не пустой.
const ledger = [];
const LEDGER_LIMIT = 200;

const json = (res, status, body, extra = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extra
  });
  res.end(text);
};

const readBody = req =>
  new Promise((done, fail) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return done(null);
      try {
        done(JSON.parse(text));
      } catch {
        done(text);
      }
    });
    req.on('error', fail);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  try {
    const file = FILES[path];
    if (file && req.method === 'GET') {
      const [name, type] = file;
      const full = resolve(WEB, name);
      if (!full.startsWith(WEB + sep)) return json(res, 404, { ok: false });
      const text = await readFile(full, 'utf8');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(text);
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (!path.startsWith('/api/v1')) {
      return json(res, 404, { ok: false, error: { code: 'not_found', message: 'Неизвестный путь' } });
    }

    const auth = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!auth || auth[1] !== TOKEN) {
      return json(res, 401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Нужен заголовок Authorization: Bearer <токен>' }
      });
    }

    if (req.method === 'GET' && path === '/api/v1/audit') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, LEDGER_LIMIT);
      return json(res, 200, { ok: true, entries: ledger.slice(0, limit), total: ledger.length });
    }

    const body = await readBody(req);
    const started = Date.now();
    const out = await answer(
      { method: req.method, path, query: url.search.replace(/^\?/, ''), body },
      {
        // Тестовые подмены, без которых мост в Node обращается к Tauri.
        appVersion: 'preview',
        buildProfile: 'stable',
        storageWritable: true,
        windowRows: [],
        closeClientsByPid: async rows => ({ closed: (rows || []).length, failed: [] })
      }
    );
    const text = out?.raw?.text ?? JSON.stringify(out?.body ?? {});
    ledger.unshift({
      at: new Date().toISOString(),
      method: req.method,
      path,
      status: out?.status ?? 200,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(text),
      ip: '127.0.0.1'
    });
    if (ledger.length > LEDGER_LIMIT) ledger.length = LEDGER_LIMIT;
    if (out?.raw) {
      res.writeHead(out.status ?? 200, {
        'Content-Type': out.raw.contentType,
        'Content-Disposition': out.raw.disposition,
        'Cache-Control': 'no-store'
      });
      return res.end(text);
    }
    return json(res, out?.status ?? 200, out?.body ?? {}, { 'X-TF-Source': 'preview' });
  } catch (error) {
    console.error('[preview] ошибка обработки', error);
    return json(res, 500, { ok: false, error: { code: 'internal_error', message: String(error?.message || error) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Страница внешнего API: http://127.0.0.1:%s/', PORT);
  console.log('Токен для поля «Подключение»:', TOKEN);
  console.log(
    'Права:',
    Object.entries(SCOPES)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(', ') || 'нет (все выключены — удобно, чтобы посмотреть 403)'
  );
  console.log('Окон игры здесь нет: /windows пуст, запуск персонажа завершится ошибкой.');
});
