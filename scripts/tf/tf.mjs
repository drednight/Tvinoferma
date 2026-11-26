#!/usr/bin/env node
// scripts/tf/tf.mjs
// `tf` — командная строка Твинофермы поверх внешнего API.
//
// Тонкий слой: разбирает аргументы, собирает запрос по каталогу страницы API
// (`scripts/tf/catalog.mjs`), отправляет его в `http://127.0.0.1:<порт>` и печатает
// ответ. Логики данных здесь нет намеренно: вторая правда о персонажах, марафонах и
// запуске означала бы расхождение с приложением. Зависимостей тоже нет — CLI должен
// запускаться как `node scripts/tf/tf.mjs` в любой копии репозитория.
//
// Правила, которые важнее удобства:
//   1. Решение остаётся за пользователем: команды с правом `modify`/`launchClose`
//      без `--yes` не отправляются — печатается тот же запрос, что ушёл бы (dry-run).
//   2. Токен не берётся из аргументов и не попадает в вывод.
//   3. `--json` — один объект в stdout; весь шум (прогресс ожидания задания) в stderr.
//
// Запуск: `npm run tf -- status --json` или `node scripts/tf/tf.mjs status --json`.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRequest,
  defaultValues,
  describeText,
  findCommand,
  helpText,
  loadCommands,
  missingFields,
  normalizeFlag,
  summarize
} from './catalog.mjs';
import { hintFor, resolveConnection, sendRequest } from './client.mjs';

/** Коды выхода: 1 и 3 различают «API отказал» и «API не отвечает» — для скрипта это важно. */
export const EXIT = { ok: 0, api: 1, usage: 2, network: 3 };

/** Корень репозитория: `<root>/scripts/tf/tf.mjs`. */
function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Разбор аргументов: `tf <команда> [позиционные…] [--флаг [значение] …]`. */
export function parseArgs(argv) {
  const positionals = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const item = String(argv[i]);
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const body = item.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (body.startsWith('no-')) {
      flags[body.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[body] = true;
    else {
      flags[body] = next;
      i += 1;
    }
  }
  return { positionals, flags };
}

/** Значение флага для поля: тип берётся из каталога, чтобы не ловить 422 от API. */
function coerce(field, raw) {
  if (field.type === 'checkbox') {
    if (raw === true) return { value: true };
    if (raw === false) return { value: false };
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'да'].includes(text)) return { value: true };
    if (['false', '0', 'no', 'нет', ''].includes(text)) return { value: false };
    return { problem: `${field.flag}: нужно true или false, получено «${raw}»` };
  }
  const value = String(raw).trim();
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return { problem: `${field.flag}: нужно число, получено «${value}»` };
    return { value: number };
  }
  if (field.options && !field.options.map(String).includes(value)) {
    return { problem: `${field.flag}: «${value}» нет среди допустимых значений — ${field.options.join(', ')}` };
  }
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { problem: `${field.flag}: ожидается дата в формате ГГГГ-ММ-ДД, получено «${value}»` };
  }
  return { value };
}

/**
 * Значения полей из флагов и позиционных аргументов.
 *
 * Позиционные заполняют обязательные поля по порядку каталога: так
 * `tf character-card Mag_1` и `tf set-stat Mag_1 hp 45` читаются как предложение.
 */
function collectValues(command, positionals, flags) {
  const values = defaultValues(command);
  const problems = [];
  const byFlag = new Map(command.fields.map(field => [normalizeFlag(field.flag), field]));
  const filled = new Set();
  for (const [name, raw] of Object.entries(flags)) {
    const field = byFlag.get(normalizeFlag(name));
    if (!field) continue; // глобальный флаг разберётся ниже
    filled.add(field.name);
    const coerced = coerce(field, raw);
    if (coerced.problem) problems.push(coerced.problem);
    else values[field.name] = coerced.value;
  }
  const free = command.fields.filter(field => field.required && !filled.has(field.name));
  positionals.forEach((raw, index) => {
    const field = free[index];
    if (!field) {
      problems.push(`лишний аргумент «${raw}»: у tf ${command.name} все обязательные поля уже заполнены`);
      return;
    }
    const coerced = coerce(field, raw);
    if (coerced.problem) problems.push(coerced.problem);
    else values[field.name] = coerced.value;
  });
  // Флаг, похожий на поле, но не найденный: промолчать — значит отправить запрос с
  // чужими значениями (`--char=Mag_1` вместо `--character-id`).
  for (const name of Object.keys(flags)) {
    if (byFlag.has(normalizeFlag(name))) continue;
    const close = command.fields.some(field => normalizeFlag(field.name).includes(normalizeFlag(name)));
    if (close) {
      problems.push(
        `неизвестный флаг --${name}: у tf ${command.name} поля — ${command.fields.map(field => field.flag).join(', ')}`
      );
    }
  }
  return { values, problems };
}

