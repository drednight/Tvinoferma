import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cloudDiagnosticReport,
  cloudDiagnosticSnapshot,
  clearCloudDiagnostics,
  recordCloudDiagnostic,
  cloudStep,
  captureCloudFailure
} from '../js/modules/cloudSync/cloudDiagnostics.js';
import { withCloudAccessDiagnostic } from '../js/modules/cloudSync/providers/cloudAccessDiagnostics.js';
import { bindCloudDiagnosticsPanel } from '../js/modules/cloudSync/ui/cloudDiagnosticsPanel.js';
import { clearCloudActivity } from '../js/modules/cloudSync/cloudEventLog.js';
const SECRET = 'PRIVATE_TOKEN_ACCOUNT_PATH_SIGNED_URL';
beforeEach(() => {
  clearCloudDiagnostics();
  clearCloudActivity();
  document.body.innerHTML = '';
});
it('only keeps allowlisted fields, not raw errors/results/account labels/URLs', () => {
  recordCloudDiagnostic({ stage: SECRET, provider: 'google', outcome: 'ok' });
  recordCloudDiagnostic({
    stage: 'file_hash',
    provider: 'google',
    outcome: 'ok',
    code: SECRET,
    httpStatus: SECRET,
    secret: SECRET
  });
  const error = new Error(`https://evil.test/${SECRET}`);
  error.stack = `Error: ${SECRET}\n at https://evil.test/standaloneFileCodec.js:123:4\n at C:\\Users\\${SECRET}\\app.js:1:2`;
  captureCloudFailure('file_encrypt', error);
  const result = {
    results: [
      { provider: 'google', status: SECRET, label: SECRET, url: SECRET },
      { provider: SECRET, status: 'empty' }
    ],
    pending: []
  };
  const report = cloudDiagnosticReport({ desktop: true, result });
  expect(report).not.toContain(SECRET);
  expect(report).not.toContain('evil.test');
  expect(report).toContain('file_encrypt: unknown_error');
  expect(cloudDiagnosticSnapshot().trace).toHaveLength(1);
});
it('retains the innermost failed step after later successful checks; never writes telemetry to storage', async () => {
  const before = JSON.stringify(localStorage);
  await expect(
    cloudStep('ui_save', null, () =>
      cloudStep('file_encrypt', null, () => {
        throw new TypeError(SECRET);
      })
    )
  ).rejects.toThrow(SECRET);
  await cloudStep('ui_check', null, () => 42);
  const snapshot = cloudDiagnosticSnapshot();
  expect(snapshot.failures).toHaveLength(1);
  expect(snapshot.failures[0]).toMatchObject({ stage: 'file_encrypt', code: 'TypeError' });
  expect(snapshot.trace.some(row => row.stage === 'ui_check' && row.outcome === 'ok')).toBe(true);
  expect(cloudDiagnosticReport()).not.toContain(SECRET);
  expect(JSON.stringify(localStorage)).toBe(before);
});
it('projects only exact own source URLs as filenames and line/column, not a raw stack', () => {
  const error = new Error(SECRET);
  const source = new URL('file://' + process.cwd() + '/js/modules/cloudSync/standaloneFileCodec.js');
  error.stack = `Error ${SECRET}\n at work (${source.href}?private=${SECRET}:123:4)\n at https://evil.test/standaloneFileCodec.js:2:3`;
  captureCloudFailure('snapshot_public', error);
  const report = cloudDiagnosticReport();
  expect(report).toContain('standaloneFileCodec.js:123:4');
  expect(report).not.toContain(SECRET);
  expect(report).not.toContain(source.origin + source.pathname);
});
it('includes the fixed Yandex rejection without inspecting provider bodies', () => {
  const result = withCloudAccessDiagnostic(
    { provider: 'yandex', status: 'unavailable', body: SECRET, link: SECRET },
    'download_content_native_redirect_host'
  );
  expect(cloudDiagnosticReport({ result: { results: [result], pending: [] } })).toContain(
    'download_content_native_redirect_host'
  );
  expect(cloudDiagnosticReport({ result: { results: [result] } })).not.toContain(SECRET);
});
it('bounds memory and keeps recent failures separate from the request ring', () => {
  captureCloudFailure('file_encrypt', new Error(SECRET));
  for (let i = 0; i < 400; i++) recordCloudDiagnostic({ stage: 'disk_list', provider: 'google', outcome: 'ok' });
  expect(cloudDiagnosticSnapshot().trace).toHaveLength(160);
  expect(cloudDiagnosticSnapshot().failures).toHaveLength(1);
  clearCloudDiagnostics();
  expect(cloudDiagnosticSnapshot()).toEqual({ trace: [], failures: [] });
});
function panel(options = {}) {
  const source = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
  document.body.innerHTML = source.getElementById('cloud-diagnostics-panel').outerHTML;
  const check = vi.fn(async () => ({
    results: [
      { provider: 'google', status: 'empty' },
      { provider: 'yandex', status: 'unavailable' }
    ],
    pending: [],
    files: [{ content: SECRET }]
  }));
  const copy = vi.fn(async () => {});
  bindCloudDiagnosticsPanel({ desktop: true, check, copy, ...options });
  return {
    check,
    copy,
    button: document.getElementById('cloud-diagnostics-check'),
    report: document.getElementById('cloud-diagnostics-report')
  };
}
it('runs the existing read/check controller, copies only a safe projection and preserves earlier Save failure', async () => {
  const f = panel();
  captureCloudFailure('snapshot_contents', new Error(SECRET));
  f.button.click();
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.check).toHaveBeenCalledOnce();
  expect(f.report.value).toContain('google: empty');
  expect(f.report.value).toContain('snapshot_contents');
  document.getElementById('cloud-diagnostics-copy').click();
  await vi.waitFor(() => expect(f.copy).toHaveBeenCalledOnce());
  expect(f.copy.mock.calls[0][0]).toBe(f.report.value);
  expect(f.report.value).not.toContain(SECRET);
});
it('supports manual Ctrl+C when the OS clipboard is unavailable', async () => {
  const f = panel({
    copy: async () => {
      throw new Error(SECRET);
    }
  });
  document.getElementById('cloud-diagnostics-copy').click();
  await vi.waitFor(() => expect(document.activeElement).toBe(f.report));
  expect(f.report.selectionEnd - f.report.selectionStart).toBe(f.report.value.length);
  expect(document.getElementById('cloud-diagnostics-status').textContent).toContain('Ctrl+C');
});
it('disables real checks in browser mode and after reset, but allows copying', () => {
  const f = panel({ desktop: false });
  expect(f.button.disabled).toBe(true);
  expect(document.getElementById('cloud-diagnostics-copy').disabled).toBe(false);
  window.dispatchEvent(new Event('tf-factory-reset-started'));
  expect(f.button.disabled).toBe(true);
  expect(f.check).not.toHaveBeenCalled();
});

