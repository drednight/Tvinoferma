// scripts/tf/catalog.mjs
// Каталог команд `tf`: собирается из того же списка, что рисует вкладку
// «Действия» на странице API (`src-tauri/src/external_api/web/actions.js`).
//
// Почему из каталога, а не ещё одним списком в репозитории: карточка действия уже
// описывает метод, путь, право, поля, подтверждение и форму запроса (`body`, `query`,
// `pathOf`). Если бы CLI держал свой перечень команд, он обязан был бы разъезжаться
// с API — ровно тот риск, от которого в проекте защищают
// `tests/externalApiActions.test.js` и `npm run docs:api-examples:check`. Здесь
// команды выводятся из каталога, а паритет проверяет `tests/agentCli.test.js`.
//
// Загрузка — та же, что на странице: файл объявляет IIFE и кладёт массив в
// `window.TF_API_ACTIONS`, поэтому в Node ему подставляем «окно»-приёмник.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Право, нужное действию; `read` — не меняет ничего. */
export const SCOPES = {
  read: 'чтение',
  modify: 'изменение',
  launchClose: 'запуск и закрытие окон'
};

/**
 * Псевдонимы для частых команд: `tf characters` вместо `tf list-characters`.
 * Только чтение и только явные соответствия — у действия не может быть двух
 * смыслов, поэтому проверяется тестом (каждый псевдоним ведёт в существующую команду).
 */
export const ALIASES = {
  characters: 'list-characters',
  parties: 'list-parties',
  marathons: 'list-marathons',
  windows: 'list-windows',
  jobs: 'job-status'
};

/** Глобальные флаги: не поля действия, а настройки самого `tf`. */
export const GLOBAL_FLAGS = [
  { name: 'base', hint: 'адрес сервера, по умолчанию http://127.0.0.1:47831 (тестовая сборка — 47832)' },
  { name: 'port', hint: 'то же, что --base, но только порт' },
  { name: 'token-file', hint: 'файл с токеном; по умолчанию переменная окружения TF_API_TOKEN' },
  { name: 'json', hint: 'один JSON в stdout — для скриптов и агентов' },
  { name: 'dry-run', hint: 'показать запрос и не отправлять его' },
  { name: 'yes', hint: 'подтвердить действие (по умолчанию все изменение/запуск требуют его)' },
  { name: 'wait', hint: 'дождаться задания запуска и вернуть его итог' },
  { name: 'wait-timeout', hint: 'сколько миллисекунд ждать задания, по умолчанию 600000' },
  { name: 'timeout', hint: 'сколько миллисекунд ждать ответ сервера, по умолчанию 20000' },
  { name: 'out', hint: 'выгрузить ответ в файл (для /export/*)' },
  { name: 'help', hint: 'краткая справка' }
];

/** Файл каталога действий страницы API. */
function actionsSource(root) {
  return readFileSync(resolve(root, 'src-tauri/src/external_api/web/actions.js'), 'utf8');
}

/** Настоящий каталог, как его видит страница: массив объектов действий. */
export function loadRawActions(root) {
  const scope = {};
  new Function('window', actionsSource(root))(scope);
  const actions = scope.TF_API_ACTIONS;
  if (!Array.isArray(actions) || !actions.length) throw new Error('Каталог действий пуст или не найден');
  return actions;
}

/** Имя флага поля: `characterId` → `--character-id`. */
export function flagName(field) {
  return `--${String(field.name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()}`;
}

/** Как флаг сопоставляется с полем: `--character-id`, `--characterId` и `--characterid` — одно и то же. */
export function normalizeFlag(flag) {
  return String(flag || '')
    .replace(/^--/, '')
    .replace(/-/g, '')
    .toLowerCase();
}

/**
 * Команда CLI из действия страницы. `build` — те же функции `body`/`query`/`pathOf`,
 * что использует форма, поэтому запрос у CLI ровно тот же, что у кнопки.
 */
