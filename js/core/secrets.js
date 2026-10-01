// js/core/secrets.js
// Учётные данные персонажей (email, пароль, recovery, телефон) хранятся в хранилище ОС
// (Windows Credential Manager / macOS Keychain / Secret Service) через Rust-команды secrets_*.
// В state.json контакты не пишутся. В памяти приложения они есть, как и раньше,
// поэтому интерфейс, помощник входа и экспорт работают без изменений.
//
// Если хранилище ОС недоступно (браузерный dev-режим, нет Secret Service), контакты
// остаются в state.json, как раньше, а в настройках показывается предупреждение.

import { state } from './state.js';

export const CONTACT_FIELDS = ['email', 'password', 'recoveryEmail', 'phone'];

const vault = {
  ready: false,        // хранилище доступно и прочитано
  checked: false,
  error: null,
  known: new Map()     // charId -> JSON, который сейчас лежит в хранилище ОС
};

let invokeImpl = null;
async function invoke(cmd, args) {
  if (!invokeImpl) invokeImpl = (await import('@tauri-apps/api/core')).invoke;
  return invokeImpl(cmd, args);
}

/** Для тестов: подменить транспорт к Rust. */
export function __setInvoke(fn) { invokeImpl = fn; vault.ready = false; vault.checked = false; vault.known.clear(); vault.error = null; }

export function vaultStatus() {
  return { ready: vault.ready, checked: vault.checked, error: vault.error, count: vault.known.size };
}

export function contactsJson(contacts = {}) {
  const clean = {};
  CONTACT_FIELDS.forEach(f => { clean[f] = String(contacts?.[f] || ''); });
  return CONTACT_FIELDS.some(f => clean[f]) ? JSON.stringify(clean) : '';
}

function useVault() {
  return state.settings?.security?.useVault !== false;
}

/**
 * Загружает контакты из хранилища ОС в персонажей.
 * Значение из хранилища главнее значения из файла; контакты, оставшиеся в файле
 * (старые версии), перенесутся в хранилище при следующем сохранении.
 */
export async function hydrateSecrets(characters, { tauri = true, aliases = {} } = {}) {
  vault.checked = true;
  if (!tauri || !useVault()) { vault.ready = false; return { migrated: 0 }; }
  try {
    const available = await invoke('secrets_available');
    if (!available) throw new Error('хранилище учётных данных ОС недоступно');
    // aliases: { новый id: старый id } — после смены id запись ещё лежит под старым ключом
    const keys = [...new Set(characters.flatMap(c => [c.id, aliases[c.id]].filter(Boolean)))];
    const values = await invoke('secrets_get_many', { keys });
    let migrated = 0;
    characters.forEach(c => {
      const oldId = aliases[c.id];
      const stored = values?.[c.id] || (oldId && values?.[oldId]);
      if (stored && !values?.[c.id] && oldId) {
        // Перенос под новый ключ произойдёт при сохранении: старый ключ удалится,
        // новый запишется (prepareForDisk сравнивает с vault.known).
        vault.known.set(oldId, stored);
        try { c.contacts = { ...c.contacts, ...JSON.parse(stored) }; } catch (_) { /* битая запись */ }
        migrated++;
      } else if (stored) {
        vault.known.set(c.id, stored);
        try { c.contacts = { ...c.contacts, ...JSON.parse(stored) }; } catch (_) { /* битая запись — оставляем файл */ }
      } else if (contactsJson(c.contacts)) {
        migrated++;
      }
    });
    vault.ready = true;
    vault.error = null;
    return { migrated };
  } catch (e) {
    vault.ready = false;
    vault.error = String(e?.message || e);
    console.warn('[SECRETS] vault unavailable:', vault.error);
    return { migrated: 0, error: vault.error };
  }
}

/**
 * Готовит снимок состояния к записи на диск: синхронизирует изменившиеся контакты
 * с хранилищем ОС и убирает их из снимка. Если хранилище не готово — снимок не меняется.
 */
export async function prepareForDisk(snapshot) {
  if (!vault.ready || !useVault() || !Array.isArray(snapshot?.characters)) return snapshot;

  const toSet = {};
  const ids = new Set();
  snapshot.characters.forEach(c => {
    ids.add(c.id);
    const json = contactsJson(c.contacts);
    if ((vault.known.get(c.id) || '') !== json) toSet[c.id] = json;
  });
  const toDelete = [...vault.known.keys()].filter(id => !ids.has(id));

  if (Object.keys(toSet).length) await invoke('secrets_set_many', { items: toSet });
  if (toDelete.length) await invoke('secrets_delete_many', { keys: toDelete });
  Object.entries(toSet).forEach(([id, json]) => json ? vault.known.set(id, json) : vault.known.delete(id));
  toDelete.forEach(id => vault.known.delete(id));

  return {
    ...snapshot,
    secretsInVault: true,
    characters: snapshot.characters.map(c => ({ ...c, contacts: null }))
  };
}
