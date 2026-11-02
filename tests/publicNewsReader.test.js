import { it, expect, vi } from 'vitest';
import { createPublicNewsReader } from '../js/modules/automation/publicNewsReader.js';
it('uses the ordinary HTTP reader first and an isolated browser only after explicit HTTP 403', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ status: 403 }).mockResolvedValue({ status: 200, html: 'public' });
  const read = createPublicNewsReader(invoke);
  expect((await read({ page: 1, article: null })).status).toBe(200);
  expect(invoke.mock.calls[0][1].browser).toBe(false);
  expect(invoke.mock.calls[1][1].browser).toBe(true);
  await read({ page: null, article: '123' });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke.mock.calls[2][1]).toEqual({ page: null, article: '123', browser: true });
});
it('does not hide network/challenge errors or turn denial into an empty successful scan', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ status: 403 }).mockRejectedValue(Error('news_challenge'));
  await expect(createPublicNewsReader(invoke)({ page: 1 })).rejects.toThrow('news_challenge');
  const network = vi.fn().mockRejectedValue(Error('news_timeout'));
  await expect(createPublicNewsReader(network)({ page: 1 })).rejects.toThrow('news_timeout');
  expect(network).toHaveBeenCalledTimes(1);
});
it('both concurrent index requests fall back if their HTTP 403 replies overlap', async () => {
  const invoke = vi.fn(async (cmd, args) => (args.browser ? { status: 200, html: 'public' } : { status: 403 }));
  const read = createPublicNewsReader(invoke);
  const results = await Promise.all([read({ page: 1 }), read({ page: 2 })]);
  expect(results.every(r => r.status === 200)).toBe(true);
  expect(invoke.mock.calls.filter(([, a]) => a.browser)).toHaveLength(2);
});
