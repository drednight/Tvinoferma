// @ts-check
// Проверяет соответствие ID до/после миграции и нормализации до чтения vault.
// Нормализация может молча назначить новый ID, а v4 — построить цепочку замен.
// В обоих случаях нельзя однозначно определить, к кому относится запись ОС.

const CONTACT_FIELDS = new Set(['email', 'password', 'recoveryEmail', 'phone']);

export function hasSafeVaultCharacterMapping(raw, migration, normalized) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.secretsInVault === true && !Array.isArray(raw.characters)) return false;
  const active = raw.characters === undefined ? [] : raw.characters;
  const archived = raw.archivedCharacters === undefined ? [] : raw.archivedCharacters;
  if (!Array.isArray(active) || !Array.isArray(archived)) return false;
  if (!Array.isArray(normalized?.characters) || !Array.isArray(normalized?.archivedCharacters)) return false;
  if (active.length !== normalized.characters.length || archived.length !== normalized.archivedCharacters.length)
    return false;
  const remap = migration?.idRemap;
  if (!remap || typeof remap !== 'object' || Array.isArray(remap)) return false;

  const oldOwners = new Map();
  const newOwners = new Set();
  const originals = [...active, ...archived];
  for (let index = 0; index < originals.length; index++) {
    const char = originals[index];
    if (!char || typeof char !== 'object' || Array.isArray(char) || typeof char.id !== 'string' || !char.id.trim())
      return false;
    if (char.contacts != null) {
      if (typeof char.contacts !== 'object' || Array.isArray(char.contacts)) return false;
      if (Object.entries(char.contacts).some(([key, value]) => !CONTACT_FIELDS.has(key) || typeof value !== 'string')) {
        return false;
      }
    }
    const oldKey = char.id.toLowerCase();
    if (oldOwners.has(oldKey)) return false;
    oldOwners.set(oldKey, index);
  }
  // Не допускаем потерянный или посторонний ключ карты миграции.
  const activeIds = new Set(active.map(char => char.id));
  if (Object.keys(remap).some(id => !activeIds.has(id))) return false;

  for (let index = 0; index < originals.length; index++) {
    const oldId = originals[index].id;
    const isActive = index < active.length;
    const newId = isActive && Object.hasOwn(remap, oldId) ? remap[oldId] : oldId;
    if (typeof newId !== 'string' || !newId.trim()) return false;
    const newKey = newId.toLowerCase();
    // Хранилища ОС могут считать регистр несущественным: удаление старого
    // ключа после записи нового в таком случае могло бы удалить обе записи.
    if (newId !== oldId && newKey === oldId.toLowerCase()) return false;
    if (newOwners.has(newKey)) return false;
    newOwners.add(newKey);
    // Цепочка A→B или перестановка A↔B смешивает старые и новые записи vault.
    if (oldOwners.has(newKey) && oldOwners.get(newKey) !== index) return false;
    const result = isActive ? normalized.characters[index] : normalized.archivedCharacters[index - active.length];
    if (!result || result.id !== newId) return false;
  }
  return true;
}
