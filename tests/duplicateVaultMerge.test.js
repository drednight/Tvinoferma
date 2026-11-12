import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => transport.invoke(...args) }));

let state, secrets, storage, prepare, originalRecords, records, disk, backups, events, token;
const empty = { email: '', password: '', recoveryEmail: '', phone: '' };
const record = value => JSON.stringify({ ...empty, ...value });
const backupName = label => `state.backup-123-${label}-42-1.json`;

beforeEach(async () => {
  vi.resetModules();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  secrets = await import('../js/core/secrets.js');
  storage = await import('../js/core/storage.js');
  ({ prepareDuplicateVaultMerge: prepare } = await import('../js/settings/duplicateVaultMerge.js'));
  state.characters = [
    { id: 'a', nick: 'Same', contacts: { ...empty } },
    { id: 'b', nick: 'same', contacts: { ...empty } }
  ];
  state.archivedCharacters = [];
  state.settings.security.useVault = true;
  originalRecords = {
    a: record({ email: 'a@example.test', password: 'PRIVATE-A' }),
    b: record({ email: 'a@example.test', phone: 'PRIVATE-B' })
  };
  records = { ...originalRecords };
  disk = null;
  backups = [];
  events = [];
  token = '0123456789abcdef01234567';
  transport.invoke.mockReset();
  transport.invoke.mockImplementation(async (command, args = {}) => {
    events.push(command);
    if (command === 'secrets_available') return true;
    if (command === 'secrets_get_many')
      return Object.fromEntries(args.keys.filter(k => Object.hasOwn(records, k)).map(k => [k, records[k]]));
    if (command === 'secrets_set_many') {
      for (const [key, value] of Object.entries(args.items)) {
        if (value) records[key] = value;
        else delete records[key];
      }
      return null;
    }
    if (command === 'secrets_delete_many') {
      args.keys.forEach(k => delete records[k]);
      return null;
    }
    if (command === 'save_state') {
      disk = JSON.stringify(args.payload);
      return null;
    }
    if (command === 'load_state_raw') return disk;
    if (command === 'create_migration_backup') {
      if (args.expectedRaw !== disk) throw new Error('PRIVATE-STALE');
      backups.push(disk);
      return backupName(args.label);
    }
    if (command === 'save_state_if_unchanged') {
      if (args.expectedRaw !== disk) throw new Error('TF_STATE_WRITE_UNCHANGED: stale');
      disk = JSON.stringify(args.payload);
      return null;
    }
    throw new Error(`Unexpected ${command}`);
  });
  secrets.__setInvoke(transport.invoke);
  await secrets.hydrateSecrets(state.characters, { requiresVault: true });
  await storage.saveNow();
  events.length = 0;
});
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

const snapshot = () =>
  JSON.parse(JSON.stringify((({ ui, ...rest }) => ({ ...rest, savedAt: new Date().toISOString() }))(state)));
const copies = () => ({
  a: records[`duplicate-merge-${token}-0`],
  b: records[`duplicate-merge-${token}-1`],
  manifest: records[`duplicate-merge-${token}-manifest`]
});

async function runMerge(afterBackup = () => {}) {
  return storage.withExclusiveDuplicateMerge(async commit => {
    const result = await prepare(snapshot(), ['a', 'b'], token, () => true);
    await afterBackup();
    state.characters[0].contacts = { ...state.characters[0].contacts, phone: state.characters[1].contacts.phone };
    state.characters.pop();
    await commit(result.raw);
    return result;
  });
}

it('copies both original vault records before merging and makes the copies discoverable for review', async () => {
  const before = disk;
  const result = await runMerge();
  expect(backups).toEqual([before]);
  expect(result.name).toContain(token);
  expect(copies()).toMatchObject({ a: originalRecords.a, b: originalRecords.b });
  expect(JSON.parse(copies().manifest)).toEqual({ version: 1, ids: ['a', 'b'], present: [true, true] });
  expect(events.indexOf('create_migration_backup')).toBeLessThan(events.indexOf('secrets_set_many'));
  expect(records.a).toBe(record({ email: 'a@example.test', password: 'PRIVATE-A', phone: 'PRIVATE-B' }));
  expect(records.b).toBeUndefined();
  expect(JSON.parse(disk).characters.map(c => c.id)).toEqual(['a']);
  expect(JSON.parse(disk).characters[0].contacts).toBeNull();
  expect(await secrets.readDuplicateContactBackup(token)).toEqual([
    { id: 'a', contacts: JSON.parse(originalRecords.a) },
    { id: 'b', contacts: JSON.parse(originalRecords.b) }
  ]);
});

