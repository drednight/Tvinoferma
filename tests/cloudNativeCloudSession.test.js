import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  openNativeCloudSession,
  openStoredNativeCloudSession
} from '../js/modules/cloudSync/providers/nativeCloudSession.js';
import { prepareGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const slotId = '01234567-89ab-4cde-8f01-23456789abcd';
const revision = '11234567-89ab-4cde-8f01-23456789abcd';
const revision2 = '21234567-89ab-4cde-8f01-23456789abcd';
const datasetId = '31234567-89ab-4cde-8f01-23456789abcd';
const clients = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const accountKey = 'FAKE_PRIVATE_ACCOUNT';
const access = 'FAKE_PRIVATE_ACCESS';
const refresh = 'FAKE_PRIVATE_REFRESH';

function fixture(provider, { lostRefresh = false, identity = accountKey, expiresAt = 3_700_000 } = {}) {
  const binding = { slotId, clientId: clients[provider], accountKey };
  let record =
    provider === 'google'
      ? prepareGoogleCredentialRecord({ ...binding, revision, refreshToken: refresh, refreshExpiresAt: null })
      : prepareYandexCredentialRecord({ ...binding, revision, accessToken: access, expiresAt });
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_credential_binding_read') return { status: 'ready', ...binding };
    if (command === 'cloud_credential_read') return { status: 'ready', slotId, record };
    if (command === 'cloud_credential_compare_exchange') {
      if (record !== args.expected) return { status: 'mismatch' };
      record = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_oauth_network' && args.operation === 'refresh') {
      if (args.refreshClaim.expected !== record) throw new Error('PRIVATE stale claim');
      expect(args.refreshClaim.slotId).toBe(slotId);
      record = args.refreshClaim.pending;
      expect(JSON.parse(record).phase).toBe('pending');
      if (lostRefresh) throw new Error('PRIVATE unknown reply');
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: OAUTH_PROVIDERS.google.scope
        })
      };
    }
    if (command === 'cloud_disk_network') {
      expect(args.args.provider).toBe(provider);
      if (args.args.operation === 'identity')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? { user: { permissionId: identity } }
              : { client_id: clients.yandex, psuid: identity }
          )
        };
      if (args.args.operation === 'list')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? { files: [], incompleteSearch: false }
              : { type: 'dir', _embedded: { offset: args.args.offset, limit: args.args.limit, total: 0, items: [] } }
          )
        };
    }
    throw new Error('PRIVATE unknown fake command');
  });
  return {
    invoke,
    record: () => record,
    replace(value) {
      record = value;
    },
    binding,
    options: {
      provider,
      ...binding,
      datasetId,
      invoke,
      cryptoSource: webcrypto,
      ...(provider === 'google' ? { folderId: 'fake-folder' } : {})
    }
  };
}
function noSecret(value) {
  const text = JSON.stringify(value);
  for (const secret of [accountKey, access, refresh, 'PRIVATE unknown']) expect(text).not.toContain(secret);
}

describe.each(['google', 'yandex'])('%s: открытая сессия только с fake IPC', provider => {
  it('сверяет сохранённую запись и аккаунт перед чтением, не выдавая токен', async () => {
    const f = fixture(provider);
    const opened = await openNativeCloudSession({ ...f.options, now: () => 100_000 });
    expect(opened.status).toBe('opened');
    noSecret(opened);
    const result = await opened.session.listWithDates();
    expect(result).toEqual({ status: 'listed', versions: [] });
    noSecret(result);
    const commands = f.invoke.mock.calls
      .filter(([command]) => command === 'cloud_disk_network')
      .map(([, args]) => args.args.operation);
    expect(commands.slice(-3)).toEqual(['identity', 'list', 'list']);
    opened.session.dispose();
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_unavailable' });
  });

  it('открывает сессию из ранее закреплённого pin без ручного ввода ID аккаунта', async () => {
    const f = fixture(provider);
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const opened = await openStoredNativeCloudSession({ ...options, now: () => 100_000 });
    expect(opened.status).toBe('opened');
    noSecret(opened);
    expect(await opened.session.listWithDates()).toEqual({ status: 'listed', versions: [] });
    expect(f.invoke.mock.calls[0][0]).toBe('cloud_credential_binding_read');
    opened.session.dispose();
  });

  it.each(['empty', 'blocked', 'pending'])('состояние pin %s останавливает открытие до OAuth и диска', async state => {
    const f = fixture(provider);
    const invoke = vi.fn(async (command, args) =>
      command === 'cloud_credential_binding_read' ? { status: state } : f.invoke(command, args)
    );
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const result = await openStoredNativeCloudSession({ ...options, invoke, now: () => 100_000 });
    expect(result).toEqual({ status: state === 'empty' ? 'credential_missing' : 'credential_blocked' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('подменённый или некорректный pin не передаёт токен и не запускает диск', async () => {
    const f = fixture(provider);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_credential_binding_read')
        return { status: 'ready', ...f.binding, accountKey: 'OTHER_ACCOUNT' };
      return f.invoke(command, args);
    });
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const result = await openStoredNativeCloudSession({ ...options, invoke, now: () => 100_000 });
    expect(result.status).not.toBe('opened');
    expect(
      f.invoke.mock.calls.some(([command]) => command === 'cloud_disk_network' || command === 'cloud_oauth_network')
    ).toBe(false);
  });

  it('не начинает запись, если локальная привязка изменилась или срок истёк', async () => {
    const f = fixture(provider);
    let time = 100_000;
    const opened = await openNativeCloudSession({ ...f.options, now: () => time });
    expect(opened.status).toBe('opened');
    const calls = f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network').length;
    const previous = JSON.parse(f.record());
    f.replace(JSON.stringify({ ...previous, revision: revision2 }));
    expect(await opened.session.upload({ envelope: {} })).toEqual({ status: 'account_unavailable' });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network')).toHaveLength(calls);
    time = 3_700_000;
    expect(await opened.session.upload({ envelope: {} })).toEqual({ status: 'account_unavailable' });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network')).toHaveLength(calls);
  });

  it('сдвиг часов назад закрывает действие, а неверная привязка не открывается', async () => {
    const f = fixture(provider);
    let time = 100_000;
    const opened = await openNativeCloudSession({ ...f.options, now: () => time });
    expect(opened.status).toBe('opened');
    time--;
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_unavailable' });
    const wrong = await openNativeCloudSession({ ...f.options, accountKey: 'OTHER_ACCOUNT', now: () => 100_000 });
    expect(wrong.status).not.toBe('opened');
    noSecret(wrong);
  });
});

describe('особые исходы подключения через fake IPC', () => {
  it('Яндекс с истёкшим access требует новый вход и не выполняет refresh', async () => {
    const f = fixture('yandex', { expiresAt: 100_001 });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({ status: 'login_required' });
    expect(f.invoke.mock.calls.some(([command]) => command === 'cloud_oauth_network')).toBe(false);
  });
  it('Google не повторяет потерянный refresh после нового открытия', async () => {
    const f = fixture('google', { lostRefresh: true });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({
      status: 'credential_blocked'
    });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({
      status: 'credential_blocked'
    });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_oauth_network')).toHaveLength(1);
  });
  it('Яндекс не начинает чтение версий при другом аккаунте', async () => {
    const f = fixture('yandex', { identity: 'OTHER_ACCOUNT' });
    const opened = await openNativeCloudSession({ ...f.options, now: () => 100_000 });
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_mismatch' });
    expect(
      f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network').map(([, args]) => args.args.operation)
    ).toEqual(['identity']);
  });
});
