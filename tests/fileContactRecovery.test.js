import { beforeEach, expect, it, vi } from 'vitest';
import { createFileContactRecovery } from '../js/settings/fileContactRecovery.js';
import { __setInvoke, contactsJson, hydrateSecrets, vaultStatus } from '../js/core/secrets.js';
import { state } from '../js/core/state.js';

let raw, disk, records, review, invoke, backups, original;
beforeEach(() => {
  raw = {
    characters: [
      { id: 'a', contacts: { email: 'file@test', password: 'FILE_PRIVATE' } },
      { id: 'b', contacts: null }
    ],
    archivedCharacters: [],
    settings: { security: { useVault: true } },
    secretsInVault: true,
    queue: ['keep']
  };
  original = JSON.stringify(raw);
  disk = original;
  records = {
    a: contactsJson({ email: 'windows@test', password: 'WINDOWS_PRIVATE' }),
    b: contactsJson({ phone: 'keep' })
  };
  review = {
    conflicts: [{ id: 'a', source: 'a', file: contactsJson(raw.characters[0].contacts), windows: records.a }],
    keys: ['a', 'b'],
    records: { ...records }
  };
  backups = [];
  invoke = vi.fn(async (cmd, args) => {
    if (cmd === 'load_state_raw') return disk;
    if (cmd === 'secrets_available') return true;
    if (cmd === 'secrets_get_many')
      return Object.fromEntries(args.keys.filter(k => Object.hasOwn(records, k)).map(k => [k, records[k]]));
    if (cmd === 'create_migration_backup') {
      if (disk !== args.expectedRaw) throw new Error('PRIVATE_CHANGED');
      backups.push(disk);
      return 'state.backup-pre-contacts-file-choice-123.json';
    }
    if (cmd === 'secrets_set_many') {
      Object.entries(args.items).forEach(([key, value]) => {
        if (value) records[key] = value;
        else delete records[key];
      });
      return null;
    }
    if (cmd === 'save_state_if_unchanged') {
      if (disk !== args.expectedRaw) throw new Error('PRIVATE_CHANGED');
      disk = JSON.stringify(args.payload);
      return null;
    }
    throw new Error('unexpected command');
  });
});

it('preserves both sources, keeps protected storage and reloads without the conflict', async () => {
  const recover = createFileContactRecovery({ raw, review });
  expect(invoke).not.toHaveBeenCalled();
  const oldWindows = records.a;
  const result = await recover(invoke);
  expect(backups).toEqual([original]);
  const manifest = JSON.parse(records[`${result.vaultBackupId}-manifest`]);
  expect(records[manifest.sources.a]).toBe(oldWindows);
  expect(records.a).toBe(review.conflicts[0].file);
  expect(JSON.parse(disk)).toEqual({
    ...raw,
    characters: [{ ...raw.characters[0], contacts: null }, raw.characters[1]]
  });
  state.settings.security = { useVault: true };
  __setInvoke(invoke);
  const chars = JSON.parse(disk).characters;
  expect((await hydrateSecrets(chars, { requiresVault: true })).blocked).not.toBe(true);
  expect(chars[0].contacts.password).toBe('FILE_PRIVATE');
  expect(chars[1].contacts.phone).toBe('keep');
  expect(vaultStatus().ready).toBe(true);
  const count = invoke.mock.calls.length;
  await expect(recover(invoke)).rejects.toThrow('Сохранение остаётся остановленным');
  expect(invoke).toHaveBeenCalledTimes(count);
});

it('handles intentionally empty contacts without resurrecting old Windows fields', async () => {
  raw.characters[0].contacts = {};
  disk = JSON.stringify(raw);
  review.conflicts[0].file = '';
  const old = records.a;
  const result = await createFileContactRecovery({ raw, review })(invoke);
  expect(records.a).toBeUndefined();
  const manifest = JSON.parse(records[`${result.vaultBackupId}-manifest`]);
  expect(records[manifest.sources.a]).toBe(old);
});

it('updates and preserves both old/new vault keys during an ID migration, including archived characters', async () => {
  raw.archivedCharacters = [raw.characters.shift()];
  raw.archivedCharacters[0].id = 'old';
  disk = JSON.stringify(raw);
  records.old = records.a;
  review.keys.push('old');
  review.records.old = records.old;
  const result = await createFileContactRecovery({ raw, aliases: { a: 'old' }, review })(invoke);
  expect(records.old).toBe(records.a);
  expect(records.a).toBe(review.conflicts[0].file);
  expect(JSON.parse(disk).archivedCharacters[0].contacts).toBeNull();
  const manifest = JSON.parse(records[`${result.vaultBackupId}-manifest`]);
  expect(Object.keys(manifest.sources).sort()).toEqual(['a', 'old']);
});

