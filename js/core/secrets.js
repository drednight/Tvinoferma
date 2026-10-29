// @ts-check
// Учётные данные персонажей хранятся в хранилище ОС через Rust-команды secrets_*.
// При недоступном vault для старых данных без ссылки на него остаётся прежний
// fallback в state.json. Если файл указывает на vault, такой fallback небезопасен.
// Проверки ниже не создают резервную копию vault и не являются транзакцией между
// state.json и хранилищем ОС: другие процессы пока не используют общую блокировку.

import { state } from './state.js';
import { markVaultUpdated, vaultWriteGuardError } from './vaultWriteGuard.js';

export const CONTACT_FIELDS = ['email', 'password', 'recoveryEmail', 'phone'];
const MAX_CONTACT_JSON = 1024 * 1024;
const UNAVAILABLE = 'Хранилище учётных данных ОС недоступно';
const DAMAGED = 'Запись учётных данных повреждена или имеет неподдерживаемый формат';
const CONFLICT = 'Открытые контакты и данные хранилища ОС различаются';
const UNSAFE_WRITE = 'Хранилище учётных данных изменилось или результат его записи не подтверждён';

const vault = {
  ready: false,
  checked: false,
  blocked: false, // остановка до перезапуска в этом JS-контексте, не устойчивый карантин
  error: null,
  // charId -> точная строка и её нормализованное содержимое; не выводить в журнал.
  known: new Map()
};

let invokeImpl = null;
async function invoke(cmd, args) {
  if (!invokeImpl) invokeImpl = (await import('@tauri-apps/api/core')).invoke;
  return invokeImpl(cmd, args);
}

/** Для тестов: подменить транспорт к Rust. */
export function __setInvoke(fn) {
  invokeImpl = fn;
  vault.ready = false;
  vault.checked = false;
  vault.blocked = false;
  vault.known.clear();
  vault.error = null;
}

export function vaultStatus() {
  return {
    ready: vault.ready,
    checked: vault.checked,
    blocked: vault.blocked,
    error: vault.error,
    count: vault.known.size
  };
}

export function contactsJson(contacts = {}) {
  const clean = {};
  CONTACT_FIELDS.forEach(f => {
    clean[f] = String(contacts?.[f] || '');
  });
  return CONTACT_FIELDS.some(f => clean[f]) ? JSON.stringify(clean) : '';
}

function useVault() {
  return state.settings?.security?.useVault !== false;
}

class VaultDataError extends Error {
  constructor() {
    super(DAMAGED);
  }
}

class VaultConflictError extends VaultDataError {
  constructor() {
    super();
    this.message = CONFLICT;
  }
}

function invalidData() {
  return new VaultDataError();
}

// Формат записи vault — плоский JSON-объект со строковыми известными полями.
// JSON.parse молча отбрасывает повторные имена; отдельный проход отклоняет и
// экранированные повторы. Форматирование, порядок и отсутствующие поля допустимы.
function parseStoredContacts(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CONTACT_JSON) throw invalidData();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidData();
    if (Object.keys(parsed).some(key => !CONTACT_FIELDS.includes(key) || typeof parsed[key] !== 'string')) {
      throw invalidData();
    }
    let index = 0;
    const whitespace = () => {
      while (index < raw.length && ' \t\r\n'.includes(raw[index])) index++;
    };
    const stringToken = () => {
      if (raw[index] !== '"') throw invalidData();
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index++] === '"') return JSON.parse(raw.slice(start, index));
      }
      throw invalidData();
    };
    whitespace();
    if (raw[index++] !== '{') throw invalidData();
    whitespace();
    const seen = new Set();
    if (raw[index] !== '}') {
      while (true) {
        const key = stringToken();
        if (!CONTACT_FIELDS.includes(key) || seen.has(key)) throw invalidData();
        seen.add(key);
        whitespace();
        if (raw[index++] !== ':') throw invalidData();
        whitespace();
        stringToken();
        whitespace();
        if (raw[index] !== ',') break;
        index++;
        whitespace();
      }
    }
    if (raw[index++] !== '}') throw invalidData();
    whitespace();
    if (index !== raw.length) throw invalidData();
    return parsed;
  } catch {
    throw invalidData();
  }
}

