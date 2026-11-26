// @ts-check
// js/modules/externalApi/actions/export.js
// Выгрузка списков для внешних программ: CSV и JSON-файл.
//
// Зачем это в API: сторонняя программа (Excel, Python, PowerShell) должна уметь
// получить таблицу персонажей, марафонов или окон одним запросом, не собирая CSV
// из JSON вручную. Форматы повторяют то, что уже делает «Гибкий экспорт» в
// настройках: CSV — с `;` и BOM (Excel открывает без настройки кодировки),
// JSON — массив записей без секретов.
//
// Правило безопасности то же, что у чтения: контакты, пароли, токены GameCenter,
// куки и облачные ключи не выгружаются никогда — только белые списки полей.
//
// Функции чистые: `state` и готовые строки приходят аргументами, файл никто не
// пишет — его отдаёт HTTP-ответ с `Content-Disposition`.

import { publicCharacters, publicMarathons, publicWindows, publicFinance, publicPlanner } from './read.js';

/** Что можно выгрузить: ключ маршрута — имя набора. */
export const EXPORT_DATASETS = ['characters', 'parties', 'marathons', 'windows', 'planner', 'finance'];

/** Точка с запятой — так Excel на русской локали не перепутает колонки. */
const DELIMITER = ';';

/**
 * Значение для CSV: кавычки, если внутри есть разделитель, кавычка или перевод строки.
 * Числа и `null` пишутся как есть — без кавычек их проще разбирать.
 */
function csvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (!text.includes(DELIMITER) && !text.includes('"') && !text.includes('\n') && !text.includes('\r')) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Таблица из строк: `columns` — пары «ключ в объекте» → «заголовок».
 * Возвращает строку CSV с BOM: Excel без него показывает кириллицу «кракозябрами».
 * @param {Array<[string, string]>} columns
 * @param {Record<string, any>[]} rows
 */
export function toCsv(columns, rows) {
  const header = columns.map(([, title]) => csvValue(title)).join(DELIMITER);
  const lines = (rows || []).map(row => columns.map(([key]) => csvValue(readPath(row, key))).join(DELIMITER));
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}

/** Достаёт значение по пути `a.b.c`; отсутствующий путь — пустая строка. */
function readPath(row, path) {
  let current = row;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return '';
    current = current[part];
  }
  return current === undefined ? '' : current;
}

/** Строки для набора: ровно те же данные, что отдаёт чтение, но плоскими строками. */
function datasetRows(state, dataset, options) {
  if (dataset === 'characters') {
    const { characters } = publicCharacters(state, options.query || '', { running: options.running || null });
    return characters;
  }
  if (dataset === 'parties') {
    // Состав склеивается в одну ячейку «Маг, Лучник»: CSV — плоская таблица.
    const parties = Array.isArray(state?.parties) ? state.parties : [];
    const characters = Array.isArray(state?.characters) ? state.characters : [];
    return parties.map(party => {
      const members = characters
        .filter(char => (char.partyIds || []).map(String).includes(String(party.id)))
        .map(char => String(char.nick || char.id));
      return {
        id: party.id,
        name: party.name || '',
        color: party.color ?? '',
        membersCount: members.length,
        members: members.join(', ')
      };
    });
  }
  if (dataset === 'marathons') {
    const { marathons } = publicMarathons(state, options.totalsOf || null);
    return marathons.map(marathon => ({
      id: marathon.id,
      kind: marathon.kind,
      title: marathon.title,
      startDate: marathon.startDate ?? '',
      endDate: marathon.endDate ?? '',
      status: marathon.status ?? '',
      participantsCount: Array.isArray(marathon.participantIds) ? marathon.participantIds.length : 0,
      tasksCount: Array.isArray(marathon.tasks) ? marathon.tasks.length : 0,
      checks: marathon.totals?.checks ?? '',
      maxChecks: marathon.totals?.maxChecks ?? '',
      done: marathon.totals?.done ?? '',
      coins: marathon.totals?.coins ?? '',
      maxCoins: marathon.totals?.maxCoins ?? ''
    }));
  }
  if (dataset === 'windows') {
    const { windows } = publicWindows(options.windowRows || [], options.now || new Date().toISOString());
    return windows;
  }
  if (dataset === 'planner') {
    return publicPlanner(state).entries;
  }
  if (dataset === 'finance') {
    const finance = publicFinance(state);
    // В CSV — только движения денег: позиции магазина и долги отдельными строками
    // смешались бы в одну таблицу без смысла.
    return finance.operations;
  }
  return [];
}

