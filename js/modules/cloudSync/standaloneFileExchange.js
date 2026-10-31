// @ts-check
// Simple immutable full-file exchange. No connectedPublication, legacy outbox,
// root, history materialisation, pairing, merge or automatic publication.
// Previous copies are optional backups; authenticated supersedes pins only hide
// those backups in the current-file list. A missing backup never prevents opening.
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { prepareFullPublicSnapshotReplace } from './applyPublicSnapshot.js';
import { planSyncIdentities } from './identityMigration.js';
import { privateDifferences, applyPrivateSelection, PRIVATE_FIELDS } from './privateSnapshot.js';
import { snapshotFileHash, sameFilePin, filePin } from './snapshotFileState.js';
import { object, array } from './exportSchema.js';
import { validateJsonSnapshot } from './envelope.js';
import { copyKeyBundle } from './keyBundle.js';
import { copyCloudEnvelope, validGoogleId } from './providers/common.js';
import {
  STANDALONE_DATASET_ID,
  sealStandaloneFile,
  openStandaloneFile,
  standaloneEnvelopeHash
} from './standaloneFileCodec.js';

const PROVIDERS = ['google', 'yandex'];
const HASH = /^[0-9a-f]{64}$/;
const emptyRow = () => ({
  account: null,
  folderId: null,
  pendingFolder: null,
  pending: null,
  baseHash: null,
  accepted: [],
  declined: []
});
export function readStandaloneState(settings) {
  if (!Object.hasOwn(settings, 'cloudStandaloneFiles'))
    return { version: 1, key: null, google: emptyRow(), yandex: emptyRow() };
  const descriptor = Object.getOwnPropertyDescriptor(settings, 'cloudStandaloneFiles');
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
    throw new Error('Некорректное состояние обмена файлами');
  validateJsonSnapshot(descriptor.value);
  const root = object(descriptor.value, ['version', 'key', 'google', 'yandex']);
  if (root.version !== 1) throw new Error('Некорректное состояние обмена файлами');
  if (root.key !== null) {
    const key = object(root.key, ['bundle', 'pin']);
    const bundle = copyKeyBundle(key.bundle),
      pin = object(key.pin, ['bundleId', 'sha256']);
    if (
      bundle.datasetId !== STANDALONE_DATASET_ID ||
      pin.bundleId !== bundle.bundleId ||
      typeof pin.sha256 !== 'string' ||
      !HASH.test(pin.sha256)
    )
      throw new Error('Некорректная капсула ключа');
  }
  for (const provider of PROVIDERS) {
    const row = object(root[provider], [
      'account',
      'folderId',
      'pendingFolder',
      'pending',
      'baseHash',
      'accepted',
      'declined'
    ]);
    if (
      (row.account !== null && (typeof row.account !== 'string' || !HASH.test(row.account))) ||
      (row.baseHash !== null && (typeof row.baseHash !== 'string' || !HASH.test(row.baseHash))) ||
      (provider === 'yandex'
        ? row.folderId !== null || row.pendingFolder !== null
        : row.folderId !== null && !validGoogleId(row.folderId))
    )
      throw new Error('Некорректное подключение файлов');
    for (const key of ['accepted', 'declined']) {
      const pins = array(row[key], filePin);
      if (pins.length > 4096 || new Set(pins.map(pin => pin.versionId)).size !== pins.length)
        throw new Error('Некорректные отметки файлов');
    }
    if (row.pendingFolder !== null) {
      const folder = object(row.pendingFolder, ['fileId']);
      if (!validGoogleId(folder.fileId)) throw new Error('Некорректная папка');
    }
    if (row.pending !== null) {
      const p = object(row.pending, ['envelope', 'pin', 'fileId', 'phase', 'contentHash']);
      const envelope = copyCloudEnvelope(p.envelope, STANDALONE_DATASET_ID);
      const pin = filePin(p.pin);
      if (
        !row.account ||
        pin.versionId !== envelope.versionId ||
        !['prepared', 'attempting'].includes(p.phase) ||
        typeof p.contentHash !== 'string' ||
        !HASH.test(p.contentHash) ||
        (provider === 'google' ? !validGoogleId(p.fileId) || !validGoogleId(row.folderId) : p.fileId !== null)
      )
        throw new Error('Некорректная ожидающая отправка');
    }
  }
  return structuredClone(root);
}
function fail(code) {
  return new Error(code);
}
function pinOf(entry) {
  return { versionId: entry.versionId, sha256: entry.sha256 };
}
function sourceWitness(snapshot) {
  const copy = structuredClone(snapshot);
  delete copy.settings.cloudStandaloneFiles;
  return JSON.stringify(copy);
}
function addPin(list, pin) {
  return [...list.filter(item => item.versionId !== pin.versionId), pin].slice(-4096);
}
/** Pure orchestration with injected durable storage and account-verified transports.
 * @param {any} ports */
