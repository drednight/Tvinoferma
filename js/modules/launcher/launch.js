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

/**
 * Мост в Tauri. Модуль импортируется один раз и запоминается: при параллельных вызовах
 * (например, проверки перед запуском спрашивают сразу два факта) повторный `import()`
 * того же модуля возвращает промис, который ещё не разрешён, и команда уходит в ошибку.
 */
let tauriCore = null;
function tauriInvoke(cmd, args) {
  if (!tauriCore) tauriCore = import('@tauri-apps/api/core');
  return tauriCore.then(({ invoke }) => invoke(cmd, args));
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

/**
 * Пауза между запусками окон, мс (Настройки → Запуск игры → «Пауза между запусками»).
 * Если настройки нет или она испорчена — {@link DEFAULT_LAUNCH_DELAY_MS}.
 * @param {any} [settings]
 */
export function launchDelayMs(settings = state.settings) {
  const raw = settings?.launcher?.delaySec;
  const sec = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(sec)) return DEFAULT_LAUNCH_DELAY_MS;
  return Math.round(Math.min(120, Math.max(0, sec)) * 1000);
}

/** Ставить ли значок класса (Настройки → Запуск игры). Название «Ник — Класс» от этого не зависит. */
export function decorateIconsEnabled() {
  return state.settings?.launcher?.decorateIcons !== false;
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
 * Значок можно не ставить (Настройки → Запуск игры → «Ставить значок класса»): тогда окно получает
 * только название, а значок остаётся игровым.
 * @param {any} character
 * @param {{ loadIcon?: (className: string, size: number) => Promise<number[] | null>, icons?: boolean }} [deps]
 */
export async function windowDecor(character, deps = {}) {
  const load = deps.loadIcon || classIconRgba;
  const cls = String(character?.class || '').trim();
  const withIcons = deps.icons ?? decorateIconsEnabled();
  const [iconSmall, iconBig] = cls && withIcons
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
 * Окна, которые уже были запущены и поэтому пропущены, идут отдельным счётчиком `running`.
 * @param {{ ok: number, failed?: number, cancelled?: number, skipped?: number, running?: number, ms: number }} r
 */
export function launchSummary(r) {
  const parts = [];
  if (r.ok || !r.running) parts.push(`Запущено ${r.ok} ${windowsWord(r.ok)} за ${formatDuration(r.ms)}`);
  else if (!r.failed && !r.cancelled && !r.skipped) return `Все окна уже запущены (${r.running}), запускать нечего`;
  if (r.running) parts.push(`уже запущено, пропущено: ${r.running}`);
  if (r.failed) parts.push(`с ошибкой: ${r.failed}`);
  if (r.cancelled) parts.push(`отменено: ${r.cancelled}`);
  if (r.skipped) parts.push(`без пути к GameCenter: ${r.skipped}`);
  return parts.join(', ');
}

/**
 * Текст итога закрытия окон по отчёту Rust: `{ found, closed, failed, denied, elevated, details, error }`.
 * @param {{ found?: number, closed?: number, failed?: number, denied?: number, elevated?: boolean, details?: string[], error?: string }} r
 */
export function closeReportText(r) {
  if (r?.error) return `Не удалось найти окна игры: ${r.error}`;
  const found = Number(r?.found) || 0;
  const closed = Number(r?.closed) || 0;
  const failed = Number(r?.failed) || 0;
  const denied = Number(r?.denied) || 0;
  if (!found) return 'Окон игры не запущено';
  if (!failed) return `Закрыто окон игры: ${closed}`;
  const head = `Закрыто ${closed} из ${found}.`;
  if (denied && !r?.elevated) return `${head} Игра запущена от имени администратора — нужны права администратора`;
  const why = (r?.details || [])[0];
  return why ? `${head} ${why}` : `${head} Остальные не поддались`;
}

/** Можно ли предложить закрыть оставшиеся окна с правами администратора (отказано в доступе, а мы сами не администратор). */
export function canCloseElevated(r) {
  return !r?.error && (Number(r?.denied) || 0) > 0 && !r?.elevated;
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

/**
 * Запущенные клиенты игры с подробностями: PID, когда запущен, заголовок окна, права.
 * Заголовок у окон, запущенных из Твинофермы, — «Ник — Класс» (так их подписывает `launcher_start`),
 * поэтому ник и класс восстанавливаются из него. У окон, запущенных не из Твинофермы, заголовок игровой,
 * и такой клиент показывается просто как «PID 1234».
 * @returns {Promise<Array<{pid: number, image: string, startedAt: number|null, title: string, hwnd: number|null, elevated: boolean|null}>>}
 */
export function runningClientDetails(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_running_details');
}

/** Запущена ли сама Твиноферма с правами администратора (`false`, если узнать не удалось). */
export function selfElevated(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_self_elevated');
}

/**
 * Что нужно знать о системе перед запуском: запущенные клиенты игры и права Твинофермы.
 * Любой сбой не мешает запуску: `clients: null` значит «какие окна запущены, неизвестно» (тогда ничего не пропускается).
 * @returns {Promise<{ clients: Array<{ pid: number, title: string, elevated: boolean|null }> | null, selfElevated: boolean | null }>}
 */
export async function readLaunchFacts(deps = {}) {
  // Оба факта независимы, поэтому спрашиваем их одновременно: каждый вызов — это перебор
  // процессов и окон, и по очереди они удваивали время ожидания перед запуском пати.
  const [clients, elevated] = await Promise.all([
    runningClientDetails(deps).catch(() => null),
    selfElevated(deps).catch(() => null)
  ]);
  return {
    clients: Array.isArray(clients) ? clients : null,
    selfElevated: typeof elevated === 'boolean' ? elevated : null
  };
}

/** Закрыть выбранные клиенты игры по PID. Отчёт — как у закрытия всех окон. */
export function closeClientsByPid(pids, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_close_clients_pids', { pids });
}

/**
 * Меняет название и значок запущенного окна игры по требованию пользователя.
 * Значок класса конвертируется здесь (canvas → RGBA): у Rust не всегда есть PNG рядом с exe,
 * а у окна браузера он точно есть. `clearIcon` — вернуть окну значок файла игры.
 * @param {{ pid: number, title?: string|null, class?: string|null, clearIcon?: boolean }} opts
 */
export async function applyWindowStyle(opts, deps = {}) {
  const invoke = deps.invoke || tauriInvoke;
  const cls = opts.clearIcon ? null : (opts.class || null);
  const [iconSmall, iconBig] = cls
    ? await Promise.all([classIconRgba(cls, WINDOW_ICON_SMALL), classIconRgba(cls, WINDOW_ICON_BIG)])
    : [null, null];
  return invoke('launcher_apply_window_style', {
    pid: opts.pid,
    title: opts.title ?? null,
    class: cls,
    clearIcon: opts.clearIcon ?? false,
    iconSmall,
    iconBig
  });
}

/** Текст итога ручной смены вида окна. */
export function applyStyleText(result) {
  switch (result?.status) {
    case 'missing': return 'Окно игры не найдено: возможно, оно уже закрыто';
    case 'failed': return 'Windows не даёт менять это окно: игра запущена от администратора, а Твиноферма — нет';
    case 'fixed': return 'Окно обновлено';
    default: return 'Изменений не потребовалось';
  }
}

/** Закрыть все клиенты игры. Возвращает, сколько было закрыто. */
export function closeAllClients(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_close_clients');
}

/** Проверка окон игры: какие окна есть, можно ли менять им заголовок и значок, от чьего имени запущена игра. */
export function inspectGameWindows(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_inspect_windows');
}

/**
 * Проверяет, что окна запущенных клиентов действительно получили название и значок,
 * и повторяет подпись там, где не получилось.
 *
 * Зачем: окно клиента появляется не сразу после запуска, а игра при загрузке может переписать заголовок.
 * `launcher_start` подписывает окно в фоне и о результате не сообщает, поэтому после запуска всех аккаунтов
 * итог проверяется по факту, и для неподписанных окон попытка повторяется.
 *
 * @param {Array<{ pid: number, title: string, iconSmall?: number[]|null, iconBig?: number[]|null }>} targets
 * @param {{ invoke?: Function }} [deps]
 * @returns {Promise<{ ok: number, fixed: number, missing: number, failed: number, details: string[] }>}
 */
export async function redecorateClients(targets, deps = {}) {
  const invoke = deps.invoke || tauriInvoke;
  const list = (targets || []).filter(t => t && t.pid && t.title);
  /** @type {{ ok: number, fixed: number, missing: number, failed: number, details: string[] }} */
  const out = { ok: 0, fixed: 0, missing: 0, failed: 0, details: [] };
  if (!list.length) return out;
  try {
    const results = await invoke('launcher_decorate_clients', { targets: list });
    for (const r of results || []) {
      if (r.status === 'ok') out.ok++;
      else if (r.status === 'fixed') out.fixed++;
      else if (r.status === 'missing') out.missing++;
      else { out.failed++; out.details.push(`PID ${r.pid}: название и значок не применились`); }
    }
  } catch (e) {
    out.details.push(`Проверка окон не удалась: ${String(e?.message || e)}`);
  }
  return out;
}

/**
 * Подписывает окна клиентов с правами администратора — без перезапуска Твинофермы.
 *
 * Нужна, когда игра запущена от администратора, а Твиноферма — обычным пользователем:
 * Windows запрещает менять чужие окна. Приложение запускает у себя короткоживущего помощника
 * (`src-tauri/src/elevate.rs`) — он получает права на минуту, подписывает окна и выходит.
 * Основной процесс остаётся обычным, перезапускать его не нужно.
 *
 * @param {Array<{pid: number, title: string, iconSmall?: number[]|null, iconBig?: number[]|null}>} targets
 * @returns {Promise<{ ok: number, fixed: number, missing: number, failed: number, denied: boolean, details: string[] }>}
 */
export async function decorateElevated(targets, deps = {}) {
  const invoke = deps.invoke || tauriInvoke;
  const list = (targets || []).filter(t => t && t.pid && t.title);
  /** @type {{ ok: number, fixed: number, missing: number, failed: number, denied: boolean, details: string[] }} */
  const out = { ok: 0, fixed: 0, missing: 0, failed: 0, denied: false, details: [] };
  if (!list.length) return out;
  try {
    const res = await invoke('launcher_run_elevated', { job: { action: 'decorate', targets: list } });
    if (res?.status === 'denied') {
      out.denied = true;
      out.details.push('Запрос прав администратора отклонён');
      return out;
    }
    for (const r of res?.decorate || []) {
      if (r.status === 'ok') out.ok++;
      else if (r.status === 'fixed') out.fixed++;
      else if (r.status === 'missing') out.missing++;
      else { out.failed++; out.details.push(`PID ${r.pid}: не удалось подписать даже с правами администратора`); }
    }
  } catch (e) {
    out.details.push(`Работа от администратора не удалась: ${String(e?.message || e)}`);
  }
  return out;
}

/** Текст итога перепроверки: пусто, если всё в порядке. */
export function redecorateText(result) {
  if (!result) return '';
  const parts = [];
  if (result.fixed) parts.push(`подписано окон: ${result.fixed}`);
  if (result.failed) parts.push(`не удалось подписать: ${result.failed}`);
  if (result.missing) parts.push(`окон не найдено: ${result.missing}`);
  return parts.length ? `Проверка названий и значков — ${parts.join(', ')}` : '';
}

/** Заголовок, который Rust ставит окну на мгновение при проверке (см. PROBE_TITLE в launcher.rs). */
export const PROBE_TITLE = 'Твиноферма — проверка';

/**
 * Выводы по отчёту проверки окон: что мешает подписать окно и что с этим делать.
 * @param {any} report ответ `launcher_inspect_windows`
 * @returns {string[]}
 */
export function inspectVerdict(report) {
  const clients = report?.clients || [];
  if (!clients.length) return ['Запущенных окон игры не найдено — запустите игру и повторите проверку.'];
  const out = [];
  const selfAdmin = !!report.selfElevated;
  for (const c of clients) {
    const wins = (c.windows || []).filter(w => w.visible && w.title);
    if (c.elevated && !selfAdmin) {
      out.push(`PID ${c.pid}: игра запущена от администратора, а Твиноферма — нет. Windows не даёт менять чужие окна (название и значок). Запустите Твиноферму от имени администратора (ПКМ по ярлыку → «Запуск от имени администратора»; в режиме разработки — терминал от администратора).`);
      continue;
    }
    if (!wins.length) { out.push(`PID ${c.pid}: нет видимого окна с заголовком — менять нечего (игра ещё грузится?).`); continue; }
    for (const w of wins) {
      if (w.titleError) out.push(`PID ${c.pid}, окно ${w.hwnd}: заголовок не принимается (код Windows ${w.titleError}).`);
      else if (w.titleAfter !== PROBE_TITLE) out.push(`PID ${c.pid}, окно ${w.hwnd}: заголовок принят, но прочитано «${w.titleAfter}» — игра обрабатывает его по-своему.`);
      if (w.iconError) out.push(`PID ${c.pid}, окно ${w.hwnd}: значок не принимается (код Windows ${w.iconError}).`);
      if (w.tool || w.owned) out.push(`PID ${c.pid}, окно ${w.hwnd}: это ${w.tool ? 'окно-инструмент' : 'окно с владельцем'} — панель задач такие не показывает.`);
      if (w.hung) out.push(`PID ${c.pid}, окно ${w.hwnd}: окно не отвечает — Windows не принимает от него сообщения.`);
    }
  }
  if (!out.length) {
    out.push('Заголовок и значок окон менять можно. Если на панели задач иконка общая: Параметры → Персонализация → Панель задач → «Группировать кнопки на панели задач» → «Никогда»; тогда у каждого окна будет свой значок и подпись.');
  }
  return out;
}

/** Читаемый отчёт проверки окон (его можно скопировать и прислать разработчику). */
export function inspectReportText(report) {
  const lines = [];
  const clients = report?.clients || [];
  lines.push(`Твиноферма: ${report?.selfElevated ? 'запущена от администратора' : 'обычные права'}`);
  lines.push(`Клиентов игры: ${clients.length}`);
  const who = (v) => v === true ? 'от администратора' : v === false ? 'обычные права' : 'права не определены';
  for (const c of clients) {
    lines.push('', `PID ${c.pid} — ${who(c.elevated)}`);
    if (!c.windows?.length) lines.push('  окон нет');
    for (const w of c.windows || []) {
      const flags = [w.visible ? 'видимое' : 'скрытое', w.tool && 'инструмент', w.owned && 'есть владелец', w.app && 'в панели задач принудительно', w.hung && 'не отвечает'].filter(Boolean).join(', ');
      lines.push(`  ${w.hwnd} «${w.title}» (${w.class}) — ${flags}`);
      if (w.visible && w.title) {
        lines.push(`    заголовок: ${w.titleError ? `отказ, код ${w.titleError}` : 'смена удалась'}; после пробы прочитано «${w.titleAfter}»`);
        lines.push(`    значки: ${w.hasSmallIcon || w.hasBigIcon ? `свои (${w.hasSmallIcon ? 'малый' : '—'}, ${w.hasBigIcon ? 'большой' : '—'})` : 'своих нет (берётся значок из файла игры)'}; смена ${w.iconError ? `отказ, код ${w.iconError}` : 'удалась'}`);
      }
    }
  }
  lines.push('', 'Вывод:', ...inspectVerdict(report).map(v => `• ${v}`));
  return lines.join('\n');
}

/** Закрыть клиенты игры с правами администратора (Windows покажет запрос UAC). Возвращает отчёт, как closeAllClients. */
export function closeAllClientsElevated(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_close_clients_elevated');
}

/**
 * Ответ Rust на запуск (`launcher_start`).
 * @typedef {{ pid?: number, dialogClicked?: boolean, switched?: boolean, clientPid?: number, closedOtherGc?: number, gcCloseFailed?: number }} LaunchInfo
 */

/**
 * Предупреждения по итогам одного запуска — их видно в логе задачи. Пусто, если всё в порядке.
 * @param {LaunchInfo | undefined} info
 * @returns {string[]}
 */
export function launchWarnings(info) {
  const out = [];
  if (!info) return out;
  if (info.closedOtherGc > 0) out.push(`Закрыт GameCenter из другой папки (${info.closedOtherGc}): GameCenter работает в одном экземпляре и открыл бы игру под своим аккаунтом`);
  if (info.gcCloseFailed > 0) out.push('GameCenter запущен от администратора, закрыть его не удалось: игра может открыться под его аккаунтом. Запустите Твиноферму от администратора');
  return out;
}

/**
 * Что сказать пользователю, когда Rust закончил подписывать окно игры (событие `launcher-decorate`).
 * @param {{ title?: string, status?: string, code?: number } | undefined} ev
 * @returns {string | null} `null` — всё хорошо, говорить нечего
 */
export function decorateNotice(ev) {
  const title = ev?.title ? `«${ev.title}»` : 'игры';
  switch (ev?.status) {
    case 'denied':
      return `Окно ${title} не подписано: игра запущена от имени администратора, а Твиноферма — нет, и Windows не даёт менять чужие окна. Запустите Твиноферму от имени администратора.`;
    case 'failed':
      return `Окно ${title} не удалось подписать (код Windows ${ev.code || '—'}).`;
    case 'missing':
      return `Окно ${title} не появилось за 90 с — название и значок не поставлены.`;
    default:
      return null;
  }
}

/** Сколько запусков прошло без запомненного входа: такие окна открываются под тем аккаунтом, что сейчас выбран в GameCenter. */
export function withoutSavedLogin(entries) {
  return (entries || []).filter(e => e.ok && e.info && e.info.switched === false).length;
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
 *   onDone?: (entry: { id: string, nick: string, ok: boolean, error?: string, info?: LaunchInfo, ms?: number | null }, done: number, total: number) => void
 * }} [opts]
 * @param {{ invoke?: (cmd: string, args?: any) => Promise<any>, ctx?: import('./gameCenters.js').GcContext, loadIcon?: (className: string, size: number) => Promise<number[] | null> }} [deps]
 */
export async function launchCharacters(characters, opts = {}, deps = {}) {
  const { delayMs = launchDelayMs(), waitSecs, url, signal, onStart, onDone, gcId } = opts;
  const decorate = opts.decorate ?? decorateEnabled();
  const invoke = deps.invoke || tauriInvoke;
  // gcId — GameCenter, из которого запускать в этот раз (например, «папка 2»); у кого его нет — запускается из доступного
  const base = deps.ctx || launchContext();
  const ctx = gcId ? { ...base, preferredId: gcId } : base;
  const list = launchable(characters, ctx);
  const jobs = list.map((character, i) => ({ character, last: i === list.length - 1 }));
  /** Сколько Твиноферма ждала клиента игры у каждого (без паузы между запусками); у неудачных — до ошибки. */
  const times = new Map();

  const results = await runQueue(
    jobs,
    async ({ character, last }) => {
      // Отмена: тем, кто ещё ждёт своей очереди, запуск уже не начинается
      if (signal?.cancelled) return { cancelled: true };
      onStart?.(character);
      const target = resolveGameCenter(character, ctx);
      // Название окна «Ник — Класс» и значок: Rust применит их к новому окну клиента в фоне
      const decor = decorate ? await windowDecor(character, deps) : { windowTitle: null, iconSmall: null, iconBig: null };
      const t0 = Date.now();
      let info;
      try {
        info = await invoke('launcher_start', {
          path: target?.path,
          charId: target?.key,
          nick: target?.nick || null,
          url: url || null,
          waitSecs: waitSecs ?? null,
          ...decor
        });
      } finally {
        times.set(character.id, Date.now() - t0);
      }
      if (!last && delayMs > 0) await sleep(delayMs); // следующий аккаунт стартует после паузы
      return { cancelled: false, info: info || {}, decor, character };
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
          error: entry.error ? String(entry.error?.message || entry.error) : undefined,
          info: entry.result?.info,
          ms: times.get(character.id) ?? null
        }, done, total);
      }
    }
  );

  return results.map(r => {
    const cancelled = !!(r.cancelled || r.result?.cancelled);
    const info = r.result?.info;
    return {
      id: r.item.character.id,
      nick: r.item.character.nick || r.item.character.id,
      ok: !r.error && !cancelled,
      cancelled,
      error: r.error ? String(r.error?.message || r.error) : undefined,
      info,
      ms: times.get(r.item.character.id) ?? null,
      // Что нужно для проверки подписи окна: PID клиента и ожидаемое название со значком
      clientPid: info?.clientPid ? Number(info.clientPid) : null,
      decor: r.result?.decor || null
    };
  });
}

/**
 * После запуска проверяет, что все окна получили название и значок, и повторяет попытку там, где не вышло.
 * Возвращает текст для журнала задачи или пустую строку, если всё в порядке.
 * @param {Array<{ ok?: boolean, clientPid?: number|null, decor?: { windowTitle?: string|null, iconSmall?: number[]|null, iconBig?: number[]|null }|null }>} results
 * @param {{ invoke?: Function }} [deps]
 */
export async function verifyLaunchedDecor(results, deps = {}) {
  const targets = (results || [])
    .filter(r => r.ok && r.clientPid && r.decor?.windowTitle)
    .map(r => ({
      pid: r.clientPid,
      title: r.decor.windowTitle,
      iconSmall: r.decor.iconSmall || null,
      iconBig: r.decor.iconBig || null
    }));
  if (!targets.length) return '';
  const res = await redecorateClients(targets, deps);
  return redecorateText(res);
}
