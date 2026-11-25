// @ts-check
// js/modules/externalApi/actions/launch.js
// Запуск окон и пати через внешний API (этап M3).
//
// Запуск долгий (окна открываются десятки секунд), поэтому HTTP-ответ приходит
// сразу — `202 { jobId }`, — а ход работы виден в `GET /jobs/{jobId}`. Само
// задание выполняет тот же `launchGroup(interactive: false)`, что и кнопка в
// интерфейсе: экраны проверок не показываются, но все проверки выполняются и
// возвращают честный итог (`skipped` с причиной).
//
// Одновременно разрешено одно внешнее задание: второй POST получает `429`.
// Задания запуска внутри приложения (кнопка) API не блокируют — они встают в
// общую очередь сами.

import { ApiError, errorBody } from './mutate.js';
import { launchContextForGroup, runPreflight } from '../../launcher/partyLaunch.js';

/** Через сколько задание забывается (не дольше TTL в плане — 30 минут). */
export const JOB_TTL_MS = 30 * 60 * 1000;
/** Сколько заданий храним, если их много: старые вытесняются. */
const MAX_JOBS = 50;

/**
 * Реестр заданий. Живёт в памяти: перезапуск приложения и задания обрывает,
 * и это честно — окна уже не запустятся «сами».
 */
export class JobRegistry {
  constructor({ now = () => Date.now(), ttlMs = JOB_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.jobs = new Map();
    this.counter = 0;
  }

  /** Самое свежее незавершённое задание — если оно есть, второй запуск запрещён. */
  active() {
    this.sweep();
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') return job;
    }
    return null;
  }

  /** Забыть задания старше TTL. Незавершённые не вытесняются по времени. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      const finished = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
      if (finished && Date.parse(job.finishedAt || job.createdAt) < cutoff) this.jobs.delete(id);
    }
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  create(kind, total) {
    this.sweep();
    const id = `job_${(++this.counter).toString(36)}${this.now().toString(36)}`;
    const job = {
      id,
      kind,
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { done: 0, total, percent: 0, stage: 'В очереди', character: null },
      result: null
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    this.sweep();
    return this.jobs.get(String(id)) || null;
  }

  clear() {
    this.jobs.clear();
  }
}

/** Публичное представление задания: без внутренних замыканий и отмены. */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: { ...job.progress, character: job.progress?.character ? { ...job.progress.character } : null },
    result: job.result
      ? {
          ...job.result,
          error: job.result.error ?? null,
          ignoredIds: Array.isArray(job.result.ignoredIds) ? [...job.result.ignoredIds] : [],
          items: (job.result.items || []).map(row => ({ ...row }))
        }
      : null
  };
}

/** Строки результата из `results` запуска: ok / failed / cancelled. */
export function itemRows(results) {
  return (results || []).map(row => ({
    id: String(row.id),
    nick: row.nick || String(row.id),
    status: row.cancelled ? 'cancelled' : row.ok ? 'ok' : 'failed',
    ms: row.cancelled ? null : Number.isFinite(row.ms) ? row.ms : null,
    error: row.cancelled ? null : row.ok ? null : String(row.error || 'Не удалось запустить')
  }));
}

/**
 * Итог запуска по результату и проверке «до».
 *
 * @param {any[]} requested запрошенные персонажи
 * @param {any[] | null} results результат `launchGroup` (null — запуск не дошёл до окон)
 * @param {any} pre проверка `launchPreflight` до запуска
 * @param {number} ms длительность
 * @param {string[]} ignoredIds id, отфильтрованные по пати
 */
