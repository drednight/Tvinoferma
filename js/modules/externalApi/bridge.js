// @ts-check
// js/modules/externalApi/bridge.js
// Мост между локальным сервером (Rust) и приложением (JS).
//
// Rust принимает HTTP, проверяет Host, токен, права и лимиты — и присылает событие
// `external-api-request` в главное окно. Здесь событие превращается в вызов
// существующих модулей приложения и ответ `invoke('external_api_reply', …)`.
//
// Почему так, а не «вся логика в Rust»: нормализация, история статов, очередь
// сохранений и запуск окон уже написаны и покрыты тестами в JS — дублировать их
// означало бы завести вторую правду о данных. Rust остаётся тонким транспортом.
//
// Ответ уходит всегда, даже при исключении: иначе внешняя программа ждала бы
// 15 секунд и получила `504`. Ошибки не содержат тел запросов и токенов.

import { state } from '../../core/state.js';
import { mskDate } from '../../core/msk.js';
import { persist, assertStateWriteAvailable } from '../../core/storage.js';
import { ApiError, errorBody } from './actions/mutate.js';
import { runningByCharId } from './actions/read.js';
import { JobRegistry } from './actions/launch.js';

const EVENT = 'external-api-request';
const STARTED_AT = Date.now();
/** Форматы выгрузки: `txt` — тот же CSV, для клиентов, которым так удобнее. */
const EXPORT_FORMATS = new Set(['csv', 'json', 'txt']);

/** Подписи полей для адресных ответов (`{ stat: "hp", label: "HP" }`). */
const FIELD_LABELS = {
  endurance: 'Выносливость',
  intelligence: 'Интеллект',
  strength: 'Сила',
  agility: 'Ловкость',
  hp: 'HP',
  mp: 'MP',
  levelBonus: 'Бонус уровня',
  physAttack: 'Физ. атака',
  physDefense: 'Физ. защита',
  magAttack: 'Маг. атака',
  magDefense: 'Маг. защита',
  critChance: 'Крит, %',
  critDamage: 'Крит. урон',
  atkSpeed: 'Скорость атаки',
  evasion: 'Уклонение',
  accuracy: 'Меткость',
  pa: 'PA',
  pz: 'PZ',
  morale: 'Дух',
  pvePa: 'PvE PA',
  pvePz: 'PvE PZ',
  physPenetration: 'Физ. пробивание',
  magPenetration: 'Маг. пробивание',
  weapon: 'Оружие',
  armor: 'Доспех',
  relic: 'Реликвия'
};

/** Подпись по ключу поля; неизвестный ключ возвращается как есть. */
function fieldLabel(key) {
  return FIELD_LABELS[String(key)] || String(key);
}

/** Текст ошибки для ответа: без стеков и внутренностей. */
function errorMessage(error) {
  return String(error?.message || error || 'Неизвестная ошибка');
}

/**
 * `marathonTotals` из модели марафонов — ленивый импорт и возможность подмены
 * в тестах. Если модель недоступна, список отдаётся без цифр (`totals: null`),
 * а не падает целиком.
 */
async function marathonTotalsFn(deps) {
  if (deps.marathonTotals !== undefined) return deps.marathonTotals;
  try {
    const model = await import('../marathons/model.js');
    return model.marathonTotals || null;
  } catch {
    return null;
  }
}

/** Права, которые Rust уже проверил; повторная проверка здесь — только для отказов. */
function denied(scope) {
  return new ApiError(403, 'forbidden_scope', `Право «${scope}» выключено в настройках`);
}

function requireScope(scope) {
  const settings = state.settings?.externalApi || {};
  if (scope === 'modify' && !settings.allowModify) throw denied('Изменение статов и проходок');
  if (scope === 'launchClose' && !settings.allowLaunchClose) throw denied('Запуск и закрытие окон');
}

/**
 * Путь из запроса. Rust присылает его как есть (в percent-encoding), поэтому
 * `..` проверяем и в сыром виде, и после декодирования: `%2e%2e%2f` — тот же
 * выход из каталога. Управляющие символы (в том числе перевод строки) не
 * пропускаем: они не должны попасть в журнал и ответ.
 */