function toCommand(action) {
  return {
    name: action.id,
    group: action.group,
    title: action.title,
    summary: action.summary,
    method: action.method,
    path: action.path,
    scope: action.scope || 'read',
    danger: !!action.danger,
    fields: (action.fields || []).map(field => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: !!field.required,
      hint: field.hint || '',
      default: field.default,
      options: field.options || null,
      // Пример значения из каталога: тип поля не подсказывает, что там PID или id
      // персонажа, а пример обязан быть рабочим — его проверяет `tests/agentCli.test.js`.
      example: field.example ?? null,
      flag: flagName(field)
    })),
    build: action.body || null,
    query: action.query || null,
    pathOf: action.pathOf || null,
    result: action.result || null,
    confirmText: action.confirmText || null,
    /** Описание для `tf describe`: те же поля, что у карточки. */
    isWrite: (action.scope || 'read') !== 'read'
  };
}

/** Все команды по имени (`tf ls`, `tf describe …`, паритет в тестах). */
export function loadCommands(root) {
  const commands = new Map();
  for (const action of loadRawActions(root)) {
    const command = toCommand(action);
    if (commands.has(command.name)) throw new Error(`Дубликат команды в каталоге: ${command.name}`);
    commands.set(command.name, command);
  }
  return commands;
}

/** Команда по имени или псевдониму; `null`, если такой команды нет. */
export function findCommand(commands, name) {
  if (!name) return null;
  const direct = commands.get(name);
  if (direct) return direct;
  const alias = ALIASES[name];
  return alias ? commands.get(alias) || null : null;
}

/**
 * Значения по умолчанию — как в форме, но БЕЗ автоподстановки «первого персонажа
 * или первой пати». На странице это удобно, в CLI было бы опасно: `tf launch-character`
 * без иди запустил бы чужого персонажа. Лучше честная ошибка «не указано».
 */
export function defaultValues(command) {
  const values = {};
  for (const field of command.fields) {
    if (field.default !== undefined) values[field.name] = field.default;
    else if (field.type === 'checkbox') values[field.name] = false;
  }
  return values;
}

/** Проверка обязательных полей: сказать до запроса, а не получить 422. */
export function missingFields(command, values) {
  return command.fields
    .filter(field => field.required && (values[field.name] === '' || values[field.name] === undefined))
    .map(field => field);
}

/** Готовый запрос команды: путь (с `?…`) и тело — теми же функциями, что и страница. */
export function buildRequest(command, values) {
  const path = command.pathOf ? command.pathOf(values) : command.path;
  const query = command.query ? command.query(values) : '';
  const body = command.build ? command.build(values) : undefined;
  return { path: `${path}${query}`, body };
}

/** Короткая human-строка «что получилось» — та же функция, что у карточки. */
export function summarize(command, data, values) {
  if (!command.result) return 'готово';
  try {
    return String(command.result(data, values) ?? 'готово');
  } catch {
    return 'готово';
  }
}

