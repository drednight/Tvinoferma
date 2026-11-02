import { beforeEach, it, expect, vi } from 'vitest';
const native = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  native.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = '<div class="topbar-right"></div>';
});
it('dock Stop cancels native scopes even for a task with only onCancel, never resumes at Stop', async () => {
  const { startTask } = await import('../js/core/taskLog.js');
  const signal = { cancelled: false };
  const task = startTask('Script');
  task.onCancel(() => (signal.cancelled = true));
  task.watch('char:a', 'char:b');
  await task.ready();
  native.mockClear();
  document.querySelector('[data-dock-stop]').click();
  await task.ready();
  expect(signal.cancelled).toBe(true);
  expect(task.cancelled).toBe(true);
  expect(native.mock.calls).toEqual([
    ['cancel_scope_command', { scope: 'char:a' }],
    ['cancel_scope_command', { scope: 'char:b' }]
  ]);
  task.finish('stopped', 'warn');
});
it('serializes old cancellation acknowledgement before a new same-character resume', async () => {
  const { startTask } = await import('../js/core/taskLog.js');
  const old = startTask('Old');
  old.watch('char:a');
  await old.ready();
  let release;
  native.mockImplementation(async cmd => {
    if (cmd === 'cancel_scope_command') await new Promise(r => (release = r));
  });
  old.stop();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  old.finish('stopped');
  const next = startTask('New');
  next.watch('char:a');
  await Promise.resolve();
  expect(native.mock.calls.at(-1)[0]).toBe('cancel_scope_command');
  release();
  await next.ready();
  expect(native.mock.calls.at(-1)[0]).toBe('resume_scope_command');
  next.finish();
});
it('does not start work that was waiting for a shared browser slot on Stop', async () => {
  const { createLimiter, runQueue } = await import('../js/modules/sync/queue.js');
  const limiter = createLimiter(1);
  let release;
  const hold = limiter.run(() => new Promise(r => (release = r)));
  const signal = { cancelled: false };
  const worker = vi.fn();
  const jobs = runQueue(['a'], worker, { limiter, signal });
  signal.cancelled = true;
  release();
  await hold;
  const rows = await jobs;
  expect(worker).not.toHaveBeenCalled();
  expect(rows[0].cancelled).toBe(true);
});
it('cancelling a queued task never resumes or cancels scopes belonging to the running task', async () => {
  const { startTask } = await import('../js/core/taskLog.js');
  const current = startTask('Current');
  current.watch('scan');
  await current.ready();
  native.mockClear();
  const queued = startTask('Queued');
  queued.stop();
  await queued.waitTurn();
  queued.watch('scan');
  await queued.ready();
  expect(native).not.toHaveBeenCalled();
  current.finish();
});
it('keeps the real header dock above script overlays and returns it to the header afterwards', async () => {
  const { startTask, renderDock } = await import('../js/core/taskLog.js');
  const task = startTask('Script');
  const dialog = document.createElement('div');
  dialog.className = 'sp-container';
  document.body.append(dialog);
  renderDock();
  const dock = document.querySelector('#tf-task-dock');
  expect(dock.parentElement).toBe(document.body);
  expect(dock.classList.contains('is-script-overlay')).toBe(true);
  dialog.remove();
  renderDock();
  expect(dock.parentElement).toBe(document.querySelector('.topbar-right'));
  expect(dock.classList.contains('is-script-overlay')).toBe(false);
  task.finish();
});
it('never persists the runtime native acknowledgement promise into the task journal', async () => {
  const { startTask } = await import('../js/core/taskLog.js');
  const task = startTask('Runtime fields');
  task.watch('char:a');
  await task.ready();
  task.finish();
  const rows = Object.values(localStorage)
    .map(value => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter(Array.isArray)
    .flat();
  const saved = rows.find(row => row?.id === task.id);
  expect(saved).toBeTruthy();
  expect(saved).not.toHaveProperty('_scopeReady');
});