function normalizePath(path) {
  const text = String(path || '/');
  if (!text.startsWith('/')) throw new ApiError(404, 'not_found', 'Неизвестный путь');
  let decoded;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Некорректный адрес запроса');
  }
  // eslint-disable-next-line no-control-regex -- проверяем именно управляющие символы
  if (text.includes('..') || decoded.includes('..') || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new ApiError(404, 'not_found', 'Неизвестный путь');
  }
  return text;
}

/**
 * Тело запроса как объект. `allowNumber` — для маршрутов, где законно «голое»
 * число (`PATCH /dungeon-passes/{pass}` с телом `5`): так короче в curl/PowerShell.
 */
function jsonBody(body, { allowNumber = false } = {}) {
  if (body === null || body === undefined) return null;
  if (allowNumber && typeof body === 'number') return body;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', 'Тело запроса должно быть JSON-объектом');
  }
  return body;
}

function parseQuery(query) {
  try {
    return new URLSearchParams(String(query || ''));
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Некорректный адрес запроса');
  }
}

function isoSeconds(ms) {
  return Math.max(0, Math.round((Number(ms) || 0) / 1000));
}

/** Список окон игры: та же сборка строк, что в интерфейсе (`runningClientDetails` + `windowRows`). */
async function readWindowRows() {
  const [{ runningClientDetails }, { windowRows }, { windowOwnershipOptions }] = await Promise.all([
    import('../launcher/launch.js'),
    import('../launcher/windowList.js'),
    import('../launcher/launchedWindows.js')
  ]);
  const clients = await runningClientDetails().catch(() => []);
  return windowRows(
    Array.isArray(clients) ? clients : [],
    state.characters,
    windowOwnershipOptions(Array.isArray(clients) ? clients : [])
  );
}

/** Разбор `POST /windows/close`: массив pid и явное подтверждение. */
export function parseCloseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', 'Тело запроса должно быть JSON-объектом');
  }
  const allowed = new Set(['pids', 'confirm']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  }
  if (body.confirm !== true) {
    throw new ApiError(400, 'confirm_required', 'Закрытие окон требует явного {"confirm": true}');
  }
  if (!Array.isArray(body.pids) || !body.pids.length) {
    throw new ApiError(422, 'invalid_value', 'pids должен быть непустым массивом');
  }
  if (body.pids.length > 100) throw new ApiError(422, 'invalid_value', 'За один раз можно закрыть не больше 100 окон');
  const pids = [];
  for (const value of body.pids) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) throw new ApiError(422, 'invalid_value', `Некорректный PID: ${value}`);
    if (pids.includes(pid)) throw new ApiError(422, 'invalid_value', `Повторяющийся PID: ${pid}`);
    pids.push(pid);
  }
  return pids;
}

/**
 * Маршрутизация одного запроса. Экспортируется для тестов: `deps` подменяются,
 * поэтому тест не поднимает ни сервер, ни приложение.
 *
 * @param {{ method: string, path: string, query?: string, body?: any }} request
 * @param {Record<string, any>} [deps]
 * @returns {Promise<{ status: number, body: any, raw?: { contentType: string, text: string, disposition?: string } }>}
 */