it.each(['stale-file', 'stale-vault', 'copy-failure', 'copy-readback', 'copy-lost-reply', 'wrong-backup-name'])(
  'stops before touching originals: %s',
  async mode => {
    const real = transport.invoke.getMockImplementation();
    transport.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'create_migration_backup' && mode === 'wrong-backup-name') return 'bad';
      if (cmd === 'secrets_set_many' && Object.keys(args.items).some(k => k.startsWith('duplicate-merge-'))) {
        if (mode === 'copy-failure') throw new Error('PRIVATE-FAIL');
        const reply = await real(cmd, args);
        if (mode === 'copy-lost-reply') throw new Error('PRIVATE-LOST');
        if (mode === 'copy-readback') delete records[`duplicate-merge-${token}-0`];
        return reply;
      }
      return real(cmd, args);
    });
    if (mode === 'stale-file') disk = JSON.stringify({ changed: true });
    if (mode === 'stale-vault') records.a = record({ password: 'PRIVATE-CHANGED' });
    const before = { a: records.a, b: records.b };
    await expect(runMerge()).rejects.toThrow();
    expect({ a: records.a, b: records.b }).toEqual(before);
    expect(state.characters).toHaveLength(2);
    expect(events).not.toContain('save_state_if_unchanged');
  }
);

it.each(['vault-lost-reply', 'state-lost-reply', 'external-state'])(
  'keeps both protected originals on uncertain save: %s',
  async mode => {
    const real = transport.invoke.getMockImplementation();
    transport.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'secrets_set_many' && Object.hasOwn(args.items, 'a') && mode === 'vault-lost-reply') {
        await real(cmd, args);
        throw new Error('PRIVATE-LOST');
      }
      if (cmd === 'save_state_if_unchanged' && mode === 'state-lost-reply') {
        await real(cmd, args);
        throw new Error('PRIVATE-LOST');
      }
      return real(cmd, args);
    });
    await expect(
      runMerge(() => {
        if (mode === 'external-state') disk = '{"external":true}';
      })
    ).rejects.toThrow();
    expect(copies()).toMatchObject({ a: originalRecords.a, b: originalRecords.b });
    expect(backups).toHaveLength(1);
    await expect(storage.persist()).rejects.toThrow();
  }
);

it('blocks ordinary writes during the exclusive operation', async () => {
  await storage.withExclusiveDuplicateMerge(async () => {
    await expect(storage.persist()).rejects.toThrow('Запись остановлена');
    await expect(storage.createBackup()).rejects.toThrow('Запись остановлена');
  });
  await expect(storage.persist()).resolves.toBeUndefined();
});

it('does not reveal contacts before explicit consent in backup review', async () => {
  await runMerge();
  document.body.innerHTML = '<div id="modal-root"></div>';
  const { openDuplicateContactBackup } = await import('../js/settings/duplicateContactBackup.js');
  const ov = await openDuplicateContactBackup(backupName(`dup-${token}`));
  expect(ov.body.textContent).not.toContain('PRIVATE-A');
  ov.body.querySelector('input').click();
  expect(ov.body.textContent).toContain('PRIVATE-A');
  expect(ov.body.textContent).toContain('PRIVATE-B');
  ov.close();
  expect(ov.body.textContent).not.toContain('PRIVATE-A');
});

