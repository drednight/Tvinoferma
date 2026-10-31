import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { createStandaloneFileExchange, readStandaloneState } from '../js/modules/cloudSync/standaloneFileExchange.js';
import {
  sealStandaloneFile,
  openStandaloneFile,
  standaloneEnvelopeHash,
  standaloneContents,
  STANDALONE_DATASET_ID,
  validateStandaloneKeyRecord
} from '../js/modules/cloudSync/standaloneFileCodec.js';
import { validateEncryptionPassword } from '../js/modules/cloudSync/keyBundle.js';
import { encryptSnapshot, generateSyncId } from '../js/modules/cloudSync/envelope.js';

const password = 'Ab3!xyZ7'; // exactly 8 characters
const cryptoSource = webcrypto;
const hash = envelope => standaloneEnvelopeHash(envelope, cryptoSource);
const normalize = raw => {
  const { ui, ...snapshot } = normalizeState(raw);
  return planSyncIdentities({ snapshot, cryptoSource }).snapshot;
};
let original, cloudState, first, second, privateFile;
beforeAll(async () => {
  original = normalize({
    characters: [
      { id: 'a', nick: 'Первый', contacts: { email: 'local@invalid', password: 'LOCAL-PRIVATE' } },
      { id: 'b', nick: 'Будет удалён' }
    ],
    plannerEntries: [{ id: 'old-task', title: 'Местная задача', date: '2026-10-31' }]
  });
  cloudState = structuredClone(original);
  cloudState.characters = cloudState.characters.slice(0, 1);
  cloudState.characters[0].nick = 'Облачный <img src=x>';
  cloudState.characters[0].contacts.email = 'cloud@invalid';
  cloudState.characters[0].contacts.password = 'CLOUD-PRIVATE';
  cloudState.plannerEntries = [];
  first = await sealStandaloneFile({ snapshot: original, password, cryptoSource });
  const supersedes = [{ versionId: first.envelope.versionId, sha256: await hash(first.envelope) }];
  second = await sealStandaloneFile({ snapshot: cloudState, unlocked: first.unlocked, supersedes, cryptoSource });
  privateFile = await sealStandaloneFile({
    snapshot: cloudState,
    unlocked: first.unlocked,
    cryptoSource,
    fields: ['email', 'password'],
    contactsSourceConfirmed: true,
    acknowledgePasswordRisk: true
  });
}, 30000);

function fixture({ recalled = first.unlocked } = {}) {
  let local = structuredClone(original);
  const disks = { google: new Map(), yandex: new Map() };
  const accounts = { google: 'a'.repeat(64), yandex: 'b'.repeat(64) };
  const failures = {};
  const backups = [];
  const calls = { google: [], yandex: [] };
  const patch = vi.fn(async change => {
    const cfg = readStandaloneState(local.settings);
    change(cfg);
    local.settings.cloudStandaloneFiles = cfg;
    readStandaloneState(local.settings);
  });
  const ports = {
    cryptoSource,
    snapshot: () => structuredClone(local),
    patch,
    ensureIds: vi.fn(async () => {}),
    recalledKey: vi.fn(async () => recalled),
    rememberKey: vi.fn(async () => {}),
    forgetKey: vi.fn(async () => {}),
    async open(provider) {
      if (failures[provider]?.open) throw new Error('network');
      return {
        account: accounts[provider],
        folderId: provider === 'google' ? 'app-folder' : null,
        session: {
          async listWithDates() {
            return {
              status: 'listed',
              versions: [...disks[provider]].map(([versionId]) => ({ versionId, modifiedAt: '2026-10-31T10:00:00Z' }))
            };
          },
          async read(versionId) {
            return disks[provider].has(versionId)
              ? { status: 'found', envelope: structuredClone(disks[provider].get(versionId)) }
              : { status: 'not_found' };
          },
          async generateFileId() {
            return { status: 'generated', fileId: 'allocated-id' };
          },
          async upload(args) {
            calls[provider].push(structuredClone(args));
            if (failures[provider]?.upload === 'not_sent') return { status: 'not_sent' };
            disks[provider].set(args.envelope.versionId, structuredClone(args.envelope));
            if (failures[provider]?.upload === 'lost_reply') throw new Error('timeout');
            return { status: 'accepted' };
          },
          async verify(args) {
            if (failures[provider]?.verify) return { status: failures[provider].verify };
            const remote = disks[provider].get(args.envelope.versionId);
            return {
              status: !remote
                ? 'not_found'
                : JSON.stringify(remote) === JSON.stringify(args.envelope)
                  ? 'verified'
                  : 'mismatch'
            };
          },
          dispose: vi.fn()
        }
      };
    },
    replace: vi.fn(async (before, candidate) => {
      if (JSON.stringify(before) !== JSON.stringify(local)) return { status: 'state_changed' };
      backups.push(structuredClone(local));
      local = structuredClone(candidate);
      return { status: 'applied', backup: 'synthetic-backup' };
    })
  };
  const engine = createStandaloneFileExchange(ports);
  const put = (provider, file) => disks[provider].set(file.envelope.versionId, structuredClone(file.envelope));
  const review = async (file = second, extra = {}) =>
    engine.review({
      provider: 'google',
      versionId: file.envelope.versionId,
      sha256: await hash(file.envelope),
      ...extra
    });
  return {
    engine,
    ports,
    patch,
    disks,
    calls,
    failures,
    backups,
    accounts,
    put,
    review,
    get local() {
      return local;
    },
    set local(value) {
      local = value;
    }
  };
}