export async function routeRequest(request, deps = {}) {
  const method = String(request?.method || 'GET').toUpperCase();
  const path = normalizePath(request?.path);
  const query = parseQuery(request?.query);
  const body = request?.body ?? null;
  const settings = state.settings?.externalApi || {};
  const now = deps.now || (() => new Date().toISOString());
  // Подмена из `deps` (тесты, альтернативная реализация) или ленивая загрузка:
  // `fallback` — фабрика, её нужно вызвать. Раньше здесь возвращалась сама
  // функция, и маршруты, которых нет в `deps`, получали фабрику вместо модуля.
  const load = async (name, fallback) => {
    if (deps[name] !== undefined) return deps[name];
    return typeof fallback === 'function' ? fallback() : fallback;
  };

  // --- Чтение ---
  if (method === 'GET' && path === '/api/v1/health') {
    const version = await load('appVersion', () =>
      import('@tauri-apps/api/app').then(app => app.getVersion?.()).catch(() => null)
    );
    const profile = await load('buildProfile', () => dynamicInvoke('app_build_profile').catch(() => 'stable'));
    const registry = await load('jobs', () => jobsRegistry());
    const storageWritable = deps.storageWritable ?? storageWritableNow(deps);
    return {
      status: 200,
      body: {
        ok: true,
        app: { version: version || 'неизвестна', build: profile || 'stable' },
        api: { version: 1, uptimeSec: isoSeconds(Date.now() - STARTED_AT) },
        storage: { writable: storageWritable },
        scopes: {
          read: settings.allowRead !== false,
          modify: !!settings.allowModify,
          launchClose: !!settings.allowLaunchClose
        },
        launch: { busy: !!registry?.active?.() }
      }
    };
  }

  // --- Сводка: что сейчас в приложении ---
  //
  // Один запрос вместо пяти: сколько персонажей и пати, что осталось на сегодня,
  // сколько денег в реестре и открыто ли окно игры. Для внешней программы это
  // дешёвый способ понять «приложение живо и готово», не разбирая все списки.
  if (method === 'GET' && path === '/api/v1/status') {
    const version = await load('appVersion', () =>
      import('@tauri-apps/api/app').then(app => app.getVersion?.()).catch(() => null)
    );
    const profile = await load('buildProfile', () => dynamicInvoke('app_build_profile').catch(() => 'stable'));
    const registry = await load('jobs', () => jobsRegistry());
    const storageWritable = deps.storageWritable ?? storageWritableNow(deps);
    const read = await load('characters', () => import('./actions/read.js'));
    const rows = await load('windowRows', () => readWindowRows());
    const characters = read.publicCharacters(state, '', { running: runningByCharIdOf(rows) }).characters || [];
    const parties = read.publicParties(state).parties || [];
    const marathons = read.publicMarathons(state, await marathonTotalsFn(deps)).marathons || [];
    const planner = read.publicPlanner(state);
    const finance = read.publicFinance(state);
    const balances = await load('balances', () =>
      import('../finance/model.js').then(model => model.currentBalances(state.finance || {}))
    );
    const today = mskDate(new Date());
    // Дела на сегодня — с учётом повторов: ежедневная запись со вторника попадает
    // в сегодняшний список, даже если её дата — прошлый вторник.
    const plannerModel = await load('planner', () => import('../dashboard/planner.js'));
    const todayEntries = (planner.entries || []).filter(entry => plannerModel.entryOccursOn(entry, today));
    const doneToday = todayEntries.filter(entry => plannerModel.entryStatusForDate(entry, today) === 'done').length;
    return {
      status: 200,
      body: {
        ok: true,
        app: { version: version || 'неизвестна', build: profile || 'stable' },
        api: { version: 1, uptimeSec: isoSeconds(Date.now() - STARTED_AT) },
        storage: { writable: storageWritable },
        scopes: {
          read: settings.allowRead !== false,
          modify: !!settings.allowModify,
          launchClose: !!settings.allowLaunchClose
        },
        launch: { busy: !!registry?.active?.() },
        counts: {
          characters: characters.length,
          parties: parties.length,
          marathons: marathons.length,
          plannerEntries: (planner.entries || []).length,
          windows: rows.length,
          financeOperations: (finance.operations || []).length
        },
        today: {
          date: today,
          total: todayEntries.length,
          done: doneToday
        },
        finance: { balances: balances || {} }
      }
    };
  }

  if (method === 'GET' && path === '/api/v1/characters') {
    const read = await load('characters', () => import('./actions/read.js'));
    // Неизвестное поле в `fields` — ошибка, а не тихий пропуск: иначе клиент
    // получил бы строки без нужной колонки и не понял, почему её нет.
    const requested = String(query.get('fields') || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    const wrong = read.unknownFields(requested);
    if (wrong.length) {
      throw new ApiError(
        422,
        'invalid_value',
        `Неизвестные поля: ${wrong.join(', ')}. Допустимые: ${read.CHARACTER_FIELD_NAMES.join(', ')}`
      );
    }
    const rows = await load('windowRows', () => readWindowRows());
    return { status: 200, body: read.publicCharacters(state, query.toString(), { running: runningByCharIdOf(rows) }) };
  }

  if (method === 'GET' && path.startsWith('/api/v1/characters/')) {
    const id = decodeSegment(path.slice('/api/v1/characters/'.length));

    // Адресные данные: /stats, /stats/{stat}, /dungeon-passes, /dungeon-passes/{pass}.
    // Разбираем путь до общего `/{id}`, чтобы `Маг_1/stats` не стал карточкой
    // персонажа с id «Маг_1/stats».
    const parts = id.split('/');
    if (parts.length >= 2 && (parts[1] === 'stats' || parts[1] === 'dungeon-passes')) {
      const read = await load('readAction', () => import('./actions/read.js'));
      const rows = await load('windowRows', () => readWindowRows());
      const running = runningByCharIdOf(rows);
      const charId = parts[0];
      // Подписи для человека (`hp` → «HP») — из общей таблицы: та же, что на странице.
      const labelOf = (await load('labels', () => fieldLabel)) || null;
      const options = { running, labels: labelOf };
      if (parts[1] === 'stats') {
        if (parts.length === 2) {
          const data = read.characterStats(state, charId, options);
          if (!data) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
          return { status: 200, body: data };
        }
        if (parts.length === 3) {
          const data = read.characterStat(state, charId, parts[2], options);
          if (!data) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
          if (data.unknown !== undefined) {
            throw new ApiError(
              422,
              'invalid_value',
              `Неизвестный стат «${data.unknown}»: список — GET /characters/${charId}/stats`
            );
          }
          return { status: 200, body: data };
        }
        throw new ApiError(404, 'not_found', 'Неизвестный путь API');
      }
      // dungeon-passes
      if (parts.length === 2) {
        const data = read.characterPasses(state, charId, options);
        if (!data) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
        return { status: 200, body: data };
      }
      if (parts.length === 3) {
        const data = read.characterPass(state, charId, parts[2], options);
        if (!data) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
        if (data.unknown !== undefined) {
          throw new ApiError(
            422,
            'invalid_value',
            `Неизвестная проходка «${data.unknown}»: weapon/оружие, armor/доспех, relic/реликвия`
          );
        }
        return { status: 200, body: data };
      }
      throw new ApiError(404, 'not_found', 'Неизвестный путь API');
    }

    const { publicCharacters } = await load('characters', () => import('./actions/read.js'));
    // Адресный маршрут — ЭТО карточка, поэтому полный: сокращение списка к нему
    // не относится, и `GET /characters/{id}` обязан оставаться «всё про персонажа».
    const list = publicCharacters(state, '', {
      running: runningByCharIdOf(await load('windowRows', () => readWindowRows())),
      forceFull: true
    }).characters;
    const character = list.find(row => String(row.id) === id) || null;
    if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
    return { status: 200, body: { character } };
  }

  if (method === 'GET' && path === '/api/v1/parties') {
    const { publicParties } = await load('characters', () => import('./actions/read.js'));
    return { status: 200, body: publicParties(state) };
  }

  if (method === 'GET' && path.startsWith('/api/v1/parties/')) {
    const { publicParties } = await load('characters', () => import('./actions/read.js'));
    const id = decodeSegment(path.slice('/api/v1/parties/'.length));
    const party = publicParties(state).parties.find(row => String(row.id) === id) || null;
    if (!party) throw new ApiError(404, 'no_such_party', 'Пати не найдена');
    return { status: 200, body: { party } };
  }

  // --- Марафоны ---
  if (method === 'GET' && path === '/api/v1/marathons') {
    const read = await load('characters', () => import('./actions/read.js'));
    const totalsOf = await marathonTotalsFn(deps);
    return { status: 200, body: read.publicMarathons(state, totalsOf) };
  }

  if (method === 'GET' && path.startsWith('/api/v1/marathons/')) {
    const rest = path.slice('/api/v1/marathons/'.length);
    const read = await load('characters', () => import('./actions/read.js'));
    if (rest.endsWith('/participants')) {
      const id = decodeSegment(rest.slice(0, -'/participants'.length));
      const participants = read.marathonParticipants(state, id);
      if (!participants) throw new ApiError(404, 'no_such_marathon', 'Марафон не найден');
      return { status: 200, body: participants };
    }
    const id = decodeSegment(rest);
    const totalsOf = await marathonTotalsFn(deps);
    const marathon = read.publicMarathonById(state, id, totalsOf);
    if (!marathon) throw new ApiError(404, 'no_such_marathon', 'Марафон не найден');
    return { status: 200, body: { marathon } };
  }

  if (method === 'GET' && path === '/api/v1/planner') {
    const { publicPlanner } = await load('characters', () => import('./actions/read.js'));
    return { status: 200, body: publicPlanner(state) };
  }

  if (method === 'GET' && path === '/api/v1/finance') {
    const { publicFinance } = await load('characters', () => import('./actions/read.js'));
    return { status: 200, body: publicFinance(state) };
  }

  // --- Выгрузки файлов: CSV или JSON ---
  if (method === 'GET' && path.startsWith('/api/v1/export/')) {
    const name = decodeSegment(path.slice('/api/v1/export/'.length));
    // `format` в query имеет приоритет: `/export/characters?format=csv` — как у
    // остального API. Суффикс в пути (`characters.csv`) — сокращение для человека.
    const suffix = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const dataset = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    const extension = String(query.get('format') || suffix || 'csv').toLowerCase();
    if (!EXPORT_FORMATS.has(extension)) {
      throw new ApiError(422, 'invalid_value', 'Формат выгрузки: csv, json или txt');
    }
    const { buildExport } = await load('exportAction', () => import('./actions/export.js'));
    // Окна нужны и для колонки `running` у персонажей, и для набора `windows`:
    // читаем один раз, чтобы выгрузка не мигала разными снимками.
    const windowRows = await load('windowRows', () => readWindowRows());
    /** @type {any} */
    let prepared;
    try {
      prepared = buildExport(state, dataset, {
        format: extension === 'json' ? 'json' : 'csv',
        query: query.toString(),
        running: runningByCharIdOf(windowRows),
        windowRows,
        totalsOf: await marathonTotalsFn(deps),
        now: now()
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(404, 'not_found', errorMessage(error));
    }
    // `body` — сводка для логов и `GET /export` через JSON-клиент,
    // `raw` — сам файл: его отдаёт Rust с нужным Content-Type.
    return {
      status: 200,
      body: {
        dataset,
        format: extension === 'json' ? 'json' : 'csv',
        rows: prepared.rows,
        fileName: prepared.fileName
      },
      raw: {
        contentType: prepared.contentType,
        text: prepared.text,
        disposition: `attachment; filename="${prepared.fileName}"`
      }
    };
  }

  if (method === 'GET' && path === '/api/v1/windows') {
    const { publicWindows } = await load('characters', () => import('./actions/read.js'));
    const rows = await load('windowRows', () => readWindowRows());
    return { status: 200, body: publicWindows(rows, now()) };
  }

  // --- Изменение ---
  // Адресная запись: один стат или одна проходка в адресе. Проверяем до общего
  // PATCH /characters/{id}, иначе «Маг_1/stats/hp» ушёл бы в общий патч.
  if (method === 'PATCH' && path.startsWith('/api/v1/characters/')) {
    const rest = decodeSegment(path.slice('/api/v1/characters/'.length));
    const parts = rest.split('/');
    if (parts.length >= 3 && parts[1] === 'stats') {
      requireScope('modify');
      const { patchCharacterStat } = await load('mutate', () => import('./actions/mutate.js'));
      if (parts.length !== 3) throw new ApiError(404, 'not_found', 'Неизвестный путь API');
      const result = await patchCharacterStat(state, parts[0], parts[2], jsonBody(body), {
        persist,
        assertStateWriteAvailable,
        renderCharacters: deps.renderCharacters,
        now
      });
      return { status: 200, body: result };
    }
    if (parts.length >= 3 && parts[1] === 'dungeon-passes') {
      requireScope('modify');
      const { patchCharacterPass } = await load('mutate', () => import('./actions/mutate.js'));
      if (parts.length !== 3) throw new ApiError(404, 'not_found', 'Неизвестный путь API');
      // «Голое» число в теле — законно: `-d 5`.
      const result = await patchCharacterPass(state, parts[0], parts[2], jsonBody(body, { allowNumber: true }), {
        persist,
        assertStateWriteAvailable,
        renderCharacters: deps.renderCharacters,
        now
      });
      return { status: 200, body: result };
    }
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/characters/')) {
    requireScope('modify');
    const { patchCharacter } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/characters/'.length));
    const result = await patchCharacter(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderCharacters: deps.renderCharacters,
      now
    });
    return {
      status: 200,
      body: { character: result.character, changed: result.changed, statsHistoryAdded: result.statsHistoryAdded }
    };
  }

  if (method === 'POST' && path === '/api/v1/characters/bulk-update') {
    requireScope('modify');
    const { bulkUpdate } = await load('mutate', () => import('./actions/mutate.js'));
    const result = await bulkUpdate(state, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderCharacters: deps.renderCharacters,
      now
    });
    return { status: 200, body: result };
  }

  if (method === 'POST' && path === '/api/v1/characters') {
    requireScope('modify');
    const { createCharacter } = await load('mutate', () => import('./actions/mutate.js'));
    const result = await createCharacter(state, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderCharacters: deps.renderCharacters,
      now
    });
    return { status: 201, body: result };
  }

  // --- Планировщик: правка записи и новая запись ---
  if (method === 'PATCH' && path.startsWith('/api/v1/planner/entries/')) {
    requireScope('modify');
    const { patchPlannerEntry } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/planner/entries/'.length));
    const result = await patchPlannerEntry(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderPlanner: deps.renderPlanner,
      now
    });
    return { status: 200, body: result };
  }

  if (method === 'POST' && path === '/api/v1/planner/entries') {
    requireScope('modify');
    const { createPlannerEntry } = await load('mutate', () => import('./actions/mutate.js'));
    const result = await createPlannerEntry(state, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderPlanner: deps.renderPlanner,
      now
    });
    return { status: 201, body: result };
  }

  // --- Учёт: новая операция в реестре ---
  if (method === 'POST' && path === '/api/v1/finance/operations') {
    requireScope('modify');
    const { addFinanceOperation } = await load('mutate', () => import('./actions/mutate.js'));
    const result = await addFinanceOperation(state, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderFinance: deps.renderFinance,
      now
    });
    return { status: 201, body: result };
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/dungeon-passes/')) {
    requireScope('modify');
    const { patchDungeonPasses } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/dungeon-passes/'.length));
    const result = await patchDungeonPasses(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderCharacters: deps.renderCharacters,
      now
    });
    return { status: 200, body: result };
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/parties/')) {
    requireScope('modify');
    const { patchParty } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/parties/'.length));
    const result = await patchParty(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderParties: deps.renderParties,
      now
    });
    return { status: 200, body: result };
  }

  if (method === 'POST' && path.endsWith('/marks') && path.startsWith('/api/v1/marathons/')) {
    requireScope('modify');
    const { setMarathonMark } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/marathons/'.length, -'/marks'.length));
    const result = await setMarathonMark(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderMarathons: deps.renderMarathons,
      now
    });
    return { status: 200, body: result };
  }

  if (method === 'POST' && path.endsWith('/adjust') && path.startsWith('/api/v1/marathons/')) {
    requireScope('modify');
    const { adjustMarathonCell } = await load('mutate', () => import('./actions/mutate.js'));
    const id = decodeSegment(path.slice('/api/v1/marathons/'.length, -'/adjust'.length));
    const result = await adjustMarathonCell(state, id, jsonBody(body), {
      persist,
      assertStateWriteAvailable,
      renderMarathons: deps.renderMarathons,
      now
    });
    return { status: 200, body: result };
  }

  // --- Задание запуска ---
  if (method === 'POST' && path === '/api/v1/launch/character') {
    requireScope('launchClose');
    const jobsAction = await load('jobsAction', () => import('./actions/launch.js'));
    const jobs = (await load('jobs', () => jobsRegistry())) || jobsRegistry();
    return { status: 202, body: jobsAction.launchCharacterJob(state, jsonBody(body), { jobs }) };
  }

  if (method === 'POST' && path === '/api/v1/launch/party') {
    requireScope('launchClose');
    const jobsAction = await load('jobsAction', () => import('./actions/launch.js'));
    const jobs = (await load('jobs', () => jobsRegistry())) || jobsRegistry();
    const { charactersInPartyOrdered } = await import('../parties/membership.js');
    return {
      status: 202,
      body: jobsAction.launchPartyJob(state, jsonBody(body), {
        jobs,
        members: (chars, partyId) => charactersInPartyOrdered(chars, partyId)
      })
    };
  }

  if (method === 'POST' && path === '/api/v1/launch/selection') {
    requireScope('launchClose');
    const jobsAction = await load('jobsAction', () => import('./actions/launch.js'));
    const jobs = (await load('jobs', () => jobsRegistry())) || jobsRegistry();
    return { status: 202, body: jobsAction.launchSelectionJob(state, jsonBody(body), { jobs }) };
  }

  if (method === 'GET' && path.startsWith('/api/v1/jobs/')) {
    const { publicJob } = await load('jobsAction', () => import('./actions/launch.js'));
    const id = decodeSegment(path.slice('/api/v1/jobs/'.length));
    const registry = (await load('jobs', () => jobsRegistry())) || jobsRegistry();
    const job = registry.get(id);
    if (!job) throw new ApiError(404, 'not_found', 'Задание не найдено или устарело');
    return { status: 200, body: publicJob(job) };
  }

  // --- Закрытие окон ---
  if (method === 'POST' && path === '/api/v1/windows/close') {
    requireScope('launchClose');
    const pids = parseCloseRequest(jsonBody(body));
    const closeClientsByPid = await load('closeClientsByPid', async () => {
      const { closeClientsByPid } = await import('../launcher/launch.js');
      return closeClientsByPid;
    });
    const report = await closeClientsByPid(pids);
    return {
      status: 200,
      body: {
        found: Number(report?.found) || 0,
        closed: Number(report?.closed) || 0,
        failed: Number(report?.failed) || 0,
        denied: Number(report?.denied) || 0,
        elevated: !!report?.elevated,
        details: Array.isArray(report?.details) ? report.details : [],
        error: report?.error || null
      }
    };
  }

  throw new ApiError(404, 'not_found', 'Неизвестный путь API');
}

