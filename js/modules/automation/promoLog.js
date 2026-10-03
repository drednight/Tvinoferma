// js/modules/automation/promoLog.js
// Журнал и архив промокодов (Issue #25). Хранится только на этом компьютере (localStorage).
//  - Журнал: последние LOG_MAX кодов. У каждого: дата первого ввода, награда, кому введён, кому не введён и почему.
//  - Архив: ВСЕ коды без ограничения (код + дата + награда), для разработчика; выгружается в CSV.
// Недействительные коды (сайт ответил «не существует / срок истёк / нет бонусов») не сохраняются никуда.
// Пропуск уже введённых работает по RECENT_N последним кодам.

import { normalizeCode, codeKey, isOk, isInvalid, rewardText, toCsv } from './promoCore.js';

export const LOG_KEY = 'tf_promo_log_v2';
export const ARCHIVE_KEY = 'tf_promo_archive_v1';
const LEGACY_KEY = 'tf_promo_history_v1';
export const LOG_MAX = 50;
export const RECENT_N = 10;

const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (key) => { try { const v = JSON.parse(store()?.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeJson = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* квота: журнал не критичен */ } };

const byRecent = (a, b) => String(b.lastAt).localeCompare(String(a.lastAt));

/** Журнал: от недавно использованных кодов к давним. */
export function loadLog() {
  try { store()?.removeItem(LEGACY_KEY); } catch { /* прежний формат (по строке на персонажа) не используется */ }
  return readJson(LOG_KEY).filter(r => r && r.code && r.entered).sort(byRecent);
}
export const saveLog = (log) => writeJson(LOG_KEY, log);
export function clearLog() { store()?.removeItem(LOG_KEY); }

/** Последние n уникальных кодов. */
export const recentRecords = (log, n = RECENT_N) => [...log].sort(byRecent).slice(0, n);
export const findRecord = (log, code) => log.find(r => codeKey(r.code) === codeKey(code)) || null;

/**
 * Что делать с кодом для выбранных персонажей: у кого уже введён (из последних n кодов) — пропустить, остальным ввести.
 * @returns {Array<{ code: string, record: object|null, done: object[], todo: object[] }>}
 */
export function planRun(log, codes, chars, n = RECENT_N) {
  const recent = recentRecords(log, n);
  return codes.map(code => {
    const record = findRecord(recent, code);
    const done = record ? chars.filter(c => record.entered[c.id]) : [];
    const doneIds = new Set(done.map(c => c.id));
    return { code, record, done, todo: chars.filter(c => !doneIds.has(c.id)) };
  });
}

/**
 * Применяет результаты запуска одного кода к журналу (без записи на диск).
 * Запись создаётся при первом введённом (или «уже введён») персонаже; до этого и для недействительных кодов ничего не пишется.
 * @param {object[]} log
 * @param {string} code
 * @param {object[]} rows строки результата (со своим `at`)
 * @param {{ known?: Array<{id:string,nick:string}>, now?: Date }} [ctx] known — все персонажи на момент запуска
 * @returns {{ log: object[], record: object|null, created: boolean, rewardSet: boolean }}
 */
export function applyRows(log, code, rows, { known = [], now = new Date() } = {}) {
  const at = now.toISOString();
  const mine = rows.filter(r => !r.skipped && !r.dryRun && !isInvalid(r.status) && codeKey(r.code ?? code) === codeKey(code));
  const existing = findRecord(log, code);
  if (!existing && !mine.some(r => isOk(r.status))) return { log, record: null, created: false, rewardSet: false };

  const rec = existing
    ? { ...existing, entered: { ...existing.entered }, missed: { ...existing.missed }, known: { ...existing.known } }
    : { code: normalizeCode(code), firstAt: at, lastAt: at, reward: null, entered: {}, missed: {}, known: {} };
  rec.lastAt = at;
  known.forEach(c => { rec.known[c.id] = c.nick; });

  let rewardSet = false;
  for (const r of mine) {
    rec.known[r.charId] = r.nick;
    if (isOk(r.status)) {
      if (!rec.entered[r.charId]) rec.entered[r.charId] = { nick: r.nick, at: r.at || at, status: r.status };
      delete rec.missed[r.charId];
      // Награда берётся с первого удачного прохода и дальше не перезаписывается
      if (!rec.reward && r.status === 'success' && r.rewards?.length) { rec.reward = r.rewards; rewardSet = true; }
    } else if (!rec.entered[r.charId]) {
      rec.missed[r.charId] = { nick: r.nick, status: r.status, error: r.error || null, at: r.at || at };
    }
  }
  const next = [rec, ...log.filter(r => r !== existing)].sort(byRecent).slice(0, LOG_MAX);
  return { log: next, record: rec, created: !existing, rewardSet };
}

/** Кто из известных персонажей не получил код и почему (reason = null: не запускался / не был выбран). */
export function missedList(record) {
  return Object.entries(record.known || {})
    .filter(([id]) => !record.entered[id])
    .map(([id, nick]) => ({ id, nick, reason: record.missed?.[id] || null }))
    .sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'ru'));
}

export const enteredList = (record) =>
  Object.entries(record.entered || {})
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

/* ------------------------------ архив ------------------------------ */

export const loadArchive = () => readJson(ARCHIVE_KEY).filter(e => e && e.code);
export function clearArchive() { store()?.removeItem(ARCHIVE_KEY); }

/** Добавляет код в архив при первом вводе; награду дописывает, если её ещё не было. */
export function upsertArchive(archive, record) {
  const i = archive.findIndex(e => codeKey(e.code) === codeKey(record.code));
  if (i < 0) return [...archive, { code: record.code, firstAt: record.firstAt, reward: record.reward || null }];
  if (archive[i].reward || !record.reward) return archive;
  const next = [...archive];
  next[i] = { ...next[i], reward: record.reward };
  return next;
}

export const archiveCsv = (archive) =>
  toCsv(['Промокод', 'Дата первого ввода', 'Награда'], archive.map(e => [e.code, e.firstAt, rewardText(e.reward)]));

/**
 * Применить результаты к журналу и архиву на диске. Вызывается после каждого введённого персонажа
 * (чтобы «Стоп» не потерял сделанное) и в конце запуска (чтобы записать, кому не введено и почему).
 */
export function recordRun(code, rows, ctx) {
  const res = applyRows(loadLog(), code, rows, ctx);
  if (!res.record) return res;
  saveLog(res.log);
  if (res.created || res.rewardSet) writeJson(ARCHIVE_KEY, upsertArchive(loadArchive(), res.record));
  try { window.dispatchEvent(new CustomEvent('tf-promo-log')); } catch { /* вне браузера */ }
  return res;
}