describe('standalone encrypted complete file', () => {
  it('accepts exactly 8 characters; tells the user explicitly about fewer than 8', () => {
    expect(validateEncryptionPassword(password)).toBe(password);
    expect(() => validateEncryptionPassword('Ab3!xyZ')).toThrow('не менее 8 символов');
    expect(() => validateEncryptionPassword('')).toThrow();
  });
  it('opens independently using only the password, without root/backup/parents/PC bindings', async () => {
    const opened = await openStandaloneFile({ envelope: second.envelope, password, cryptoSource });
    expect(opened.contents.publicSnapshot).toEqual(second.contents.publicSnapshot);
    expect(opened.contents.supersedes).toHaveLength(1); // ancestor intentionally not supplied
    expect(opened.unlocked.dataKey).toBe(first.unlocked.dataKey);
    expect(second.envelope.datasetId).toBe(STANDALONE_DATASET_ID);
    const raw = JSON.stringify(second.envelope);
    for (const secret of [password, 'CLOUD-PRIVATE', 'Облачный', first.unlocked.dataKey])
      expect(raw).not.toContain(secret);
  });
  it('rejects wrong password and tampering, without leaking the secret in errors', async () => {
    await expect(
      openStandaloneFile({ envelope: second.envelope, password: 'wrong123!', cryptoSource })
    ).rejects.toThrow();
    const changed = structuredClone(second.envelope);
    changed.ciphertext = (changed.ciphertext[0] === 'A' ? 'B' : 'A') + changed.ciphertext.slice(1);
    await expect(openStandaloneFile({ envelope: changed, unlocked: first.unlocked, cryptoSource })).rejects.toThrow();
  });
  it('excludes private fields by default and requires separate consent for exporting passwords', async () => {
    expect(second.contents.privateSnapshot).toBeNull();
    expect(JSON.stringify(second.contents)).not.toContain('CLOUD-PRIVATE');
    await expect(
      sealStandaloneFile({
        snapshot: cloudState,
        unlocked: first.unlocked,
        cryptoSource,
        fields: ['password'],
        contactsSourceConfirmed: true
      })
    ).rejects.toThrow('риск');
    await expect(
      sealStandaloneFile({ snapshot: cloudState, unlocked: first.unlocked, cryptoSource, fields: ['email'] })
    ).rejects.toThrow('полноту');
    expect(privateFile.contents.privateSnapshot.records[0].fields.password).toBe('CLOUD-PRIVATE');
  });
  it('keeps the protected master separate from the public bundle and validates its namespace', () => {
    expect(
      validateStandaloneKeyRecord({ bundleId: first.unlocked.bundle.bundleId, dataKey: first.unlocked.dataKey }).dataKey
    ).toBe(first.unlocked.dataKey);
    expect(() => validateStandaloneKeyRecord({ bundleId: first.unlocked.bundle.bundleId, password })).toThrow();
    expect(() =>
      validateStandaloneKeyRecord({ bundleId: first.unlocked.bundle.bundleId, dataKey: 'other-key' })
    ).toThrow();
  });
  it('strictly validates decrypted schema, duplicate archive pins and accessor properties', () => {
    expect(() => standaloneContents({ ...second.contents, extra: true })).toThrow();
    expect(() =>
      standaloneContents({
        ...second.contents,
        supersedes: [...second.contents.supersedes, ...second.contents.supersedes]
      })
    ).toThrow();
    const accessor = { ...second.contents };
    Object.defineProperty(accessor, 'createdAt', {
      enumerable: true,
      get() {
        throw new Error('must not run');
      }
    });
    expect(() => standaloneContents(accessor)).toThrow();
  });
  it('does not transfer local paths, website sessions, account bindings or private fields in ordinary snapshots', async () => {
    const local = structuredClone(original);
    local.settings.localOnlySentinel = 'SECRET-LOCAL-PATH';
    local.settings.cloudSync = { token: 'SECRET-TOKEN' };
    const sealed = await sealStandaloneFile({ snapshot: local, unlocked: first.unlocked, cryptoSource });
    expect(JSON.stringify(sealed.contents)).not.toMatch(/SECRET-LOCAL-PATH|SECRET-TOKEN|LOCAL-PRIVATE/);
  });
});

