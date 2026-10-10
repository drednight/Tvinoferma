// @ts-check
// js/modules/launcher/preflight.js
// Проверки перед запуском игры («предзапуск»): кого запускать, а кого пропустить и почему.
// Чистая логика без интерфейса и без обращения к Tauri — всё, что нужно знать о системе, приходит параметрами
// (readLaunchFacts собирает это из запущенных окон игры). Экран с итогом проверок: preflightDialog.js.
//
// Что проверяется для набора персонажей:
//  - окно этого ника уже запущено → запуск пропускается, очередь идёт к следующему (настройка launcher.skipRunning);
//  - нет GameCenter (ни из списка, ни «своего пути») → запустить нечем (можно исправить: прикрепить GameCenter);
//  - нет запомненного входа → окно откроется под тем аккаунтом, что выбран в GameCenter (у пати из нескольких — один и тот же);
//  - среди запущенных окон есть окна от администратора, а Твиноферма — без прав: названия и значки им не поставить;
//  - нет входа на сайт (🔴) — на запуск игры не влияет, но скрипты сайта у этих персонажей не сработают (только справка).
//
// Окно клиента узнаётся по заголовку «Ник — Класс» (его ставит сама Твиноферма, launcher_start). Если «Подписывать окна игры»
// выключено или заголовок изменён вручную, запущенный клиент не распознаётся — тогда он просто не будет пропущен.

import { resolveGameCenter, pickMajorityGc } from './gameCenters.js';
import { parseWindowTitle } from './windowList.js';

/** Режимы экрана проверок (Настройки → Запуск игры). */
export const PREFLIGHT_MODES = ['issues', 'always', 'off'];
export const DEFAULT_PREFLIGHT_MODE = 'issues';

/** @param {any} v */
export const normalizePreflightMode = (v) => (PREFLIGHT_MODES.includes(v) ? v : DEFAULT_PREFLIGHT_MODE);

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Сопоставляет запущенные клиенты с персонажами: какой персонаж уже в игре.
 * Один клиент закрывает только одного персонажа (у двоих с одинаковым ником и классом второй всё равно запустится).
 * Класс из заголовка сверяется, только если он есть и у окна, и у персонажа.
 * @param {any[]} characters
 * @param {Array<{ pid?: number, title?: string, elevated?: boolean|null }>} clients
 * @returns {Map<string, { pid: number, title: string, elevated: boolean|null }>} id персонажа → его клиент
 */
export function matchRunningClients(characters, clients) {
  const parsed = (clients || []).map(c => ({ client: c, info: parseWindowTitle(String(c?.title || '')), used: false }));
  /** @type {Map<string, { pid: number, title: string, elevated: boolean|null }>} */
  const out = new Map();
  for (const ch of characters || []) {
    const hit = parsed.find(p => !p.used && p.info && same(p.info.nick, ch.nick)
      && (!p.info.cls || !ch.class || same(p.info.cls, ch.class)));
    if (!hit) continue;
    hit.used = true;
    out.set(String(ch.id), { pid: Number(hit.client.pid) || 0, title: String(hit.client.title || ''), elevated: hit.client.elevated ?? null });
  }
  return out;
}

/**
 * Итог проверок перед запуском.
 * @param {{
 *   characters: any[],
 *   ctx?: import('./gameCenters.js').GcContext,
 *   clients?: Array<{ pid?: number, title?: string, elevated?: boolean|null }> | null,   // null — запущенные окна узнать не удалось
 *   selfElevated?: boolean | null,
 *   skipRunning?: boolean,
 *   decorate?: boolean
 * }} input
 */
