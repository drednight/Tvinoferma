// js/modules/characters/grouping.js
// Группировка и свой порядок персонажей в списке. Чистые функции, без DOM:
// покрываются тестами так же, как filters.js.
//
// Группировка (только отображение): без группировки / по пати / по классу.
// Свой порядок: список id, который задаёт пользователь перетаскиванием карточек.
// Перетаскивание меняет только порядок, но не состав пати и не класс.

export const GROUP_NONE = 'none';
export const GROUP_PARTY = 'party';
export const GROUP_CLASS = 'class';

export const ORDER_NICK = 'nick';
export const ORDER_MANUAL = 'manual';

export const NO_PARTY_TITLE = 'Без пати';
export const NO_CLASS_TITLE = 'Без класса';

/**
 * Пати персонажа: основная, если она существует, иначе первая из существующих.
 * Пати, которых уже нет в списке, игнорируются.
 * @param {any} char
 * @param {any[]} parties
 * @returns {any | null}
 */
export function characterParty(char, parties) {
  const byId = new Map((parties || []).map(p => [p.id, p]));
  if (char?.mainPartyId && byId.has(char.mainPartyId)) return byId.get(char.mainPartyId);
  for (const id of char?.partyIds || []) {
    if (byId.has(id)) return byId.get(id);
  }
  return null;
}

/**
 * Делит персонажей на группы. Порядок внутри группы сохраняется как во входном массиве.
 * Пустые группы не возвращаются.
 *
 * @param {any[]} chars уже отфильтрованные и отсортированные персонажи
 * @param {string} key GROUP_NONE | GROUP_PARTY | GROUP_CLASS
 * @param {any[]} parties
 * @returns {{ key: string, title: string | null, chars: any[], online: number }[]}
 */
export function groupChars(chars, key, parties = []) {
  const list = chars || [];
  if (key !== GROUP_PARTY && key !== GROUP_CLASS) {
    return list.length ? [{ key: 'all', title: null, chars: list, online: countOnline(list) }] : [];
  }

  /** @type {Map<string, { key: string, title: string, order: number, chars: any[] }>} */
  const groups = new Map();
  for (const c of list) {
    let gKey;
    let title;
    let order = 0;
    if (key === GROUP_PARTY) {
      const party = characterParty(c, parties);
      gKey = party ? `p:${party.id}` : 'p:none';
      title = party ? party.name : NO_PARTY_TITLE;
      order = party ? Number(party.order) || 1e9 : Infinity;
    } else {
      gKey = c.class ? `c:${c.class}` : 'c:none';
      title = c.class || NO_CLASS_TITLE;
    }
    if (!groups.has(gKey)) groups.set(gKey, { key: gKey, title, order, chars: [] });
    groups.get(gKey).chars.push(c);
  }

  const out = [...groups.values()];
  if (key === GROUP_PARTY) {
    // Партии — в их порядке, затем по названию; «Без пати» всегда последней
    out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
  } else {
    // Классы — по алфавиту, «Без класса» последней
    out.sort((a, b) => {
      if (a.key === 'c:none') return 1;
      if (b.key === 'c:none') return -1;
      return a.title.localeCompare(b.title, 'ru');
    });
  }
  return out.map(g => ({ key: g.key, title: g.title, chars: g.chars, online: countOnline(g.chars) }));
}

function countOnline(chars) {
  return chars.filter(c => c.isLoggedIn === true).length;
}

/**
 * Применяет сохранённый порядок. Персонажи, которых нет в сохранённом порядке
 * (новые или добавленные из парсера), идут в конец в том порядке, в котором пришли.
 * @param {any[]} chars
 * @param {string[]} orderIds
 * @returns {any[]}
 */
export function applyManualOrder(chars, orderIds = []) {
  const pos = new Map();
  orderIds.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i);
  });
  return (chars || [])
    .map((c, i) => ({ c, i, p: pos.has(c.id) ? pos.get(c.id) : Infinity }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(x => x.c);
}

/**
 * Переносит персонажа `dragId` на место `targetId`.
 * По умолчанию вставка перед целью; с `after: true` — после неё.
 * Если цели нет — персонаж уходит в конец. Возвращает новый массив id.
 * @param {string[]} orderIds
 * @param {{ dragId: string, targetId: string | null, after?: boolean }} move
 * @returns {string[]}
 */
export function moveChar(orderIds, { dragId, targetId, after = false }) {
  const ids = (orderIds || []).filter(id => id !== dragId);
  const at = targetId != null ? ids.indexOf(targetId) : -1;
  if (at === -1) ids.push(dragId);
  else ids.splice(after ? at + 1 : at, 0, dragId);
  return ids;
}