/** Состояние записи: остановлено ли сохранение защитой. */
function storageWritableNow(deps) {
  if (deps.storageWritable !== undefined) return !!deps.storageWritable;
  try {
    assertStateWriteAvailable();
    return true;
  } catch {
    return false;
  }
}

/**
 * Реестр заданий по умолчанию — один на всё приложение. Мост и вкладка настроек
 * обязаны смотреть в один и тот же реестр, иначе статус «идёт запуск» разойдётся
 * с тем, что видит клиент.
 */
function jobsRegistry() {
  const existing = globalThis.__tfExternalApiJobs;
  if (existing) return existing;
  // Реестр создаётся лениво: он хранит задания 30 минут и не должен переживать
  // перезагрузку страницы вместе с окнами, которые уже никто не откроет.
  //
  // Это тот же `JobRegistry`, что и в тестах: у него есть `now()`, который ждёт
  // код запуска. Свой реестр здесь означал бы, что `POST /launch/*` падает с
  // «registry.now is not a function» — ровно то, что было до этого изменения.
  const registry = new JobRegistry();
  globalThis.__tfExternalApiJobs = registry;
  return registry;
}

/**
 * Окна в виде `Map<charId, строка>`: `publicCharacter` ждёт карту, а `windowRows`
 * возвращает массив — превращаем один раз на запрос, а не на каждого персонажа.
 */
