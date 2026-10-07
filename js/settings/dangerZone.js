// @ts-check
// js/settings/dangerZone.js
// «Настройки → Опасные действия»: массовое удаление пати, марафонов и персонажей.
// Логика отделена от интерфейса (чистые функции над state) — так её можно проверить тестами.
// Перед любым удалением settings.js делает резервную копию, поэтому ошибку можно откатить из «Резервных копий».

/**
 * Описания действий для окна подтверждения и для карточек в настройках.
 * `count(state)` — сколько записей будет затронуто.
 */
export const DANGER_ACTIONS = {
  parties: {
    title: 'Удалить все пати',
    what: 'пати',
    button: '🗑 Удалить пати',
    description: 'Удаляются все пати. Персонажи остаются, но у всех будет статус «Без пати» (и запуск игры «по пати» станет недоступен). Марафоны и монеты не меняются.',
    count: (/** @type {any} */ s) => (s.parties || []).length + (s.archivedParties || []).length
  },
  marathons: {
    title: 'Удалить все марафоны',
    what: 'марафонов и папок',
    button: '🗑 Удалить марафоны',
    description: 'Удаляются все марафоны и папки вместе с отметками заданий, настройками и статистикой монет. Персонажи, пати и их монеты остаются. Прогресс на сайте не меняется — марафон можно найти и создать заново.',
    count: (/** @type {any} */ s) => (s.marathons || []).length
  },
  characters: {
    title: 'Удалить всех персонажей',
    what: 'персонажей',
    button: '🗑 Удалить всех персонажей',
    description: 'Удаляются ВСЕ активные и архивные персонажи: данные, пароли в хранилище ОС, запомненные входы в GameCenter, история монет. Пати остаются пустыми, у марафонов исчезают участники. Самое разрушительное действие.',
    count: (/** @type {any} */ s) => (s.characters || []).length + (s.archivedCharacters || []).length
  }
};

/**
 * Удаляет все пати: сами пати и принадлежность к ним у персонажей.
 * @returns {number} сколько пати удалено
 */
export function clearParties(state) {
  const n = (state.parties || []).length + (state.archivedParties || []).length;
  const now = new Date().toISOString();
  state.parties = [];
  state.archivedParties = [];
  for (const c of [...(state.characters || []), ...(state.archivedCharacters || [])]) {
    if ((c.partyIds || []).length || c.mainPartyId) {
      c.partyIds = [];
      c.mainPartyId = null;
      c.updatedAt = now;
    }
  }
  if (state.ui) state.ui.partyFilter = '';
  return n;
}

/**
 * Удаляет все марафоны и папки (шаблоны марафонов и данные, прочитанные с сайта, остаются).
 * @returns {number} сколько записей удалено
 */
export function clearMarathons(state) {
  const n = (state.marathons || []).length;
  state.marathons = [];
  return n;
}

/**
 * Удаляет всех персонажей.
 * @returns {{ count: number, accountKeys: string[] }} сколько удалено и какие запомненные входы GameCenter нужно стереть из хранилища ОС
 */
export function clearCharacters(state, accountKeysOf = (/** @type {any} */ _c) => /** @type {string[]} */ ([])) {
  const characters = [...(state.characters || []), ...(state.archivedCharacters || [])];
  const count = characters.length;
  const accountKeys = characters.flatMap(accountKeysOf);
  state.characters = [];
  state.archivedCharacters = [];
  for (const party of state.archivedParties || []) party.memberLinks = [];
  if (state.ui) state.ui.expandedCharacterId = null;
  return { count, accountKeys };
}
