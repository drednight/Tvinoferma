import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const KEY = 'tvinoferma_state_v1';
async function fixture() {
  vi.resetModules();
  localStorage.clear();
  const { state, normalizeState } = await import('../js/core/state.js');
  const { createMarathon, createTask } = await import('../js/modules/marathons/model.js');
  const storage = await import('../js/core/storage.js');
  const { stageSyncIdentities } = await import('../js/modules/cloudSync/commitSyncIdentities.js');
  const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
  Object.assign(
    state,
    normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'local-hero', nick: 'Герой', contacts: { password: 'LOCAL_PASSWORD' } }],
      marathons: [
        createMarathon({
          id: 'local-marathon',
          title: 'Марафон',
          tasks: [createTask({ id: 'local-task', title: 'Задание', rewards: [{ id: 'local-reward', threshold: 1 }] })],
          bonuses: [{ id: 'local-bonus', needTasks: 1, text: 'Бонус' }]
        })
      ],
      plannerEntries: [{ id: 'local-calendar', title: 'Задача', date: '2026-10-30' }],
      settings: { security: { useVault: false } }
    })
  );
  await storage.saveNow();
  return { state, storage, stageSyncIdentities, buildPublicSnapshot };
}
beforeEach(() => vi.restoreAllMocks());

describe('сохранение устойчивых ID перед синхронизацией', () => {
  it('создаёт backup, записывает ID всех видов, сохраняет ссылки в памяти и переживает следующий запуск', async () => {
    const f = await fixture();
    const oldRaw = localStorage.getItem(KEY);
    const chars = f.state.characters;
    const char = chars[0];
    const task = f.state.marathons[0].tasks[0];
    const reward = task.rewards[0];
    const staged = f.stageSyncIdentities({ cryptoSource: webcrypto });
    expect(staged.status).toBe('prepared');
    expect(staged.operation.selectedCount).toBe(6);
    expect(char.syncId).toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe(oldRaw);
    const result = await staged.operation.commit({ confirmed: true });
    expect(result.status).toBe('applied');
    expect(localStorage.getItem(result.backup)).toBe(oldRaw);
    expect(f.state.characters).toBe(chars);
    expect(f.state.characters[0]).toBe(char);
    expect(f.state.marathons[0].tasks[0]).toBe(task);
    expect(task.rewards[0]).toBe(reward);
    expect(char.syncId).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.syncId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reward.syncId).toMatch(/^[0-9a-f-]{36}$/);
    const saved = JSON.parse(localStorage.getItem(KEY));
    expect(saved.characters[0].syncId).toBe(char.syncId);
    expect(saved.characters[0].contacts.password).toBe('LOCAL_PASSWORD');
    expect(saved.marathons[0].tasks[0].syncId).toBe(task.syncId);
    expect(f.stageSyncIdentities({ cryptoSource: webcrypto })).toEqual({ status: 'already_assigned' });
    expect(f.buildPublicSnapshot(saved).sections.characters.records[0].id).toBe(char.syncId);
  });

  it('при следующем сохранении добавляет ID лишь новым сущностям, не меняя прежние', async () => {
    const f = await fixture();
    const first = f.stageSyncIdentities({ cryptoSource: webcrypto });
    expect((await first.operation.commit({ confirmed: true })).status).toBe('applied');
    const charId = f.state.characters[0].syncId;
    const oldCalendar = f.state.plannerEntries[0].syncId;
    const { normalizeState } = await import('../js/core/state.js');
    const extra = normalizeState({
      schemaVersion: 10,
      plannerEntries: [{ id: 'another', title: 'Новая', date: '2026-10-31' }]
    }).plannerEntries[0];
    f.state.plannerEntries.push(extra);
    await f.storage.saveNow();
    const second = f.stageSyncIdentities({ cryptoSource: webcrypto });
    expect(second.operation.selectedCount).toBe(1);
    expect((await second.operation.commit({ confirmed: true })).status).toBe('applied');
    expect(f.state.characters[0].syncId).toBe(charId);
    expect(f.state.plannerEntries[0].syncId).toBe(oldCalendar);
    expect(f.state.plannerEntries[1]).toBe(extra);
    expect(extra.syncId).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(KEY)).plannerEntries[1].syncId).toBe(extra.syncId);
  });

  it.each([null, '', 'not-a-uuid'])('не заменяет повреждённый существующий syncId: %s', async damaged => {
    const f = await fixture();
    f.state.characters[0].syncId = damaged;
    await f.storage.saveNow();
    const before = localStorage.getItem(KEY);
    expect(() => f.stageSyncIdentities({ cryptoSource: webcrypto })).toThrow('идентификаторы');
    expect(f.state.characters[0].syncId).toBe(damaged);
    expect(localStorage.getItem(KEY)).toBe(before);
  });

  it('не записывает устаревший план или не совпадающий диск', async () => {
    const f = await fixture();
    const oldRaw = localStorage.getItem(KEY);
    const first = f.stageSyncIdentities({ cryptoSource: webcrypto });
    f.state.characters[0].notes = 'Несохранённая правка';
    expect(await first.operation.commit({ confirmed: true })).toEqual({ status: 'state_changed' });
    const next = f.stageSyncIdentities({ cryptoSource: webcrypto });
    expect(await next.operation.commit({ confirmed: true })).toEqual({ status: 'disk_changed_or_unsaved' });
    expect(localStorage.getItem(KEY)).toBe(oldRaw);
    expect(f.state.characters[0].syncId).toBeUndefined();
  });
});
