// tests/agentCli.test.js
// `tf` — командная строка поверх внешнего API (scripts/tf/).
//
// Зачем тест нужен: CLI намеренно не имеет своего списка команд — он строит их из
// каталога страницы API (`src-tauri/src/external_api/web/actions.js`). Это держит
// три вещи в одном месте: страницу, справочник `docs.js` и команды `tf`. Если
// завтра у действия появится новое поле, а в документации маршрут останется без
// команды — проверка падает здесь, а не у пользователя.
//
// Что проверяется:
//   1. Паритет: команды = каталог страницы = документированные маршруты (34 ↔ 34).
//   2. Ни одно изменение/запуск не уходит без `--yes`; dry-run показывает ровно тот
//      запрос, что ушёл бы (тело совпадает с формой страницы).
//   3. Токен не берётся из аргументов и не попадает ни в один вывод.
//   4. Отказ API превращается в подсказку, коды выхода различают API и сеть.
//   5. Снимок `--help` (сгенерированный файл) — чтобы текст справки не менялся молча.
//
// Снимок обновить: `node scripts/tf/tf.mjs --help > tests/fixtures/tf-help.txt`
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALIASES, findCommand, loadCommands } from '../scripts/tf/catalog.mjs';
import { parseArgs, run, EXIT } from '../scripts/tf/tf.mjs';
import { resolveConnection } from '../scripts/tf/client.mjs';

const WEB = resolve(process.cwd(), 'src-tauri/src/external_api/web');
const readCatalogFile = name => readFileSync(resolve(WEB, name), 'utf8');
const loadWindow = (name, key) => {
  const scope = {};
  new Function('window', readCatalogFile(name))(scope);
  return scope[key] || [];
};

/** Токен для тестов: формат тот же, что требует Rust (64 hex-символа). */
const TOKEN = 'a'.repeat(64);
const ENV = { TF_API_TOKEN: TOKEN };

