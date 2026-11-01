import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const html = readFileSync('index.html', 'utf8');
const binding = {
  slotId: '01234567-89ab-4cde-8f01-23456789abcd',
  clientId: '0123456789abcdef',
  accountKey: 'FAKE_ACCOUNT'
};
let accounts, coordination;
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.resetModules();
  const source = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
  document.body.innerHTML = source;
  accounts = await import('../js/modules/cloudSync/cloudAccountPresentation.js');
  coordination = await import('../js/modules/cloudSync/credentialResetCoordination.js');
});
async function setup(extra = {}) {
  const invoke = vi.fn();
  const readBinding = vi.fn(async () => ({ status: 'ready', binding }));
  const logout = vi.fn(async () => 'forgotten');
  const confirmLogout = vi.fn(async () => true);
  const { bindCloudRegistrationCheck } = await import('../js/modules/cloudSync/ui/registrationCheckPanel.js');
  bindCloudRegistrationCheck({
    doc: document,
    desktop: true,
    loadNative: async () => ({ invoke, openBrowser: vi.fn() }),
    readBinding,
    readDataset: async () => 'empty',
    logout,
    confirmLogout,
    ...extra
  });
  accounts.presentCloudAccount('google', {
    status: 'ready',
    label: { kind: 'email', value: 'google@example.invalid' }
  });
  accounts.presentCloudAccount('yandex', { status: 'ready', label: { kind: 'login', value: 'fake-yandex' } });
  return { invoke, readBinding, logout, confirmLogout, ...extra };
}
const button = provider => document.querySelector(`[data-cloud-sign-out="${provider}"]`);
const progress = () => document.getElementById('cloud-connection-progress').textContent;
describe('independent explicit local cloud logout', () => {
  it.each(['google', 'yandex'])(
    'removes only the observed %s login, keeps the other account and data untouched',
    async provider => {
      const f = await setup();
      const event = vi.fn();
      window.addEventListener('tf-cloud-credential-removed', event, { once: true });
      expect(button(provider).disabled).toBe(false);
      button(provider).click();
      await vi.waitFor(() => expect(f.logout).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(progress()).toContain('Вы вышли'));
      expect(f.logout.mock.calls[0][0]).toMatchObject({
        provider,
        slotId: binding.slotId,
        confirmed: true,
        invoke: f.invoke
      });
      expect(f.confirmLogout.mock.calls[0][0].text).toContain('ключ шифрования');
      expect(accounts.cloudAccountPresentation(provider).status).toBe('signed_out');
      expect(accounts.cloudAccountPresentation(provider === 'google' ? 'yandex' : 'google').status).toBe('ready');
      expect(event).toHaveBeenCalledTimes(1);
      expect(f.invoke).not.toHaveBeenCalled();
      expect(button(provider).disabled).toBe(true);
    }
  );
  it('does nothing after cancellation', async () => {
    const f = await setup({ confirmLogout: vi.fn(async () => false) });
    button('yandex').click();
    await vi.waitFor(() => expect(f.confirmLogout).toHaveBeenCalled());
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.readBinding).not.toHaveBeenCalled();
    expect(accounts.cloudAccountPresentation('yandex').status).toBe('ready');
  });
  it('waits for the active file/OAuth operation, then logs out without disconnecting the other disk', async () => {
    const f = await setup();
    const running = coordination.beginCloudCredentialOperation();
    try {
      button('google').click();
      await vi.waitFor(() => expect(progress()).toContain('Ожидаем завершения'));
      expect(f.logout).not.toHaveBeenCalled();
    } finally {
      running.finish(false);
    }
    await vi.waitFor(() => expect(f.logout).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(progress()).toContain('Вы вышли'));
    expect(accounts.cloudAccountPresentation('yandex').status).toBe('ready');
  });
  it('holds an exclusive barrier during native logout and keeps keys/files out of its IPC', async () => {
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const f = await setup({ logout: vi.fn(() => pending) });
    button('google').click();
    await vi.waitFor(() => expect(f.logout).toHaveBeenCalled());
    expect(() => coordination.beginCloudCredentialOperation()).toThrow();
    expect(() => coordination.beginCloudDataOperation()).toThrow();
    expect(() => coordination.beginCloudCredentialReset()).toThrow();
    release('forgotten');
    await vi.waitFor(() => expect(progress()).toContain('Вы вышли'));
    const next = coordination.beginCloudCredentialOperation();
    next.finish(false);
  });
  it.each(['blocked', 'mismatch'])('does not pretend logout succeeded when the native slot is %s', async result => {
    const f = await setup({ logout: vi.fn(async () => result) });
    button('yandex').click();
    await vi.waitFor(() => expect(progress()).toContain('заблокирован'));
    expect(accounts.cloudAccountPresentation('yandex').status).toBe('ready');
    expect(f.logout).toHaveBeenCalledTimes(1);
  });
  it('blocks retries and data operations after an uncertain native removal', async () => {
    const f = await setup({
      logout: vi.fn(async () => {
        throw new Error('SECRET MUST NOT DISPLAY');
      })
    });
    button('yandex').click();
    await vi.waitFor(() => expect(progress()).toContain('не подтверждён'));
    expect(document.body.textContent).not.toContain('SECRET MUST NOT DISPLAY');
    expect(button('yandex').disabled).toBe(true);
    expect(() => coordination.beginCloudDataOperation()).toThrow();
    expect(f.logout).toHaveBeenCalledTimes(1);
    expect(coordination.cloudProviderLogoutUncertain('yandex')).toBe(true);
    expect(coordination.cloudProviderLogoutUncertain('google')).toBe(false);
    const { openNativeCloudSession } = await import('../js/modules/cloudSync/providers/nativeCloudSession.js');
    const invoke = vi.fn();
    expect(
      await openNativeCloudSession({
        ...binding,
        provider: 'yandex',
        datasetId: '7eab1931-650f-4dc7-98bb-f9e903526af4',
        invoke
      })
    ).toEqual({ status: 'credential_logout_unconfirmed' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('disables both logout buttons in the browser demo', async () => {
    const f = await setup({ desktop: false });
    expect(button('google').disabled).toBe(true);
    expect(button('yandex').disabled).toBe(true);
    button('google').click();
    expect(f.confirmLogout).not.toHaveBeenCalled();
  });
});

it('uses the real slot-checked native removal bridge, never broad logout or key/data deletion', async () => {
  const invoke = vi.fn(async () => ({ status: 'forgotten' }));
  await setup({ logout: undefined, loadNative: async () => ({ invoke, openBrowser: vi.fn() }) });
  button('yandex').click();
  await vi.waitFor(() => expect(progress()).toContain('Вы вышли'));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('cloud_credential_logout', {
    provider: 'yandex',
    expectedSlot: binding.slotId,
    logoutId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    confirmed: true
  });
});

it('clears ephemeral Google access on explicit logout without removing its encryption key', async () => {
  const f = await setup();
  const cache = await import('../js/modules/cloudSync/providers/googleAccessMemory.js');
  const { prepareGoogleCredentialRecord } = await import('../js/modules/cloudSync/providers/oauthCredentialRecord.js');
  const record = prepareGoogleCredentialRecord({
    ...binding,
    clientId: 'fake-client.apps.googleusercontent.com',
    revision: '11234567-89ab-4cde-8f01-23456789abcd',
    refreshToken: 'FAKE_REFRESH',
    refreshExpiresAt: null
  });
  cache.rememberGoogleAccess({ invoke: f.invoke, record, accessToken: 'FAKE_TOKEN', expiresAt: Date.now() + 3600000 });
  expect(cache.recalledGoogleAccess({ invoke: f.invoke, record })).not.toBeNull();
  button('google').click();
  await vi.waitFor(() => expect(progress()).toContain('Вы вышли'));
  expect(cache.recalledGoogleAccess({ invoke: f.invoke, record })).toBeNull();
});
