import { beforeEach, expect, it, vi } from 'vitest';
import { openReceiverTools, receiverReport } from '../js/modules/gameMacros/receiverTools.js';
import { exportTrialBundle, openBundlePreview } from '../js/modules/gameMacros/evidenceBundle.js';
import { readFileSync } from 'node:fs';
const row = {
  id: 'private-id',
  charId: 'private-char',
  partyId: 'private-party',
  key: 'B',
  method: 'post',
  verdict: 'failed',
  notes: 'private note',
  at: 'test-time',
  technical: {
    runId: 'private-run',
    trace: {
      runId: 'private-run',
      state: 'finished',
      events: [{ stage: 'background-phase', status: 'ok', details: { pid: 123, hwnd: '0xA', key: 'B' } }]
    }
  }
};
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});
it('exports only selected records with identifiers and notes opt-in', () => {
  const data = JSON.parse(exportTrialBundle([row, { ...row, id: 'other', notes: 'Not selected' }], ['private-id']));
  expect(data.records).toHaveLength(1);
  expect(data.records[0].charId).toBe('recipient-1');
  expect(JSON.stringify(data)).not.toMatch(/private-|private note|Not selected|"pid"|"hwnd"/);
  const explicit = JSON.parse(
    exportTrialBundle([row], ['private-id'], { includeNotes: true, includeIdentifiers: true })
  );
  expect(explicit.records[0]).toMatchObject({
    charId: 'private-char',
    notes: 'private note',
    technical: { runId: 'private-run' }
  });
  expect(() => exportTrialBundle([row], [])).toThrow(/Выберите/);
  expect(row.technical.trace.events[0].details.pid).toBe(123);
});
it('requires preview before download, escaping notes rather than rendering markup', () => {
  openBundlePreview([{ ...row, notes: '<img src=x>' }], ['private-id'], { includeNotes: true });
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('textarea').value).toContain('<img src=x>');
  expect(document.querySelector('[data-bundle-download]')).not.toBeNull();
});
it('receiver has no automatic open/send; requires consent for each single send', async () => {
  const control = vi.fn(async () => ({ open: true, total: 2, events: [{ message: 256, vk: 66, foreground: false }] }));
  openReceiverTools(control);
  const q = name => document.querySelector(`[data-receiver-${name}]`);
  expect(control).not.toHaveBeenCalled();
  expect(q('send').disabled).toBe(true);
  q('open').click();
  await vi.waitFor(() => expect(q('open').disabled).toBe(false));
  expect(control).toHaveBeenCalledWith('open', 'B', 'post');
  q('consent').checked = true;
  q('consent').dispatchEvent(new Event('change'));
  q('send').click();
  q('send').click();
  await vi.waitFor(() => expect(q('consent').checked).toBe(false));
  expect(control.mock.calls.filter(([operation]) => operation === 'send')).toHaveLength(1);
  expect(q('send').disabled).toBe(true);
  expect(document.querySelector('textarea').value).toContain('WM_KEYDOWN');
});
it('does not retry after receiver failure and invalidates consent when method changes', async () => {
  const control = vi.fn(async () => {
    throw new Error('Windows unavailable');
  });
  openReceiverTools(control);
  const q = name => document.querySelector(`[data-receiver-${name}]`);
  q('consent').checked = true;
  q('consent').dispatchEvent(new Event('change'));
  q('method').value = 'notify';
  q('method').dispatchEvent(new Event('change'));
  expect(q('send').disabled).toBe(true);
  q('read').click();
  await vi.waitFor(() => expect(q('status').textContent).toContain('Windows unavailable'));
  expect(control).toHaveBeenCalledTimes(1);
});
it('reports actual receipt and foreground separately from delivery without game-success claim', () => {
  const report = JSON.parse(
    receiverReport({ open: true, delivery: { ok: true }, total: 1, events: [{ message: 257, foreground: false }] })
  );
  expect(report.gameAccepted).toBe('unknown');
  expect(report.events[0]).toMatchObject({ messageName: 'WM_KEYUP', foreground: false });
});
it('native receiver is main-only, owns target and has no hooks or client discovery', () => {
  const native = readFileSync('src-tauri/src/input_receiver.rs', 'utf8');
  expect(native).toContain('window.label() != "main"');
  expect(native).not.toMatch(/SetWindowsHook|RegisterRawInput|macro_client_at|SendInput/);
  expect(native).toContain('state.events.len() > 200');
  expect(native).toContain('Receiver test keys: B, F8, SHIFT+1');
});
