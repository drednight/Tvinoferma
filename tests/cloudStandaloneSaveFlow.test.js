import { describe, expect, it, vi } from 'vitest';
import { prepareStandaloneSave } from '../js/modules/cloudSync/standaloneSaveFlow.js';
const options = { targets: ['google', 'yandex'], password: 'PRIVATE', fields: [] };
const row = (provider, status) => ({ provider, status });
const unavailable = results => Object.assign(new Error('destinations_unavailable'), { results });
function fixture(first, connected = true) {
  const prepared = { results: [row('google', 'checked'), row('yandex', 'checked')] };
  const engine = {
    prepareSave: vi
      .fn()
      .mockImplementationOnce(async () => {
        if (first instanceof Error) throw first;
        return first;
      })
      .mockResolvedValue(prepared),
    save: vi.fn(),
    continuePending: vi.fn()
  };
  const connect = vi.fn(async () => connected);
  const progress = vi.fn();
  const run = () => prepareStandaloneSave({ engine, options, connect, progress });
  return { run, engine, connect, progress, prepared };
}
describe('one manual save includes explicit sign-in without retrying writes', () => {
  it('recovers the reported Google pending state and rescans both destinations once', async () => {
    const f = fixture(unavailable([row('google', 'credential_refresh_pending'), row('yandex', 'unavailable')]));
    expect(await f.run()).toBe(f.prepared);
    expect(f.connect).toHaveBeenCalledExactlyOnceWith('google');
    expect(f.engine.prepareSave).toHaveBeenNthCalledWith(2, options);
    expect(f.engine.save).not.toHaveBeenCalled();
    expect(f.engine.continuePending).not.toHaveBeenCalled();
  });
  it('keeps the healthy Yandex destination when Google sign-in is cancelled', async () => {
    const prepared = { results: [row('google', 'login_required'), row('yandex', 'checked')] };
    const f = fixture(prepared, false);
    expect(await f.run()).toBe(prepared);
    expect(f.engine.prepareSave).toHaveBeenCalledOnce();
    expect(options.targets).toEqual(['google', 'yandex']);
    expect(options.fields).toEqual([]);
  });
  it('does not loop or retry a blocked Google refresh after fresh OAuth', async () => {
    const failure = unavailable([row('google', 'credential_refresh_pending')]);
    const f = fixture(failure);
    f.engine.prepareSave.mockRejectedValueOnce(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.engine.prepareSave).toHaveBeenCalledTimes(2);
  });
  it('supports first login to each selected provider, serially', async () => {
    const f = fixture(unavailable([row('google', 'credential_missing'), row('yandex', 'credential_missing')]));
    await f.run();
    expect(f.connect.mock.calls).toEqual([['google'], ['yandex']]);
  });
  it.each(['verification_pending', 'content_mismatch', 'credential_binding_blocked', 'unavailable'])(
    'never signs in/reset/retries for %s',
    async status => {
      const failure = unavailable([row('google', status), row('yandex', status)]);
      const f = fixture(failure);
      await expect(f.run()).rejects.toBe(failure);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.engine.prepareSave).toHaveBeenCalledOnce();
    }
  );
  it('does not contact unselected destinations or prompt twice for duplicate results', async () => {
    const f = fixture({
      results: [row('google', 'login_required'), row('google', 'login_required'), row('other', 'credential_missing')]
    });
    await f.run();
    expect(f.connect).toHaveBeenCalledExactlyOnceWith('google');
  });
});

it.each(['google_refresh_unconfirmed', 'google_refresh_store_unconfirmed', 'google_scope_unverified'])(
  'offers one fresh sign-in for the exact Google failure %s, never a refresh loop',
  async status => {
    const f = fixture(unavailable([row('google', status)]));
    await f.run();
    expect(f.connect).toHaveBeenCalledExactlyOnceWith('google');
    expect(f.engine.prepareSave).toHaveBeenCalledTimes(2);
    expect(f.engine.save).not.toHaveBeenCalled();
  }
);
