import { expect, it, vi } from 'vitest';
import { syncGuildFromSite, respondToEvent, voteInGuildPoll } from '../js/modules/guild/window.js';

it('сериализует отметки, фоновое чтение и опрос через общую очередь, восстанавливается после ошибки', async () => {
  let release;
  const first = new Promise(resolve => {
    release = resolve;
  });
  const invoke = vi.fn().mockReturnValueOnce(first).mockRejectedValueOnce('login').mockResolvedValue({ ok: true });
  const a = respondToEvent('1', 'yes', { invoke });
  const b = syncGuildFromSite({ invoke });
  const failed = expect(b).rejects.toBe('login');
  const c = voteInGuildPoll('2', ['3'], { invoke });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  release({ ok: true });
  await a;
  await failed;
  await c;
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['guild_set_response', 'guild_sync', 'guild_vote_poll']);
});
