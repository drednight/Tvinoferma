import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindCloudRegistrationCheck } from '../js/modules/cloudSync/ui/registrationCheckPanel.js';
import {
  presentCloudAccount,
  clearCloudAccountPresentation
} from '../js/modules/cloudSync/cloudAccountPresentation.js';
import { cloudDiagnosticReport } from '../js/modules/cloudSync/cloudDiagnostics.js';
const source = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
beforeEach(() => {
  clearCloudAccountPresentation();
  document.body.innerHTML = source.getElementById('cloud-registration-panel').outerHTML;
});
const client = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
it('shows equal provider cards at the start, no visible login selector; destinations remain independent', () => {
  const cards = document.querySelectorAll('.cloud-provider-card');
  expect(cards).toHaveLength(2);
  expect(cards[0].parentElement).toBe(cards[1].parentElement);
  expect(cards[0].closest('#cloud-login-settings')).toBeNull();
  expect(document.querySelector('select#cloud-login-provider')).toBeNull();
  expect(document.getElementById('cloud-login-provider').type).toBe('hidden');
  expect([...document.querySelectorAll('[data-standalone-destination]')].every(input => !input.checked)).toBe(true);
  expect(document.getElementById('cloud-activity-panel').nextElementSibling.id).toBe('cloud-diagnostics-panel');
});
it.each(['google', 'yandex'])(
  '%s button selects only its own login and shows confirmed account beneath its heading',
  async provider => {
    const confirmAccount = vi.fn(async () => true);
    const label = {
      kind: provider === 'google' ? 'email' : 'login',
      value: provider === 'google' ? 'test-user@example.test' : 'test-user'
    };
    const enroll = vi.fn(async args => {
      expect(
        await args.confirmAccount({ provider, clientId: client[provider], label, signal: new AbortController().signal })
      ).toBe(true);
      return { status: 'installed' };
    });
    document.getElementById('cloud-registration-client').value = client[provider];
    bindCloudRegistrationCheck({
      desktop: true,
      check: vi.fn(),
      enroll,
      readBinding: vi.fn(async () => ({ status: 'empty' })),
      readDataset: vi.fn(async () => 'empty'),
      confirmAccount,
      loadNative: async () => ({
        invoke: vi.fn(async () => ({ status: 'ready', clientId: client.google })),
        openBrowser: vi.fn()
      })
    });
    const destinations = [...document.querySelectorAll('[data-standalone-destination]')];
    destinations[0].checked = true;
    document.querySelector(`[data-cloud-sign-in=${provider}]`).click();
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(document.getElementById(`cloud-${provider}-account`).textContent).toContain(label.value)
    );
    expect(enroll.mock.calls[0][0].provider).toBe(provider);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(destinations.map(input => input.checked)).toEqual([true, false]);
    expect(cloudDiagnosticReport()).not.toContain(label.value);
  }
);
it('shows only validated labels, never guesses from IDs, and clears them on reset', () => {
  bindCloudRegistrationCheck({ desktop: false });
  presentCloudAccount('google', { status: 'ready', label: { kind: 'email', value: 'valid@example.test' } });
  expect(document.getElementById('cloud-google-account').textContent).toContain('valid@example.test');
  presentCloudAccount('yandex', { status: 'ready', label: { kind: 'login', value: '<img src=x onerror=alert(1)>' } });
  expect(document.querySelector('.cloud-provider-card img')).toBeNull();
  expect(document.getElementById('cloud-yandex-account').textContent).toContain('имя аккаунта пока не подтверждено');
  window.dispatchEvent(new Event('tf-factory-reset-started'));
  expect(document.getElementById('cloud-google-account').textContent).not.toContain('valid@example.test');
});
