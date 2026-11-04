import { expect, it, vi } from 'vitest';
import { redecorateRunningWindows } from '../js/modules/launcher/launch.js';
const windows = [
  { pid: 1, known: true, nick: 'A', cls: '' },
  { pid: 2, known: true, nick: 'B', cls: '' }
];
it('reapplies one window at a time with force and reports monotonic progress', async () => {
  let release;
  const events = [];
  const invoke = vi.fn((_cmd, { targets }) =>
    targets[0].pid === 1
      ? new Promise(resolve => {
          release = () => resolve([{ pid: 1, status: 'fixed' }]);
        })
      : Promise.resolve([{ pid: 2, status: 'fixed' }])
  );
  const work = redecorateRunningWindows(windows, { invoke, onProgress: p => events.push(p) });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke.mock.calls[0][1].targets).toHaveLength(1);
  expect(invoke.mock.calls[0][1].targets[0].force).toBe(true);
  release();
  expect((await work).fixed).toBe(2);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(events.at(-1)).toMatchObject({ percent: 100, done: 2, total: 2, phase: 'done' });
  expect(events.some(p => p.nick === 'B')).toBe(true);
  expect(events.every((p, i) => i === 0 || p.percent >= events[i - 1].percent)).toBe(true);
});
it('retries only failed windows with one administrator request after partial success', async () => {
  const invoke = vi.fn((cmd, args) =>
    Promise.resolve(
      cmd === 'launcher_run_elevated'
        ? { status: 'done', decorate: [{ pid: 1, status: 'fixed' }] }
        : [{ pid: args.targets[0].pid, status: args.targets[0].pid === 1 ? 'failed' : 'fixed' }]
    )
  );
  const result = await redecorateRunningWindows(windows, { invoke });
  expect(result).toMatchObject({ fixed: 2, failed: 0 });
  const admin = invoke.mock.calls.filter(([cmd]) => cmd === 'launcher_run_elevated');
  expect(admin).toHaveLength(1);
  expect(admin[0][1].job.targets.map(t => t.pid)).toEqual([1]);
});