export function launchSummary(requested, results, pre, ms, ignoredIds = []) {
  const rows = itemRows(results);
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const items = [];
  const runningIds = new Set((pre?.alreadyRunning || []).map(entry => String(entry.char?.id ?? entry.id)));
  const noGcIds = new Set((pre?.noGc || []).map(char => String(char.id)));
  const noLoginIds = new Set((pre?.noSavedLogin || []).map(char => String(char.id)));
  for (const character of requested) {
    const id = String(character.id);
    const row = byId.get(id);
    if (row) {
      items.push(row);
      continue;
    }
    const skipped = runningIds.has(id)
      ? 'already_running'
      : noGcIds.has(id)
        ? 'no_gc'
        : noLoginIds.has(id)
          ? 'no_saved_login'
          : null;
    if (skipped) items.push({ id, nick: character.nick || id, status: 'skipped', ms: null, error: skipped });
  }
  const count = status => items.filter(row => row.status === status).length;
  return {
    requested: requested.length,
    launched: count('ok'),
    alreadyRunning: items.filter(row => row.error === 'already_running').length,
    skipped: count('skipped'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    ms,
    ignoredIds,
    items
  };
}

/**
 * Запуск по HTTP: проверка занятости, задание, фон.
 *
 * Важно: `pre` считается ДО запуска и тем же `launchPreflight` с тем же `ctx`,
 * что и внутри `launchGroup`. Своего кода проверки в API нет — иначе он разошёлся
 * бы с кнопкой в интерфейсе. Пропущенные (`noGc`, `noSavedLogin`, `alreadyRunning`)
 * в итоге пересчитываются из `pre`, потому что `launchGroup` их просто не запускает.
 *
 * @param {JobRegistry} registry
 * @param {'character' | 'party'} kind
 * @param {any[]} characters кого запускаем (уже в нужном порядке)
 * @param {{
 *   launchGroup: (title: string, chars: any[], opts: any) => Promise<any>,
 *   preflight?: (chars: any[], ctx: any) => Promise<any>, // для тестов; по умолчанию — runPreflight
 *   gcId?: string,
 *   ignoredIds?: string[]
 * }} deps
 */
export function startJob(registry, kind, characters, deps) {
  if (registry.active()) {
    throw new ApiError(429, 'launch_busy', 'Уже идёт запуск: дождитесь завершения и повторите');
  }
  if (!characters.length) {
    throw new ApiError(409, 'launch_not_ready', 'Запускать некого: список пуст');
  }
  const created = registry.create(kind, characters.length);
  const job = registry.get(created.id) || created;
  job.status = 'running';
  job.startedAt = new Date(registry.now()).toISOString();
  job.progress.stage = 'Проверка перед запуском';

  const requested = [...characters];
  const ignoredIds = Array.isArray(deps.ignoredIds) ? [...deps.ignoredIds] : [];
  const started = registry.now();
  const finish = (status, result, stage) => {
    job.status = status;
    job.result = result;
    job.progress.percent = 100;
    if (stage) job.progress.stage = stage;
    job.finishedAt = new Date(registry.now()).toISOString();
  };

  const run = async () => {
    /** @type {any} */
    let pre = null;
    try {
      // Тот же GameCenter для проверки и запуска: иначе проверка скажет «вход
      // запомнен» про одну папку, а запуск пойдёт из другой (см. partyLaunch.js).
      const group = launchContextForGroup(requested, deps.gcId);
      job.progress.stage = 'Проверка перед запуском';
      // Тот же runPreflight, что и в launchGroup; подмена — только для тестов.
      pre = await (deps.preflight || runPreflight)(requested, group.ctx);
      if (pre) {
        job.progress.total = Math.max(1, pre.toLaunch.length + (pre.alreadyRunning?.length || 0));
        job.progress.stage = pre.toLaunch.length ? 'Запуск окон' : 'Запускать некого';
      }
      // Запускать некого по известной причине — это честный итог задания, а не ошибка
      // сервера: клиент читает строки `skipped` и причину в них.
      if (!pre?.toLaunch.length && (pre?.noGc?.length || pre?.noSavedLogin?.length || pre?.alreadyRunning?.length)) {
        finish('done', launchSummary(requested, null, pre, registry.now() - started, ignoredIds));
        return;
      }
      const results = await deps.launchGroup(
        kind === 'party' ? 'Внешний API: запуск пати' : 'Внешний API: запуск персонажа',
        requested,
        {
          interactive: false,
          gcId: deps.gcId,
          // Прогресс берём из того же `onProgress`, что рисует журнал в интерфейсе:
          // `GET /jobs/{id}` должен показывать тот же процент и ту же строку этапа.
          onProgress: current => {
            job.progress.done = Math.max(0, Number(current.done) || 0);
            job.progress.total = Math.max(1, Number(current.total) || requested.length);
            job.progress.percent = Math.max(0, Math.min(100, Number(current.percent) || 0));
            if (current.stage) job.progress.stage = String(current.stage);
            job.progress.character = current.character
              ? { id: current.character.id, nick: current.character.nick }
              : null;
          }
        }
      );
      const summary = launchSummary(requested, results, pre, registry.now() - started, ignoredIds);
      finish(results ? 'done' : 'failed', summary, results ? 'Готово' : 'Запуск не начался');
    } catch (error) {
      finish(
        'failed',
        { ...launchSummary(requested, null, pre, registry.now() - started, ignoredIds), error: errorMessage(error) },
        'Ошибка запуска'
      );
    }
  };
  // Выполнение — в фоне: HTTP-ответ уже ушёл. Ошибки фона не должны падать в консоль
  // как «unhandled»: их собирает само задание.
  Promise.resolve().then(run);
  return publicJob(job);
}

function errorMessage(error) {
  return String(error?.message || error || 'Ошибка запуска');
}

/** Ответ моста на исключение: одинаковый формат ошибки для всех действий. */
export function failure(error) {
  if (error instanceof ApiError) return errorBody(error);
  return errorBody({ status: 500, code: 'internal_error', message: errorMessage(error) });
}

/**
 * `POST /launch/character`: один персонаж задания.
 *
 * `gcId` необязателен — иначе берётся GameCenter персонажа или выбранный в
 * настройках. Проверка «есть ли GameCenter и запомнен ли вход» не отбрасывает
 * задание: итогом будет строка `skipped` с причиной, как и в интерфейсе.
 */
/**
 * @param {any} state
 * @param {any} body
 * @param {{ jobs?: any, now?: () => number, preflight?: any, launchGroup?: any }} [deps]
 */
export function launchCharacterJob(state, body, deps = {}) {
  const { jobs, preflight, launchGroup } = deps;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(400, 'invalid_json', 'Тело запроса должно быть JSON-объектом');
  const allowed = new Set(['characterId', 'gcId']);
  for (const key of Object.keys(body))
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  const characterId = String(body.characterId || '').trim();
  if (!characterId) throw new ApiError(422, 'invalid_value', 'characterId обязателен');
  if (body.gcId !== undefined && typeof body.gcId !== 'string')
    throw new ApiError(422, 'invalid_value', 'gcId должен быть строкой');
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const character = characters.find(c => String(c.id) === characterId);
  if (!character) throw new ApiError(404, 'no_such_character', 'Персонаж не найден');
  return startJob(jobs, 'character', [character], { launchGroup, preflight, gcId: body.gcId });
}

/**
 * `POST /launch/party`: пати по id или названию, состав — в сохранённом порядке.
 * `memberIds` фильтруется по составу пати; чужие id отбрасываются и возвращаются
 * в итоге как `ignoredIds`. Без `memberIds` запускается вся пати.
 */
/**
 * @param {any} state
 * @param {any} body
 * @param {{ jobs?: any, members?: any, preflight?: any, launchGroup?: any }} [deps]
 */
export function launchPartyJob(state, body, deps = {}) {
  const { jobs, members, preflight, launchGroup } = deps;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(400, 'invalid_json', 'Тело запроса должно быть JSON-объектом');
  const allowed = new Set(['partyId', 'partyName', 'memberIds']);
  for (const key of Object.keys(body))
    if (!allowed.has(key)) throw new ApiError(422, 'invalid_value', `Неизвестное поле «${key}»`);
  if (body.partyId !== undefined && typeof body.partyId !== 'string')
    throw new ApiError(422, 'invalid_value', 'partyId должен быть строкой');
  if (body.partyName !== undefined && typeof body.partyName !== 'string')
    throw new ApiError(422, 'invalid_value', 'partyName должен быть строкой');
  if (body.memberIds !== undefined && !Array.isArray(body.memberIds))
    throw new ApiError(422, 'invalid_value', 'memberIds должен быть массивом');
  const parties = Array.isArray(state?.parties) ? state.parties : [];
  const wanted = String(body.partyId || '').trim();
  const wantedName = String(body.partyName || '')
    .trim()
    .toLowerCase();
  const party = wanted
    ? parties.find(p => String(p.id) === wanted)
    : parties.find(
        p =>
          String(p.name || '')
            .trim()
            .toLowerCase() === wantedName
      );
  if (!party) throw new ApiError(404, 'no_such_party', 'Пати не найдена');
  const all = (
    typeof members === 'function' ? members(state.characters || [], party.id) : loadDefaultMembers(state, party.id)
  ).map(member => member);
  let selected = all;
  let ignoredIds = [];
  if (Array.isArray(body.memberIds) && body.memberIds.length) {
    const wantedIds = new Set(body.memberIds.map(id => String(id)));
    const ids = new Set(all.map(member => String(member.id)));
    ignoredIds = [...wantedIds].filter(id => !ids.has(id));
    selected = all.filter(member => wantedIds.has(String(member.id)));
    if (!selected.length) throw new ApiError(422, 'invalid_value', 'Ни один memberIds не входит в пати');
  }
  return startJob(jobs, 'party', selected, { launchGroup, preflight, ignoredIds });
}

/** Участники пати в сохранённом порядке — пока без модуля пати, по `partyOrder`. */
function loadDefaultMembers(state, partyId) {
  return (state?.characters || [])
    .filter(c => (c.partyIds || []).includes(partyId))
    .map((c, index) => ({ ...c, __index: index }))
    .sort((a, b) => {
      const order = char => {
        const value = char.partyOrder && char.partyOrder[partyId];
        return Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
      };
      return order(a) - order(b) || a.__index - b.__index;
    })
    .map(({ __index, ...character }) => character);
}