/** Что ушло бы на сервер: токен скрыт, тело — как есть. */
function preview(base, method, path, body) {
  return {
    method,
    url: `${base}${path}`,
    headers: { Authorization: 'Bearer <скрыт>' },
    body: body === undefined ? null : body
  };
}

/** Сообщение о токене: одно на все команды. */
function noTokenMessage() {
  return (
    'токен не найден: задайте TF_API_TOKEN или --token-file <путь>. Скопировать токен можно только при перевыпуске: ' +
    '«Настройки → 🔌 Внешний API» → «Перевыпустить токен» → «Скопировать токен» (старые программы после этого получат 401).'
  );
}

/**
 * Точка входа без побочных эффектов: аргументы, окружение и `fetch` приходят
 * параметрами. `run` нужен тестам, `main` — запуску из командной строки.
 *
 * @param {{
 *   argv?: string[], env?: Record<string, string|undefined>, root?: string,
 *   fetchImpl?: (url: string, init: any) => Promise<any>, readFile?: (path: string) => string,
 *   writeFile?: (path: string, text: string) => void,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number
 * }} [options]
 * @returns {Promise<{ code: number, stdout: string[], stderr: string[] }>}
 */
export async function run(options = {}) {
  const argv = options.argv || [];
  const env = options.env || {};
  const root = options.root || repoRoot();
  const asJson = argv.includes('--json');
  const { positionals, flags } = parseArgs(argv);
  const stderr = [];

  /**
   * Один выход: в `--json` — единственный объект в stdout, иначе строки.
   * @param {number} code
   * @param {string[]} lines
   * @param {any} [data]
   */
  const emit = (code, lines, data) =>
    asJson ? { code, stdout: [JSON.stringify(data)], stderr } : { code, stdout: lines, stderr };
  /** Ошибка командной строки: код 2, объяснение и (в JSON) машиночитаемый код. */
  const usage = (message, extra = {}) =>
    emit(EXIT.usage, [message], { ok: false, error: { code: 'usage', message, ...extra } });

  let commands;
  try {
    commands = loadCommands(root);
  } catch (error) {
    const message = `не удалось прочитать каталог действий: ${error?.message || error}`;
    return emit(EXIT.usage, [message], { ok: false, error: { code: 'catalog_unavailable', message } });
  }

  // --- Служебные команды ---
  if (!positionals.length || positionals[0] === 'help' || flags.help === true) {
    const text = helpText(commands);
    return emit(EXIT.ok, [text], { ok: true, usage: text, commands: [...commands.keys()] });
  }
  if (positionals[0] === 'ls' || positionals[0] === 'commands') {
    const list = [...commands.values()].map(command => ({
      command: command.name,
      group: command.group,
      title: command.title,
      summary: command.summary,
      method: command.method,
      path: command.path,
      scope: command.scope,
      needsYes: command.isWrite,
      danger: command.danger,
      fields: command.fields.map(field => ({
        flag: field.flag,
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options,
        default: field.default === undefined ? null : field.default,
        example: field.example ?? undefined,
        hint: field.hint || undefined
      }))
    }));
    const lines = list.map(
      row =>
        `tf ${row.command} — ${row.title} (${row.method} ${row.path}; право ${row.scope}${row.needsYes ? '; нужен --yes' : ''})`
    );
    return emit(EXIT.ok, lines, { ok: true, commands: list });
  }
  if (positionals[0] === 'describe') {
    const command = findCommand(commands, positionals[1]);
    if (!command) return usage(`неизвестная команда «${positionals[1] || '—'}». Список: tf ls`);
    const text = describeText(command);
    if (!asJson) return emit(EXIT.ok, [text]);
    const { build, query, pathOf, result: resultOf, confirmText, ...publicCommand } = command;
    return emit(EXIT.ok, [], { ok: true, command: publicCommand, usage: text });
  }

  const connection = resolveConnection({ argv: flags, env, readFile: options.readFile });
  if (connection.problems.length) return usage(connection.problems.join('\n   → '));

  /** Отказ API или сети: код, подсказка и машиночитаемая часть. */
  const failure = received => {
    const hint = hintFor(received);
    const code = String(received?.data?.error?.code || (received?.networkError ? 'unreachable' : 'http_error'));
    const message = String(received?.data?.error?.message || received?.networkError || 'запрос не выполнен');
    const data = {
      ok: false,
      status: Number(received?.status) || 0,
      error: { code, message },
      ...(hint ? { hint } : {})
    };
    const lines = [`❌ ${data.status || '—'} ${code}: ${message}`, ...(hint ? [`   → ${hint}`] : [])];
    return emit(received?.networkError ? EXIT.network : EXIT.api, lines, data);
  };

  /** Dry-run: тот же запрос, что ушёл бы, но не отправленный. */
  const dryRun = (command, values, request, note) => {
    const data = {
      ok: true,
      command: command.name,
      dryRun: true,
      note,
      request: preview(connection.base, command.method, request.path, request.body)
    };
    if (command.danger && command.confirmText) {
      try {
        data.confirm = String(command.confirmText(values) || '');
      } catch {
        /* подтверждение — пояснение; его отсутствие не меняет запрос */
      }
    }
    const lines = [
      `dry-run: ${command.method} ${connection.base}${request.path}`,
      `   тело: ${JSON.stringify(request.body ?? null)}`,
      ...(data.confirm ? [`   подтверждение: ${data.confirm}`] : []),
      `   → повторите с --yes, чтобы отправить`
    ];
    return emit(EXIT.ok, lines, data);
  };

  // --- Прямой запрос: тот же токен и те же права, без удобств ---
  if (positionals[0] === 'call') {
    const method = String(positionals[1] || 'GET').toUpperCase();
    const rawPath = String(positionals[2] || '');
    if (!rawPath) return usage('call: нужен путь, например tf call GET /characters');
    const path = rawPath.startsWith('/api/v1/') ? rawPath : `/api/v1${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
    let body;
    if (flags.body !== undefined && flags.body !== true) {
      try {
        body = JSON.parse(String(flags.body));
      } catch (error) {
        return usage(`--body: не JSON (${error?.message || error})`);
      }
    }
    if (method !== 'GET' && flags.yes !== true)
      return dryRun(
        { name: 'call', method, danger: false, confirmText: null },
        {},
        { path, body },
        'изменяющий запрос отправится только с --yes'
      );
    if (!connection.token) return usage(noTokenMessage());
    const received = await sendRequest({
      ...connection,
      method,
      path,
      body,
      timeoutMs: flags.timeout,
      fetchImpl: options.fetchImpl
    });
    if (!received.ok) return failure(received);
    const lines = [
      `${method} ${path} → ${received.status}`,
      JSON.stringify(received.data ?? received.rawText, null, 2)
    ];
    return emit(EXIT.ok, lines, {
      ok: true,
      method,
      path,
      status: received.status,
      data: received.data ?? received.rawText
    });
  }

  const command = findCommand(commands, positionals[0]);
  if (!command) {
    const typed = String(positionals[0] || '');
    const near = [...commands.keys()].find(name => normalizeFlag(name).startsWith(normalizeFlag(typed)));
    return usage(`неизвестная команда «${typed}».${near ? ` Похоже, вы имели в виду tf ${near}.` : ''} Список: tf ls`);
  }

  const { values, problems } = collectValues(command, positionals.slice(1), flags);
  if (problems.length) return usage(problems.join('\n   → '));
  const missing = missingFields(command, values);
  if (missing.length) {
    return usage(
      `не хватает: ${missing.map(field => `${field.flag} (${field.label})`).join(', ')}.\n   → tf describe ${command.name}`,
      {
        missing: missing.map(field => field.name)
      }
    );
  }

  const request = buildRequest(command, values);
  if (flags['dry-run'] === true) return dryRun(command, values, request, 'dry-run: запрос не отправлен');
  if (command.isWrite && flags.yes !== true) {
    return dryRun(command, values, request, 'действие меняет данные или окна — нужен --yes');
  }
  if (!connection.token) return usage(noTokenMessage());

  const received = await sendRequest({
    ...connection,
    method: command.method,
    path: request.path,
    body: command.method === 'GET' ? undefined : request.body,
    timeoutMs: flags.timeout,
    fetchImpl: options.fetchImpl
  });
  if (!received.ok) return failure(received);

  // Выгрузка: сервер отдаёт файл. С `--out` пишем его на диск, с `--json` кладём в
  // поле `text`, без `--json` печатаем как есть — `tf export … > characters.csv`
  // работает так же, как `curl`.
  if (typeof received.rawText === 'string') {
    const target = flags.out !== undefined ? String(flags.out) : '';
    if (target) {
      const write = options.writeFile || ((path, text) => writeFileSync(path, text, 'utf8'));
      write(target, received.rawText);
      return emit(EXIT.ok, [`файл: ${resolve(target)} (${received.rawText.length} байт)`], {
        ok: true,
        command: command.name,
        status: received.status,
        savedTo: resolve(target),
        bytes: received.rawText.length,
        contentType: received.contentType
      });
    }
    return emit(EXIT.ok, [received.rawText], {
      ok: true,
      command: command.name,
      status: received.status,
      text: received.rawText
    });
  }

  const data = received.data;
  const envelope = {
    ok: true,
    command: command.name,
    method: command.method,
    path: request.path,
    status: received.status,
    summary: summarize(command, data, values),
    data
  };

  // Задание запуска: `202 { jobId }` приходит сразу, итог — в `GET /jobs/{id}`.
  // С `--wait` CLI опрашивает сам; прогресс идёт в stderr, чтобы stdout остался
  // одним объектом JSON.
  const jobId = data?.jobId ? String(data.jobId) : '';
  const isLaunch = request.path.includes('/launch/');
  if (jobId && isLaunch && flags.wait === true) {
    const waitMs = Number(flags['wait-timeout']) > 0 ? Number(flags['wait-timeout']) : 600000;
    const sleep = options.sleep || (ms => new Promise(done => setTimeout(done, ms)));
    const now = options.now || (() => Date.now());
    const deadline = now() + waitMs;
    /** @type {any} */
    let job;
    for (;;) {
      const poll = await sendRequest({
        ...connection,
        method: 'GET',
        path: `/api/v1/jobs/${encodeURIComponent(jobId)}`,
        timeoutMs: flags.timeout,
        fetchImpl: options.fetchImpl
      });
      if (!poll.ok) return failure(poll);
      job = poll.data;
      stderr.push(
        `… ${job?.status || '?'} · ${job?.progress?.stage || ''} ${job?.progress?.done ?? 0}/${job?.progress?.total ?? '?'}`
      );
      if (job?.status && !['queued', 'running'].includes(job.status)) break;
      if (now() > deadline) {
        stderr.push(`задание ${jobId} не завершилось за ${Math.round(waitMs / 1000)} с — tf jobs --job-id ${jobId}`);
        break;
      }
      await sleep(1500);
    }
    envelope.job = job;
    if (job?.status === 'failed')
      envelope.warning = `задание завершилось с ошибкой: ${job?.result?.error || job?.progress?.stage || 'см. result'}`;
  } else if (jobId && isLaunch) {
    envelope.next = `tf jobs --job-id ${jobId} --wait`;
  }

  const lines = [`${command.method} ${request.path} → ${received.status} · ${envelope.summary}`];
  if (envelope.job) {
    const stats = envelope.job.result;
    lines.push(
      `задание ${envelope.job.id}: ${envelope.job.status}` +
        (stats
          ? ` · запущено ${stats.launched ?? 0}, пропущено ${stats.skipped ?? 0}, ошибок ${stats.failed ?? 0}`
          : '')
    );
  }
  if (envelope.next) lines.push(`   → ${envelope.next}`);
  return emit(EXIT.ok, [...lines, JSON.stringify(data, null, 2)], envelope);
}

/** Запуск из командной строки: печать двух потоков и кода выхода. */
async function main() {
  const output = await run({ argv: process.argv.slice(2), env: process.env });
  for (const line of output.stdout) process.stdout.write(`${line}\n`);
  for (const line of output.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = output.code;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`tf: внутренняя ошибка: ${error?.stack || error}\n`);
    process.exitCode = EXIT.usage;
  });
}
