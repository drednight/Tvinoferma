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
    // An absent directory is an empty collection, NOT a reason to create it on
    // a read-only automatic check. All other failures remain failures.
    if (path === 'app:/' && response.status === 404 && url.pathname === '/v1/disk/resources') {
      return new Response(
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
    }
    // The inner protocol validates the original, fixed app:/ request. This is a
    // local address translation, never an HTTP redirect or arbitrary URL proxy.
    const reply = new Response(response.body, { status: response.status, headers: response.headers });
    Object.defineProperty(reply, 'url', { value: original });
    return withCloudAccessDiagnostic(reply, cloudAccessDiagnostic(response));
  };
  const primary = createAuthenticatedCloudSession({ ...options, fetchImpl: visibleFetch });
  const legacy = createAuthenticatedCloudSession(options);
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
      const identity = await primary.checkAccount();
      if (identity.status !== 'access_verified') return identity;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 70_000);
      try {
        const url = new URL(`${API}/v1/disk/resources`);
        // No overwrite, no arbitrary path, no recursive creation or deletion.
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
            { status: 'not_sent' },
            cloudAccessDiagnostic(response) || cloudAccessHttpDiagnostic('disk', response.status)
          );
        if (response.status === 409 && (await primary.listWithDates()).status !== 'listed')
          return { status: 'not_sent' };
      } catch (error) {
        // Only directory creation may have run; no encrypted file PUT started.
        return withCloudAccessDiagnostic({ status: 'not_sent' }, cloudAccessDiagnostic(error));
      } finally {
        clearTimeout(timer);
      }
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
        if (old.status === 'not_found') return current;
        if (old.status !== 'found') return old;
        return JSON.stringify(old.envelope) === JSON.stringify(args.envelope) ? current : { status: 'mismatch' };
      }
      // Settle pre-upgrade receipts without copying, deleting, or replaying them.
      return legacy.verify(args);
    },
    generateFileId: () => primary.generateFileId(),
    trashVersion: async () => ({ status: 'not_sent' })
  });
}
