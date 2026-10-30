import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../js/core/storage.js', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { state, normalizeState } from '../js/core/state.js';
import { syncIdWithNick } from '../js/modules/characters/identity.js';

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(state, normalizeState({ schemaVersion: 10 }));
  state.characters = [{ id: 'Old', nick: 'New' }];
  state.marathons = [{ id: 'm', participantIds: ['Old'], progress: { Old: { t: 1 } } }];
  mocks.invoke.mockReset();
});
afterEach(() => vi.useRealTimers());

async function run() {
  const pending = syncIdWithNick(state.characters[0]);
  await vi.advanceTimersByTimeAsync(400);
  return pending;
}

describe('переименование профиля и параллельное изменение состояния', () => {
  it('при смене только регистра ника оставляет прежний ID и не трогает профиль', async () => {
    state.characters[0].nick = 'old';
    expect(await syncIdWithNick(state.characters[0])).toEqual({ id: 'Old', changed: false });
    expect(state.characters[0].id).toBe('Old');
    expect(state.marathons[0].participantIds).toEqual(['Old']);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('применяет актуальные изменения после ожидания профиля вместо старой копии', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'rename_char_profiles') {
        state.marathons[0].progress.Old.t = 9;
        state.marathons.push({ id: 'added', participantIds: ['Old'] });
        return [];
      }
    });
    expect(await run()).toEqual({ id: 'New', changed: true });
    expect(state.marathons).toHaveLength(2);
    expect(state.marathons[0].progress.New.t).toBe(9);
    expect(state.marathons[1].participantIds).toEqual(['New']);
  });
  it('не перезаписывает возникшую коллизию и не переименовывает профиль повторно вслепую', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'rename_char_profiles') {
        state.marathons[0].progress.New = { t: 2 };
        return [];
      }
    });
    expect(await run()).toEqual({ id: 'Old', changed: false, error: 'profile_rename_unconfirmed' });
    expect(state.characters[0].id).toBe('Old');
    expect(state.marathons[0].progress).toEqual({ Old: { t: 1 }, New: { t: 2 } });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'rename_char_profiles')).toHaveLength(1);
  });
  it('не трогает профиль, если коллизия известна заранее', async () => {
    state.marathons[0].progress.New = { t: 2 };
    expect(await syncIdWithNick(state.characters[0])).toEqual({
      id: 'Old',
      changed: false,
      error: 'references_conflict'
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