export function createStandaloneFileExchange(ports) {
  const cryptoSource = ports.cryptoSource || globalThis.crypto;
  const seal = ports.seal || sealStandaloneFile;
  const unlock = ports.unlock || openStandaloneFile;
  const hashEnvelope = ports.hashEnvelope || (envelope => standaloneEnvelopeHash(envelope, cryptoSource));
  let busy = false;
  let disposed = false;
  let key = null;
  const decoded = new Map();
  let reviews = new WeakMap();
  let uploads = new WeakMap();
  const observations = new Map();
  async function run(action) {
    if (disposed) throw fail('closed');
    if (busy) throw fail('busy');
    busy = true;
    let release;
    try {
      release = ports.begin?.();
      return await action();
    } finally {
      release?.();
      busy = false;
    }
  }
  const config = () => readStandaloneState(ports.snapshot().settings);
  async function patch(change) {
    await ports.patch(change);
  }
  async function connect(provider, createFolder = false) {
    if (!PROVIDERS.includes(provider)) throw fail('provider_invalid');
    const opened = await ports.open(provider, { createFolder });
    const row = config()[provider];
    if (row.account !== null && row.account !== opened.account) {
      opened.session?.dispose();
      throw fail('account_changed');
    }
    return opened;
  }
  async function readCopies(provider, opened, fresh = false) {
    const listed = await opened.session.listWithDates();
    if (listed.status !== 'listed' || !Array.isArray(listed.versions)) throw fail('list_unavailable');
    const result = [];
    for (const item of listed.versions) {
      const cacheKey = `${provider}:${opened.account}:${item.versionId}`;
      const cached = observations.get(cacheKey);
      // A polling optimisation, NEVER evidence authorising replacement/upload.
      // Explicit checks, save preparation and acceptance always reread bytes.
      if (
        !fresh &&
        cached &&
        cached.modifiedAt === item.modifiedAt &&
        (!key || decoded.has(cached.sha256) || cached.triedBundleId === key.bundle.bundleId)
      ) {
        result.push(cached);
        continue;
      }
      const found = await opened.session.read(item.versionId);
      if (found.status !== 'found' || found.envelope.versionId !== item.versionId) throw fail('file_unavailable');
      const sha256 = await hashEnvelope(found.envelope);
      await tryCached({ envelope: found.envelope, sha256 });
      const entry = {
        provider,
        account: opened.account,
        versionId: item.versionId,
        sha256,
        modifiedAt: item.modifiedAt,
        triedBundleId: key?.bundle.bundleId || null
      };
      // Retain only lightweight pins and authenticated archive hints, not N full
      // plaintext databases / ciphertext copies in memory as backups accumulate.
      observations.set(cacheKey, entry);
      result.push(entry);
    }
    return result;
  }
  function heads(entries) {
    const byPin = new Map(entries.map(entry => [JSON.stringify(pinOf(entry)), entry.sha256]));
    const nodes = new Map(entries.map(entry => [entry.sha256, new Set()]));
    const incoming = new Map([...nodes.keys()].map(hash => [hash, 0]));
    for (const [hash, edges] of nodes) {
      for (const pin of decoded.get(hash)?.supersedes || []) {
        const target = byPin.get(JSON.stringify(pin));
        if (target && !edges.has(target)) {
          edges.add(target);
          incoming.set(target, incoming.get(target) + 1);
        }
      }
    }
    const roots = new Set([...incoming].filter(([, count]) => count === 0).map(([hash]) => hash));
    const queue = [...roots];
    const remaining = new Map(incoming);
    for (let i = 0; i < queue.length; i++)
      for (const target of nodes.get(queue[i])) {
        remaining.set(target, remaining.get(target) - 1);
        if (remaining.get(target) === 0) queue.push(target);
      }
    // Optional, authenticated archive hints must not hide cyclic contenders.
    // Missing copies are simply absent nodes, never an opening dependency.
    if (queue.length !== nodes.size) return entries;
    return entries.filter(entry => roots.has(entry.sha256));
  }
  async function tryCached(entry) {
    if (decoded.has(entry.sha256)) return;
    if (!key) key = (await ports.recalledKey?.(config().key)) || null;
    if (!key) return;
    try {
      const opened = await unlock({ envelope: entry.envelope, unlocked: key, cryptoSource });
      decoded.set(entry.sha256, { createdAt: opened.contents.createdAt, supersedes: opened.contents.supersedes });
    } catch {
      /* Different key/password: keep visible, never select a timestamp winner. */
    }
  }
  function view(entries, manual, includeBackups = false) {
    const grouped = new Map();
    for (const entry of includeBackups ? entries : heads(entries)) {
      const cfg = config();
      const known = PROVIDERS.flatMap(provider => [...cfg[provider].accepted, ...cfg[provider].declined]);
      if (!manual && known.some(pin => sameFilePin(pin, pinOf(entry)))) continue;
      const existing = grouped.get(entry.sha256);
      const location = { provider: entry.provider, modifiedAt: entry.modifiedAt };
      if (existing) {
        existing.locations.push(location);
        continue;
      }
      const token = Object.freeze({
        sha256: entry.sha256,
        versionId: entry.versionId,
        locations: [location],
        createdAt: decoded.get(entry.sha256)?.createdAt || null
      });
      // locations must stay mutable until equal copies have been grouped.
      grouped.set(entry.sha256, { token, locations: token.locations, entry });
    }
    return [...grouped.values()].map(({ token, locations }) =>
      Object.freeze({ ...token, locations: Object.freeze(locations) })
    );
  }
  async function scanAll(targets, fresh = false) {
    if (!key) key = (await ports.recalledKey?.(config().key)) || null;
    const entries = [],
      results = [];
    for (const provider of targets) {
      let opened;
      try {
        opened = await connect(provider);
        if (!opened.session) {
          results.push({ provider, status: 'empty' });
          continue;
        }
        const copies = await readCopies(provider, opened, fresh);
        entries.push(...copies);
        results.push({ provider, status: 'checked', count: copies.length });
      } catch (error) {
        results.push({
          provider,
          status: error.message === 'folder_ambiguous' ? 'folder_ambiguous' : 'unavailable',
          ...(error.message === 'folder_ambiguous' ? { folders: error.folders } : {})
        });
      } finally {
        opened?.session?.dispose();
      }
    }
    return { entries, results };
  }
  async function confirmPending(provider, opened) {
    const pending = config()[provider].pending;
    if (!pending) return { provider, status: 'idle' };
    if ((await hashEnvelope(pending.envelope)) !== pending.pin.sha256) throw fail('pending_invalid');
    const args = { envelope: pending.envelope, ...(pending.fileId ? { fileId: pending.fileId } : {}) };
    const verified = await opened.session.verify(args);
    if (verified.status !== 'verified')
      return { provider, status: verified.status === 'mismatch' ? 'content_mismatch' : 'verification_pending' };
    await patch(cfg => {
      const row = cfg[provider];
      if (JSON.stringify(row.pending) !== JSON.stringify(pending)) throw fail('pending_changed');
      row.pending = null;
      row.baseHash = pending.contentHash;
      row.accepted = addPin(row.accepted, pending.pin);
    });
    return { provider, status: 'sent_verified' };
  }
  return Object.freeze({
    isBusy: () => busy,
    dispose() {
      disposed = true;
      key = null;
      decoded.clear();
      observations.clear();
      reviews = new WeakMap();
      uploads = new WeakMap();
    },
    chooseGoogleFolder(folderId) {
      return run(async () => {
        if (!ports.chooseFolder) throw fail('folder_unavailable');
        await ports.chooseFolder(folderId);
      });
    },
    canSeal() {
      return run(async () => {
        if (!key) key = (await ports.recalledKey?.(config().key)) || null;
        return !!key;
      });
    },
    check({ targets = PROVIDERS, manual = false, includeBackups = false } = {}) {
      return run(async () => {
        // A check may settle an earlier receipt, but NEVER sends a file.
        const pending = [];
        for (const provider of targets) {
          if (!config()[provider].pending) continue;
          let opened;
          try {
            opened = await connect(provider);
            pending.push(await confirmPending(provider, opened));
          } catch {
            pending.push({ provider, status: 'verification_pending' });
          } finally {
            opened?.session?.dispose();
          }
        }
        const scanned = await scanAll(targets, manual);
        return { files: view(scanned.entries, manual, includeBackups), results: scanned.results, pending };
      });
    },
    /** Download and read-only comparison. No accepted base, app data or cloud write. */
    review({ provider, versionId, sha256, password, fields = [] }) {
      return run(async () => {
        let opened;
        try {
          opened = await connect(provider);
          const found = await opened.session.read(versionId);
          if (found.status !== 'found' || (await hashEnvelope(found.envelope)) !== sha256) throw fail('remote_changed');
          if (!key) key = (await ports.recalledKey?.(config().key)) || null;
          const openedFile = await unlock({ envelope: found.envelope, password, unlocked: key, cryptoSource });
          key = openedFile.unlocked;
          decoded.set(sha256, { createdAt: openedFile.contents.createdAt, supersedes: openedFile.contents.supersedes });
          const original = ports.snapshot();
          const localState = planSyncIdentities({ snapshot: original, cryptoSource }).snapshot;
          const cloud = openedFile.contents.publicSnapshot;
          const local = buildPublicSnapshot(localState, { settingsSelections: cloud.sections.preferences.selections });
          const comparison = comparePublicSnapshots({ local, cloud });
          const privateChanges = privateDifferences(openedFile.contents.privateSnapshot, cloud, localState, fields);
          const base = config()[provider].baseHash;
          const localHash = await snapshotFileHash(local, cryptoSource);
          const cloudHash = await snapshotFileHash(cloud, cryptoSource);
          // Validate the entire replacement before offering Accept.
          const prepared = prepareFullPublicSnapshotReplace({ localState, cloudSnapshot: cloud, cryptoSource });
          const candidate = prepared.candidateState();
          const retainedIds = new Set(
            [...candidate.characters, ...candidate.archivedCharacters].map(row => row.syncId)
          );
          const token = Object.freeze({
            provider,
            versionId,
            sha256,
            createdAt: openedFile.contents.createdAt,
            comparison,
            privateChanges,
            localPrivateAtRisk: [...localState.characters, ...localState.archivedCharacters].some(
              character =>
                !retainedIds.has(character.syncId) && PRIVATE_FIELDS.some(field => character.contacts?.[field])
            ),
            hasPrivate: !!openedFile.contents.privateSnapshot,
            bothChanged: !!base && localHash !== base && cloudHash !== base,
            noCommonBase: !base,
            supersedes: openedFile.contents.supersedes.length
          });
          reviews.set(token, {
            original,
            candidate,
            account: opened.account,
            envelope: found.envelope,
            contents: openedFile.contents,
            key,
            cloudHash
          });
          return token;
        } finally {
          opened?.session?.dispose();
        }
      });
    },
    decline(token) {
      return run(async () => {
        if (!reviews.has(token)) throw fail('review_required');
        await patch(cfg => {
          cfg[token.provider].declined = addPin(
            cfg[token.provider].declined,
            filePin({ versionId: token.versionId, sha256: token.sha256 })
          );
        });
        reviews.delete(token);
        return { status: 'kept_local' };
      });
    },
    accept(
      token,
      {
        confirmed = false,
        fields = [],
        acknowledgePasswordRisk = false,
        contactsBackupConfirmed = false,
        remember = false
      } = {}
    ) {
      return run(async () => {
        const review = reviews.get(token);
        if (!review || !confirmed) throw fail('confirmation_required');
        if (JSON.stringify(ports.snapshot()) !== JSON.stringify(review.original)) throw fail('local_changed');
        if ((fields.length || token.localPrivateAtRisk) && !contactsBackupConfirmed) throw fail('contacts_required');
        if (fields.length) ports.assertContacts?.(review.original);
        if (fields.includes('password') && !acknowledgePasswordRisk) throw fail('password_risk_confirmation_required');
        if (fields.some(field => !PRIVATE_FIELDS.includes(field))) throw fail('private_selection_invalid');
        let opened;
        try {
          opened = await connect(token.provider);
          if (opened.account !== review.account) throw fail('account_changed');
          const found = await opened.session.read(token.versionId);
          if (found.status !== 'found' || (await hashEnvelope(found.envelope)) !== token.sha256)
            throw fail('remote_changed');
          let candidate = structuredClone(review.candidate);
          if (fields.length && review.contents.privateSnapshot) {
            const selections = review.contents.privateSnapshot.records.flatMap(row =>
              Object.keys(row.fields)
                .filter(field => fields.includes(field))
                .map(field => ({ characterId: row.characterId, field }))
            );
            if (selections.length)
              candidate = applyPrivateSelection(
                review.contents.privateSnapshot,
                review.contents.publicSnapshot,
                candidate,
                selections
              );
          }
          const cfg = readStandaloneState(candidate.settings);
          const row = cfg[token.provider];
          row.account = opened.account;
          row.baseHash = review.cloudHash;
          row.accepted = addPin(row.accepted, filePin({ versionId: token.versionId, sha256: token.sha256 }));
          cfg.key = { bundle: review.key.bundle, pin: review.key.pin };
          candidate.settings.cloudStandaloneFiles = cfg;
          const result = await ports.replace(review.original, candidate);
          if (result.status === 'applied') {
            reviews.delete(token);
            if (remember) {
              try {
                await ports.rememberKey(review.key);
              } catch {
                return { ...result, remembering: 'unavailable' };
              }
            }
          }
          return result;
        } finally {
          opened?.session?.dispose();
        }
      });
    },
    /** Prepare one identical encrypted file for all healthy selected providers. */
    prepareSave(options) {
      return run(async () => {
        const targets = [...new Set(options.targets)];
        if (!targets.length || targets.some(provider => !PROVIDERS.includes(provider)))
          throw fail('destination_required');
        if (!options.source) await ports.ensureIds();
        const original = ports.snapshot();
        const source = options.source || original;
        if (options.fields?.length && !options.source) ports.assertContacts?.(source);
        const scanned = await scanAll(targets, true);
        const supersedes = [...new Map(scanned.entries.map(entry => [entry.versionId, pinOf(entry)])).values()];
        if (!key) key = (await ports.recalledKey?.(config().key)) || null;
        const sealed = await seal({ ...options, snapshot: source, unlocked: key, supersedes, cryptoSource });
        key = sealed.unlocked;
        const sha256 = await hashEnvelope(sealed.envelope);
        const contentHash = await snapshotFileHash(sealed.contents.publicSnapshot, cryptoSource);
        const token = Object.freeze({
          targets,
          results: scanned.results,
          remoteCopies: heads(scanned.entries).length,
          hasPrivate: !!sealed.contents.privateSnapshot,
          versionId: sealed.envelope.versionId
        });
        uploads.set(token, {
          ...sealed,
          sha256,
          contentHash,
          sourceWitness: sourceWitness(original),
          // Recheck exact observed file set before each write; no snapshot winner by date.
          observed: new Map(
            targets.map(provider => [
              provider,
              scanned.entries
                .filter(entry => entry.provider === provider)
                .map(entry => JSON.stringify(pinOf(entry)))
                .sort()
                .join('|')
            ])
          )
        });
        return token;
      });
    },
    save(token, { confirmed = false, remember = false } = {}) {
      return run(async () => {
        const prepared = uploads.get(token);
        if (!prepared || !confirmed) throw fail('confirmation_required');
        uploads.delete(token);
        const results = [];
        for (const provider of token.targets) {
          let opened;
          try {
            if (sourceWitness(ports.snapshot()) !== prepared.sourceWitness) throw fail('local_changed');
            if (config()[provider].pending) {
              opened = await connect(provider);
              const previous = await confirmPending(provider, opened);
              if (previous.status !== 'sent_verified') {
                results.push(previous);
                continue;
              }
              // The user explicitly confirmed saving the prepared CURRENT source.
              // Settling an earlier receipt alone must not report that source sent.
              // Only after exact settlement may this same manual action proceed;
              // normal source/remote rechecks below still apply.
              opened.session.dispose();
              opened = null;
            }
            if (token.results.find(row => row.provider === provider)?.status === 'unavailable')
              throw fail('unavailable');
            opened = await connect(provider, true);
            const current = await readCopies(provider, opened, true);
            const witnessed = current
              .map(entry => JSON.stringify(pinOf(entry)))
              .sort()
              .join('|');
            if (witnessed !== prepared.observed.get(provider)) throw fail('remote_changed');
            let fileId = null;
            if (provider === 'google') {
              const allocated = await opened.session.generateFileId();
              if (allocated.status !== 'generated') throw fail('unavailable');
              fileId = allocated.fileId;
            }
            const pending = {
              envelope: prepared.envelope,
              pin: { versionId: prepared.envelope.versionId, sha256: prepared.sha256 },
              fileId,
              phase: 'prepared',
              contentHash: prepared.contentHash
            };
            await patch(cfg => {
              const row = cfg[provider];
              if (row.pending) throw fail('pending_changed');
              row.account = opened.account;
              row.folderId = opened.folderId || null;
              row.pending = pending;
              cfg.key = { bundle: prepared.unlocked.bundle, pin: prepared.unlocked.pin };
            });
            if (sourceWitness(ports.snapshot()) !== prepared.sourceWitness) throw fail('local_changed');
            await patch(cfg => {
              cfg[provider].pending.phase = 'attempting';
            });
            if (sourceWitness(ports.snapshot()) !== prepared.sourceWitness) throw fail('local_changed');
            // The durable intent exists before the ONLY upload call. Regardless of
            // HTTP success/failure/timeout, only exact readback may report success.
            try {
              await opened.session.upload({ envelope: pending.envelope, ...(fileId ? { fileId } : {}) });
            } catch {
              /* Verify uncertain outcomes; never create another version. */
            }
            results.push(await confirmPending(provider, opened));
          } catch (error) {
            const code = ['local_changed', 'remote_changed', 'account_changed'].includes(error.message)
              ? error.message
              : config()[provider].pending
                ? 'verification_pending'
                : 'unavailable';
            results.push({ provider, status: code });
          } finally {
            opened?.session?.dispose();
          }
        }
        let remembering = 'not_requested';
        if (remember && results.some(row => row.status === 'sent_verified')) {
          try {
            await ports.rememberKey(prepared.unlocked);
            remembering = 'remembered';
          } catch {
            remembering = 'unavailable';
          }
        }
        return { results, remembering };
      });
    },
    /** Explicit continuation reuses the identical immutable path and preallocated ID.
     * It verifies BEFORE retry and never sends a fresh version for an unknown one. */
    continuePending(provider) {
      return run(async () => {
        let opened;
        try {
          opened = await connect(provider);
          const checked = await confirmPending(provider, opened);
          if (checked.status !== 'verification_pending') return checked;
          const pending = config()[provider].pending;
          const current = await opened.session.verify({
            envelope: pending.envelope,
            ...(pending.fileId ? { fileId: pending.fileId } : {})
          });
          if (current.status !== 'not_found') return checked;
          await patch(cfg => {
            cfg[provider].pending.phase = 'attempting';
          });
          try {
            await opened.session.upload({
              envelope: pending.envelope,
              ...(pending.fileId ? { fileId: pending.fileId } : {})
            });
          } catch {
            /* Exact readback remains the only success signal. */
          }
          return await confirmPending(provider, opened);
        } finally {
          opened?.session?.dispose();
        }
      });
    },
    forgetRememberedKey() {
      return run(async () => {
        await ports.forgetKey?.();
        key = null;
        decoded.clear();
        observations.clear();
        reviews = new WeakMap();
        uploads = new WeakMap();
      });
    }
  });
}
