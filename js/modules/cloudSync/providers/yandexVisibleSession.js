// @ts-check
// Standalone copies use one fixed ordinary directory. app:/ is read-only legacy
// storage; it is never moved, deleted, or chosen as a fallback upload destination.
import { createAuthenticatedCloudSession } from './authenticatedSession.js';
import { STANDALONE_DATASET_ID, MAX_STANDALONE_COPIES } from '../standaloneFileConstants.js';
import {
  cloudAccessDiagnostic,
  withCloudAccessDiagnostic,
  cloudAccessHttpDiagnostic
} from './cloudAccessDiagnostics.js';

import { YANDEX_VISIBLE_ROOT } from './yandexDisk.js';
const API = 'https://cloud-api.yandex.net';

/** @param {any} options */
export function createYandexVisibleSession(options) {
  if (options.provider !== 'yandex' || options.datasetId !== STANDALONE_DATASET_ID)
    throw new Error('invalid_visible_session');
  const nativeFetch = options.fetchImpl;
  let denied = false;
  let lastDenied = false;
  let folderState = 'unknown';
  /** @type {typeof fetch} */
  const visibleFetch = async (address, init) => {
    const original = String(address);
    const url = new URL(original);
    const path = url.searchParams.get('path');
    if (url.origin !== API || !path?.startsWith('app:/')) return nativeFetch(address, init);
    url.searchParams.set('path', YANDEX_VISIBLE_ROOT + path.slice(5));
    const response = await nativeFetch(url.toString(), init);
    if (response.status === 403) {
      denied = true;
      lastDenied = true;
    }
    if (path === 'app:/' && url.pathname === '/v1/disk/resources') {
      folderState = response.status === 404 ? 'missing' : response.status === 200 ? 'present' : 'unknown';
      if (response.status === 404) return emptyDirectory(url, original);
    }
    // The inner protocol validates the original, fixed app:/ request. This is a
    // local address translation, never an HTTP redirect or arbitrary URL proxy.
    const reply = new Response(response.body, { status: response.status, headers: response.headers });
    Object.defineProperty(reply, 'url', { value: original });
    return withCloudAccessDiagnostic(reply, cloudAccessDiagnostic(response));
  };
  const primary = createAuthenticatedCloudSession({ ...options, fetchImpl: visibleFetch });
  // A genuinely absent legacy root is empty, not an unavailable provider. Do
  // not turn 401/403/5xx, malformed responses or missing file reads into empty.
  const legacyFetch = async (address, init) => {
    const response = await nativeFetch(address, init);
    const url = new URL(String(address));
    if (
      init.method === 'GET' &&
      url.origin === API &&
      url.pathname === '/v1/disk/resources' &&
      url.searchParams.get('path') === 'app:/' &&
      response.status === 404
    )
      return emptyDirectory(url, String(address));
    return response;
  };
  const legacy = createAuthenticatedCloudSession({ ...options, fetchImpl: legacyFetch });
  function emptyDirectory(url, original) {
    const reply = new Response(
      JSON.stringify({
        type: 'dir',
        _embedded: {
          offset: Number(url.searchParams.get('offset')),
          limit: Number(url.searchParams.get('limit')),
          total: 0,
          items: []
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    Object.defineProperty(reply, 'url', { value: original });
    return reply;
  }
  function folderFailure(status, reply) {
    const code = cloudAccessDiagnostic(reply) || reply?.status;
    return withCloudAccessDiagnostic(
      { status },
      typeof code === 'string' && code.startsWith('disk_') ? code.replace('disk_', 'folder_') : code
    );
  }
  async function inspectStorage() {
    folderState = 'unknown';
    const access = await primary.checkAccount();
    if (access.status !== 'access_verified')
      return folderFailure(access.status === 'account_mismatch' ? 'account_mismatch' : 'folder_unavailable', access);
    return { status: folderState === 'missing' ? 'folder_missing' : 'folder_ready' };
  }
  async function ensureStorage() {
    const found = await inspectStorage();
    if (found.status !== 'folder_missing') return found;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 70_000);
    try {
      const url = new URL(`${API}/v1/disk/resources`);
      url.searchParams.set('path', YANDEX_VISIBLE_ROOT.slice(0, -1));
      const response = await nativeFetch(url.toString(), {
        method: 'PUT',
        headers: { Accept: 'application/json', Authorization: `OAuth ${options.accessToken}` },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (response.status !== 201 && response.status !== 409)
        return withCloudAccessDiagnostic(
          { status: 'folder_not_created' },
          cloudAccessDiagnostic(response) || cloudAccessHttpDiagnostic('folder', response.status)
        );
      // Even a 201 is not enough: confirm the same fixed path is a directory.
      const verified = await inspectStorage();
      if (verified.status !== 'folder_ready') return folderFailure('folder_creation_unconfirmed', verified);
      return { status: response.status === 201 ? 'folder_created' : 'folder_ready' };
    } catch (error) {
      // Only an empty directory may have been created. NEVER replay this PUT
      // automatically and never claim a cloud file has been saved.
      return folderFailure('folder_creation_unconfirmed', error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(versionId) {
    lastDenied = false;
    const current = await primary.read(versionId);
    if (!['found', 'not_found'].includes(current.status) && !lastDenied) return current;
    const old = await legacy.read(versionId);
    if (!['found', 'not_found'].includes(old.status)) return old;
    if (
      current.status === 'found' &&
      old.status === 'found' &&
      JSON.stringify(current.envelope) !== JSON.stringify(old.envelope)
    )
      return { status: 'content_mismatch' };
    return current.status === 'found' ? current : old;
  }
  return Object.freeze({
    checkAccount: () => primary.checkAccount(),
    inspectStorage,
    ensureStorage,
    storageNotice: () => (denied ? 'visible_permissions_required' : null),
    async listWithDates() {
      denied = false;
      lastDenied = false;
      const current = await primary.listWithDates();
      if (current.status !== 'listed' && !lastDenied) return current;
      const old = await legacy.listWithDates();
      if (old.status !== 'listed') return old;
      const entries = new Map(old.versions.map(row => [row.versionId, row]));
      for (const row of current.versions || []) entries.set(row.versionId, row);
      if (entries.size > MAX_STANDALONE_COPIES) return { status: 'unavailable' };
      return {
        status: 'listed',
        versions: [...entries.values()].sort((a, b) => a.versionId.localeCompare(b.versionId))
      };
    },
    read,
    async upload(args) {
      const folder = await ensureStorage();
      if (folder.status === 'account_mismatch') return folder;
      if (!['folder_ready', 'folder_created'].includes(folder.status))
        return withCloudAccessDiagnostic({ status: 'not_sent' }, cloudAccessDiagnostic(folder));
      // Once the file PUT can start, preserve the upload transport's uncertain
      // outcome. Never relabel a thrown/unknown file write as definitely absent.
      return primary.upload(args);
    },
    async verify(args) {
      lastDenied = false;
      const current = await primary.verify(args);
      if (current.status !== 'not_found' && !(lastDenied && current.status === 'unavailable')) {
        if (current.status !== 'verified') return current;
        const old = await legacy.read(args.envelope.versionId);
        if (old.status === 'not_found') return { ...current, storageLocation: 'visible' };
        if (old.status !== 'found') return old;
        return JSON.stringify(old.envelope) === JSON.stringify(args.envelope)
          ? { ...current, storageLocation: 'visible' }
          : { status: 'mismatch' };
      }
      // Settle pre-upgrade receipts without copying, deleting, or replaying them.
      const old = await legacy.verify(args);
      return old.status === 'verified' ? { ...old, storageLocation: 'legacy' } : old;
    },
    generateFileId: () => primary.generateFileId(),
    trashVersion: async () => ({ status: 'not_sent' })
  });
}
