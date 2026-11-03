// Explicit file-source recovery. Never guess the newer source or discard Windows contacts.
// A verified file backup AND separate verified OS-vault copies precede any replacement.
// Rechecks fail closed; the user must close other instances (IPC calls are not one transaction).
import { CONTACT_FIELDS, contactsJson } from '../core/secrets.js';

const STOP =
  'Выбор не подтверждён. Сохранение остаётся остановленным. Не повторяйте запись автоматически: перезапустите приложение и сравните источники. Созданные резервные копии не удалялись.';

export function createFileContactRecovery({ raw, aliases = {}, review }) {
  if (!raw || !review?.conflicts?.length || !Array.isArray(review.keys) || !review.records) return null;
  const original = JSON.stringify(raw);
  const pinned = structuredClone(review);
  const payload = JSON.parse(original);
  const characters = [...(payload.characters || []), ...(payload.archivedCharacters || [])];
  const writes = Object.create(null);
  const sources = new Set();
  try {
    for (const conflict of pinned.conflicts) {
      const id = Object.hasOwn(aliases, conflict.id) ? aliases[conflict.id] : conflict.id;
      const matches = characters.filter(c => c.id === id);
      if (
        matches.length !== 1 ||
        sources.has(conflict.source) ||
        !pinned.keys.includes(conflict.source) ||
        !Object.hasOwn(pinned.records, conflict.source)
      )
        return null;
      const local = JSON.parse(conflict.file || '{}');
      if (
        !local ||
        Array.isArray(local) ||
        Object.keys(local).some(k => !CONTACT_FIELDS.includes(k) || typeof local[k] !== 'string') ||
        contactsJson(matches[0].contacts) !== contactsJson(local)
      )
        return null;
      // During an ID migration both the old and new keys can exist. Keep them
      // identical, otherwise the next safe hydration would reject the alias pair.
      for (const key of new Set([conflict.source, conflict.id, aliases[conflict.id]])) {
        if (typeof key === 'string' && Object.hasOwn(pinned.records, key)) {
          sources.add(key);
          writes[key] = contactsJson(local);
        }
      }
      matches[0].contacts = null;
    }
  } catch {
    return null;
  }
  payload.secretsInVault = true;
  payload.settings ??= {};
  payload.settings.security ??= {};
  payload.settings.security.useVault = true;
  let attempted = false;
  const sameRecords = (actual, expected) =>
    actual &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(actual).every(key => Object.hasOwn(expected, key) && actual[key] === expected[key]);
  return async invoke => {
    if (attempted) throw new Error(STOP);
    attempted = true;
    try {
      const expectedRaw = await invoke('load_state_raw');
      const verifyFile = async () => {
        const current = await invoke('load_state_raw');
        if (typeof current !== 'string' || current !== expectedRaw) throw new Error(STOP);
      };
      if (typeof expectedRaw !== 'string' || JSON.stringify(JSON.parse(expectedRaw)) !== original)
        throw new Error(STOP);
      const verifyVault = async expected => {
        if (!sameRecords(await invoke('secrets_get_many', { keys: pinned.keys }), expected)) throw new Error(STOP);
      };
      await verifyVault(pinned.records);
      const backup = await invoke('create_migration_backup', { expectedRaw, label: 'pre-contacts-file-choice' });
      if (typeof backup !== 'string' || backup.length > 200 || !/^state\.backup-[a-z0-9-]+\.json$/i.test(backup))
        throw new Error(STOP);
      await verifyFile();
      await verifyVault(pinned.records);

      // Preserve the old Windows source under NEW random vault keys, not in plaintext files.
      const vaultBackupId = `recovery-${crypto.randomUUID()}`;
      const protectedCopies = Object.create(null);
      const manifest = Object.create(null);
      [...sources].forEach((source, index) => {
        const key = `${vaultBackupId}-${index}`;
        protectedCopies[key] = pinned.records[source];
        manifest[source] = key;
      });
      protectedCopies[`${vaultBackupId}-manifest`] = JSON.stringify({ version: 1, sources: manifest });
      const keys = Object.keys(protectedCopies);
      if (!sameRecords(await invoke('secrets_get_many', { keys }), {})) throw new Error(STOP);
      if ((await invoke('secrets_set_many', { items: protectedCopies })) != null) throw new Error(STOP);
      if (!sameRecords(await invoke('secrets_get_many', { keys }), protectedCopies)) throw new Error(STOP);
      await verifyFile();
      await verifyVault(pinned.records);
      if ((await invoke('secrets_set_many', { items: writes })) != null) throw new Error(STOP);
      const expected = { ...pinned.records };
      Object.entries(writes).forEach(([key, value]) => {
        if (value) expected[key] = value;
        else delete expected[key];
      });
      await verifyVault(expected);
      await verifyFile();
      if ((await invoke('save_state_if_unchanged', { expectedRaw, payload })) != null) throw new Error(STOP);
      await verifyVault(expected);
      return { backup, vaultBackupId };
    } catch {
      // Do not expose native messages/paths/secrets or retry a possibly successful write.
      throw new Error(STOP);
    }
  };
}
