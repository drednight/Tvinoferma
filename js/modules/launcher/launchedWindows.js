// @ts-check
// js/modules/launcher/launchedWindows.js
// Память «какое окно мы запустили» — по PID.
//
// Зачем: окно клиента узнаётся по нику из заголовка (windowList.js), а заголовок и значок
// слетают вместе — игра переписывает заголовок при загрузке, проводник сбрасывает значок.
// Окно, потерявшее заголовок, становится безымянным («PID 1234»), и починить его нечем:
// персонажа не с кем сопоставить. Здесь хранится то, что известно из запуска, — сопоставить
// окно можно даже тогда, когда заголовок уже бесполезен.
//
// Осторожность с PID: система переиспользует номера, после перезагрузки тот же PID может
// достаться чужому процессу. Поэтому запись сверяется со временем старта процесса из Rust:
// если окно запущено не в то время, которое мы запомнили, запись не верится.

const KEY = 'tf:launched-windows';
/** Срок резервной записи запуска; явные привязки проверяются по старту живого процесса. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Насколько может разойтись время старта, чтобы запись ещё считалась нашей. */
const START_TOLERANCE_MS = 5 * 60 * 1000;

const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** @returns {Record<string, { charId: string, at: number, startedAt?: number, launchCharId?: string, launchAt?: number }>} */
function readAll() {
  try {
    const raw = JSON.parse(store()?.getItem(KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const now = Date.now();
    /** @type {Record<string, { charId: string, at: number, startedAt?: number, launchCharId?: string, launchAt?: number }>} */
    const out = {};
    for (const [pid, v] of Object.entries(raw)) {
      const num = Number(pid);
      if (!Number.isInteger(num) || num <= 0 || !v || typeof v !== 'object') continue;
      const charId = String(v.charId || '');
      const at = Number(v.at);
      if (!charId || !Number.isFinite(at) || (!v.startedAt && now - at > TTL_MS)) continue;
      out[String(num)] = {
        charId,
        at,
        ...(Number(v.startedAt) > 0 ? { startedAt: Number(v.startedAt) } : {}),
        ...(v.launchCharId && Number(v.launchAt) > 0
          ? { launchCharId: String(v.launchCharId), launchAt: Number(v.launchAt) }
          : {})
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    store()?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* квота: память не критична */
  }
}

/**
 * Запоминает, что окно `pid` — это персонаж `charId`.
 * Вызывается сразу после успешного запуска.
 */
export function rememberLaunched(pid, charId) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0 || !charId) return;
  writeAll({ ...readAll(), [String(num)]: { charId: String(charId), at: Date.now() } });
}

/**
 * Забывает PID: окно закрыто, и держать запись незачем.
 * @param {number} pid
 */
export function forgetLaunched(pid) {
  const all = readAll();
  if (all[String(pid)]) {
    delete all[String(pid)];
    writeAll(all);
  }
}

/**
 * Кому принадлежат окна по памяти запусков.
 *
 * Возвращает `{ [pid]: charId }` только для тех окон, чьё время старта совпадает с
 * запомненным — это и защита от переиспользования PID, и проверка, что запись наша.
 * Пересечение с заголовком не проверяется: решает `windowRows`, где память является
 * запасным вариантом и берётся только там, где заголовок не разобрался.
 *
 * @param {Array<{ pid: number, uptimeMs?: number|null }>} windows
 * @param {number} [now]
 * @returns {Record<string, string>}
 */
export function recalledOwnership(windows, now = Date.now()) {
  const all = readAll();
  /** @type {Record<string, string>} */
  const out = {};
  for (const w of windows || []) {
    if (!w || !w.pid || w.uptimeMs === null || w.uptimeMs === undefined) continue;
    const rec = all[String(w.pid)];
    if (!rec) continue;
    // Окно стартовало не в то время, которое мы запомнили → PID переиспользован
    if (Math.abs(now - w.uptimeMs - (rec.startedAt ?? rec.at)) > (rec.startedAt ? 1000 : START_TOLERANCE_MS)) continue;
    out[String(w.pid)] = rec.charId;
  }
  return out;
}

/** Убирает из памяти PID, которых больше нет среди запущенных окон. */
export function pruneLaunched(rows) {
  const all = readAll();
  const alive = new Set((rows || []).map(r => String(r?.pid || '')).filter(Boolean));
  const now = Date.now();
  let changed = false;
  for (const pid of Object.keys(all)) {
    if (!alive.has(pid) || (!all[pid].startedAt && now - all[pid].at > TTL_MS)) {
      delete all[pid];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

/** Attach an existing verified client, using its actual process start rather than attachment time. */
export function rememberExistingWindow(pid, charId, startedAt) {
  const num = Number(pid),
    at = Number(startedAt);
  if (!Number.isInteger(num) || num <= 0 || !charId || !Number.isFinite(at) || at <= 0 || at > Date.now())
    throw new Error('Не удалось проверить время запуска окна. Обновите список.');
  const all = readAll(),
    old = all[String(num)];
  const sameProcess = old && Math.abs((old.startedAt ?? old.at) - at) <= (old.startedAt ? 1000 : START_TOLERANCE_MS);
  const fallback = sameProcess
    ? old.startedAt
      ? { launchCharId: old.launchCharId, launchAt: old.launchAt }
      : { launchCharId: old.charId, launchAt: old.at }
    : {};
  writeAll({ ...all, [String(num)]: { ...fallback, charId: String(charId), at: Date.now(), startedAt: at } });
  const saved = readAll()[String(num)];
  if (saved?.charId !== String(charId) || saved?.startedAt !== at)
    throw new Error('Не удалось сохранить привязку окна в локальном хранилище.');
}

/** Validated provenance shared by commands and every window list. */
export function windowOwnershipOptions(clients, now = Date.now()) {
  const recalled = recalledOwnership(
    clients.map(c => ({ pid: c.pid, uptimeMs: c.startedAt ? now - c.startedAt : null })),
    now
  );
  const all = readAll();
  const manual = Object.fromEntries(Object.entries(recalled).filter(([pid]) => !!all[pid]?.startedAt));
  return { recalled, manual };
}

/** Remove only the explicit override; title and original launcher recognition remain. */
export function forgetManualWindow(pid, startedAt) {
  const all = readAll(),
    key = String(pid),
    old = all[key];
  if (!Number.isFinite(Number(startedAt)) || !old?.startedAt || Math.abs(old.startedAt - Number(startedAt)) > 1000)
    return;
  if (old.launchCharId && old.launchAt) all[key] = { charId: old.launchCharId, at: old.launchAt };
  else delete all[key];
  writeAll(all);
  if (readAll()[key]?.startedAt) throw new Error('Не удалось снять ручную привязку.');
}
