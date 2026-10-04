// @ts-check
// js/modules/launcher/launch.js
// Запуск игры: у каждого аккаунта (персонажа) свой GameCenter — из общего списка с названиями (Настройки → Запуск игры)
// или «свой путь» в character.launch.gcPath. Выбор между ними — resolveGameCenter (gameCenters.js).
// Аккаунты запускаются по очереди. Rust-команда launcher_start сама:
//  - подставляет сохранённый вход аккаунта в GameCenter.ini (если он запомнен, см. captureAccount);
//  - подтверждает окно GameCenter «Клиент игры уже запущен» («Запустить новую копию клиента»);
//  - ждёт появления нового клиента игры.
// После этого выдерживается короткая пауза, и стартует следующий аккаунт.
// Токен входа в JS не попадает: он лежит в хранилище ОС и читается только на стороне Rust.

import { createLimiter, runQueue, sleep } from '../sync/queue.js';
import { state } from '../../core/state.js';
import { resolveGameCenter } from './gameCenters.js';
import { getClassIconSrc } from '../../core/constants.js';

/** Пауза между запусками аккаунтов (после появления нового клиента), мс. */
export const DEFAULT_LAUNCH_DELAY_MS = 3000;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** GameCenter из настроек (общий список с названиями) и предпочитаемый — для выбора, откуда запускать персонажа. */
/** @returns {import('./gameCenters.js').GcContext} */
export function launchContext() {
  const l = state.settings?.launcher || {};
  return { gameCenters: l.gameCenters || [], preferredId: l.preferredGcId || '' };
}

/** Есть ли чем запускать персонажа: GameCenter из списка или свой путь из карточки. */
export function hasGameCenterPath(character, ctx = launchContext()) {
  return !!resolveGameCenter(character, ctx);
}

/** Аккаунты, для которых есть GameCenter, в порядке списка. */
export function launchable(characters, ctx = launchContext()) {
  return (characters || []).filter(c => hasGameCenterPath(c, ctx));
}

/** Кого запустим (`ready`), а кого пропустим из-за отсутствия GameCenter (`skipped`). */
export function launchPlan(characters, ctx = launchContext()) {
  const list = characters || [];
  return { ready: list.filter(c => hasGameCenterPath(c, ctx)), skipped: list.filter(c => !hasGameCenterPath(c, ctx)) };
}

/** Строка про GameCenter и сохранённый вход для карточки персонажа. */
export function loginStatusText(character, ctx = launchContext()) {
  const r = resolveGameCenter(character, ctx);
  const where = r?.gc ? `GameCenter «${r.gc.name}». ` : '';
  if (!r?.saved) return `${where}Вход не запомнен: запускается тот аккаунт, под которым уже открыт этот GameCenter.`;
  const who = r.nick ? ` «${r.nick}»` : '';
  return `${where}Вход запомнен${who}. При запуске этот GameCenter будет закрыт и откроется под этим аккаунтом.`;
}

/** Размеры значков окна: малый (заголовок) и большой (панель задач, Alt+Tab), пикселей. */
export const WINDOW_ICON_SMALL = 16;
export const WINDOW_ICON_BIG = 48;

/** Название окна клиента: «Ник — Класс» (без класса — просто ник). */
export function windowTitle(character) {
  const nick = String(character?.nick || '').trim();
  const cls = String(character?.class || '').trim();
  return cls ? `${nick} — ${cls}` : nick;
}

/** Подписывать ли окна клиентов (Настройки → Запуск игры). */
export function decorateEnabled() {
  return state.settings?.launcher?.decorateWindows !== false;
}

/** @type {Map<string, Promise<number[] | null>>} */
const iconCache = new Map();

/**
 * Значок класса как пиксели RGBA (`size`×`size`, массив байт) — так его ждёт Rust. Берётся из `public/assets/icons/classes`.
 * null — у класса нет значка или картинку не удалось прочитать (тогда окно только получит название).
 */