it.each([
  'file-before',
  'vault-before',
  'file-during-backup',
  'vault-during-backup',
  'backup-failure',
  'backup-readback',
  'backup-lost-reply'
])('does not replace original vault records when safety checks fail: %s', async mode => {
  const old = records.a;
  const recover = createFileContactRecovery({ raw, review });
  const wrapped = vi.fn(async (cmd, args) => {
    if (cmd === 'load_state_raw' && mode === 'file-before') return '{"changed":true}';
    if (cmd === 'secrets_get_many' && mode === 'vault-before' && args.keys.includes('a'))
      return { ...review.records, a: 'PRIVATE_CHANGED' };
    if (cmd === 'create_migration_backup' && mode === 'backup-failure') throw new Error('PRIVATE_ERROR');
    const value = await invoke(cmd, args);
    if (cmd === 'create_migration_backup') {
      if (mode === 'file-during-backup') disk = '{"new":true}';
      if (mode === 'vault-during-backup') records.b = 'PRIVATE_NEW';
    }
    if (cmd === 'secrets_set_many' && Object.keys(args.items).every(k => k.startsWith('recovery-'))) {
      if (mode === 'backup-readback') records[Object.keys(args.items)[0]] = 'PRIVATE_BAD_COPY';
      if (mode === 'backup-lost-reply') throw new Error('PRIVATE_LOST_REPLY');
    }
    return value;
  });
  await expect(recover(wrapped)).rejects.toThrow('Сохранение остаётся остановленным');
  expect(records.a).toBe(old);
  expect(wrapped.mock.calls.some(([cmd]) => cmd === 'save_state_if_unchanged')).toBe(false);
  const count = wrapped.mock.calls.length;
  await expect(recover(wrapped)).rejects.toThrow();
  expect(wrapped).toHaveBeenCalledTimes(count);
});

it.each(['replacement-lost-reply', 'state-lost-reply', 'bad-reply', 'post-readback'])(
  'preserves the original file and protected Windows copy on uncertain replacement: %s',
  async mode => {
    const old = records.a;
    const recover = createFileContactRecovery({ raw, review });
    const wrapped = vi.fn(async (cmd, args) => {
      const value = await invoke(cmd, args);
      if (cmd === 'secrets_set_many' && Object.hasOwn(args.items, 'a')) {
        if (mode === 'replacement-lost-reply') throw new Error('PRIVATE_LOST_REPLY');
        if (mode === 'bad-reply') return false;
        if (mode === 'post-readback') records.a = 'PRIVATE_BAD_WRITE';
      }
      if (cmd === 'save_state_if_unchanged' && mode === 'state-lost-reply') throw new Error('PRIVATE_LOST_REPLY');
      return value;
    });
    await expect(recover(wrapped)).rejects.toThrow('Сохранение остаётся остановленным');
    expect(backups).toEqual([original]);
    expect(Object.entries(records).some(([k, v]) => k.startsWith('recovery-') && v === old)).toBe(true);
    const count = wrapped.mock.calls.length;
    await expect(recover(wrapped)).rejects.toThrow();
    expect(wrapped).toHaveBeenCalledTimes(count);
  }
);

it('rejects missing/ambiguous characters and stale local plans without IPC', () => {
  raw.characters.push({ ...raw.characters[0] });
  expect(createFileContactRecovery({ raw, review })).toBeNull();
  raw.characters.pop();
  review.conflicts[0].file = contactsJson({ password: 'not the file' });
  expect(createFileContactRecovery({ raw, review })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
it('keeps a safe manifest even for a contact ID matching an Object prototype property', async () => {
  const value = records.a;
  delete records.a;
  Object.defineProperty(records, '__proto__', { value, enumerable: true, writable: true, configurable: true });
  raw.characters[0].id = '__proto__';
  disk = JSON.stringify(raw);
  review.keys = ['__proto__', 'b'];
  review.records = JSON.parse(JSON.stringify(records));
  review.conflicts[0].id = '__proto__';
  review.conflicts[0].source = '__proto__';
  const result = await createFileContactRecovery({ raw, review })(invoke);
  const manifest = JSON.parse(records[`${result.vaultBackupId}-manifest`]);
  expect(Object.hasOwn(manifest.sources, '__proto__')).toBe(true);
  expect(records[manifest.sources.__proto__]).toBe(value);
});
