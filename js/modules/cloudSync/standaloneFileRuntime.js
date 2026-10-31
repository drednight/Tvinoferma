// @ts-check
// Desktop composition. Metadata contains public bundle + encrypted pending file,
// never password/dataKey. OS-vault remembering is explicit and separately scoped.
import { saveNow } from '../../core/storage.js';
import { currentCloudStateSnapshot, stageGuardedCloudStateWrite } from './guardedStateWrite.js';
import { stageSyncIdentities } from './commitSyncIdentities.js';
import { beginCloudCredentialOperation } from './credentialResetCoordination.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { openStoredNativeCloudSession, openStoredStandaloneGoogleFolder } from './providers/nativeCloudSession.js';
import { createStandaloneFileExchange, readStandaloneState } from './standaloneFileExchange.js';
import { STANDALONE_DATASET_ID, validateStandaloneKeyRecord } from './standaloneFileCodec.js';
import { verifyKeyBundleDataKey } from './keyBundle.js';
import { privateSourceAvailable } from './snapshotFilePrivate.js';

function error(code) {
  return new Error(code);
}
async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** @param {{invoke:(command:string,args?:any)=>Promise<any>}} native */
export function createStandaloneFileRuntime(native) {
  let refreshUncertain = false;
  async function replace(original, candidate, label = 'pre-cloud-standalone-file-replace') {
    return stageGuardedCloudStateWrite({
      original,
      candidate,
      backupLabel: label,
      selectedCount: original.characters.length + original.archivedCharacters.length
    }).commit({ confirmed: true });
  }
  async function patch(change) {
    await saveNow();
    const original = currentCloudStateSnapshot();
    const cfg = readStandaloneState(original.settings);
    change(cfg);
    const candidate = structuredClone(original);
    candidate.settings.cloudStandaloneFiles = cfg;
    readStandaloneState(candidate.settings);
    const result = await replace(original, candidate, 'pre-cloud-standalone-file-receipt');
    if (result.status !== 'applied') throw error(result.status);
  }
  async function open(provider, { createFolder }) {
    const local = await readNativeCredentialBinding({ provider, invoke: native.invoke });
    if (local.status === 'empty') throw error('credential_missing');
    if (local.status !== 'ready' || !local.binding) throw error('credential_blocked');
    const account = await digest(JSON.stringify([provider, local.binding.clientId, local.binding.accountKey]));
    let row = readStandaloneState(currentCloudStateSnapshot().settings)[provider];
    if (row.account !== null && row.account !== account) throw error('account_changed');
    let folderId;
    if (provider === 'google') {
      refreshUncertain = true;
      const opened = await openStoredStandaloneGoogleFolder({ invoke: native.invoke });
      if (opened.status !== 'opened') throw error(opened.status);
      refreshUncertain = false;
      try {
        let found = await opened.session.discover();
        if (!['empty', 'candidate', 'ambiguous'].includes(found.status)) throw error('folder_unavailable');
        if (found.folders.length === 0 && !createFolder) return { account, session: null };
        if (row.folderId) {
          if (!found.folders.some(folder => folder.folderId === row.folderId)) throw error('folder_changed');
          folderId = row.folderId;
        } else if (found.folders.length === 1) folderId = found.folders[0].folderId;
        else if (found.folders.length > 1) {
          const ambiguity = Object.assign(error('folder_ambiguous'), { folders: found.folders });
          throw ambiguity;
        } else {
          if (!row.pendingFolder) {
            const allocated = await opened.session.generateFileId();
            if (allocated.status !== 'generated') throw error('folder_unavailable');
            await patch(cfg => {
              cfg.google.account = account;
              cfg.google.pendingFolder = { fileId: allocated.fileId };
            });
            row = readStandaloneState(currentCloudStateSnapshot().settings).google;
          }
          // Retries, including after unknown outcome, reuse the same durable ID.
          // Discovery is always performed before another POST.
          await opened.session.createOnce({ fileId: row.pendingFolder.fileId });
          found = await opened.session.discover();
          if (!found.folders?.some(folder => folder.folderId === row.pendingFolder.fileId))
            throw error('folder_verification_pending');
          folderId = row.pendingFolder.fileId;
        }
        if (createFolder && (row.folderId !== folderId || row.pendingFolder)) {
          await patch(cfg => {
            cfg.google.account = account;
            cfg.google.folderId = folderId;
            cfg.google.pendingFolder = null;
          });
        }
      } finally {
        opened.session.dispose();
      }
    }
    if (provider === 'google') refreshUncertain = true;
    const opened = /** @type {any} */ (
      await openStoredNativeCloudSession({
        provider,
        datasetId: STANDALONE_DATASET_ID,
        invoke: native.invoke,
        ...(folderId ? { folderId } : {})
      })
    );
    if (opened.status !== 'opened') throw error(opened.status);
    if (provider === 'google') refreshUncertain = false;
    return { account, folderId: folderId || null, session: opened.session };
  }
  return createStandaloneFileExchange({
    snapshot: currentCloudStateSnapshot,
    patch,
    open,
    replace,
    begin() {
      // The file engine isolates receipts per provider. A legacy queue or unknown
      // Google refresh must not quarantine healthy Yandex operations. Native
      // credential/account CAS remains authoritative for each provider.
      const operation = beginCloudCredentialOperation();
      refreshUncertain = false;
      return () => operation.finish(refreshUncertain);
    },
    async chooseFolder(folderId) {
      const local = await readNativeCredentialBinding({ provider: 'google', invoke: native.invoke });
      if (local.status !== 'ready' || !local.binding) throw error('credential_missing');
      const account = await digest(JSON.stringify(['google', local.binding.clientId, local.binding.accountKey]));
      refreshUncertain = true;
      const opened = await openStoredStandaloneGoogleFolder({ invoke: native.invoke });
      if (opened.status !== 'opened') throw error(opened.status);
      refreshUncertain = false;
      try {
        const found = await opened.session.discover();
        if (!found.folders?.some(folder => folder.folderId === folderId)) throw error('folder_changed');
        await patch(cfg => {
          const row = cfg.google;
          if (
            (row.account && row.account !== account) ||
            row.pending ||
            (row.pendingFolder && row.pendingFolder.fileId !== folderId)
          )
            throw error('pending_changed');
          row.account = account;
          row.folderId = folderId;
          row.pendingFolder = null;
        });
      } finally {
        opened.session.dispose();
      }
    },
    assertContacts(snapshot) {
      if (!privateSourceAvailable(snapshot)) throw error('contacts_unavailable');
    },
    async ensureIds() {
      await saveNow();
      const staged = stageSyncIdentities();
      if (staged.status === 'prepared') {
        const result = await staged.operation.commit({ confirmed: true });
        if (result.status !== 'applied') throw error(result.status);
      }
    },
    async recalledKey(publicKey) {
      if (!publicKey) return null;
      try {
        const raw = await native.invoke('cloud_simple_key_read');
        if (raw === null) return null;
        if (typeof raw !== 'string' || raw.length > 256) return null;
        const remembered = validateStandaloneKeyRecord(JSON.parse(raw));
        if (remembered.bundleId !== publicKey.bundle.bundleId) return null;
        await verifyKeyBundleDataKey({
          bundle: publicKey.bundle,
          expectedDatasetId: STANDALONE_DATASET_ID,
          expectedPin: publicKey.pin,
          dataKey: remembered.dataKey
        });
        return { ...publicKey, dataKey: remembered.dataKey };
      } catch {
        return null;
      }
    },
    async rememberKey(key) {
      const record = validateStandaloneKeyRecord({ bundleId: key.bundle.bundleId, dataKey: key.dataKey });
      const payload = JSON.stringify(record);
      if ((await native.invoke('cloud_simple_key_remember', { payload })) !== null)
        throw error('remembering_unavailable');
      if ((await native.invoke('cloud_simple_key_read')) !== payload) throw error('remembering_unavailable');
    },
    async forgetKey() {
      if ((await native.invoke('cloud_simple_key_forget')) !== null) throw error('remembering_unavailable');
    }
  });
}
