import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { openLegacyCloudRecovery } from '../js/modules/cloudSync/ui/legacyRecoveryPanel.js';
it('mounts old windows only for explicit recovery in Data settings, with its own disk selector', () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('index.html', 'utf8'),
    'text/html'
  ).body.innerHTML;
  expect(document.getElementById('cloud-registration-provider')).toBeNull();
  expect(document.getElementById('cloud-file-panel')).toBeNull();
  expect(document.getElementById('settings-data').contains(document.getElementById('cloud-legacy-open'))).toBe(true);
  if (!HTMLDialogElement.prototype.showModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
  const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
    this.open = true;
  });
  const modal = openLegacyCloudRecovery(document);
  expect(document.getElementById('cloud-file-panel').closest('dialog')).toBe(modal);
  expect(document.getElementById('cloud-standalone-legacy').open).toBe(true);
  document.getElementById('cloud-login-provider').value = 'google';
  document.getElementById('cloud-registration-provider').value = 'yandex';
  expect(document.getElementById('cloud-login-provider').value).toBe('google');
  expect(document.getElementById('cloud-registration-provider').value).toBe('yandex');
  expect(openLegacyCloudRecovery(document)).toBe(modal);
  expect(show).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});