export function launchPreflight({ characters, ctx = {}, clients = null, selfElevated = null, skipRunning = true, decorate = true }) {
  const list = characters || [];
  const withGc = list.filter(c => !!resolveGameCenter(c, ctx));
  const noGc = list.filter(c => !resolveGameCenter(c, ctx));

  const running = clients ? matchRunningClients(withGc, clients) : new Map();
  const alreadyRunning = skipRunning ? withGc.filter(c => running.has(String(c.id))).map(c => ({ char: c, ...running.get(String(c.id)) })) : [];
  const skipIds = new Set(alreadyRunning.map(r => String(r.char.id)));
  const planned = withGc.filter(c => !skipIds.has(String(c.id)));

  // Без запомненного входа GameCenter запускает окно под тем аккаунтом, который выбран
  // в нём сейчас. Для пати это почти всегда не тот аккаунт, поэтому такие персонажи не
  // запускаются вовсе — пользователь подтверждает запуск остальных.
  const noSavedLogin = planned.filter(c => !resolveGameCenter(c, ctx)?.saved);
  const noLoginIds = new Set(noSavedLogin.map(c => String(c.id)));
  const toLaunch = planned.filter(c => !noLoginIds.has(String(c.id)));
  const siteNoLogin = toLaunch.filter(c => c.isLoggedIn === false);
  // Окна игры от администратора: их нужно сопоставить с персонажами, иначе «Исправить» не знает,
// что именно подписывать. Само сопоставление — то же, что для уже запущенных окон.
const elevatedRows = clients ? matchRunningClients(withGc, clients.filter(c => c?.elevated === true)) : new Map();
const elevatedMatched = [...elevatedRows.entries()].map(([id, info]) => {
  const char = withGc.find(c => String(c.id) === id);
  return char ? { char, ...info } : null;
}).filter(Boolean);
const elevatedClients = (clients || []).filter(c => c?.elevated === true).length;
const adminMismatch = elevatedClients > 0 && selfElevated === false;
  const unknownClients = clients ? clients.filter(c => !parseWindowTitle(String(c?.title || ''))).length : 0;

  /**
   * Серьёзные проблемы: из-за них экран проверок показывается сам (в режиме «только при проблемах»).
   * «Вход не запомнен» теперь тоже проблема: без него окно откроется под чужим аккаунтом, и
   * запускать пати молча было бы хуже, чем спросить. Раньше это считалось обычным делом
   * (один аккаунт на нескольких персонажей) и только предупреждалось в журнале — теперь такие
   * персонажи пропускаются, а пользователь решает сам, запускать ли остальных.
   */
  const problems = [];
  if (noGc.length) problems.push('noGc');
  if (noSavedLogin.length) problems.push('noSavedLogin');
  if (adminMismatch) problems.push('adminMismatch');

  return {
    toLaunch, planned, alreadyRunning, noGc, noSavedLogin, siteNoLogin,
    elevatedClients, selfElevated, adminMismatch, unknownClients,
    /** Окна игры от администратора, сопоставленные с персонажами: их можно подписать помощником. */
    elevatedRows: elevatedMatched,
    /** Узнали ли мы, какие окна запущены (иначе «уже запущено» не проверялось). */
    runningKnown: clients !== null, decorate,
    problems, hasProblems: problems.length > 0,
    total: list.length
  };
}

/** @typedef {ReturnType<typeof launchPreflight>} Preflight */

/**
 * Показывать ли экран проверок.
 * @param {Preflight} pre
 * @param {string} mode 'issues' | 'always' | 'off'
 */
export function shouldShowPreflight(pre, mode) {
  const m = normalizePreflightMode(mode);
  if (m === 'off') return false;
  // Показываем и когда запускать некого: если у всех нет входа, пользователь должен увидеть
  // список и понять, что именно доделать, а не молчаливую ошибку «не указан GameCenter».
  if (!pre.toLaunch.length && !pre.noGc.length && !pre.noSavedLogin.length && !pre.alreadyRunning.length) return false;
  return m === 'always' || pre.hasProblems;
}

const nicks = (list, max = 6) => {
  const names = list.map(c => String(c.char?.nick ?? c.nick ?? c.id));
  return names.length > max ? `${names.slice(0, max).join(', ')} и ещё ${names.length - max}` : names.join(', ');
};

/**
 * Строки для журнала задачи (и для запуска из трея, где экрана нет): что пропущено и что стоит знать.
 * @param {Preflight} pre
 * @returns {Array<{ text: string, level: 'info'|'warn'|'ok' }>}
 */