function runningByCharIdOf(rows) {
  return runningByCharId(rows);
}

/** `invoke` из Tauri, но только когда приложение запущено. */
async function dynamicInvoke(cmd, args) {
  const w = /** @type {any} */ (globalThis.window);
  if (!w?.__TAURI_INTERNALS__) throw new Error('Не в приложении');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/**
 * Ответ на событие: всегда `{ status, body }`, даже при исключении.
 * @param {{ method: string, path: string, query?: string, body?: any }} request
 * @param {Record<string, any>} [deps]
 */
export async function answer(request, deps = {}) {
  try {
    return await routeRequest(request, deps);
  } catch (error) {
    if (error instanceof ApiError) return errorBody(error);
    console.error('[EXTERNAL API] Ошибка обработки запроса', error);
    return errorBody({ status: 500, code: 'internal_error', message: 'Внутренняя ошибка приложения' });
  }
}

/**
 * Подключить мост: событие `external-api-request` → ответ через invoke.
 * @param {{ unlisten?: () => void } & Record<string, any>} [options]
 */
export async function bindExternalApiBridge(options = {}) {
  const deps = { ...options };
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen(EVENT, async event => {
    const payload = event?.payload || {};
    const requestId = String(payload.requestId || '');
    if (!requestId) return;
    const answerResult = await answer(payload, deps);
    try {
      // `raw` приходит у выгрузок: Rust отдаст готовый текст с нужными заголовками.
      const raw = /** @type {any} */ (answerResult).raw || null;
      await dynamicInvoke('external_api_reply', {
        requestId,
        status: answerResult.status,
        body: answerResult.body,
        // Tauri приводит `null` к отсутствию поля; Rust ждёт `Option<RawReplyInput>`.
        raw: raw ? { contentType: raw.contentType, body: raw.text, disposition: raw.disposition ?? null } : null
      });
    } catch (error) {
      console.warn('[EXTERNAL API] Не удалось отправить ответ', error);
    }
  });
  deps.unlisten?.();
  return { unlisten, deps };
}