/** `fetch`-заглушка: отвечает по очереди из `replies`, записывает вызовы. */
function fakeFetch(replies = [{ status: 200, body: { ok: true } }]) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body, headers: init.headers || {} });
    if (reply.networkError) throw new Error(reply.networkError);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return {
      ok: (reply.status || 200) < 400,
      status: reply.status || 200,
      headers: {
        get: name =>
          String(name).toLowerCase() === 'content-type'
            ? (reply.contentType ?? 'application/json; charset=utf-8')
            : null
      },
      text: async () => text
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Запуск команды с подменённым `fetch`; stdout — всегда один JSON (тесты в `--json`). */
async function tf(argv, { replies, env = ENV, options = {} } = {}) {
  const fetchImpl = replies === undefined ? fakeFetch([{ networkError: 'нет соединения' }]) : fakeFetch(replies);
  const result = await run({ argv: [...argv, '--json'], env, fetchImpl, ...options });
  const payload = result.stdout.length === 1 ? JSON.parse(result.stdout[0]) : null;
  return { ...result, payload, fetchImpl, calls: fetchImpl.calls };
}

describe('tf: команды = каталог страницы API', () => {
  it('каждое действие страницы имеет команду, и наоборот', () => {
    const actions = loadWindow('actions.js', 'TF_API_ACTIONS');
    const commands = loadCommands(process.cwd());
    expect([...commands.keys()].sort()).toEqual(actions.map(action => action.id).sort());
    // Имена команд — kebab-case и только строчные: `tf LaunchCharacter` искать бы не стали.
    for (const name of commands.keys()) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('документированные маршруты закрыты командами полностью', () => {
    const docs = loadWindow('docs.js', 'TF_API_DOCS');
    // Пути в каталоге страницы с префиксом `/api/v1`, в справочнике — без: сравниваем нормализованные.
    const norm = path =>
      String(path)
        .replace(/\{[^}]+\}/g, '{}')
        .replace(/^\/api\/v1/, '');
    const commands = new Map(
      [...loadCommands(process.cwd()).values()].map(command => [`${command.method} ${norm(command.path)}`, command])
    );
    const documented = docs.groups
      .flatMap(group => group.methods)
      .filter(method => method.method !== '—' && String(method.path).startsWith('/'))
      .map(method => ({ key: `${method.method} ${norm(method.path)}`, id: method.id }));
    expect(documented.length).toBeGreaterThan(30);
    expect(documented.filter(row => !commands.has(row.key)).map(row => `${row.id} ${row.key}`)).toEqual([]);
    // Обратное направление: команда без строки в справочнике — значит, страница и
    // документация уже разошлись, и CLI унаследовал это молча.
    const docKeys = new Set(documented.map(row => row.key));
    expect([...commands.keys()].filter(key => !docKeys.has(key))).toEqual([]);
  });

  it('псевдонимы ведут в существующие команды и не спорят с ними', () => {
    const commands = loadCommands(process.cwd());
    for (const [alias, name] of Object.entries(ALIASES)) {
      expect(commands.has(name), `алиас ${alias} → ${name}`).toBe(true);
      expect(commands.has(alias), `алиас ${alias} перекрывает команду`).toBe(false);
      // Псевдоним обязан читаться так же, как команда: `tf characters` = `tf list-characters`.
      expect(findCommand(commands, alias)?.name).toBe(name);
    }
  });

  it('справка перечисляет все команды, а примеры командной строки разбираются', async () => {
    const commands = loadCommands(process.cwd());
    const help = await run({ argv: ['--help'], env: ENV });
    const text = help.stdout.join('\n');
    for (const command of commands.values()) {
      expect(text).toContain(`tf ${command.name}`);
      if (command.isWrite) expect(text).toContain('--yes');
    }
    // Каждый пример из `tf describe` — рабочая командная строка (dry-run, без сети).
    for (const command of commands.values()) {
      const described = await run({ argv: ['describe', command.name], env: ENV, fetchImpl: fakeFetch([]) });
      const example = (described.stdout.join('\n').match(/Пример: (.+)/) || [])[1];
      expect(example, `пример для ${command.name}`).toBeTruthy();
      const args = example
        .split(/\s+/)
        .slice(1)
        .filter(item => item !== '--dry-run');
      const parsed = parseArgs(args);
      expect(parsed.positionals[0]).toBe(command.name);
      const probe = await run({ argv: [...args, '--dry-run', '--json'], env: ENV, fetchImpl: fakeFetch([]) });
      expect(probe.code, example).toBe(EXIT.ok);
      const payload = JSON.parse(probe.stdout[0]);
      expect(payload.dryRun).toBe(true);
      expect(payload.request.method).toBe(command.method);
      expect(payload.request.url).toContain('/api/v1/');
    }
  });

  it('снимок --help совпадает с собранным текстом', async () => {
    const expected = readFileSync(resolve(process.cwd(), 'tests/fixtures/tf-help.txt'), 'utf8');
    const result = await run({ argv: ['--help'], env: ENV });
    expect(`${result.stdout.join('\n')}\n`).toBe(expected);
  });
});

describe('tf: dry-run по умолчанию и право пользователя', () => {
  const launchReply = { status: 202, body: { jobId: 'job_1', status: 'queued' } };

  it('запуск без --yes не отправляется, но показывает точный запрос', async () => {
    const result = await tf(['launch-character', 'Mag_1'], { replies: [launchReply] });
    expect(result.code).toBe(EXIT.ok);
    expect(result.calls).toHaveLength(0);
    expect(result.payload).toMatchObject({
      ok: true,
      command: 'launch-character',
      dryRun: true,
      request: { method: 'POST', url: `http://127.0.0.1:47831/api/v1/launch/character`, body: { characterId: 'Mag_1' } }
    });
    // Токен не виден ни в запросе-превью, ни в подсказке.
    expect(JSON.stringify(result.payload)).not.toContain(TOKEN);
  });

  it('с --yes запрос уходит тем же, что строит форма страницы', async () => {
    const result = await tf(['launch-character', 'Mag_1', '--yes'], { replies: [launchReply] });
    expect(result.code).toBe(EXIT.ok);
    expect(result.calls).toHaveLength(1);
    const action = loadWindow('actions.js', 'TF_API_ACTIONS').find(item => item.id === 'launch-character');
    expect(JSON.parse(result.calls[0].body)).toEqual(action.body({ characterId: 'Mag_1' }));
    expect(result.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.payload).toMatchObject({ ok: true, status: 202, summary: 'задание: job_1' });
    expect(result.payload.next).toContain('job_1');
  });

  it('опасное действие добавляет подтверждение в dry-run и требует --yes', async () => {
    const preview = await tf(['close-windows', '--pids', '4321, 99'], {
      replies: [{ status: 200, body: { closed: [] } }]
    });
    expect(preview.calls).toHaveLength(0);
    expect(preview.payload.confirm).toContain('Закрыть 2 окно');
    const sent = await tf(['close-windows', '--pids', '4321, 99', '--yes'], {
      replies: [{ status: 200, body: { closed: [4321], found: 1 } }]
    });
    // `confirm: true` добавляет каталог, а не флаг: без него сервер отказал бы.
    expect(JSON.parse(sent.calls[0].body)).toEqual({ pids: [4321, 99], confirm: true });
  });

  it('изменение стата: значение приводится к числу, путь — как у карточки', async () => {
    const result = await tf(['set-stat', 'Mag_1', 'hp', '45', '--yes'], {
      replies: [{ status: 200, body: { id: 'Mag_1', nick: 'Маг', stat: 'hp', value: 45, changed: true } }]
    });
    expect(result.payload.request || result.payload).toMatchObject({ status: 200 });
    expect(result.calls[0].url).toBe('http://127.0.0.1:47831/api/v1/characters/Mag_1/stats/hp');
    expect(JSON.parse(result.calls[0].body)).toEqual({ value: 45 });
  });

  it('неизвестное значение select и не-число отбиваются до запроса', async () => {
    const badStat = await tf(['set-stat', 'Mag_1', 'mood', '45', '--yes'], { replies: [{ status: 200, body: {} }] });
    expect(badStat.code).toBe(EXIT.usage);
    expect(badStat.calls).toHaveLength(0);
    const badNumber = await tf(['set-stat', 'Mag_1', 'hp', 'много', '--yes'], { replies: [{ status: 200, body: {} }] });
    expect(badNumber.code).toBe(EXIT.usage);
    expect(badNumber.stdout.join(' ')).toContain('нужно число');
  });

  it('обязательное поле не подставляется «первым попавшимся»', async () => {
    const result = await tf(['launch-character'], { replies: [launchReply] });
    expect(result.code).toBe(EXIT.usage);
    expect(result.calls).toHaveLength(0);
    expect(result.stdout.join(' ')).toContain('Персонаж');
    expect(result.payload.error).toMatchObject({ code: 'usage', missing: ['characterId'] });
  });

  it('чтение отправляется сразу, без --yes', async () => {
    const result = await tf(['status'], {
      replies: [
        { status: 200, body: { ok: true, counts: { characters: 3, windows: 1 }, today: { done: 1, total: 4 } } }
      ]
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.calls).toHaveLength(1);
    expect(result.payload).toMatchObject({
      ok: true,
      command: 'status',
      summary: 'персонажей: 3; окон: 1; дел на сегодня: 1 из 4'
    });
  });
});

describe('tf: токен, адрес и подсказки', () => {
  it('токен только из окружения или файла; --token запрещён', () => {
    const fromEnv = resolveConnection({ argv: {}, env: { TF_API_TOKEN: TOKEN } });
    expect(fromEnv.token).toBe(TOKEN);
    expect(fromEnv.tokenSource).toBe('TF_API_TOKEN');
    const fromFile = resolveConnection({
      argv: { 'token-file': 'token.txt' },
      env: {},
      readFile: () => `${TOKEN}\n`
    });
    expect(fromFile.token).toBe(TOKEN);
    expect(fromFile.tokenSource).toContain('token.txt');
    const rejected = resolveConnection({ argv: { token: TOKEN }, env: {}, readFile: () => '' });
    expect(rejected.problems.join(' ')).toContain('--token');
    expect(rejected.token).toBe('');
  });

  it('обрезанный токен и чужой адрес — ошибка разбора, а не запрос', () => {
    expect(resolveConnection({ argv: {}, env: { TF_API_TOKEN: 'abc' } }).problems.join(' ')).toContain('64 hex');
    expect(
      resolveConnection({ argv: { base: 'http://example.com' }, env: { TF_API_TOKEN: TOKEN } }).problems.join(' ')
    ).toContain('127.0.0.1');
    expect(resolveConnection({ argv: {}, env: { TF_API_PORT: '80' } }).problems.join(' ')).toContain('TF_API_PORT');
  });

  it('порт тестовой сборки и --base работают вместе', () => {
    const viaEnv = resolveConnection({ argv: {}, env: { TF_API_PORT: '47832' } });
    expect(viaEnv.base).toBe('http://127.0.0.1:47832');
    const viaBase = resolveConnection({ argv: { base: 'http://127.0.0.1:47832/api/v1/' }, env: {} });
    expect(viaBase.base).toBe('http://127.0.0.1:47832');
    expect(viaBase.port).toBe(47832);
    // Противоречие видно сразу, а не «один из флагов молча проиграл».
    const conflict = resolveConnection({ argv: { base: 'http://127.0.0.1:47831', port: '47832' }, env: {} });
    expect(conflict.problems.join(' ')).toContain('противоречат');
  });

  it('403 forbidden_scope получает подсказку про настройки', async () => {
    const result = await tf(['launch-character', 'Mag_1', '--yes'], {
      replies: [
        {
          status: 403,
          body: { error: { code: 'forbidden_scope', message: 'Право «запуск и закрытие окон» выключено' } }
        }
      ]
    });
    expect(result.code).toBe(EXIT.api);
    expect(result.payload.error.code).toBe('forbidden_scope');
    expect(result.payload.hint).toContain('Внешний API');
  });

  it('429 launch_busy подсказывает дождаться задания, 404 — где взять id', async () => {
    const busy = await tf(['launch-selection', '--character-ids', 'Mag_1', '--yes'], {
      replies: [{ status: 429, body: { error: { code: 'launch_busy', message: 'уже идёт запуск' } } }]
    });
    expect(busy.payload.hint).toContain('tf jobs');
    const missing = await tf(['character-card', 'Нет_такого'], {
      replies: [{ status: 404, body: { error: { code: 'no_such_character', message: 'Персонаж не найден' } } }]
    });
    expect(missing.payload.hint).toContain('tf characters');
  });

  it('сервер не отвечает — код 3 и текст с портами', async () => {
    const result = await tf(['status'], { replies: [{ networkError: 'ECONNREFUSED 127.0.0.1:47831' }] });
    expect(result.code).toBe(EXIT.network);
    expect(result.payload.error.code).toBe('unreachable');
    expect(result.payload.hint).toContain('47831');
    expect(result.payload.hint).toContain('47832');
  });

  it('без токена CLI не делает запрос', async () => {
    const result = await run({ argv: ['status', '--json'], env: {}, fetchImpl: fakeFetch([]) });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout[0]).toContain('TF_API_TOKEN');
    expect(result.stdout[0]).toContain('Скопировать токен');
  });
});

describe('tf: ожидание задания и выгрузки', () => {
  it('--wait опрашивает /jobs и пишет прогресс в stderr', async () => {
    const fetchImpl = fakeFetch([
      { status: 202, body: { jobId: 'job_9', status: 'queued' } },
      { status: 200, body: { id: 'job_9', status: 'running', progress: { stage: 'Запуск окон', done: 1, total: 2 } } },
      {
        status: 200,
        body: {
          id: 'job_9',
          status: 'done',
          progress: { stage: 'Готово', done: 2, total: 2 },
          result: { launched: 1, skipped: 1, failed: 0 }
        }
      }
    ]);
    const result = await run({
      argv: ['launch-party', 'p-osnova', '--yes', '--wait', '--json'],
      env: ENV,
      fetchImpl,
      sleep: async () => {}
    });
    const payload = JSON.parse(result.stdout[0]);
    expect(payload.job.status).toBe('done');
    expect(payload.summary).toBe('задание: job_9');
    expect(result.stderr.join(' ')).toContain('Запуск окон');
    // stdout — ровно один объект: прогресс не должен ломать `| jq`.
    expect(result.stdout).toHaveLength(1);
    expect(fetchImpl.calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:47831/api/v1/launch/party',
      'http://127.0.0.1:47831/api/v1/jobs/job_9',
      'http://127.0.0.1:47831/api/v1/jobs/job_9'
    ]);
  });

  it('задание с ошибкой помечается warning, но код выхода остаётся 0', async () => {
    const result = await run({
      argv: ['launch-character', 'Mag_1', '--yes', '--wait', '--json'],
      env: ENV,
      fetchImpl: fakeFetch([
        { status: 202, body: { jobId: 'job_3' } },
        {
          status: 200,
          body: {
            id: 'job_3',
            status: 'failed',
            progress: { stage: 'Ошибка запуска' },
            result: { error: 'нет GameCenter' }
          }
        }
      ]),
      sleep: async () => {}
    });
    const payload = JSON.parse(result.stdout[0]);
    expect(payload.job.status).toBe('failed');
    expect(payload.warning).toContain('нет GameCenter');
    expect(result.code).toBe(EXIT.ok);
  });

  it('выгрузка: текст идёт как есть, с --out — на диск', async () => {
    const csv = 'id,nick\nMag_1,Маг\n';
    const plain = await run({
      argv: ['export', '--set', 'characters', '--format', 'csv'],
      env: ENV,
      fetchImpl: fakeFetch([{ status: 200, body: csv, contentType: 'text/csv; charset=utf-8' }])
    });
    expect(plain.stdout.join('')).toContain('Mag_1,Маг');
    /** @type {string[]} */
    const written = [];
    const saved = await run({
      argv: ['export', '--set', 'characters', '--format', 'csv', '--out', 'out/characters.csv', '--json'],
      env: ENV,
      fetchImpl: fakeFetch([{ status: 200, body: csv, contentType: 'text/csv; charset=utf-8' }]),
      writeFile: (path, text) => written.push(`${path}|${text}`)
    });
    expect(saved.code).toBe(EXIT.ok);
    expect(written[0]).toContain(csv);
    expect(JSON.parse(saved.stdout[0]).bytes).toBe(csv.length);
  });

  it('прямой запрос через tf call: GET сразу, изменение — только с --yes', async () => {
    const read = await tf(['call', 'GET', '/health'], { replies: [{ status: 200, body: { ok: true } }] });
    expect(read.calls[0].url).toBe('http://127.0.0.1:47831/api/v1/health');
    const write = await tf(['call', 'POST', '/app/show'], { replies: [{ status: 200, body: { ok: true } }] });
    expect(write.calls).toHaveLength(0);
    expect(write.payload.dryRun).toBe(true);
    const confirmed = await tf(['call', 'POST', '/app/show', '--yes', '--body', '{"x":1}'], {
      replies: [{ status: 200, body: { ok: true } }]
    });
    expect(JSON.parse(confirmed.calls[0].body)).toEqual({ x: 1 });
  });
});

describe('tf: разбор командной строки', () => {
  it('флаги, значения и отрицание', () => {
    expect(parseArgs(['set-stat', 'Mag_1', 'hp', '--value', '45'])).toEqual({
      positionals: ['set-stat', 'Mag_1', 'hp'],
      flags: { value: '45' }
    });
    expect(parseArgs(['marathon-mark', '--marked=false'])).toEqual({
      positionals: ['marathon-mark'],
      flags: { marked: 'false' }
    });
    expect(parseArgs(['list-characters', '--no-flat'])).toEqual({
      positionals: ['list-characters'],
      flags: { flat: false }
    });
    expect(parseArgs(['status', '--json'])).toEqual({ positionals: ['status'], flags: { json: true } });
  });

  it('опечатка в похожем флаге — ошибка, а не тихий запрос с чужими значениями', async () => {
    const result = await tf(['launch-character', '--char', 'Mag_1', '--yes'], { replies: [{ status: 202, body: {} }] });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout.join(' ')).toContain('--character-id');
    expect(result.calls).toHaveLength(0);
  });

  it('неизвестная команда получает подсказку по началу названия', async () => {
    const result = await tf(['marath']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout.join(' ')).toMatch(/tf marathon-[a-z-]+/);
  });

  it('ls и describe: машиночитаемый каталог и поля команды', async () => {
    const list = await tf(['ls']);
    expect(list.payload.commands).toHaveLength(loadCommands(process.cwd()).size);
    expect(list.payload.commands[0]).toMatchObject({
      command: expect.any(String),
      fields: expect.any(Array),
      scope: 'read'
    });
    const described = await tf(['describe', 'launch-selection']);
    expect(described.payload.command).toMatchObject({
      name: 'launch-selection',
      method: 'POST',
      scope: 'launchClose',
      fields: [expect.objectContaining({ name: 'characterIds', flag: '--character-ids', required: true })]
    });
    expect(described.payload.usage).toContain('tf launch-selection');
  });
});
