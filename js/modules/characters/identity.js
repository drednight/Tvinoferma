// js/modules/characters/identity.js
// id персонажа = читаемый слаг ника (core/ids.js). При смене ника id тоже меняется:
// переименовываются ссылки в марафонах, профиль браузера (вход на сайт сохраняется)
// и ключ в хранилище ОС (переезжает при следующем сохранении).

import { state } from '../../core/state.js';
import { characterIdFor, remapIdsDeep } from '../../core/ids.js';
import { isTauri } from '../../core/storage.js';

/** id для нового персонажа. */
export function newCharacterId(nick) {
  return characterIdFor(nick, state.characters.map(c => c.id));
}

/**
 * Приводит id персонажа к его нику. Возвращает { id, changed, error }.
 * Если профиль браузера перенести нельзя (окно не закрылось), id остаётся прежним.
 */
export async function syncIdWithNick(char) {
  const prevId = char.id;
  const nextId = characterIdFor(char.nick, state.characters.map(c => c.id), prevId);
  if (!prevId || nextId === prevId) return { id: prevId, changed: false };

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_sync_window', { charId: prevId }).catch(() => {});
      await new Promise(r => setTimeout(r, 400)); // WebView2 отпускает файлы профиля не мгновенно
      const failed = await invoke('rename_char_profiles', { remap: { [prevId]: nextId } });
      if (failed?.length) return { id: prevId, changed: false, error: 'profile_busy' };
    } catch (e) {
      return { id: prevId, changed: false, error: String(e?.message || e) };
    }
  }

  renameCharacterReferences(prevId, nextId);
  char.id = nextId;
  return { id: nextId, changed: true };
}

/** Заменяет старый id на новый во всех данных приложения (кроме самого персонажа). */
export function renameCharacterReferences(prevId, nextId) {
  const remap = new Map([[prevId, nextId]]);
  state.marathons = remapIdsDeep(state.marathons, remap);
  state.marathonTemplates = remapIdsDeep(state.marathonTemplates || [], remap);
  const ui = state.ui;
  ['authCheck', 'revealedContacts'].forEach(key => {
    if (ui[key] && prevId in ui[key]) { ui[key][nextId] = ui[key][prevId]; delete ui[key][prevId]; }
  });
  if (ui.expandedCharacterId === prevId) ui.expandedCharacterId = nextId;
  if (ui.selection?.has(prevId)) { ui.selection.delete(prevId); ui.selection.add(nextId); }
}