it('does not reread changing exception getters into public codes', () => {
  let calls = 0;
  const error = {
    get message() {
      return ++calls === 1 ? 'closed' : SECRET;
    },
    name: 'Error'
  };
  captureCloudFailure('ui_save', error);
  expect(cloudDiagnosticReport()).toContain('ui_save: closed');
  expect(cloudDiagnosticReport()).not.toContain(SECRET);
  expect(calls).toBe(1);
});

it('preserves the last failed Save even if many later provider checks fail', async () => {
  await cloudStep('ui_save', null, () =>
    cloudStep('file_encrypt', null, () => {
      throw new TypeError(SECRET);
    })
  ).catch(() => {});
  for (let i = 0; i < 20; i++) captureCloudFailure('disk_list', new Error('unavailable'), 'yandex');
  expect(cloudDiagnosticSnapshot().failures).toHaveLength(10);
  expect(cloudDiagnosticSnapshot().lastSaveFailure).toMatchObject({ stage: 'file_encrypt', code: 'TypeError' });
  expect(cloudDiagnosticReport()).toContain('file_encrypt: TypeError');
  expect(cloudDiagnosticReport()).not.toContain(SECRET);
});

it('carries only allowlisted schema metadata through the failing snapshot stage', async () => {
  const { preparationCheck } = await import('../js/modules/cloudSync/preparationDiagnostics.js');
  const { object } = await import('../js/modules/cloudSync/exportSchema.js');
  await cloudStep('snapshot_public', null, () =>
    preparationCheck('preferences', () => object({ [SECRET]: SECRET }, []))
  ).catch(() => {});
  const report = cloudDiagnosticReport();
  expect(report).toContain('setup/identities/preferences/unknown_field');
  expect(report).not.toContain(SECRET);
  const forged = new Error('setup/identities/preferences/unknown_field');
  captureCloudFailure('ui_action', forged);
  expect(cloudDiagnosticSnapshot().failures.at(-1).code).toBe('unknown_error');
  recordCloudDiagnostic({
    stage: 'snapshot_public',
    outcome: 'failed',
    code: 'setup/identities/' + SECRET + '/unknown_field'
  });
  expect(cloudDiagnosticReport()).not.toContain(SECRET);
});
