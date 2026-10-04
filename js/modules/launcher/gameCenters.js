// @ts-check
// js/modules/launcher/gameCenters.js
// Несколько GameCenter (VK Play): общий список с названиями в «Настройки → Запуск игры» и привязка к персонажам.
//
// Данные:
//  - settings.launcher.gameCenters: [{ id, name, path }] — GameCenter, которые пользователь назвал сам («Папка 1», «Папка 2»…);
//  - settings.launcher.preferredGcId — какой GameCenter запускать в первую очередь ('' — первый из списка персонажа);
//  - character.launch.gcIds — id прикреплённых к персонажу GameCenter (первый — «основной»);
//  - character.launch.gcAccounts[gcId] — запомненный вход этого персонажа в этом GameCenter ({ nick }); токен лежит в хранилище ОС.
//  - character.launch.gcPath — «свой путь» из карточки (старый способ). Используется, только если GameCenter из списка не прикреплены.
//
// Выбор GameCenter при запуске (resolveGameCenter): если у персонажа есть предпочитаемый GameCenter — берётся он,
// иначе — первый из прикреплённых («только из доступного»), иначе — свой путь из карточки.

/**
 * @typedef {{ id: string, name: string, path: string }} GameCenter
 * @typedef {{ gameCenters?: GameCenter[], preferredId?: string }} GcContext
 * @typedef {{ path: string, key: string, nick: string, saved: boolean, gc: GameCenter | null }} ResolvedGc
 */

/** Максимум GameCenter в списке (защита от мусора в state.json). */
export const MAX_GAME_CENTERS = 30;

/** Путь для сравнения: без регистра, со слэшами `\`, без хвоста `\GameCenter.exe` и лишних разделителей. */
export function samePathKey(path) {
  return String(path || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .replace(/\\gamecenter\.exe$/i, '')
    .toLowerCase();
}

/** Список GameCenter из state.json: только объекты с id и путём, без повторов. */
export function normalizeGameCenters(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw?.id || '').trim();
    const path = String(raw?.path || '').trim();
    if (!id || !path || seen.has(id) || out.length >= MAX_GAME_CENTERS) continue;
    seen.add(id);
    out.push({ id, name: String(raw?.name || '').trim().slice(0, 60) || 'GameCenter', path });
  }
  return out;
}

/** Уникальный id для нового GameCenter. */
export function newGcId(existing = []) {
  const taken = new Set((existing || []).map(g => g.id));
  for (let i = 0; i < 1000; i++) {
    const rnd = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 8);
    const id = `gc-${rnd}`;
    if (!taken.has(id)) return id;
  }
  return `gc-${Date.now()}`;
}

