import { describe, expect, it, vi } from 'vitest';
import { createGoogleFolderManager } from '../js/modules/cloudSync/providers/googleFolderManager.js';
import { createNativeDiskFetch } from '../js/modules/cloudSync/providers/nativeDiskFetch.js';
import {
  googleCreateAppFolderRequest,
  googleListAppFoldersRequest
} from '../js/modules/cloudSync/providers/googleDrive.js';
import { parseStrictCloudJson } from '../js/modules/cloudSync/providers/strictCloudJson.js';

const clientId = 'fake-client.apps.googleusercontent.com';
const accountKey = 'FAKE_ACCOUNT';
const accessToken = 'FAKE_PRIVATE_TOKEN';
const mimeType = 'application/vnd.google-apps.folder';
const folder = (id, name = 'Твиноферма') => ({ id, name, mimeType, appProperties: { tfFolder: '1' } });
const reply = (data, status = 200) => ({
  status,
  body: typeof data === 'string' ? data : JSON.stringify(data),
  contentType: 'application/json'
});
const empty = status => ({ status, body: '', contentType: null });
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fakeNative() {
  const folders = new Map();
  const calls = [];
  const listReplies = [];
  let currentAccount = accountKey;
  let lost = false;
  let createGate = null;
  const invoke = vi.fn(async (command, { args }) => {
    if (command !== 'cloud_disk_network' || args.provider !== 'google') throw new Error('bad fake IPC');
    calls.push(args.operation);
    if (args.operation === 'identity') return reply({ user: { permissionId: currentAccount } });
    if (args.operation === 'generate_id')
      return reply({ ids: ['new_folder_id'], kind: 'drive#generatedIds', space: 'drive' });
    if (args.operation === 'folder_list') {
      if (listReplies.length) return reply(listReplies.shift());
      const rows = [...folders.values()].sort((a, b) => a.id.localeCompare(b.id));
      const start = args.pageToken ? Number(args.pageToken) : 0;
      const selected = rows.slice(start, start + 1);
      return reply({
        files: selected,
        incompleteSearch: false,
        ...(start + 1 < rows.length ? { nextPageToken: String(start + 1) } : {})
      });
    }
    if (args.operation === 'folder_create') {
      if (createGate) return createGate.promise;
      if (folders.has(args.fileId)) return empty(409);
      const item = folder(args.fileId);
      folders.set(item.id, item);
      if (lost) throw new Error(`FAKE_PRIVATE_ERROR ${accessToken}`);
      return reply(item);
    }
    throw new Error('unexpected fake operation');
  });
  return {
    folders,
    calls,
    listReplies,
    invoke,
    setAccount(value) {
      currentAccount = value;
    },
    setLost(value) {
      lost = value;
    },
    setGate(value) {
      createGate = value;
    }
  };
}
function manager(native, extra = {}) {
  return createGoogleFolderManager({
    clientId,
    accountKey,
    accessToken,
    fetchImpl: createNativeDiskFetch({ provider: 'google', invoke: native.invoke }),
    ...extra
  });
}

