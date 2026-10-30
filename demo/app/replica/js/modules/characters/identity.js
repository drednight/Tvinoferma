// js/modules/characters/identity.js
// id персонажа = читаемый слаг ника (core/ids.js). При смене ника id тоже меняется:
// переименовываются ссылки в марафонах, профиль браузера (вход на сайт сохраняется)
// и ключ в хранилище ОС (переезжает при следующем сохранении).

import { state } from '../../core/state.js';
import { characterIdFor } from '../../core/ids.js';
import { isTauri } from '../../core/storage.js';

/** id для нового персонажа. */
export function newCharacterId(nick) {
  return characterIdFor(
    nick,
    [...state.characters, ...state.archivedCharacters].map(c => c.id)
  );
}

/**
 * Приводит id персонажа к его нику. Возвращает { id, changed, error }.
 * Если профиль браузера перенести нельзя (окно не закрылось), id остаётся прежним.
 */
export async function syncIdWithNick(char) {
  const prevId = char.id;
  const requestedNick = char.nick;
  const nextId = characterIdFor(
    requestedNick,
    [...state.characters, ...state.archivedCharacters].map(c => c.id),
    prevId
  );
  // Один только регистр не меняет локальную идентичность: некоторые хранилища
  // и файловые системы считают такие имена одинаковыми.
  if (!prevId || nextId.toLowerCase() === prevId.toLowerCase()) return { id: prevId, changed: false };

  // Готовим все ссылки до переименования профиля на диске: при пересечении с уже
  // существующим ключом нельзя молча затереть историю другого персонажа.
  try {
    prepareReferenceRename(prevId, nextId);
  } catch {
    return { id: prevId, changed: false, error: 'references_conflict' };
  }

  let profileMoved = false;
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_sync_window', { charId: prevId }).catch(() => {});
      await new Promise(r => setTimeout(r, 400)); // WebView2 отпускает файлы профиля не мгновенно
      const failed = await invoke('rename_char_profiles', { remap: { [prevId]: nextId } });
      if (failed?.length) return { id: prevId, changed: false, error: 'profile_busy' };
      profileMoved = true;
    } catch (e) {
      return { id: prevId, changed: false, error: String(e?.message || e) };
    }
  }

  // Пока открывали/закрывали профиль, состояние могло измениться. Заново готовим
  // ссылки из актуальных данных, а не перезаписываем их устаревшей копией.
  try {
    const characters = [...state.characters, ...state.archivedCharacters];
    if (
      char.id !== prevId ||
      char.nick !== requestedNick ||
      !characters.includes(char) ||
      characters.some(row => row !== char && String(row.id).toLowerCase() === nextId.toLowerCase())
    )
      throw new Error('Персонаж изменился');
    applyReferenceRename(prepareReferenceRename(prevId, nextId));
  } catch {
    // Команда профилей не сообщает, был ли файл действительно перенесён; обратное
    // переименование могло бы тронуть чужой профиль. Не повторяем его вслепую.
    return { id: prevId, changed: false, error: profileMoved ? 'profile_rename_unconfirmed' : 'references_conflict' };
  }
  char.id = nextId;
  return { id: nextId, changed: true };
}

// Меняем только известные ссылки на персонажа. Старый локальный id уже не UUID, а
// слаг ника: произвольная рекурсивная замена портит совпадающие названия, id заданий
// и даже sync-ID других сущностей. Перед изменением обнаруживаем столкновения ключей.
function prepareReferenceRename(prevId, nextId) {
  const conflict = () => {
    throw new Error('Ссылки персонажа неоднозначны');
  };
  const rows = value => {
    if (value == null) return value;
    if (!Array.isArray(value)) return conflict();
    return value;
  };
  const replaceList = value => {
    const list = rows(value);
    if (list == null) return list;
    if (list.includes(prevId) && list.includes(nextId)) return conflict();
    return list.map(id => (id === prevId ? nextId : id));
  };
  const replaceKey = value => {
    if (value == null) return value;
    if (typeof value !== 'object' || Array.isArray(value)) return conflict();
    if (Object.hasOwn(value, prevId) && Object.hasOwn(value, nextId)) return conflict();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === prevId ? nextId : key, item]));
  };
  const renameRows = (value, key) => {
    const list = rows(value);
    return list == null
      ? list
      : list.map(row => (row && typeof row === 'object' && row[key] === prevId ? { ...row, [key]: nextId } : row));
  };
  const marathon = value => {
    const next = { ...value };
    if (Object.hasOwn(value, 'participantIds')) next.participantIds = replaceList(value.participantIds);
    if (Object.hasOwn(value, 'assignments')) next.assignments = replaceKey(value.assignments);
    if (Object.hasOwn(value, 'progress')) next.progress = replaceKey(value.progress);
    if (value.balance && typeof value.balance === 'object') {
      next.balance = { ...value.balance };
      for (const key of ['start', 'end'])
        if (Object.hasOwn(value.balance, key)) next.balance[key] = replaceKey(value.balance[key]);
    }
    if (Object.hasOwn(value, 'awards')) next.awards = renameRows(value.awards, 'characterId');
    if (value.lastSync && typeof value.lastSync === 'object') {
      next.lastSync = { ...value.lastSync };
      for (const key of ['changes', 'errors'])
        if (Object.hasOwn(value.lastSync, key)) next.lastSync[key] = renameRows(value.lastSync[key], 'charId');
    }
    return next;
  };
  const marathons = rows(state.marathons).map(marathon);
  const archivedParties = rows(state.archivedParties).map(party => {
    if (!Object.hasOwn(party, 'memberLinks')) return party;
    const links = rows(party.memberLinks);
    if (links?.some(row => row?.characterId === prevId) && links.some(row => row?.characterId === nextId))
      return conflict();
    return { ...party, memberLinks: renameRows(links, 'characterId') };
  });
  const ui = state.ui;
  const authCheck = replaceKey(ui.authCheck);
  const revealedContacts = replaceKey(ui.revealedContacts);
  const selection = new Set(ui.selection || []);
  if (selection.has(prevId)) {
    selection.delete(prevId);
    selection.add(nextId);
  }
  return {
    marathons,
    archivedParties,
    authCheck,
    revealedContacts,
    selection,
    expandedCharacterId: ui.expandedCharacterId === prevId ? nextId : ui.expandedCharacterId
  };
}

function applyReferenceRename(references) {
  state.marathons = references.marathons;
  state.archivedParties = references.archivedParties;
  state.ui.authCheck = references.authCheck;
  state.ui.revealedContacts = references.revealedContacts;
  state.ui.selection = references.selection;
  state.ui.expandedCharacterId = references.expandedCharacterId;
}

/** Заменяет только ссылки на персонажа; при неоднозначности не изменяет состояние. */
export function renameCharacterReferences(prevId, nextId) {
  if (prevId === nextId) return;
  applyReferenceRename(prepareReferenceRename(prevId, nextId));
}
