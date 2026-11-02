import { beforeEach, expect, it, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { __setInvoke, hydrateSecrets, vaultConflictReview, vaultStatus, prepareForDisk } from '../js/core/secrets.js';
import { attachVaultConflictRecovery, createWindowsContactRecovery } from '../js/settings/vaultConflictRecovery.js';

let raw, original, disk, records, backups, invoke, review;
beforeEach(async () => {
  state.settings.security = { useVault: true };
  raw = {
    schemaVersion: 10,
    characters: [
      { id: 'a', contacts: { email: 'file@example.test', password: 'PRIVATE_FILE' }, tasks: ['keep'] },
      { id: 'b', contacts: { email: 'second@example.test' } }
    ],
    archivedCharacters: [{ id: 'arch', contacts: { phone: 'keep archived' } }],
    settings: { security: { useVault: true } },
    queue: ['untouched']
  };
  original = JSON.stringify(raw, null, 2);
  disk = original;
  backups = [];
  records = { a: JSON.stringify({ email: 'windows@example.test', password: 'PRIVATE_WINDOWS' }) };
  invoke = vi.fn(async (command, args) => {
    if (command === 'secrets_available') return true;
    if (command === 'secrets_get_many') return { ...records };
    if (command === 'load_state_raw') return disk;
    if (command === 'create_migration_backup') {
      if (args.expectedRaw !== disk) throw new Error('PRIVATE_NATIVE');
      backups.push(disk);
      return 'state.backup-pre-contacts-windows-choice-123.json';
    }
    if (command === 'save_state_if_unchanged') {
      if (args.expectedRaw !== disk) throw new Error('PRIVATE_NATIVE');
      disk = JSON.stringify(args.payload);
      return null;
    }
    throw new Error('unexpected mutation');
  });
  __setInvoke(invoke);
  const chars = JSON.parse(JSON.stringify([...raw.characters, ...raw.archivedCharacters]));
  const result = await hydrateSecrets(chars, { plaintextIds: new Set(['a', 'b', 'arch']) });
  expect(result.conflict).toBe(true);
  expect(chars[0].contacts.password).toBe('PRIVATE_FILE');
  review = vaultConflictReview();
  invoke.mockClear();
  document.body.innerHTML = '<div id="storage-readonly-banner"></div><div id="modal-root"></div>';
});
it('explicit recovery backs up exact original, preserves unrelated data and never writes Windows; normal saving stays blocked', async () => {
  const recover = createWindowsContactRecovery({ raw, review });
  expect(invoke).not.toHaveBeenCalled();
  const beforeRecords = JSON.stringify(records);
  const backup = await recover(invoke);
  expect(backup).toContain('pre-contacts-windows-choice');
  expect(backups).toEqual([original]);
  expect(JSON.parse(disk)).toEqual({
    ...raw,
    secretsInVault: true,
    characters: [{ ...raw.characters[0], contacts: null }, raw.characters[1]]
  });
  expect(JSON.stringify(records)).toBe(beforeRecords);
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    'load_state_raw',
    'secrets_get_many',
    'create_migration_backup',
    'secrets_get_many',
    'save_state_if_unchanged',
    'secrets_get_many'
  ]);
  expect(vaultStatus().blocked).toBe(true);
  await expect(prepareForDisk(raw)).rejects.toThrow();
  const count = invoke.mock.calls.length;
  await expect(recover(invoke)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(vaultConflictReview()).toEqual(review);
});
it('works for archived conflicts and migrated IDs without changing schema/IDs or other contacts', async () => {
  const local = {
    schemaVersion: 3,
    characters: [],
    archivedCharacters: [{ id: 'old', contacts: { password: 'old' } }]
  };
  const plan = { conflicts: [{ id: 'new', source: 'old' }], records: { ...records }, keys: ['a'] };
  disk = JSON.stringify(local);
  await createWindowsContactRecovery({ raw: local, aliases: { new: 'old' }, review: plan })(invoke);
  expect(JSON.parse(disk)).toEqual({
    ...local,
    secretsInVault: true,
    archivedCharacters: [{ id: 'old', contacts: null }],
    settings: { security: { useVault: true } }
  });
  expect(backups).toEqual([JSON.stringify(local)]);
});
it.each([
  'file-before',
  'vault-before',
  'backup-fails',
  'vault-during-backup',
  'file-during-backup',
  'bad-backup-reply'
])('fails closed with no vault writes: %s', async mode => {
  const recover = createWindowsContactRecovery({ raw, review });
  const transport = vi.fn(async (command, args) => {
    if (command === 'load_state_raw') {
      if (mode === 'file-before') disk += ' ' + 'invalid';
      if (mode === 'vault-before') records.a = 'PRIVATE_NEW';
    }
    if (command === 'create_migration_backup' && mode === 'backup-fails') throw new Error('PRIVATE_ERROR');
    const value = await invoke(command, args);
    if (command === 'create_migration_backup') {
      if (mode === 'vault-during-backup') records.a = 'PRIVATE_NEW';
      if (mode === 'file-during-backup') disk = '{"newer":true}';
      if (mode === 'bad-backup-reply') return null;
    }
    return value;
  });
  await expect(recover(transport)).rejects.toThrow('Сохранение остаётся остановленным');
  if (!mode.startsWith('file-')) expect(disk).toBe(original);
  expect(
    transport.mock.calls.some(([cmd]) => ['secrets_set_many', 'secrets_delete_many', 'save_state'].includes(cmd))
  ).toBe(false);
  const calls = transport.mock.calls.length;
  await expect(recover(transport)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(calls);
});
it.each(['lost-reply', 'vault-after', 'bad-write-reply'])(
  'does not retry uncertain state replacement and preserves verified backup: %s',
  async mode => {
    const recover = createWindowsContactRecovery({ raw, review });
    const transport = vi.fn(async (command, args) => {
      const result = await invoke(command, args);
      if (command === 'save_state_if_unchanged') {
        if (mode === 'lost-reply') throw new Error('PRIVATE_UNCERTAIN');
        if (mode === 'vault-after') records.a = 'PRIVATE_NEW';
        if (mode === 'bad-write-reply') return false;
      }
      return result;
    });
    try {
      await recover(transport);
      throw new Error('expected failure');
    } catch (error) {
      expect(error.message).toContain('Сохранение остаётся остановленным');
      expect(error.message).not.toContain('PRIVATE');
    }
    expect(backups).toEqual([original]);
    expect(JSON.parse(disk).characters[0].contacts).toBeNull();
    const calls = transport.mock.calls.length;
    await expect(recover(transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(calls);
  }
);
it('compares all conflicting characters only after every vault record validates; a damaged record cannot publish a partial plan', async () => {
  records.b = 'not json PRIVATE';
  __setInvoke(invoke);
  const chars = JSON.parse(JSON.stringify(raw.characters));
  expect((await hydrateSecrets(chars, { plaintextIds: new Set(['a', 'b']) })).conflict).not.toBe(true);
  expect(vaultConflictReview()).toBeNull();
  expect(chars).toEqual(raw.characters);
  records.b = JSON.stringify({ email: 'another@example.test' });
  __setInvoke(invoke);
  expect((await hydrateSecrets(chars, { plaintextIds: new Set(['a', 'b']) })).conflict).toBe(true);
  expect(vaultConflictReview().conflicts.map(item => item.id)).toEqual(['a', 'b']);
});
it('missing or ambiguous raw IDs do not offer a replacement', () => {
  expect(createWindowsContactRecovery({ raw: { characters: [] }, review })).toBeNull();
  expect(
    createWindowsContactRecovery({ raw: { characters: [raw.characters[0], raw.characters[0]] }, review })
  ).toBeNull();
});
it('comparison is opt-in, escaped and masked by default; cancel and unconfirmed choice make no IPC calls', () => {
  attachVaultConflictRecovery({ raw, review });
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-vault-conflict-summary]').textContent).toContain('a: почта, пароль');
  expect(document.querySelector('[data-vault-conflict-summary]').textContent).not.toContain('PRIVATE');
  document.querySelector('[data-vault-review]').click();
  expect(document.body.innerHTML).not.toContain('PRIVATE_FILE');
  expect(document.body.innerHTML).not.toContain('PRIVATE_WINDOWS');
  const buttons = document.querySelectorAll('.tf-dialog-foot button');
  expect(buttons[1].disabled).toBe(true);
  document.querySelector('.tf-dialog-body input').click();
  expect(document.body.textContent).toContain('PRIVATE_FILE');
  expect(document.body.textContent).toContain('PRIVATE_WINDOWS');
  document.querySelector('.tf-dialog-body input').click();
  expect(document.body.innerHTML).not.toContain('PRIVATE_FILE');
  buttons[0].click();
  expect(document.querySelector('.tf-dialog')).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  expect(disk).toBe(original);
});