// IPC должен вернуть только запрошенные ключи и строковые значения. Отсутствие
// ключа и пустая строка — разные случаи: пустая/повреждённая запись не считается
// намеренным удалением. Значения не включаются в ошибки.
function readRecords(response, requested) {
  try {
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw invalidData();
    const prototype = Object.getPrototypeOf(response);
    if (prototype !== Object.prototype && prototype !== null) throw invalidData();
    const descriptors = Object.getOwnPropertyDescriptors(response);
    const result = new Map();
    for (const key of Reflect.ownKeys(response)) {
      if (typeof key !== 'string') throw invalidData();
      const descriptor = descriptors[key];
      if (
        !requested.has(key) ||
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length > MAX_CONTACT_JSON
      ) {
        throw invalidData();
      }
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    throw invalidData();
  }
}

function blockVault(message) {
  vault.ready = false;
  vault.blocked = true;
  vault.error = message;
}

/** Не позволяет обойти обнаруженную небезопасную ссылку на vault отключением настройки. */
export function blockUnsafeVaultRead() {
  vault.checked = true;
  if (!vault.blocked) blockVault(DAMAGED);
}

/**
 * Загружает контакты только после проверки ВСЕХ полученных записей. Повреждённую
 * запись, конфликт старого и нового ключа или отсутствие доступного обязательного
 * vault нельзя превращать в пустые контакты с последующей перезаписью.
 * requiresVault берётся из исходного файла ДО нормализации, которая отбрасывает метаданные.
 */
export async function hydrateSecrets(
  characters,
  { tauri = true, aliases = {}, requiresVault = false, plaintextIds = new Set() } = {}
) {
  vault.checked = true;
  if (vault.blocked) return { migrated: 0, error: vault.error, blocked: true };
  // Даже при выключенной настройке нужно прочитать vault, если файл ссылается
  // на него: иначе следующее сохранение запишет вместо контактов пустые значения.
  if (!tauri || (!useVault() && !requiresVault)) {
    vault.ready = false;
    if (requiresVault) {
      blockVault(UNAVAILABLE);
      return { migrated: 0, error: vault.error, blocked: true };
    }
    return { migrated: 0 };
  }
  try {
    const available = await invoke('secrets_available');
    if (available !== true) throw new Error(UNAVAILABLE);
    if (!Array.isArray(characters) || !(plaintextIds instanceof Set)) throw invalidData();
    const ids = new Set();
    const owners = new Map();
    const oldOwners = new Map();
    for (let index = 0; index < characters.length; index++) {
      const character = characters[index];
      if (!character || typeof character.id !== 'string' || !character.id.trim()) throw invalidData();
      const key = character.id.toLowerCase();
      if (owners.has(key)) throw invalidData();
      owners.set(key, index);
      ids.add(character.id);
    }
    const oldIds = new Map();
    const keys = new Set(ids);
    for (let index = 0; index < characters.length; index++) {
      const character = characters[index];
      const old = aliases && Object.hasOwn(aliases, character.id) ? aliases[character.id] : undefined;
      if (old !== undefined && (typeof old !== 'string' || !old.trim())) throw invalidData();
      if (old) {
        const key = old.toLowerCase();
        if (old !== character.id && key === character.id.toLowerCase()) throw invalidData();
        if ((owners.has(key) && owners.get(key) !== index) || (oldOwners.has(key) && oldOwners.get(key) !== index)) {
          throw invalidData();
        }
        oldOwners.set(key, index);
        oldIds.set(character.id, old);
        keys.add(old);
      }
    }
    const records = readRecords(await invoke('secrets_get_many', { keys: [...keys] }), keys);
    const parsed = new Map();
    for (const [id, raw] of records) parsed.set(id, parseStoredContacts(raw));

    // Формируем весь план до изменения персонажей или vault.known.
    const known = new Map();
    const usedSources = new Set();
    const updates = [];
    let migrated = 0;
    for (const character of characters) {
      const old = oldIds.get(character.id);
      const hasCurrent = records.has(character.id);
      const hasOld = !!old && old !== character.id && records.has(old);
      if (hasCurrent && hasOld && contactsJson(parsed.get(character.id)) !== contactsJson(parsed.get(old))) {
        throw invalidData();
      }
      const source = hasCurrent ? character.id : hasOld ? old : null;
      if (source) {
        if (usedSources.has(source)) throw invalidData();
        // Открытый state мог измениться, пока vault был выключен. Нельзя молча
        // заменить новые значения (включая намеренно пустые) старой записью ОС.
        const local = contactsJson(character.contacts);
        const stored = contactsJson(parsed.get(source));
        if ((plaintextIds.has(character.id) || local) && local !== stored) throw new VaultConflictError();
        usedSources.add(source);
        known.set(source, { raw: records.get(source), normalized: stored });
        updates.push([character, { ...character.contacts, ...parsed.get(source) }]);
        if (source !== character.id) migrated++;
      } else if (contactsJson(character.contacts)) {
        migrated++;
      }
    }
    for (const [character, contacts] of updates) character.contacts = contacts;
    vault.known = known;
    vault.ready = true;
    vault.error = null;
    return { migrated };
  } catch (error) {
    vault.ready = false;
    vault.known.clear();
    vault.error =
      error instanceof VaultConflictError ? CONFLICT : error instanceof VaultDataError ? DAMAGED : UNAVAILABLE;
    if (error instanceof VaultDataError || requiresVault) vault.blocked = true;
    // Сообщение ОС/JSON может содержать путь, идентификатор или фрагмент секрета.
    console.warn('[SECRETS] Не удалось безопасно прочитать хранилище ОС.');
    return {
      migrated: 0,
      error: vault.error,
      ...(vault.blocked ? { blocked: true } : {}),
      ...(error instanceof VaultConflictError ? { conflict: true } : {})
    };
  }
}

/**
 * Готовит снимок к записи: до изменений сверяет затронутые записи vault с тем,
 * что было прочитано, а после изменений перечитывает точные значения. Ошибка
 * записи или проверки может означать частичный успех, поэтому повтор в этом
 * контексте запрещён. Проверка не является межпроцессным CAS или fsync.
 */
export async function prepareForDisk(snapshot) {
  if (vault.blocked) throw vaultWriteGuardError();
  if (!vault.ready || !useVault()) return snapshot;
  if (
    !snapshot ||
    !Array.isArray(snapshot.characters) ||
    (snapshot.archivedCharacters != null && !Array.isArray(snapshot.archivedCharacters))
  ) {
    blockVault(DAMAGED);
    throw vaultWriteGuardError();
  }
  const characters = [...snapshot.characters, ...(snapshot.archivedCharacters || [])];
  const toSet = Object.create(null);
  const ids = new Set();
  const idKeys = new Set();
  const knownKeys = new Map([...vault.known.keys()].map(id => [id.toLowerCase(), id]));
  try {
    for (const character of characters) {
      if (!character || typeof character.id !== 'string' || !character.id.trim()) throw invalidData();
      const key = character.id.toLowerCase();
      if (idKeys.has(key) || (knownKeys.has(key) && knownKeys.get(key) !== character.id)) throw invalidData();
      idKeys.add(key);
      ids.add(character.id);
      const json = contactsJson(character.contacts);
      if ((vault.known.get(character.id)?.normalized || '') !== json) toSet[character.id] = json;
    }
  } catch {
    blockVault(DAMAGED);
    throw vaultWriteGuardError();
  }
  const toDelete = [...vault.known.keys()].filter(id => !ids.has(id));
  const changedIds = [...new Set([...Object.keys(toSet), ...toDelete])];
  // Снимок фиксируется до первого await, не добавляя в файл служебное свидетельство.
  const prepared = {
    ...snapshot,
    secretsInVault: true,
    characters: snapshot.characters.map(c => ({ ...c, contacts: null })),
    archivedCharacters: (snapshot.archivedCharacters || []).map(c => ({ ...c, contacts: null }))
  };
  if (changedIds.length) {
    try {
      const requested = new Set(changedIds);
      const before = readRecords(await invoke('secrets_get_many', { keys: changedIds }), requested);
      for (const id of changedIds) {
        const expected = vault.known.get(id)?.raw ?? null;
        if ((before.has(id) ? before.get(id) : null) !== expected) throw invalidData();
      }
      if (Object.keys(toSet).length) {
        const reply = await invoke('secrets_set_many', { items: toSet });
        if (reply !== null && reply !== undefined) throw invalidData();
      }
      if (toDelete.length) {
        const reply = await invoke('secrets_delete_many', { keys: toDelete });
        if (reply !== null && reply !== undefined) throw invalidData();
      }
      const after = readRecords(await invoke('secrets_get_many', { keys: changedIds }), requested);
      for (const id of changedIds) {
        const expected = Object.hasOwn(toSet, id) && toSet[id] ? toSet[id] : null;
        if ((after.has(id) ? after.get(id) : null) !== expected) throw invalidData();
      }
    } catch {
      blockVault(UNSAFE_WRITE);
      throw vaultWriteGuardError();
    }
    for (const [id, json] of Object.entries(toSet)) {
      if (json) vault.known.set(id, { raw: json, normalized: json });
      else vault.known.delete(id);
    }
    toDelete.forEach(id => vault.known.delete(id));
    markVaultUpdated(prepared);
  }
  return prepared;
}