describe('standalone exchange: two providers and two PCs', () => {
  it('groups identical files across disks and leaves genuinely different copies separate; never chooses by date', async () => {
    const f = fixture();
    f.put('google', first);
    f.put('yandex', first);
    const result = await f.engine.check();
    expect(result.files).toHaveLength(1);
    expect(result.files[0].locations).toHaveLength(2);
    f.put('yandex', privateFile);
    const different = await f.engine.check({ manual: true });
    expect(different.files).toHaveLength(2);
    expect(f.ports.replace).not.toHaveBeenCalled();
    expect(f.calls.google).toHaveLength(0);
  });
  it('treats old copies as optional backups after authenticating a complete replacement; no missing history dependency', async () => {
    const f = fixture();
    f.put('google', first);
    f.put('google', second);
    const result = await f.engine.check({ manual: true });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].versionId).toBe(second.envelope.versionId);
    f.disks.google.delete(first.envelope.versionId);
    expect((await f.review()).comparison.entries.some(entry => entry.kind === 'only_local')).toBe(true);
  });
  it('downloads and previews without writing local data, accepted bases or either cloud', async () => {
    const f = fixture({ recalled: null });
    f.put('google', second);
    const before = structuredClone(f.local);
    const review = await f.review(second, { password });
    expect(review.comparison.entries.some(row => row.kind === 'only_local')).toBe(true);
    expect(review.comparison.entries.some(row => row.kind === 'changed')).toBe(true);
    expect(f.local).toEqual(before);
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.ports.replace).not.toHaveBeenCalled();
  });
  it('accepts the entire public copy including deletions, creates a backup and does not republish to the second provider', async () => {
    const f = fixture();
    f.put('google', second);
    const before = structuredClone(f.local);
    const token = await f.review();
    expect((await f.engine.accept(token, { confirmed: true })).status).toBe('applied');
    expect(f.local.characters).toHaveLength(1);
    expect(f.local.characters[0].nick).toBe('Облачный <img src=x>');
    expect(f.local.plannerEntries).toHaveLength(0);
    expect(f.local.characters[0].contacts.password).toBe('LOCAL-PRIVATE');
    expect(f.backups).toEqual([before]);
    expect(f.calls.google).toHaveLength(0);
    expect(f.calls.yandex).toHaveLength(0);
  });
  it('keeps local data after decline and suppresses that same file on BOTH disks; manual review and new versions remain available', async () => {
    const f = fixture();
    f.put('google', second);
    f.put('yandex', second);
    const before = structuredClone(f.local.characters);
    await f.engine.decline(await f.review());
    expect(f.local.characters).toEqual(before);
    expect((await f.engine.check()).files).toHaveLength(0);
    expect((await f.engine.check({ manual: true })).files).toHaveLength(1);
    f.put('google', privateFile);
    expect((await f.engine.check()).files).toHaveLength(1);
    expect(f.calls.google).toHaveLength(0);
    expect(f.ports.replace).not.toHaveBeenCalled();
  });
  it('requires a fresh preview after local edits and rechecks remote bytes after preview', async () => {
    const f = fixture();
    f.put('google', second);
    const token = await f.review();
    f.local.characters[0].nick = 'Changed during preview';
    await expect(f.engine.accept(token, { confirmed: true })).rejects.toThrow('local_changed');
    const updated = await f.review();
    f.disks.google.delete(second.envelope.versionId);
    await expect(f.engine.accept(updated, { confirmed: true })).rejects.toThrow('remote_changed');
    expect(f.backups).toHaveLength(0);
  });
  it('applies private data only with explicit field selection, backup acknowledgement and password-risk consent', async () => {
    const f = fixture();
    f.put('google', privateFile);
    const token = await f.review(privateFile, { fields: ['email', 'password'] });
    await expect(f.engine.accept(token, { confirmed: true, fields: ['email'] })).rejects.toThrow('contacts_required');
    await expect(
      f.engine.accept(token, { confirmed: true, fields: ['password'], contactsBackupConfirmed: true })
    ).rejects.toThrow('password_risk');
    const result = await f.engine.accept(token, { confirmed: true, fields: ['email'], contactsBackupConfirmed: true });
    expect(result.status).toBe('applied');
    expect(f.local.characters[0].contacts.email).toBe('cloud@invalid');
    expect(f.local.characters[0].contacts.password).toBe('LOCAL-PRIVATE');
  });
  it('uses one save action and the same full file on both providers, with durable intent before each upload', async () => {
    const f = fixture();
    const order = [];
    f.patch.mockImplementation(async change => {
      const cfg = readStandaloneState(f.local.settings);
      change(cfg);
      f.local.settings.cloudStandaloneFiles = cfg;
      order.push({ google: cfg.google.pending?.phase, yandex: cfg.yandex.pending?.phase });
    });
    const prepared = await f.engine.prepareSave({ targets: ['google', 'yandex'] });
    const result = await f.engine.save(prepared, { confirmed: true });
    expect(result.results.map(row => row.status)).toEqual(['sent_verified', 'sent_verified']);
    expect(f.calls.google[0].envelope).toEqual(f.calls.yandex[0].envelope);
    expect(f.calls.google[0].fileId).toBe('allocated-id');
    expect(order.some(row => row.google === 'prepared')).toBe(true);
    expect(order.some(row => row.google === 'attempting')).toBe(true);
    expect(f.local.settings.cloudStandaloneFiles.google.pending).toBeNull();
    expect(f.local.settings.cloudStandaloneFiles.yandex.pending).toBeNull();
    expect(JSON.stringify(f.local.settings.cloudStandaloneFiles)).not.toContain(first.unlocked.dataKey);
  });
  it('does not roll back or block a healthy provider when the other fails', async () => {
    const f = fixture();
    f.failures.google = { open: true };
    const token = await f.engine.prepareSave({ targets: ['google', 'yandex'] });
    const result = await f.engine.save(token, { confirmed: true });
    expect(result.results).toEqual([
      { provider: 'google', status: 'unavailable' },
      { provider: 'yandex', status: 'sent_verified' }
    ]);
    expect(f.disks.yandex.size).toBe(1);
    expect(f.disks.google.size).toBe(0);
  });
  it('verifies a lost upload acknowledgement before reporting success; never blindly retries it', async () => {
    const f = fixture();
    f.failures.google = { upload: 'lost_reply' };
    const token = await f.engine.prepareSave({ targets: ['google'] });
    expect((await f.engine.save(token, { confirmed: true })).results[0].status).toBe('sent_verified');
    expect(f.calls.google).toHaveLength(1);
  });
  it('retains an uncertain encrypted intent across restarts, checks without upload, then settles exact readback', async () => {
    const f = fixture();
    f.failures.google = { verify: 'unavailable' };
    const token = await f.engine.prepareSave({ targets: ['google'] });
    expect((await f.engine.save(token, { confirmed: true })).results[0].status).toBe('verification_pending');
    const pending = structuredClone(f.local.settings.cloudStandaloneFiles.google.pending);
    expect(pending.phase).toBe('attempting');
    const restarted = createStandaloneFileExchange(f.ports);
    await restarted.check();
    expect(f.calls.google).toHaveLength(1);
    delete f.failures.google;
    const checked = await restarted.check();
    expect(checked.pending[0].status).toBe('sent_verified');
    expect(f.local.settings.cloudStandaloneFiles.google.pending).toBeNull();
    expect(f.calls.google).toHaveLength(1);
  });
  it('only explicitly continues the identical encrypted attempt with the SAME Google ID after verified absence', async () => {
    const f = fixture();
    f.failures.google = { upload: 'not_sent' };
    const token = await f.engine.prepareSave({ targets: ['google'] });
    await f.engine.save(token, { confirmed: true });
    const pending = structuredClone(f.local.settings.cloudStandaloneFiles.google.pending);
    delete f.failures.google;
    expect((await f.engine.continuePending('google')).status).toBe('sent_verified');
    expect(f.calls.google).toHaveLength(2);
    expect(f.calls.google[1]).toEqual(f.calls.google[0]);
    expect(f.calls.google[1].envelope).toEqual(pending.envelope);
  });
  it('stops new uploads when the source or cloud changed after preparation', async () => {
    const f = fixture();
    const localToken = await f.engine.prepareSave({ targets: ['google'] });
    f.local.characters[0].nick = 'New local edit';
    expect((await f.engine.save(localToken, { confirmed: true })).results[0].status).toBe('local_changed');
    const remoteToken = await f.engine.prepareSave({ targets: ['google'] });
    f.put('google', second);
    expect((await f.engine.save(remoteToken, { confirmed: true })).results[0].status).toBe('remote_changed');
    expect(f.calls.google).toHaveLength(0);
  });
  it('does not send anything before a durable intent is confirmed', async () => {
    const f = fixture();
    const token = await f.engine.prepareSave({ targets: ['google'] });
    f.patch.mockRejectedValue(new Error('storage refused'));
    expect((await f.engine.save(token, { confirmed: true })).results[0].status).not.toBe('sent_verified');
    expect(f.calls.google).toHaveLength(0);
  });
  it('preserves legacy keys, bindings, queues and native-local settings through whole-file replacement', async () => {
    const f = fixture();
    f.local.settings.cloudSnapshotFiles = { legacy: 'sentinel' };
    f.local.settings.cloudLegacyBinding = { queue: 'unsettled' };
    f.put('google', second);
    await f.engine.accept(await f.review(), { confirmed: true });
    expect(f.local.settings.cloudSnapshotFiles).toEqual({ legacy: 'sentinel' });
    expect(f.local.settings.cloudLegacyBinding).toEqual({ queue: 'unsettled' });
  });
  it('blocks accidental writes to another account while allowing the other disk to work', async () => {
    const f = fixture();
    f.local.settings.cloudStandaloneFiles = readStandaloneState(f.local.settings);
    f.local.settings.cloudStandaloneFiles.google.account = 'f'.repeat(64);
    const token = await f.engine.prepareSave({ targets: ['google', 'yandex'] });
    const result = await f.engine.save(token, { confirmed: true });
    expect(result.results[0].status).toBe('unavailable');
    expect(result.results[1].status).toBe('sent_verified');
    expect(f.calls.google).toHaveLength(0);
  });
  it('remembers an OS-vault key only after explicit consent and verified success, not password or raw snapshot', async () => {
    const f = fixture();
    const token = await f.engine.prepareSave({ targets: ['google'] });
    await f.engine.save(token, { confirmed: true });
    expect(f.ports.rememberKey).not.toHaveBeenCalled();
    const another = await f.engine.prepareSave({ targets: ['google'] });
    await f.engine.save(another, { confirmed: true, remember: true });
    expect(f.ports.rememberKey).toHaveBeenCalledTimes(1);
  });
  it('can publish a selected saved state without replacing the current application data', async () => {
    const f = fixture();
    const token = await f.engine.prepareSave({ targets: ['google'], source: cloudState });
    await f.engine.save(token, { confirmed: true });
    expect(f.local.characters).toHaveLength(2);
    expect(f.ports.replace).not.toHaveBeenCalled();
    const sent = await openStandaloneFile({
      envelope: f.calls.google[0].envelope,
      unlocked: first.unlocked,
      cryptoSource
    });
    expect(sent.contents.publicSnapshot).toEqual(second.contents.publicSnapshot);
  });
  it('warns when both local and cloud changed relative to the accepted full-file base', async () => {
    const f = fixture();
    f.put('google', first);
    await f.engine.accept(await f.review(first), { confirmed: true });
    f.local.characters[0].nick = 'Local branch';
    f.put('google', second);
    expect((await f.review()).bothChanged).toBe(true);
  });
  it('requires an explicit separate backup acknowledgement before deleting local characters with private contacts', async () => {
    const f = fixture();
    f.local.characters[1].contacts.email = 'removed-private@invalid';
    f.put('google', second);
    const review = await f.review();
    expect(review.localPrivateAtRisk).toBe(true);
    await expect(f.engine.accept(review, { confirmed: true })).rejects.toThrow('contacts_required');
    expect(f.ports.replace).not.toHaveBeenCalled();
    expect((await f.engine.accept(review, { confirmed: true, contactsBackupConfirmed: true })).status).toBe('applied');
  });
  it('can show independently openable previous full copies in the explicit backup view', async () => {
    const f = fixture();
    f.put('google', first);
    f.put('google', second);
    expect((await f.engine.check({ manual: true })).files).toHaveLength(1);
    expect((await f.engine.check({ manual: true, includeBackups: true })).files).toHaveLength(2);
    expect((await f.review(first)).versionId).toBe(first.envelope.versionId);
  });
  it('polling may reuse lightweight pins, but an explicit check and acceptance always reread bytes', async () => {
    const f = fixture();
    f.put('google', second);
    await f.engine.check();
    const review = await f.review();
    const corrupted = structuredClone(second.envelope);
    corrupted.iv = 'AAAAAAAAAAAAAAAA';
    f.disks.google.set(corrupted.versionId, corrupted);
    await expect(f.engine.accept(review, { confirmed: true })).rejects.toThrow('remote_changed');
    const explicit = await f.engine.check({ manual: true });
    expect(explicit.files[0].sha256).not.toBe(review.sha256);
  });
  it('rejects hidden/accessor local metadata without executing it or accepting plaintext master fields', () => {
    const getter = vi.fn(() => ({}));
    const settings = {};
    Object.defineProperty(settings, 'cloudStandaloneFiles', { enumerable: true, get: getter });
    expect(() => readStandaloneState(settings)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cfg = readStandaloneState({});
    cfg.key = { bundle: first.unlocked.bundle, pin: first.unlocked.pin, dataKey: first.unlocked.dataKey };
    expect(() => readStandaloneState({ cloudStandaloneFiles: cfg })).toThrow();
  });
  it('invalidates pending previews and unlocked memory when the remembered key is forgotten', async () => {
    const f = fixture();
    f.put('google', second);
    const review = await f.review();
    await f.engine.forgetRememberedKey();
    await expect(f.engine.accept(review, { confirmed: true })).rejects.toThrow('confirmation_required');
    f.engine.dispose();
    await expect(f.engine.check()).rejects.toThrow('closed');
  });
  it('does not require old history payloads even when opening a standalone file with missing ancestors', async () => {
    const orphan = await encryptSnapshot({
      snapshot: second.contents,
      datasetId: STANDALONE_DATASET_ID,
      versionId: generateSyncId(cryptoSource),
      keyCapsule: second.envelope.keyCapsule,
      recoveryKey: first.unlocked.dataKey,
      cryptoSource
    });
    expect((await openStandaloneFile({ envelope: orphan, password, cryptoSource })).contents.publicSnapshot).toEqual(
      second.contents.publicSnapshot
    );
  });
});