it('completes the actual UI flow with a chosen conflicting password and preserves both versions', async () => {
  records.b = record({ email: 'a@example.test', password: 'PRIVATE-OTHER', phone: 'PRIVATE-B' });
  secrets.__setInvoke(transport.invoke);
  state.characters[1].contacts = { ...empty };
  await secrets.hydrateSecrets(state.characters, { requiresVault: true });
  await storage.saveNow();
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  const { openDuplicateCharacters } = await import('../js/settings/duplicateCharacters.js');
  const ov = openDuplicateCharacters();
  ov.body.querySelector('[data-merge]').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.modal-overlay')).toHaveLength(2));
  const conflict = [...document.querySelectorAll('.modal-overlay')].at(-1);
  expect(conflict.textContent).toContain('contacts.password');
  expect(conflict.textContent).not.toContain('PRIVATE');
  conflict.querySelectorAll('.modal-footer button')[1].click();
  await vi.waitFor(() => expect(document.querySelector('.tf-confirm-overlay')).not.toBeNull());
  document.querySelector('.tf-confirm-overlay .btn.danger').click();
  await vi.waitFor(() => expect(JSON.parse(disk).characters).toHaveLength(1));
  expect(JSON.parse(records.a)).toMatchObject({
    password: 'PRIVATE-OTHER',
    phone: 'PRIVATE-B',
    email: 'a@example.test'
  });
  const saved = Object.entries(records).filter(([key]) => key.startsWith('duplicate-merge-'));
  expect(saved.some(([, value]) => value === originalRecords.a)).toBe(true);
  expect(saved.some(([, value]) => value.includes('PRIVATE-OTHER'))).toBe(true);
  ov.close();
});

it('backs up an absent contact record without inventing a secret', async () => {
  delete records.b;
  secrets.__setInvoke(transport.invoke);
  state.characters.forEach(c => {
    c.contacts = { ...empty };
  });
  await secrets.hydrateSecrets(state.characters, { requiresVault: true });
  await storage.saveNow();
  await runMerge();
  expect(copies().b).toBeUndefined();
  expect(JSON.parse(copies().manifest).present).toEqual([true, false]);
  expect((await secrets.readDuplicateContactBackup(token))[1]).toEqual({ id: 'b', contacts: null });
});

it('can merge an archived duplicate while retaining the original protected records', async () => {
  state.archivedCharacters = [state.characters.pop()];
  await storage.saveNow();
  await storage.withExclusiveDuplicateMerge(async commit => {
    const prepared = await prepare(snapshot(), ['a', 'b'], token, () => true);
    state.characters[0].contacts.phone = state.archivedCharacters[0].contacts.phone;
    state.archivedCharacters = [];
    await commit(prepared.raw);
  });
  expect(copies()).toMatchObject({ a: originalRecords.a, b: originalRecords.b });
  expect(JSON.parse(disk).archivedCharacters).toEqual([]);
  expect(JSON.parse(records.a).phone).toBe('PRIVATE-B');
});

it('detects a vault edit after copying and does not overwrite it', async () => {
  const changed = record({ password: 'EXTERNAL' });
  await expect(
    runMerge(() => {
      records.a = changed;
    })
  ).rejects.toThrow();
  expect(records.a).toBe(changed);
  expect(records.b).toBe(originalRecords.b);
  expect(copies()).toMatchObject({ a: originalRecords.a, b: originalRecords.b });
  expect(JSON.parse(disk).characters).toHaveLength(2);
});

it('refuses the UI merge if the vault was disabled while it still has protected records', async () => {
  state.settings.security.useVault = false;
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  const { openDuplicateCharacters } = await import('../js/settings/duplicateCharacters.js');
  const ov = openDuplicateCharacters();
  ov.body.querySelector('[data-merge]').click();
  await vi.waitFor(() => expect(document.getElementById('toast-root').textContent).toContain('отключено'));
  expect(state.characters).toHaveLength(2);
  expect(records).toMatchObject(originalRecords);
  ov.close();
});

it('does not interpret protected contact content as markup when showing the backup', async () => {
  records.a = record({ password: '<img src=x onerror=alert(1)>' });
  secrets.__setInvoke(transport.invoke);
  state.characters[0].contacts = { ...empty };
  await secrets.hydrateSecrets(state.characters, { requiresVault: true });
  await storage.saveNow();
  await runMerge();
  document.body.innerHTML = '<div id="modal-root"></div>';
  const { openDuplicateContactBackup } = await import('../js/settings/duplicateContactBackup.js');
  const ov = await openDuplicateContactBackup(backupName(`dup-${token}`));
  ov.body.querySelector('input').click();
  expect(ov.body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(ov.body.querySelector('img')).toBeNull();
  ov.close();
});