/** Название по умолчанию: имя папки, где лежит GameCenter.exe («GameCenter2»), иначе «GameCenter N». */
export function suggestGcName(path, existing = []) {
  const parts = String(path || '').replace(/\//g, '\\').split('\\').filter(Boolean);
  if (parts.length && /\.exe$/i.test(parts[parts.length - 1])) parts.pop();
  const folder = parts[parts.length - 1] || '';
  const taken = new Set((existing || []).map(g => String(g.name || '').toLowerCase()));
  if (folder && !taken.has(folder.toLowerCase())) return folder;
  for (let n = (existing || []).length + 1; n < 1000; n++) {
    const name = `GameCenter ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return 'GameCenter';
}

/** GameCenter, прикреплённые к персонажу (только существующие в списке), в порядке привязки. */
export function attachedGcs(char, gameCenters) {
  const byId = new Map((gameCenters || []).map(g => [g.id, g]));
  const ids = Array.isArray(char?.launch?.gcIds) ? char.launch.gcIds : [];
  return ids.map(id => byId.get(id)).filter(Boolean);
}

/**
 * Ключ запомненного входа в хранилище ОС. Для GameCenter из списка — «персонаж@GameCenter»;
 * для входов, перенесённых из старой привязки (legacy), и для «своего пути» — просто id персонажа, как раньше.
 */
export function accountKey(char, gcId) {
  if (!gcId || char?.launch?.gcAccounts?.[gcId]?.legacy) return String(char?.id || '');
  return `${char?.id}@${gcId}`;
}

/**
 * Какой GameCenter, под каким ключом входа и ником запускать персонажа. null — запускать нечем.
 * @param {any} char
 * @param {GcContext} [ctx]
 * @returns {ResolvedGc | null}
 */
export function resolveGameCenter(char, ctx = {}) {
  const attached = attachedGcs(char, ctx.gameCenters);
  if (attached.length) {
    const gc = attached.find(g => g.id === ctx.preferredId) || attached[0];
    const acc = char.launch?.gcAccounts?.[gc.id];
    return { path: gc.path, key: accountKey(char, gc.id), nick: acc?.nick || '', saved: !!acc, gc };
  }
  const own = String(char?.launch?.gcPath || '').trim();
  if (own) {
    return {
      path: own,
      key: String(char?.id || ''),
      nick: String(char?.launch?.gcNick || ''),
      saved: char?.launch?.gcAccount === true,
      gc: null
    };
  }
  return null;
}

/** Копия `launch` персонажа с изменениями (оригинальный объект не трогаем). */
function launchOf(char) {
  const l = char.launch || {};
  return {
    ...l,
    gcIds: Array.isArray(l.gcIds) ? [...l.gcIds] : [],
    gcAccounts: { ...(l.gcAccounts || {}) }
  };
}

/** Прикрепить GameCenter к персонажу (в конец списка). Повторно не добавляет. */
export function attachGc(char, gcId) {
  const l = launchOf(char);
  if (gcId && !l.gcIds.includes(gcId)) l.gcIds.push(gcId);
  char.launch = l;
  return char;
}

/** Открепить GameCenter от персонажа. Запомненный вход этого GameCenter остаётся в хранилище ОС, пока его не забудут отдельно. */
export function detachGc(char, gcId) {
  const l = launchOf(char);
  l.gcIds = l.gcIds.filter(id => id !== gcId);
  delete l.gcAccounts[gcId];
  char.launch = l;
  return char;
}

/** Заменить GameCenter в позиции `index` на другой (вход старого забывается в данных; сам токен чистит вызывающий код). */
export function replaceGc(char, index, gcId) {
  const l = launchOf(char);
  if (index < 0 || index >= l.gcIds.length || !gcId || l.gcIds.includes(gcId)) return char;
  delete l.gcAccounts[l.gcIds[index]];
  l.gcIds[index] = gcId;
  char.launch = l;
  return char;
}

/** Записать (или убрать при `nick === null`) запомненный вход персонажа в GameCenter. */
export function setGcAccount(char, gcId, nick, legacy = false) {
  const l = launchOf(char);
  if (nick === null) delete l.gcAccounts[gcId];
  else l.gcAccounts[gcId] = legacy ? { nick: String(nick || ''), legacy: true } : { nick: String(nick || '') };
  char.launch = l;
  return char;
}

/** Ключи запомненных входов персонажа в хранилище ОС: из списка GameCenter и старый (`id`). Нужны при удалении персонажа. */
export function accountKeysOf(char) {
  const keys = new Set();
  const l = char?.launch || {};
  if (l.gcAccount) keys.add(String(char.id));
  for (const gcId of Object.keys(l.gcAccounts || {})) keys.add(accountKey(char, gcId));
  return [...keys];
}

/**
 * Убрать GameCenter из списка: он открепляется от всех персонажей.
 * Возвращает ключи входов, которые нужно удалить из хранилища ОС.
 */
export function removeGameCenter(settingsLauncher, characters, gcId) {
  const keys = [];
  for (const c of characters || []) {
    if (!(c.launch?.gcIds || []).includes(gcId)) continue;
    const acc = c.launch?.gcAccounts?.[gcId];
    if (acc && !acc.legacy) keys.push(accountKey(c, gcId)); // перенесённый вход (legacy) остаётся: он же вход «своего пути»
    detachGc(c, gcId);
  }
  settingsLauncher.gameCenters = (settingsLauncher.gameCenters || []).filter(g => g.id !== gcId);
  if (settingsLauncher.preferredGcId === gcId) settingsLauncher.preferredGcId = '';
  return keys;
}

/**
 * Перенос путей из карточек в общий список: одинаковые пути объединяются в один GameCenter,
 * персонажи прикрепляются к нему, а их запомненный вход сохраняется (ключ остаётся прежним).
 * @returns {{ created: number, attached: number }}
 */
export function importLegacyPaths(settingsLauncher, characters) {
  const list = settingsLauncher.gameCenters || (settingsLauncher.gameCenters = []);
  let created = 0;
  let attached = 0;
  for (const c of characters || []) {
    const own = String(c.launch?.gcPath || '').trim();
    if (!own || attachedGcs(c, list).length) continue;
    const key = samePathKey(own);
    let gc = list.find(g => samePathKey(g.path) === key);
    if (!gc) {
      if (list.length >= MAX_GAME_CENTERS) continue;
      gc = { id: newGcId(list), name: suggestGcName(own, list), path: own };
      list.push(gc);
      created++;
    }
    attachGc(c, gc.id);
    if (c.launch?.gcAccount) setGcAccount(c, gc.id, c.launch.gcNick || '', true);
    attached++;
  }
  return { created, attached };
}

/** Сколько персонажей имеют GameCenter из списка или свой путь (для подписи в настройках). */
export function countLaunchReady(characters, ctx) {
  return (characters || []).filter(c => resolveGameCenter(c, ctx)).length;
}
