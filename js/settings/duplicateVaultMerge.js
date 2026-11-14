// A state backup and separately protected contact copies precede any destructive
// vault operation. Checks are not a cross-process transaction: close other copies.
import { invoke } from '@tauri-apps/api/core';
import { backupDuplicateContacts } from '../core/secrets.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
}

export async function prepareDuplicateVaultMerge(snapshot, ids, token, unchanged) {
  const stop = () => new Error('Исходные данные или защищённая копия не подтверждены');
  try {
    if (!/^[0-9a-f]{24}$/.test(token) || typeof unchanged !== 'function') throw stop();
    const raw = await invoke('load_state_raw');
    if (typeof raw !== 'string' || !unchanged()) throw stop();
    const disk = JSON.parse(raw);
    const expected = structuredClone(snapshot);
    expected.secretsInVault = true;
    expected.characters = expected.characters.map(c => ({ ...c, contacts: null }));
    expected.archivedCharacters = expected.archivedCharacters.map(c => ({ ...c, contacts: null }));
    // savedAt is set when saveNow builds its own snapshot, not in live memory.
    expected.savedAt = disk.savedAt;
    if (JSON.stringify(canonical(disk)) !== JSON.stringify(canonical(expected))) throw stop();
    const name = await invoke('create_migration_backup', { expectedRaw: raw, label: `dup-${token}` });
    if (
      typeof name !== 'string' ||
      !new RegExp(`^state\\.backup-[0-9]+-dup-${token}-[0-9]+-[0-9]+\\.json$`).test(name) ||
      !unchanged()
    )
      throw stop();
    await backupDuplicateContacts(snapshot, ids, token);
    if (!unchanged() || (await invoke('load_state_raw')) !== raw || !unchanged()) throw stop();
    return { raw, name };
  } catch {
    throw stop();
  }
}
