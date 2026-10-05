// js/modules/parties/membership.js
// Членство персонажей в партиях (issue #4). У персонажа `partyIds` — массив id всех его партий
// и `mainPartyId` — основная пати (одна; остальные — дополнительные). Инвариант: если партии есть,
// основная входит в `partyIds`; если партий нет, `mainPartyId = null`.
// Монеты на вкладке «Пати» и выбор в марафон считаются по основной пати.
// Сами партии лежат в state.parties ({ id, name, order }). Модуль без DOM и без импорта state:
// списки передаются аргументами, поэтому всё покрыто тестами (tests/parties.test.js).

/** Значение фильтра/выбора «Без пати». */
export const NO_PARTY = '__none__';
/** Подпись группы персонажей без партии. */
export const NO_PARTY_LABEL = 'Без пати';

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Массив id без пустых значений и дублей, порядок сохраняется. */
export function normalizePartyIds(input) {
  const list = Array.isArray(input) ? input : (input == null || input === '' ? [] : [input]);
  const seen = new Set();
  return list.map(x => String(x ?? '').trim()).filter(id => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export const partyById = (parties, id) => (parties || []).find(p => p.id === id) || null;
export const partyByName = (parties, name) => (parties || []).find(p => lower(p.name) === lower(name)) || null;

/** Основная пати: допустимое значение из списка id, иначе первая, иначе null. */
export function resolveMainPartyId(partyIds, mainPartyId) {
  const ids = normalizePartyIds(partyIds);
  return ids.includes(mainPartyId) ? mainPartyId : (ids[0] || null);
}

/** Приводит char.partyIds / char.mainPartyId к инварианту (мутирует). */
export function ensureMainParty(char) {
  char.partyIds = normalizePartyIds(char.partyIds);
  char.mainPartyId = resolveMainPartyId(char.partyIds, char.mainPartyId);
  return char;
}

const byOrder = (a, b) => (Number(a.order) || Number.MAX_SAFE_INTEGER) - (Number(b.order) || Number.MAX_SAFE_INTEGER) ||
  String(a.name).localeCompare(String(b.name), 'ru');

/** Партии персонажа (объекты): основная первой, затем дополнительные в порядке партий. */
export function partiesOf(char, parties) {
  const ids = new Set(char?.partyIds || []);
  const main = char?.mainPartyId;
  return (parties || []).filter(p => ids.has(p.id)).sort((a, b) =>
    (b.id === main) - (a.id === main) || byOrder(a, b));
}

export const partyNamesOf = (char, parties) => partiesOf(char, parties).map(p => p.name);

/** Основная пати (объект) или null. */
export const mainPartyOf = (char, parties) => partyById(parties, char?.mainPartyId);
export const mainPartyName = (char, parties) => mainPartyOf(char, parties)?.name || null;
export const isMainParty = (char, partyId) => !!partyId && char?.mainPartyId === partyId;

/** Дополнительные пати (объекты). */
export const additionalPartiesOf = (char, parties) => partiesOf(char, parties).filter(p => p.id !== char?.mainPartyId);

/** Персонажи, у которых эта пати основная. */
export const charactersInMainParty = (chars, partyId) => (chars || []).filter(c => isMainParty(c, partyId));

export const isInParty = (char, partyId) => (char?.partyIds || []).includes(partyId);

/**
 * Порядок участников внутри пати (задаётся перетаскиванием на вкладке «Пати»).
 * Хранится у персонажа: `char.partyOrder` — объект `{ [partyId]: число }`. Так персонаж, состоящий
 * в нескольких пати, может стоять в каждой на своём месте, а сам порядок живёт в одном месте —
 * рядом с остальными данными персонажа, и переживает перезапуск приложения.
 * Меньшее значение — выше в списке.
 */
export function partyOrderOf(char, partyId) {
  const value = char?.partyOrder?.[partyId];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Персонажи пати в заданном порядке: сначала те, кому порядок назначен (по возрастанию),
 * затем остальные по алфавиту. Возвращает новый массив.
 */
export function charactersInPartyOrdered(chars, partyId) {
  return [...charactersInParty(chars, partyId)].sort((a, b) => {
    const oa = partyOrderOf(a, partyId);
    const ob = partyOrderOf(b, partyId);
    if (oa !== null && ob !== null && oa !== ob) return oa - ob;
    if (oa !== null && ob === null) return -1;
    if (oa === null && ob !== null) return 1;
    return String(a.nick || '').localeCompare(String(b.nick || ''), 'ru');
  });
}

/**
 * Записывает порядок участников пати по списку id (первый — самый верхний).
 * Возвращает true, если что-то изменилось. Персонажи, которых нет в списке, порядок не теряют.
 */
export function applyPartyOrder(chars, partyId, orderedIds) {
  const position = new Map((orderedIds || []).map((id, i) => [String(id), i + 1]));
  let changed = false;
  for (const c of chars || []) {
    const next = position.get(String(c.id));
    if (next === undefined) continue;
    c.partyOrder = { ...(c.partyOrder || {}), [partyId]: next };
    changed = true;
  }
  return changed;
}

/**
 * Переносит участника пати в позицию другого участника.
 *
 * `after` — вставлять после того, на кого навели, а не до него. Наведение на верхнюю половину
 * строки вставляет перед ней (персонаж встаёт на её место, а она сдвигается вниз), на нижнюю —
 * после. Так перетаскивание вниз на соседнюю строку сдвигает на одну позицию, а не переносит в конец.
 *
 * После переноса порядок перенумеровывается подряд (1, 2, 3…), поэтому он остаётся предсказуемым.
 */
export function movePartyMember(chars, partyId, fromId, toId, { after = false } = {}) {
  const ordered = charactersInPartyOrdered(chars, partyId).map(c => c.id);
  const from = ordered.indexOf(fromId);
  const to = ordered.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return false;
  // Цель ищем уже без перетаскиваемого: иначе его собственное место сдвигало бы расчёт
  const rest = ordered.filter(id => id !== fromId);
  const targetIdx = rest.indexOf(toId);
  if (targetIdx < 0) return false;
  rest.splice(after ? targetIdx + 1 : targetIdx, 0, fromId);
  return applyPartyOrder(chars, partyId, rest);
}

/** Персонаж без единой существующей партии. */
export const hasNoParty = (char, parties) => partiesOf(char, parties).length === 0;

export const charactersInParty = (chars, partyId) => (chars || []).filter(c => isInParty(c, partyId));

/**
 * Добавляет (member = true) или убирает персонажа из партии. Возвращает true, если что-то изменилось.
 * Первая добавленная пати становится основной; если убрали основную — основной становится следующая.
 */
export function setMembership(char, partyId, member) {
  const has = isInParty(char, partyId);
  if (member === has) return false;
  char.partyIds = member ? [...(char.partyIds || []), partyId] : (char.partyIds || []).filter(id => id !== partyId);
  ensureMainParty(char);
  return true;
}

/** Делает пати основной (если персонаж в ней не состоял — добавляет). Прежняя основная остаётся дополнительной. */
export function setMainParty(char, partyId) {
  if (!partyId) return false;
  const was = char.mainPartyId;
  if (!isInParty(char, partyId)) char.partyIds = [...(char.partyIds || []), partyId];
  char.mainPartyId = partyId;
  ensureMainParty(char);
  return was !== char.mainPartyId;
}

/**
 * Создаёт новую пати и сразу собирает в неё персонажей (режим «Выбрать» → «В пати» → «Создать новую»).
 * `asMain: true` — пати становится основной у всех (прежняя основная остаётся дополнительной), иначе — дополнительной
 * (у кого пати не было, она всё равно станет основной). Пати добавляется в конец списка и в `parties`.
 * @returns {{ error: string } | { party: any, changed: number }}
 */
export function createPartyWith(parties, chars, name, { asMain = true, now = new Date().toISOString() } = {}) {
  const title = String(name ?? '').trim();
  if (!title) return { error: 'Введите название новой пати.' };
  if (partyByName(parties, title)) return { error: `Пати «${title}» уже существует.` };
  const max = (parties || []).reduce((m, p) => Math.max(m, Number(p.order) || 0), 0);
  const party = { id: newId(), name: title, order: Math.max(max, (parties || []).length) + 1, createdAt: now, updatedAt: now };
  parties.push(party);
  let changed = 0;
  (chars || []).forEach(c => {
    const did = asMain ? setMainParty(c, party.id) : setMembership(c, party.id, true);
    if (did) { c.updatedAt = now; changed++; }
  });
  return { party, changed };
}

/** Убирает партию у всех персонажей (удаление партии). Возвращает число затронутых. */
export function removePartyFromAll(chars, partyId) {
  let n = 0;
  (chars || []).forEach(c => { if (setMembership(c, partyId, false)) n++; });
  return n;
}

/** Выкидывает id несуществующих партий (после импорта/удаления). Возвращает число изменённых персонажей. */
export function sweepPartyIds(chars, parties) {
  const known = new Set((parties || []).map(p => p.id));
  let n = 0;
  (chars || []).forEach(c => {
    const next = normalizePartyIds(c.partyIds).filter(id => known.has(id));
    if (next.length !== (c.partyIds || []).length) n++;
    c.partyIds = next;
    ensureMainParty(c);
  });
  return n;
}

/** Копии персонажей с заменёнными id партий по карте { старый id → новый id }. */
export function remapCharacterParties(chars, idMap) {
  return (chars || []).map(c => {
    const partyIds = normalizePartyIds((c.partyIds || []).map(id => idMap.get(id) || id));
    return { ...c, partyIds, mainPartyId: resolveMainPartyId(partyIds, idMap.get(c.mainPartyId) || c.mainPartyId) };
  });
}

function newId() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Сопоставление партий из файла с локальными: совпадение по названию (без учёта регистра).
 * @returns {{ idMap: Map<string,string>, newParties: object[] }}
 */
export function planPartyImport(localParties, incomingParties) {
  const byName = new Map((localParties || []).map(p => [lower(p.name), p]));
  const usedIds = new Set((localParties || []).map(p => p.id));
  const idMap = new Map();
  const newParties = [];
  (incomingParties || []).forEach(p => {
    if (!p || !lower(p.name)) return;
    const same = byName.get(lower(p.name));
    if (same) { idMap.set(p.id, same.id); return; }
    const id = p.id && !usedIds.has(p.id) ? p.id : newId();
    const created = { ...p, id };
    idMap.set(p.id, id);
    usedIds.add(id);
    byName.set(lower(p.name), created);
    newParties.push(created);
  });
  return { idMap, newParties };
}

/** Сумма монет: каждый персонаж учитывается один раз (даже если состоит в нескольких партиях). */
export function totalCoins(chars) {
  const seen = new Set();
  let sum = 0;
  (chars || []).forEach(c => {
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    sum += Number(c.ancientCoins) || 0;
  });
  return Math.round(sum * 10) / 10;
}

/**
 * Монеты по партиям: персонаж считается ТОЛЬКО в своей основной пати.
 * perParty[id] — сумма персонажей с этой основной пати; noParty — персонажи без пати.
 * Поэтому sum(perParty) + noParty === overall: двойного счёта нет, даже если персонаж
 * состоит в нескольких пати.
 */
export function coinSummary(parties, chars) {
  const perParty = {};
  (parties || []).forEach(p => { perParty[p.id] = totalCoins(charactersInMainParty(chars, p.id)); });
  const noParty = totalCoins((chars || []).filter(c => hasNoParty(c, parties)));
  return { perParty, noParty, overall: totalCoins(chars) };
}
