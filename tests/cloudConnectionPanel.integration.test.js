import { legacyCloudHtml } from './helpers/legacyCloudHtml.js';
// @vitest-environment jsdom
// Вся цепочка панели до поддельного IPC/провайдера. Настоящих токенов, Tauri и облаков здесь нет.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudRegistrationCheck } from '../js/modules/cloudSync/ui/registrationCheckPanel.js';
import { enrollNativeCloudAccount } from '../js/modules/cloudSync/providers/nativeOAuthEnrollment.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';
import { parseGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';

const html = legacyCloudHtml(readFileSync('index.html', 'utf8'));
const panel = new DOMParser().parseFromString(html, 'text/html').getElementById('cloud-registration-panel')?.outerHTML;
const CLIENT = {
  google: '123456789-test_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
const SECRET = 'FAKE_ONLY_SECRET';
const ACCOUNT = 'FAKE_ONLY_PRIVATE_ACCOUNT';
const LABEL = { google: 'fake-user@example.test', yandex: 'fake-user' };
const CODE = 'FAKE_ONLY_CODE';
const json = body => ({ body: JSON.stringify(body), contentType: 'application/json; charset=utf-8' });
const reg = id => document.getElementById(id === 'provider' ? 'cloud-login-provider' : `cloud-registration-${id}`);
const conn = id => document.getElementById(`cloud-connection-${id}`);
const parse = (provider, record) =>
  provider === 'google' ? parseGoogleCredentialRecord(record) : parseYandexCredentialRecord(record);

function fakeNative(provider, extra = {}) {
  let stored = null;
  let dataset = 'empty';
  let identities = 0;
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_google_client_read') return { status: 'ready', clientId: CLIENT.google };
    if (command === 'cloud_credential_binding_read') {
      if (!stored) return { status: 'empty' };
      const record = parse(provider, stored.record);
      return { status: 'ready', slotId: record.slotId, clientId: record.clientId, accountKey: record.accountKey };
    }
    if (command === 'cloud_dataset_binding_read') return { status: dataset };
    if (command === 'cloud_credential_read') return stored || { status: 'empty' };
    if (command === 'cloud_credential_install') {
      if (dataset !== 'empty') return { status: 'blocked' };
      if (stored) return { status: 'occupied' };
      stored = { status: 'ready', slotId: args.slotId, record: args.record };
      if (extra.uncertainInstall) throw new Error(SECRET);
      return { status: 'installed' };
    }
    if (command === 'cloud_credential_forget_if_unbound') {
      if (dataset !== 'empty') return { status: 'blocked' };
      if (!stored || stored.slotId !== args.expectedSlot) return { status: 'mismatch' };
      stored = null;
      return { status: 'forgotten' };
    }
    if (command === 'cloud_oauth_callback_begin') return { port: args.port || 37181 };
    if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: CODE };
    if (command === 'cloud_oauth_callback_cancel') return null;
    if (command === 'cloud_oauth_network' && args.operation === 'exchange') {
      return json({
        access_token: SECRET,
        refresh_token: `${SECRET}_REFRESH`,
        expires_in: 3600,
        token_type: 'bearer',
        ...(provider === 'google' ? { scope: OAUTH_PROVIDERS.google.scope } : {})
      });
    }
    if (command === 'cloud_oauth_network' && args.operation === 'identity') {
      identities++;
      if (extra.pinDuringIdentity && identities === 1) dataset = 'blocked';
      return json(
        provider === 'google'
          ? { user: { permissionId: ACCOUNT, emailAddress: LABEL.google } }
          : { login: LABEL.yandex, id: '123456', client_id: CLIENT.yandex, psuid: ACCOUNT }
      );
    }
    throw new Error(SECRET);
  });
  const openBrowser = vi.fn(async () => {});
  return {
    invoke,
    openBrowser,
    get stored() {
      return stored;
    },
    get identities() {
      return identities;
    },
    setDataset(status) {
      dataset = status;
    }
  };
}
async function inspect() {
  conn('inspect').click();
  await vi.waitFor(() => expect(conn('inspect').disabled).toBe(false));
}
function setup(provider, extra = {}) {
  const native = fakeNative(provider, extra);
  const confirmAccount = vi.fn(extra.confirmAccount || (async () => true));
  bindCloudRegistrationCheck({
    doc: document,
    desktop: true,
    loadNative: async () => native,
    enroll: args =>
      enrollNativeCloudAccount({ ...args, cryptoSource: webcrypto, pollIntervalMs: 20, storeTimeoutMs: 1000 }),
    confirmAccount
  });
  reg('provider').value = provider;
  reg('provider').dispatchEvent(new Event('change'));
  reg('client').value = CLIENT[provider];
  return { native, confirmAccount };
}
async function start() {
  await inspect();
  expect(conn('approve').disabled).toBe(false);
  conn('approve').click();
  conn('start').click();
}
function assertNoPrivate() {
  const visible = document.body.textContent;
  for (const secret of [SECRET, ACCOUNT, CODE, ...Object.values(LABEL)]) expect(visible).not.toContain(secret);
}
beforeEach(() => {
  expect(panel).toBeTruthy();
  document.body.innerHTML = `<main>${panel}</main>`;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('панель → PKCE → локальная запись с поддельным IPC', () => {
  it.each(['google', 'yandex'])(
    '%s: подтверждает аккаунт, сохраняет, сверяет и явно забывает доступ',
    async provider => {
      const { native, confirmAccount } = setup(provider);
      await start();
      await vi.waitFor(() => expect(conn('progress').textContent).toContain('Доступ сохранён'));
      expect(native.openBrowser).toHaveBeenCalledOnce();
      expect(confirmAccount).toHaveBeenCalledOnce();
      expect(confirmAccount.mock.calls[0][0].label.value).toBe(LABEL[provider]);
      expect(native.identities).toBe(2);
      expect(native.stored).not.toBeNull();
      const parsed = parse(provider, native.stored.record);
      expect(parsed.clientId).toBe(CLIENT[provider]);
      expect(parsed.accountKey).toBe(ACCOUNT);
      expect(native.stored.record).not.toContain(LABEL[provider]);
      expect(native.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(1);
      expect(native.invoke.mock.calls.some(([command]) => command === 'cloud_disk_network')).toBe(false);
      assertNoPrivate();
      await inspect();
      expect(conn('local').textContent).toContain('облачные файлы и синхронизация не проверялись');
      conn('forget-approve').click();
      conn('forget').click();
      await vi.waitFor(() => expect(conn('progress').textContent).toContain('Локальный доступ забыт'));
      expect(native.stored).toBeNull();
      expect(
        native.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_forget_if_unbound')
      ).toHaveLength(1);
      expect(native.invoke.mock.calls.some(([command]) => command === 'cloud_disk_network')).toBe(false);
      assertNoPrivate();
    }
  );

  it('при появлении pin после проверки backend блокирует забывание и сохраняет доступ', async () => {
    const { native } = setup('yandex');
    await start();
    await vi.waitFor(() => expect(conn('progress').textContent).toContain('Доступ сохранён'));
    await inspect();
    native.setDataset('blocked');
    conn('forget-approve').click();
    conn('forget').click();
    await vi.waitFor(() => expect(conn('local').textContent).toContain('Ничего не удалено'));
    expect(native.stored).not.toBeNull();
    assertNoPrivate();
  });

  it('не сохраняет новый доступ, если после проверки появилась привязка набора', async () => {
    const { native } = setup('yandex', { pinDuringIdentity: true });
    await start();
    await vi.waitFor(() => expect(conn('progress').textContent).toContain('не подтверждён'));
    expect(native.stored).toBeNull();
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(1);
    expect(conn('start').disabled).toBe(true);
    assertNoPrivate();
  });

  it('при потере ответа после установки не повторяет запись и не выдаёт успех', async () => {
    const { native } = setup('google', { uncertainInstall: true });
    await start();
    await vi.waitFor(() => expect(conn('progress').textContent).toContain('не подтверждён'));
    expect(native.stored).not.toBeNull();
    expect(conn('progress').textContent).not.toContain('Доступ сохранён');
    await inspect();
    expect(conn('forget').disabled).toBe(true);
    expect(conn('start').disabled).toBe(true);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(1);
    assertNoPrivate();
  });

  it('отказ от сверки не записывает токен и не отображает его', async () => {
    const { native, confirmAccount } = setup('yandex', { confirmAccount: async () => false });
    await start();
    await vi.waitFor(() => expect(conn('progress').textContent).toContain('Аккаунт не подтверждён'));
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(native.stored).toBeNull();
    expect(native.invoke.mock.calls.some(([command]) => command === 'cloud_credential_install')).toBe(false);
    assertNoPrivate();
  });
});