export function preflightLog(pre) {
  /** @type {Array<{ text: string, level: 'info'|'warn'|'ok' }>} */
  const out = [];
  if (pre.alreadyRunning.length) out.push({ level: 'info', text: `Уже запущены, пропускаю (${pre.alreadyRunning.length}): ${nicks(pre.alreadyRunning)}` });
  if (pre.noGc.length) out.push({ level: 'warn', text: `Не указан GameCenter, пропускаю (${pre.noGc.length}): ${nicks(pre.noGc)}` });
  if (pre.noSavedLogin.length) out.push({ level: 'warn', text: `Вход в GameCenter не запомнен, пропускаю (${pre.noSavedLogin.length}): ${nicks(pre.noSavedLogin)}. Такое окно открылось бы под тем аккаунтом, который выбран в GameCenter сейчас` });
  if (pre.adminMismatch) out.push({ level: 'warn', text: 'Среди запущенных окон есть окна от администратора, а Твиноферма запущена без прав: названия и значки им не поставить' });
  if (pre.siteNoLogin.length) out.push({ level: 'info', text: `Нет входа на сайт (на запуск игры не влияет): ${nicks(pre.siteNoLogin)}` });
  return out;
}

/**
 * Что можно исправить одной кнопкой «Исправить и запустить».
 * @param {Preflight} pre
 * @param {{ gameCenters?: Array<{ id: string, name: string }> }} [ctx]
 * @returns {Array<{ id: 'attachGc'|'elevate', text: string }>}
 */
export function availableFixes(pre, ctx = {}) {
  const fixes = [];
  // Отсутствие GameCenter и незапомненный вход чинятся только вручную, в окне «GameCenter и
  // персонажи». Раньше здесь был автопереход: приложение само прикрепляло GameCenter из
  // списка. Но вход без ручного входа в сам GameCenter не запомнить, поэтому «Исправить»
  // открывает окно — иначе кнопка обещала исправление, которого не происходит.
  if (pre.noGc.length || pre.noSavedLogin.length) {
    fixes.push({
      id: /** @type {'openGcWindow'} */ ('openGcWindow'),
      text: `Открыть «GameCenter и персонажи» и доделать привязку и входы (${pre.noGc.length + pre.noSavedLogin.length})`
    });
  }
  // Окна игры от администратора: раньше выход был один — перезапуск Твинофермы от администратора.
  // Теперь то же делает короткоживущий помощник: Windows спросит разрешение один раз,
  // основной процесс остаётся обычным. Поэтому это идёт в «Исправить», а не в текст-просьбу.
  if (pre.adminMismatch) {
    fixes.push({
      id: /** @type {'elevate'} */ ('elevate'),
      text: `Подписать окна игры от администратора (${pre.elevatedClients}) — спросят разрешение Windows`
    });
  }
  return fixes;
}

/**
 * Какой GameCenter прикрепить персонажам без него: тот, которым пользуется большинство группы, иначе «запускать в первую очередь»,
 * иначе первый из списка. null — в списке GameCenter нет.
 * @param {any[]} group вся группа (не только персонажи без GameCenter)
 * @param {import('./gameCenters.js').GcContext} ctx
 */
export function chooseGcToAttach(group, ctx) {
  const gcs = ctx.gameCenters || [];
  if (!gcs.length) return null;
  return pickMajorityGc(group, ctx)?.gc || gcs.find(g => g.id === ctx.preferredId) || gcs[0];
}

/**
 * Прикрепляет GameCenter к персонажам (без записи на диск — этим занимается вызывающий).
 * Уже прикреплённые GameCenter не трогаются; запомненные входы не меняются.
 * @param {any[]} chars
 * @param {string} gcId
 */
export function attachGcTo(chars, gcId) {
  const stamp = new Date().toISOString();
  for (const c of chars) {
    const ids = Array.isArray(c.launch?.gcIds) ? c.launch.gcIds : [];
    if (ids.includes(gcId)) continue;
    c.launch = { ...(c.launch || {}), gcIds: [...ids, gcId] };
    c.updatedAt = stamp;
  }
}