/** Колонки для каждого набора: ключ → заголовок. Порядок важен для читаемости. */
const DATASET_COLUMNS = {
  characters: [
    ['id', 'id'],
    ['nick', 'Ник'],
    ['class', 'Класс'],
    ['level', 'Уровень'],
    ['favorite', 'Избранный'],
    ['partyIds', 'Пати'],
    ['mainPartyId', 'Основная пати'],
    ['stats.physAttack', 'Физ. атака'],
    ['stats.magAttack', 'Маг. атака'],
    ['stats.hp', 'HP'],
    ['stats.mp', 'MP'],
    ['dungeonPasses.weapon', 'Проходки: оружие'],
    ['dungeonPasses.armor', 'Проходки: доспех'],
    ['dungeonPasses.relic', 'Проходки: реликвия'],
    ['ancientCoins', 'Древние монеты'],
    ['isLoggedIn', 'Вход проверен'],
    ['lastLoginCheck', 'Проверка входа'],
    ['running.pid', 'PID окна'],
    ['updatedAt', 'Обновлён'],
    ['tags', 'Теги'],
    ['notes', 'Заметки']
  ],
  parties: [
    ['id', 'id'],
    ['name', 'Название'],
    ['color', 'Цвет'],
    ['membersCount', 'Участников'],
    ['members', 'Состав']
  ],
  marathons: [
    ['id', 'id'],
    ['kind', 'Тип'],
    ['title', 'Название'],
    ['startDate', 'Начало'],
    ['endDate', 'Окончание'],
    ['status', 'Статус'],
    ['participantsCount', 'Участников'],
    ['tasksCount', 'Заданий'],
    ['checks', 'Отметок'],
    ['maxChecks', 'Максимум отметок'],
    ['done', 'Выполнено'],
    ['coins', 'Монет'],
    ['maxCoins', 'Максимум монет']
  ],
  windows: [
    ['pid', 'PID'],
    ['title', 'Заголовок'],
    ['charId', 'id персонажа'],
    ['nick', 'Ник'],
    ['class', 'Класс'],
    ['elevated', 'От администратора'],
    ['startedAt', 'Запущено']
  ],
  planner: [
    ['id', 'id'],
    ['title', 'Название'],
    ['date', 'Дата'],
    ['time', 'Время'],
    ['durationMinutes', 'Минут'],
    ['kind', 'Тип'],
    ['priority', 'Приоритет'],
    ['recurrence', 'Повтор'],
    ['status', 'Статус']
  ],
  finance: [
    ['id', 'id'],
    ['date', 'Дата'],
    ['kind', 'Направление'],
    ['amount', 'Сумма'],
    ['currency', 'Валюта'],
    ['counterparty', 'Контрагент'],
    ['note', 'Комментарий'],
    ['characterId', 'id персонажа']
  ]
};

/**
 * Собрать выгрузку. `format` — `csv` или `json`; имя файла и MIME подставляются
 * сюда же, чтобы мост не выбирал их у себя.
 *
 * @param {any} state
 * @param {string} dataset одно из `EXPORT_DATASETS`
 * @param {{ format?: 'csv' | 'json', query?: string, running?: Map<string, any> | null,
 *           windowRows?: any[], totalsOf?: null | ((m: any) => any),
 *           now?: string, dateStamp?: string }} [options]
 * @returns {{ contentType: string, fileName: string, text: string, rows: number, columns: number }}
 */
export function buildExport(state, dataset, options = {}) {
  const name = String(dataset || '');
  if (!EXPORT_DATASETS.includes(name)) {
    throw new Error(`Неизвестный набор для выгрузки: ${name}`);
  }
  const format = options.format === 'json' ? 'json' : 'csv';
  const rows = datasetRows(state, name, options);
  const stamp = options.dateStamp || new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      fileName: `tvinoferma_${name}_${stamp}.json`,
      text: JSON.stringify({ dataset: name, exportedAt: options.now || new Date().toISOString(), rows }, null, 2),
      rows: rows.length,
      columns: 0
    };
  }
  const columns = DATASET_COLUMNS[name] || [];
  return {
    contentType: 'text/csv; charset=utf-8',
    fileName: `tvinoferma_${name}_${stamp}.csv`,
    text: toCsv(columns, rows),
    rows: rows.length,
    columns: columns.length
  };
}