export function classIconRgba(className, size) {
  const src = getClassIconSrc(className);
  if (!src || typeof document === 'undefined') return Promise.resolve(null);
  const key = `${src}@${size}`;
  let p = iconCache.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (!g) { resolve(null); return; }
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, size, size);
          resolve(Array.from(g.getImageData(0, 0, size, size).data));
        } catch { resolve(null); }
      };
      img.src = src;
    });
    iconCache.set(key, p);
    p.then(v => { if (!v) iconCache.delete(key); }); // неудачу не запоминаем: в следующий раз попробуем снова
  }
  return p;
}

/**
 * Что передать в Rust, чтобы окно клиента получило название и значок класса.
 * @param {any} character
 * @param {{ loadIcon?: (className: string, size: number) => Promise<number[] | null> }} [deps]
 */
export async function windowDecor(character, deps = {}) {
  const load = deps.loadIcon || classIconRgba;
  const cls = String(character?.class || '').trim();
  const [iconSmall, iconBig] = cls
    ? await Promise.all([load(cls, WINDOW_ICON_SMALL), load(cls, WINDOW_ICON_BIG)])
    : [null, null];
  return { windowTitle: windowTitle(character) || null, iconSmall, iconBig };
}

/** «45 с», «1 мин 12 с», «2 ч 05 мин» — для итога запуска. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} с`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} мин ${s} с` : `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${String(m % 60).padStart(2, '0')} мин`;
}

/** Склонение: 1 окно, 2 окна, 5 окон. */
export function windowsWord(n) {
  const k = Math.abs(n) % 100;
  const d = k % 10;
  if (k > 10 && k < 20) return 'окон';
  if (d === 1) return 'окно';
  if (d >= 2 && d <= 4) return 'окна';
  return 'окон';
}

/**
 * Итог запуска одной строкой: «Запущено 3 окна за 1 мин 12 с» (+ ошибки, отмена, пропущенные без пути).
 * @param {{ ok: number, failed?: number, cancelled?: number, skipped?: number, ms: number }} r
 */
export function launchSummary(r) {
  const parts = [`Запущено ${r.ok} ${windowsWord(r.ok)} за ${formatDuration(r.ms)}`];
  if (r.failed) parts.push(`с ошибкой: ${r.failed}`);
  if (r.cancelled) parts.push(`отменено: ${r.cancelled}`);
  if (r.skipped) parts.push(`без пути к GameCenter: ${r.skipped}`);
  return parts.join(', ');
}

/**
 * Текст итога закрытия окон по отчёту Rust: `{ found, closed, failed, error }`.
 * @param {{ found?: number, closed?: number, failed?: number, error?: string }} r
 */
export function closeReportText(r) {
  if (r?.error) return `Не удалось найти окна игры: ${r.error}`;
  const found = Number(r?.found) || 0;
  const closed = Number(r?.closed) || 0;
  const failed = Number(r?.failed) || 0;
  if (!found) return 'Окон игры не запущено';
  if (!failed) return `Закрыто окон игры: ${closed}`;
  return `Закрыто ${closed} из ${found}. Остальные не поддались: возможно, игра запущена от имени администратора — запустите Твиноферму так же`;
}

/** Пати, которые есть смысл запускать из трея: в них есть хотя бы один персонаж с путём к GameCenter. */
export function launchablePartyNames(parties, characters, membersOf, ctx = launchContext()) {
  return (parties || [])
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .filter(p => launchable(membersOf(characters, p.id), ctx).length > 0)
    .map(p => p.name)
    .filter(Boolean);
}

/** Проверка пути из настроек. Возвращает полный путь к GameCenter.exe или бросает ошибку. */
export function checkGameCenterPath(path, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_check_path', { path });
}

/**
 * Запомнить вход, который сейчас открыт в GameCenter персонажа (токен уходит в хранилище ОС).
 * `target` — `{ key, path }` из resolveGameCenter; без него берётся «свой путь» из карточки.
 * Возвращает ник из GameCenter (может быть пустой строкой).
 */
export function captureAccount(character, deps = {}, target = null) {
  return (deps.invoke || tauriInvoke)('launcher_capture_account', {
    charId: target?.key || character.id,
    path: target?.path ?? (character.launch?.gcPath || '')
  });
}