describe('Google: папка приложения через поддельный IPC', () => {
  it('пустой поиск, явное создание с заранее выделенным ID и обнаружение со второго экземпляра', async () => {
    const native = fakeNative();
    const first = manager(native);
    expect(await first.discover()).toEqual({ status: 'empty', folders: [] });
    expect(await first.generateFileId()).toEqual({ status: 'generated', fileId: 'new_folder_id' });
    // В настоящем приложении намерение и ID ещё нужно устойчиво сохранить до вызова.
    expect(await first.createOnce({ fileId: 'new_folder_id' })).toEqual({ status: 'accepted' });
    expect(await first.createOnce({ fileId: 'different_id' })).toEqual({ status: 'blocked_in_session' });
    const second = manager(native);
    expect(await second.discover()).toEqual({
      status: 'candidate',
      folders: [{ folderId: 'new_folder_id', name: 'Твиноферма' }]
    });
    expect(await second.createOnce({ fileId: 'different_id' })).toEqual({ status: 'existing' });
    expect(native.calls.filter(call => call === 'folder_create')).toHaveLength(1);
    expect(native.folders.size).toBe(1);
  });

  it('переименованная папка остаётся кандидатом, несколько папок не выбираются автоматически', async () => {
    const native = fakeNative();
    native.folders.set('b', folder('b', 'Моя копия'));
    native.folders.set('a', folder('a', 'Переименовано'));
    const client = manager(native);
    expect(await client.discover()).toEqual({
      status: 'ambiguous',
      folders: [
        { folderId: 'a', name: 'Переименовано' },
        { folderId: 'b', name: 'Моя копия' }
      ]
    });
    expect(await client.createOnce({ fileId: 'new_folder_id' })).toEqual({ status: 'existing' });
    expect(native.calls).not.toContain('folder_create');
    expect(native.calls.filter(call => call === 'folder_list')).toHaveLength(8);
  });

  it('смена аккаунта блокирует поиск и запись до обращения к диску', async () => {
    const native = fakeNative();
    native.setAccount('OTHER_ACCOUNT');
    const client = manager(native);
    expect(await client.discover()).toEqual({ status: 'account_mismatch' });
    expect(await client.createOnce({ fileId: 'folder_id' })).toEqual({ status: 'account_mismatch' });
    expect(native.calls).toEqual(['identity', 'identity']);
  });

  it('потерянный ответ не разрешает повтор: другой экземпляр может только заново обнаружить папку', async () => {
    const native = fakeNative();
    native.setLost(true);
    const client = manager(native);
    const result = await client.createOnce({ fileId: 'folder_id' });
    expect(result).toEqual({ status: 'unknown' });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(await client.createOnce({ fileId: 'folder_id' })).toEqual({ status: 'blocked_in_session' });
    expect(native.calls.filter(call => call === 'folder_create')).toHaveLength(1);
    expect(await manager(native).discover()).toEqual({
      status: 'candidate',
      folders: [{ folderId: 'folder_id', name: 'Твиноферма' }]
    });
  });

  it('два разных обхода и неполный список не дают разрешения на создание', async () => {
    const native = fakeNative();
    native.listReplies.push({ files: [] }, { files: [folder('other')] });
    expect(await manager(native).createOnce({ fileId: 'folder_id' })).toEqual({ status: 'changed' });
    expect(native.calls).not.toContain('folder_create');
    const another = fakeNative();
    another.listReplies.push({ files: [], incompleteSearch: true });
    expect(await manager(another).createOnce({ fileId: 'folder_id' })).toEqual({ status: 'not_sent' });
    expect(another.calls).not.toContain('folder_create');
  });

  it('отклоняет повторные страницы, ID, чужие типы и дублированные поля JSON', async () => {
    const cases = [
      [
        { files: [folder('x')], nextPageToken: 'same' },
        { files: [folder('y')], nextPageToken: 'same' }
      ],
      [{ files: [folder('x')], nextPageToken: 'next' }, { files: [folder('x')] }],
      [{ files: [{ ...folder('x'), mimeType: 'text/plain' }] }],
      [{ files: [{ ...folder('x'), name: 'имя\u202eопасное' }] }],
      ['{"files":[],"\\u0066iles":[]}'],
      [
        '{"files":[{"id":"x","name":"a","mimeType":"application/vnd.google-apps.folder","appProperties":{"tfFolder":"1","tfFolder":"1"}}]}'
      ]
    ];
    for (const values of cases) {
      const native = fakeNative();
      native.listReplies.push(...values);
      expect(await manager(native).discover()).toEqual({ status: 'unavailable' });
      expect(native.calls).not.toContain('folder_create');
    }
  });

  it('таймаут POST остаётся неизвестным и не снимает занятость до завершения IPC', async () => {
    const native = fakeNative();
    const gate = deferred();
    native.setGate(gate);
    const client = manager(native, { timeoutMs: 100 });
    expect(await client.createOnce({ fileId: 'folder_id' })).toEqual({ status: 'unknown' });
    expect(client.isBusy()).toBe(true);
    expect(await client.discover()).toEqual({ status: 'busy' });
    expect(await client.createOnce({ fileId: 'folder_id' })).toEqual({ status: 'blocked_in_session' });
    gate.resolve(reply(folder('folder_id')));
    await vi.waitFor(() => expect(client.isBusy()).toBe(false));
    expect(native.calls.filter(call => call === 'folder_create')).toHaveLength(1);
  });

  it('адаптер не пропускает замену метаданных или произвольный POST', async () => {
    const invoke = vi.fn();
    const fetch = createNativeDiskFetch({ provider: 'google', invoke });
    const request = googleCreateAppFolderRequest({ fileId: 'folder_id' });
    const init = {
      method: 'POST',
      headers: { ...request.headers, Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      body: request.body,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: new AbortController().signal
    };
    for (const change of [
      { ...init, body: request.body.replace('Твиноферма', 'Чужое имя') },
      { ...init, body: request.body.replace('"id":', '"id":"other","id":') },
      { ...init, headers: { ...init.headers, Cookie: 'private' } },
      { ...init, body: '{"name":"private"}' }
    ])
      await expect(fetch(request.url, change)).rejects.toThrow();
    await expect(fetch(googleListAppFoldersRequest().url + '&extra=1', { ...init, method: 'GET' })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('строгий разбор ответов папки', () => {
  it('не допускает повторы ключей, небезопасные имена, числа, BOM и усечённые объекты', () => {
    for (const text of [
      '{"files":[],"files":[]}',
      '{"x":true,"\\u0078":false}',
      '{"__proto__":{}}',
      '{"files": [1]}',
      '\ufeff{"files":[]}',
      '{"files":',
      '{"files":[],}',
      '{"files":[],"unused":null}'
    ])
      expect(() => parseStrictCloudJson(text)).toThrow();
    expect(parseStrictCloudJson(' {"files":[{"id":"x"}],"incompleteSearch":false} ')).toEqual({
      files: [{ id: 'x' }],
      incompleteSearch: false
    });
  });
});
