// Static contracts only: native/Windows behavior requires compilation and real acceptance.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = path => readFileSync(path, 'utf8');

it('pairs distinct Tauri identity with compile-time namespaces and rejects unsafe overrides', () => {
  const stable = JSON.parse(read('src-tauri/tauri.conf.json'));
  const test = JSON.parse(read('src-tauri/tauri.acceptance.conf.json'));
  const profile = read('src-tauri/src/profile.rs');
  const app = read('src-tauri/src/lib.rs');
  expect(stable.identifier).toBe('com.tvinoferma.desktop');
  expect(test.identifier).toBe('com.tvinoferma.desktop.acceptance');
  expect(test.identifier).not.toBe(stable.identifier);
  expect(test.bundle.active).toBe(false);
  expect(test.app.windows[0].title).toContain('ТЕСТОВАЯ');
  expect(profile).toContain('com.tvinoferma.desktop.acceptance.cloud.simple-key');
  expect(profile).toContain('com.tvinoferma.desktop.cloud.simple-key');
  expect(profile).toContain('validate_config_identifier');
  expect(app.indexOf('validate_config_identifier')).toBeLessThan(app.indexOf('run_as_helper_if_requested'));
  expect(app).toContain('WEBVIEW2_USER_DATA_FOLDER');
  expect(app).toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS');
  expect(app).toContain('app_directories_override.is_some()');
  expect(app).toContain('window.data_directory.is_some()');
  expect(app).toMatch(/#\[cfg\(not\(feature = "acceptance"\)\)\]\s*app\.handle\(\)\s*\.plugin\(tauri_plugin_updater/);
  expect(app).toMatch(/#\[cfg\(not\(feature = "acceptance"\)\)\]\s*shortcut::ensure_russian_shortcut/);
});

it('routes contacts, launcher, cookie key, reset, cloud OAuth and outbox to one compile-time namespace', () => {
  for (const path of [
    'src-tauri/src/launcher.rs',
    'src-tauri/src/cookie_bank.rs',
    'src-tauri/src/commands/secrets.rs',
    'src-tauri/src/commands/factory_reset.rs',
    'src-tauri/src/commands/cloud_credentials.rs',
    'src-tauri/src/commands/cloud_google_client.rs',
    'src-tauri/src/commands/cloud_dataset_binding.rs',
    'src-tauri/src/commands/cloud_key_state.rs',
    'src-tauri/src/commands/cloud_outbox.rs'
  ]) {
    const content = read(path);
    expect(content, path).toContain('crate::profile::VAULT_SERVICE');
    expect(content, path).not.toMatch(
      /const (?:SERVICE|VAULT_SERVICE|KEYRING_SERVICE): &str = "com\.tvinoferma\.desktop"/
    );
  }
  expect(read('src-tauri/src/commands/cloud_simple_key.rs')).toContain('crate::profile::SIMPLE_KEY_SERVICE');
  expect(read('src-tauri/src/notify.rs')).toContain('crate::profile::APP_ID');
  expect(read('src-tauri/src/tray.rs')).toContain('crate::profile::TRAY_LABEL');
  const autostart = read('src-tauri/src/autostart.rs');
  for (const field of ['AUTOSTART_VALUE', 'AUTOSTART_TASK', 'AUTOSTART_XML'])
    expect(autostart).toContain(`crate::profile::${field}`);
});

it('local and CI scripts opt into both config and feature and keep artifacts separate', () => {
  const local = read('scripts/build-windows-local.ps1');
  const ci = read('.github/scripts/build-windows-acceptance.ps1');
  const workflow = read('.github/workflows/windows-acceptance.yml');
  for (const text of [local, ci]) {
    expect(text).toContain('tauri.acceptance.conf.json');
    expect(text).toContain('acceptance');
    expect(text).toContain('--no-bundle');
    expect(text).toContain('--no-sign');
    expect(text).toContain('--locked');
  }
  expect(local).toContain('src-tauri\\target\\acceptance');
  expect(workflow).toContain('${{ github.workspace }}/src-tauri/target/acceptance');
  expect(local).toContain('isolationVerified = $false');
});
