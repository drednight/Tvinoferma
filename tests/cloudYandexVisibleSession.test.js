import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { encryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { cloudAccessDiagnostic } from '../js/modules/cloudSync/providers/cloudAccessDiagnostics.js';
import { STANDALONE_DATASET_ID } from '../js/modules/cloudSync/standaloneFileConstants.js';
import { createNativeDiskFetch } from '../js/modules/cloudSync/providers/nativeDiskFetch.js';
import { createYandexVisibleSession } from '../js/modules/cloudSync/providers/yandexVisibleSession.js';
import { YANDEX_VISIBLE_ROOT, YANDEX_VISIBLE_FOLDER } from '../js/modules/cloudSync/providers/yandexDisk.js';

let envelope, other;
beforeAll(async () => {
  const recoveryKey = generateRecoveryKey(webcrypto);
  const args = {
    snapshot: { value: 'synthetic' },
    recoveryKey,
    datasetId: STANDALONE_DATASET_ID,
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  };
  envelope = await encryptSnapshot(args);
  other = await encryptSnapshot({ ...args, snapshot: { value: 'different' } });
});
function fixture() {
  const files = new Map();
  const flags = {
    visibleExists: false,
    visibleError: 0,
    legacyError: 0,
    wrongAccount: false,
    folderFile: false,
    uploadThrows: false,
    folderThrows: false,
    hideCreated: false,
    folderError: 0,
    folderReply: 201,
    conflictOnCreate: false
  };
  const name = version => `tf-v1-${STANDALONE_DATASET_ID}-${version}.tfsc`;
  const path = (root, version) => `${root}${name(version)}`;
  const empty = status => ({ status, body: '', contentType: null });
  const json = body => ({ status: 200, body: JSON.stringify(body), contentType: 'application/json' });
  const invoke = vi.fn(async (command, { args }) => {
    expect(command).toBe('cloud_disk_network');
    const visible = args.folderId === YANDEX_VISIBLE_FOLDER;
    const root = visible ? YANDEX_VISIBLE_ROOT : 'app:/';
    if (args.operation === 'identity')
      return json({ client_id: '0123456789abcdef', psuid: flags.wrongAccount ? 'OTHER' : 'ACCOUNT' });
    if (visible && flags.visibleError) return empty(flags.visibleError);
    if (!visible && ['list', 'download_link'].includes(args.operation) && flags.legacyError)
      return empty(flags.legacyError);
    if (args.operation === 'folder_create') {
      if (flags.folderThrows) throw 'cloud_disk_connect';
      if (flags.folderError) return empty(flags.folderError);
      if (flags.visibleExists || flags.folderFile) return empty(409);
      flags.visibleExists = true;
      flags.folderFile = flags.conflictOnCreate;
      return empty(flags.folderReply);
    }
    if (args.operation === 'list') {
      if (visible && ((!flags.visibleExists && !flags.folderFile) || flags.hideCreated)) return empty(404);
      if (visible && flags.folderFile) return json({ type: 'file' });
      const all = [...files.keys()].filter(key => key.startsWith(root)).sort();
      const items = all
        .slice(args.offset, args.offset + args.limit)
        .map(key => ({ name: key.slice(root.length), type: 'file', modified: '2026-11-01T10:00:00Z' }));
      return json({ type: 'dir', _embedded: { offset: args.offset, limit: args.limit, total: all.length, items } });
    }
    if (args.operation === 'download_link') {
      const target = path(root, args.versionId);
      return files.has(target)
        ? json({
            href: `https://downloader.disk.yandex.ru/disk/fake?path=${encodeURIComponent(target)}`,
            method: 'GET',
            templated: false
          })
        : empty(404);
    }
    if (args.operation === 'download_content') {
      const target = new URL(args.link).searchParams.get('path');
      return files.has(target)
        ? { status: 200, body: files.get(target), contentType: 'application/octet-stream' }
        : empty(404);
    }
    if (args.operation === 'upload_link')
      return json({
        href: `https://uploader9x.disk.yandex.net/upload-target/fake?path=${encodeURIComponent(path(root, args.versionId))}`,
        method: 'PUT',
        templated: false
      });
    if (args.operation === 'upload_content') {
      expect(args.accessToken).toBeUndefined();
      const target = new URL(args.link).searchParams.get('path');
      files.set(target, args.body);
      if (flags.uploadThrows) throw 'cloud_disk_connect';
      return empty(201);
    }
    throw new Error('unexpected synthetic operation');
  });
  const fetchImpl = createNativeDiskFetch({ provider: 'yandex', invoke });
  const session = createYandexVisibleSession({
    provider: 'yandex',
    clientId: '0123456789abcdef',
    accountKey: 'ACCOUNT',
    datasetId: STANDALONE_DATASET_ID,
    accessToken: 'FAKE_TOKEN',
    fetchImpl,
    cryptoSource: webcrypto
  });
  return {
    session,
    flags,
    files,
    invoke,
    fetchImpl,
    path,
    put(root = 'app:/', value = envelope) {
      files.set(path(root, value.versionId), JSON.stringify(value));
      if (root === YANDEX_VISIBLE_ROOT) flags.visibleExists = true;
    }
  };
}
describe('ordinary Yandex folder with immutable legacy reads', () => {
  it('does not create a directory during read-only checks; lists and reads old app files', async () => {
    const f = fixture();
    f.put();
    expect(await f.session.listWithDates()).toMatchObject({
      status: 'listed',
      versions: [{ versionId: envelope.versionId }]
    });
    expect(await f.session.read(envelope.versionId)).toMatchObject({ status: 'found', envelope });
    expect(f.flags.visibleExists).toBe(false);
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'folder_create')).toBe(false);
  });
  it('writes new copies only to the fixed ordinary directory, verifies bytes, and never deletes legacy files', async () => {
    const f = fixture();
    f.put();
    const args = { envelope: other };
    // This version already exists in app:/ with different bytes: upload must
    // not overwrite it or silently pick the newer/ordinary copy during review.
    expect((await f.session.upload(args)).status).toBe('accepted');
    expect(f.files.get(f.path(YANDEX_VISIBLE_ROOT, other.versionId))).toBe(JSON.stringify(other));
    expect(f.files.get(f.path('app:/', envelope.versionId))).toBe(JSON.stringify(envelope));
    expect((await f.session.read(envelope.versionId)).status).toBe('content_mismatch');
    expect((await f.session.verify(args)).status).toBe('mismatch');
    expect(
      f.invoke.mock.calls
        .filter(([, a]) => a.args.operation === 'upload_link')
        .every(([, a]) => a.args.folderId === YANDEX_VISIBLE_FOLDER)
    ).toBe(true);
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'retire')).toBe(false);
  });
  it('verifies and lists a new ordinary file and preserves a legacy pending receipt without sending', async () => {
    const f = fixture();
    expect((await f.session.upload({ envelope })).status).toBe('accepted');
    expect((await f.session.verify({ envelope })).status).toBe('verified');
    expect((await f.session.listWithDates()).versions).toHaveLength(1);
    const old = fixture();
    old.put();
    expect((await old.session.verify({ envelope })).status).toBe('verified');
    expect(
      old.invoke.mock.calls.some(([, a]) =>
        ['folder_create', 'upload_content', 'upload_link'].includes(a.args.operation)
      )
    ).toBe(false);
  });
  it('uses a verified existing directory, refuses a file with the directory name', async () => {
    const f = fixture();
    f.flags.visibleExists = true;
    expect((await f.session.upload({ envelope })).status).toBe('accepted');
    const bad = fixture();
    bad.flags.folderFile = true;
    expect((await bad.session.upload({ envelope })).status).not.toBe('accepted');
    expect(bad.invoke.mock.calls.some(([, a]) => a.args.operation === 'upload_link')).toBe(false);
  });
  it('keeps legacy copies readable with old app-only authorization, explains missing rights, never falls back to legacy upload', async () => {
    const f = fixture();
    f.flags.visibleError = 403;
    f.put();
    expect((await f.session.listWithDates()).status).toBe('listed');
    expect(f.session.storageNotice()).toBe('visible_permissions_required');
    expect((await f.session.read(envelope.versionId)).status).toBe('found');
    expect((await f.session.upload({ envelope })).status).not.toBe('accepted');
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'upload_link')).toBe(false);
  });
  it('does not hide connection/server failures as an empty folder or a successful legacy fallback', async () => {
    const f = fixture();
    f.flags.visibleError = 500;
    f.put();
    expect((await f.session.listWithDates()).status).toBe('unavailable');
    expect((await f.session.read(envelope.versionId)).status).toBe('unavailable');
    f.flags.visibleError = 0;
    f.flags.legacyError = 500;
    f.put(YANDEX_VISIBLE_ROOT);
    expect((await f.session.listWithDates()).status).toBe('unavailable');
  });
  it('checks account identity before creating any directory', async () => {
    const f = fixture();
    f.flags.wrongAccount = true;
    expect((await f.session.upload({ envelope })).status).toBe('account_mismatch');
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'folder_create')).toBe(false);
  });
  it('distinguishes an unknown encrypted-file PUT from an uncertain directory-only creation', async () => {
    const f = fixture();
    f.flags.uploadThrows = true;
    expect((await f.session.upload({ envelope })).status).toBe('unknown');
    expect((await f.session.verify({ envelope })).status).toBe('verified');
    const folder = fixture();
    folder.flags.folderThrows = true;
    expect((await folder.session.upload({ envelope })).status).toBe('not_sent');
    expect(folder.invoke.mock.calls.some(([, a]) => a.args.operation === 'upload_content')).toBe(false);
  });
  it('rejects other directories, extra query fields and arbitrary datasets before native IPC', async () => {
    const f = fixture();
    const init = {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'OAuth FAKE_TOKEN' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: new AbortController().signal
    };
    for (const path of [
      'disk:/Private/',
      'disk:/Твиноферма/../other',
      'disk:/Твиноферма/tf-v1-01234567-89ab-4cde-8f01-23456789abcd-' + envelope.versionId + '.tfsc'
    ]) {
      const url = new URL('https://cloud-api.yandex.net/v1/disk/resources');
      url.searchParams.set('path', path);
      await expect(f.fetchImpl(url.toString(), init)).rejects.toThrow();
    }
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('independent Yandex directory preparation', () => {
  it('treats only a genuine legacy root 404 as empty, so a first ordinary save is not blocked', async () => {
    const f = fixture();
    f.flags.legacyError = 404;
    expect(await f.session.listWithDates()).toEqual({ status: 'listed', versions: [] });
    expect((await f.session.read(envelope.versionId)).status).toBe('not_found');
    expect((await f.session.upload({ envelope })).status).toBe('accepted');
    expect(f.flags.visibleExists).toBe(true);
    expect((await f.session.verify({ envelope })).status).toBe('verified');
  });
  it.each([401, 403, 429, 500])('does not relabel a legacy %s as an empty root', async status => {
    const f = fixture();
    f.flags.legacyError = status;
    expect((await f.session.listWithDates()).status).not.toBe('listed');
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'folder_create')).toBe(false);
  });
  it('checks only the ordinary directory, without creating it or reading legacy/file contents', async () => {
    const f = fixture();
    f.flags.legacyError = 500;
    expect(await f.session.inspectStorage()).toEqual({ status: 'folder_missing' });
    expect(f.invoke.mock.calls.every(([, a]) => ['identity', 'list'].includes(a.args.operation))).toBe(true);
    expect(
      f.invoke.mock.calls
        .filter(([, a]) => a.args.operation === 'list')
        .every(([, a]) => a.args.folderId === YANDEX_VISIBLE_FOLDER)
    ).toBe(true);
  });
  it('creates only the fixed empty folder, verifies it, does not upload and does not repeat a PUT when it already exists', async () => {
    const f = fixture();
    f.flags.legacyError = 500;
    expect(await f.session.ensureStorage()).toEqual({ status: 'folder_created' });
    expect(f.files.size).toBe(0);
    expect(await f.session.ensureStorage()).toEqual({ status: 'folder_ready' });
    expect(f.invoke.mock.calls.filter(([, a]) => a.args.operation === 'folder_create')).toHaveLength(1);
    expect(f.invoke.mock.calls.some(([, a]) => /upload|download/.test(a.args.operation))).toBe(false);
  });
  it('never reports a 201 alone as verified creation', async () => {
    const f = fixture();
    f.flags.hideCreated = true;
    expect((await f.session.ensureStorage()).status).toBe('folder_creation_unconfirmed');
    expect(f.invoke.mock.calls.filter(([, a]) => a.args.operation === 'folder_create')).toHaveLength(1);
    expect(f.files.size).toBe(0);
  });
  it('preserves an uncertain creation as such and exposes a fixed folder-connect reason without raw details', async () => {
    const f = fixture();
    f.flags.folderThrows = true;
    const result = await f.session.ensureStorage();
    expect(result.status).toBe('folder_creation_unconfirmed');
    expect(cloudAccessDiagnostic(result)).toBe('folder_native_connect');
    expect(JSON.stringify(result)).not.toContain('FAKE_TOKEN');
  });
  it('distinguishes a denied folder creation from a failed file upload', async () => {
    const f = fixture();
    f.flags.folderError = 403;
    const result = await f.session.ensureStorage();
    expect(result.status).toBe('folder_not_created');
    expect(cloudAccessDiagnostic(result)).toBe('folder_forbidden');
    expect(f.invoke.mock.calls.some(([, a]) => a.args.operation === 'upload_content')).toBe(false);
  });
});

it('accepts a concurrent 409 only after rechecking a real directory; never overwrites a file conflict', async () => {
  const good = fixture();
  good.flags.folderReply = 409;
  expect((await good.session.ensureStorage()).status).toBe('folder_ready');
  const bad = fixture();
  bad.flags.folderReply = 409;
  bad.flags.conflictOnCreate = true;
  expect((await bad.session.ensureStorage()).status).toBe('folder_creation_unconfirmed');
  expect(bad.invoke.mock.calls.filter(([, a]) => a.args.operation === 'folder_create')).toHaveLength(1);
  expect(bad.files.size).toBe(0);
  expect(bad.invoke.mock.calls.some(([, a]) => a.args.operation === 'upload_content')).toBe(false);
});