/** Список команд для `tf ls` и `tf --help`. */
export function helpText(commands) {
  const lines = [];
  lines.push('tf — командная строка Твинофермы поверх внешнего API (127.0.0.1, токен из TF_API_TOKEN).');
  lines.push('');
  lines.push('Использование: tf <команда> [позиционные значения] [--флаг значение …] [--json]');
  lines.push('');
  lines.push('Служебные команды:');
  lines.push('  tf ls                     список команд (то же, что этот раздел)');
  lines.push('  tf describe <команда>    поля команды и пример запроса');
  lines.push('  tf call GET /characters   прямой запрос к API (то же право и тот же токен)');
  lines.push('  tf <команда> --yes        подтвердить изменение, запуск или закрытие окон');
  lines.push('');
  const groups = new Map();
  for (const command of commands.values()) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  for (const [group, list] of groups) {
    lines.push('');
    lines.push(`${group}:`);
    for (const command of list) {
      const required = command.fields.some(field => field.required)
        ? command.fields
            .filter(field => field.required)
            .map(field => `<${field.name}>`)
            .join(' ')
        : '';
      const marks = [command.danger ? '⚠' : '', command.isWrite ? 'изм.' : 'чтение'].filter(Boolean).join(' ');
      lines.push(`  tf ${command.name} ${required}`.padEnd(46) + `${command.method} ${command.path}  [${marks}]`);
    }
  }
  lines.push('');
  lines.push(
    'Псевдонимы: ' +
      Object.entries(ALIASES)
        .map(([alias, name]) => `${alias} → ${name}`)
        .join(', ')
  );
  lines.push('');
  lines.push('Глобальные флаги:');
  for (const flag of GLOBAL_FLAGS) lines.push(`  --${flag.name.padEnd(13)}${flag.hint}`);
  lines.push('');
  lines.push('Права берутся из настроек приложения («Настройки → 🔌 Внешний API»): без нужного');
  lines.push('права команда получает 403 forbidden_scope — CLI подскажет, какое право включить.');
  lines.push(
    'Коды выхода: 0 — успех (в том числе dry-run), 1 — отказ API, 2 — ошибка в командной строке, 3 — сервер не отвечает.'
  );
  return `${lines.join('\n')}\n`;
}

/** Справка по одной команде: поля, права, пример. */
export function describeText(command) {
  const lines = [];
  lines.push(`tf ${command.name} — ${command.title}`);
  lines.push(command.summary);
  lines.push('');
  lines.push(`Запрос:  ${command.method} ${command.path}`);
  lines.push(`${'Право:'.padEnd(8)}${SCOPES[command.scope] || command.scope}`);
  if (command.danger) lines.push(`${'Опасно:'.padEnd(8)}да — CLI потребует --yes и покажет подтверждение`);
  if (command.confirmText) {
    const preview = confirmPreview(command);
    if (preview) lines.push(`Подтверждение: ${preview}`);
  }
  if (command.isWrite)
    lines.push('По умолчанию запрос НЕ отправляется: нужен --yes (или --dry-run, чтобы посмотреть).');
  lines.push('');
  if (!command.fields.length) {
    lines.push('Полей нет: запрос уходит как есть.');
  } else {
    lines.push('Поля:');
    for (const field of command.fields) {
      const parts = [field.flag, field.type];
      if (field.required) parts.push('обязательно');
      if (field.options) parts.push(`одно из: ${field.options.join('|')}`);
      if (field.default !== undefined) parts.push(`по умолчанию ${JSON.stringify(field.default)}`);
      lines.push(`  ${parts.join(', ')} — ${field.label}`);
      if (field.hint) lines.push(`      ${field.hint}`);
    }
  }
  lines.push('');
  lines.push('Пример: ' + exampleLine(command));
  return `${lines.join('\n')}\n`;
}

/** Строка примера: заполняем обязательные поля значениями из каталога. */
export function exampleLine(command) {
  const parts = [`tf ${command.name}`];
  for (const field of command.fields) {
    if (!field.required) continue;
    parts.push(field.flag, exampleValue(field));
  }
  if (command.isWrite) parts.push('--dry-run');
  return parts.join(' ');
}

/**
 * Значение для примера: сначала `example` из каталога, потом — по типу поля.
 * Несуществующие id не выдумываем: `<id>` честнее, чем «Mag_1», которого может не быть.
 */
function exampleValue(field) {
  if (field.example) return String(field.example);
  if (field.options) return String(field.options[0]);
  if (field.type === 'number') return '1';
  if (field.type === 'date') return '2026-01-01';
  if (field.type === 'character' || field.type === 'party') return '<id>';
  return '<значение>';
}

/**
 * Текст подтверждения для справки. `confirmText` — функция, и она может обратиться
 * к полю, которого пользователь ещё не задал: показываем заглушку, а не падаем.
 */
function confirmPreview(command) {
  if (!command.confirmText) return '';
  const values = {};
  for (const field of command.fields) values[field.name] = field.default ?? `<${field.name}>`;
  try {
    return String(command.confirmText(values));
  } catch {
    return '';
  }
}