/** Что сейчас за вход открыт в GameCenter (ник и есть ли вход вообще): `{ exe, nick, loggedIn }`. */
export function gameCenterInfo(path, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_gc_info', { path });
}

/** Открыть проводник и выбрать GameCenter.exe. Возвращает полный путь или null, если окно закрыли. */
export function pickGameCenter(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_pick_gamecenter');
}

/** Удалить сохранённый вход персонажа из хранилища ОС. */
export function forgetAccount(charId, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_forget_account', { charId });
}

/** Есть ли сохранённый вход у персонажа. */
export function hasAccount(charId, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_has_account', { charId });
}

/** Диагностика: видимые окна VK Play и окна вопросов GameCenter. */
export function findDialogs(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_find_dialogs');
}

/** PID запущенных клиентов игры. */
export function runningClients(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_running_clients');
}

/** Закрыть все клиенты игры. Возвращает, сколько было закрыто. */
export function closeAllClients(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_close_clients');
}

/**
 * Запустить игру для списка аккаунтов по очереди (по одному, с паузой между запусками).
 * Персонажи без GameCenter пропускаются (их можно узнать через launchPlan).
 *
 * @param {Array<any>} characters
 * @param {{
 *   delayMs?: number,
 *   waitSecs?: number,
 *   url?: string,
 *   signal?: { cancelled: boolean },
 *   gcId?: string,
 *   decorate?: boolean,
 *   onStart?: (character: any) => void,
 *   onDone?: (entry: { id: string, nick: string, ok: boolean, error?: string }, done: number, total: number) => void
 * }} [opts]
 * @param {{ invoke?: (cmd: string, args?: any) => Promise<any>, ctx?: import('./gameCenters.js').GcContext, loadIcon?: (className: string, size: number) => Promise<number[] | null> }} [deps]
 */
export async function launchCharacters(characters, opts = {}, deps = {}) {
  const { delayMs = DEFAULT_LAUNCH_DELAY_MS, waitSecs, url, signal, onStart, onDone, gcId } = opts;
  const decorate = opts.decorate ?? decorateEnabled();
  const invoke = deps.invoke || tauriInvoke;
  // gcId — GameCenter, из которого запускать в этот раз (например, «папка 2»); у кого его нет — запускается из доступного
  const base = deps.ctx || launchContext();
  const ctx = gcId ? { ...base, preferredId: gcId } : base;
  const list = launchable(characters, ctx);
  const jobs = list.map((character, i) => ({ character, last: i === list.length - 1 }));

  const results = await runQueue(
    jobs,
    async ({ character, last }) => {
      // Отмена: тем, кто ещё ждёт своей очереди, запуск уже не начинается
      if (signal?.cancelled) return { cancelled: true };
      onStart?.(character);
      const target = resolveGameCenter(character, ctx);
      // Название окна «Ник — Класс» и значок: Rust применит их к новому окну клиента в фоне
      const decor = decorate ? await windowDecor(character, deps) : { windowTitle: null, iconSmall: null, iconBig: null };
      await invoke('launcher_start', {
        path: target?.path,
        charId: target?.key,
        nick: target?.nick || null,
        url: url || null,
        waitSecs: waitSecs ?? null,
        ...decor
      });
      if (!last && delayMs > 0) await sleep(delayMs); // следующий аккаунт стартует после паузы
      return { cancelled: false };
    },
    {
      limiter: createLimiter(1), // строго по одному
      retries: 0,
      signal,
      onDone: (entry, done, total) => {
        if (entry.result?.cancelled) return;
        const { character } = entry.item;
        onDone?.({
          id: character.id,
          nick: character.nick || character.id,
          ok: !entry.error,
          error: entry.error ? String(entry.error?.message || entry.error) : undefined
        }, done, total);
      }
    }
  );

  return results.map(r => {
    const cancelled = !!(r.cancelled || r.result?.cancelled);
    return {
      id: r.item.character.id,
      nick: r.item.character.nick || r.item.character.id,
      ok: !r.error && !cancelled,
      cancelled,
      error: r.error ? String(r.error?.message || r.error) : undefined
    };
  });
}
