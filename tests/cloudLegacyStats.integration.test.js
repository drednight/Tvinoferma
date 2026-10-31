// @vitest-environment jsdom
// Историческая схема DEFAULT_STATS: bb141ee / bc27bd1 / 8f7c318;
// 54058f8 убрал hpMax/mpMax/stealth/detection, 69c8245 — power.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state, normalizeState } from '../js/core/state.js';
import { normalizeCharacter } from '../js/core/state/character.js';
import { saveNow } from '../js/core/storage.js';
import { stageSyncIdentities } from '../js/modules/cloudSync/commitSyncIdentities.js';
import { captureInitialCloudBaseline } from '../js/modules/cloudSync/initialCloudBaseline.js';
import { exportCharacter } from '../js/modules/cloudSync/characterExport.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { prepareFullPublicSnapshotReplace } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import {
  encryptSnapshot,
  decryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../js/modules/cloudSync/envelope.js';

const LEGACY = { hpMax: 42000, mpMax: 7000, power: 123, stealth: 40, detection: 50 };
const OLD = { hpMax: 40000, mpMax: 6000, power: 100, stealth: 30, detection: 35 };
const syncId = 'c9115bf2-e834-444d-aeb6-7c3af1db8890';
const opts = { syncId, partySyncIds: new Map() };
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  Object.assign(state, normalizeState({ schemaVersion: 10, settings: { security: { useVault: false } } }));
});
afterEach(() => vi.unstubAllGlobals());

describe('совместимость облака с историческими характеристиками приложения', () => {
  it.each(Object.keys(LEGACY))('сохраняет присутствие и значение %s в текущих статах и истории', key => {
    const char = normalizeCharacter({
      id: 'old',
      syncId,
      nick: 'Старый',
      stats: { [key]: LEGACY[key] },
      statsHistory: [{ at: '2026-01-01', stats: { [key]: OLD[key] } }]
    });
    const before = structuredClone(char);
    const out = exportCharacter(char, opts);
    expect(out.fields.stats[key]).toBe(LEGACY[key]);
    expect(out.fields.statsHistory[0].stats[key]).toBe(OLD[key]);
    for (const other of Object.keys(LEGACY).filter(other => other !== key)) {
      expect(out.fields.stats).not.toHaveProperty(other);
      expect(out.fields.statsHistory[0].stats).not.toHaveProperty(other);
    }
    expect(char).toEqual(before);
  });

  it('не добавляет удалённые показатели новым карточкам', () => {
    const char = normalizeCharacter({ id: 'new', syncId });
    const out = exportCharacter(char, opts);
    for (const key of Object.keys(LEGACY)) expect(out.fields.stats).not.toHaveProperty(key);
  });

  it.each([NaN, Infinity, -Infinity, -0, '100', null, {}, []])(
    'не приводит неподдерживаемый legacy-тип %j к числу при экспорте',
    value => {
      const char = normalizeCharacter({ id: 'old', syncId });
      char.stats.hpMax = value;
      expect(() => exportCharacter(char, opts)).toThrow();
      delete char.stats.hpMax;
      char.statsHistory = [{ at: null, stats: { ...char.stats, stealth: value } }];
      expect(() => exportCharacter(char, opts)).toThrow();
    }
  );

  it('не разрешает неизвестные поля/секреты, getter и символ рядом с legacy-полями', () => {
    for (const key of ['accessToken', 'password', 'unknownStat']) {
      const char = normalizeCharacter({ id: 'old', syncId, stats: LEGACY });
      char.stats[key] = 123;
      expect(() => exportCharacter(char, opts)).toThrow();
    }
    const char = normalizeCharacter({ id: 'old', syncId });
    const getter = vi.fn(() => 100);
    Object.defineProperty(char.stats, 'hpMax', { enumerable: true, configurable: true, get: getter });
    expect(() => exportCharacter(char, opts)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    delete char.stats.hpMax;
    char.stats[Symbol('private')] = 1;
    expect(() => exportCharacter(char, opts)).toThrow();
  });

  it('реальный save → ID backup/commit → baseline → шифрование/чтение → второй localState → reload сохраняет все старые значения', async () => {
    Object.assign(
      state,
      normalizeState({
        schemaVersion: 10,
        characters: [
          {
            id: 'old',
            nick: 'Старый',
            stats: LEGACY,
            statsHistory: [{ at: '2026-01-01', stats: OLD }],
            contacts: { password: 'FAKE_PRIVATE_PASSWORD' }
          }
        ],
        archivedCharacters: [
          { id: 'archived', nick: 'Архив', stats: OLD, statsHistory: [{ at: null, stats: LEGACY }] }
        ],
        settings: { security: { useVault: false } }
      })
    );
    await saveNow();
    const saved = localStorage.getItem('tvinoferma_state_v1');
    const character = state.characters[0];
    const staged = stageSyncIdentities();
    expect(staged.status).toBe('prepared');
    const commit = await staged.operation.commit({ confirmed: true });
    expect(commit.status).toBe('applied');
    expect(localStorage.getItem(commit.backup)).toBe(saved);
    expect(state.characters[0]).toBe(character);
    expect(character.stats).toMatchObject(LEGACY);
    expect(character.contacts.password).toBe('FAKE_PRIVATE_PASSWORD');
    const baseline = await captureInitialCloudBaseline();
    expect(baseline.status).toBe('ready');
    const snapshot = baseline.getPublicSnapshot();
    const recoveryKey = generateRecoveryKey(webcrypto);
    const datasetId = generateSyncId(webcrypto);
    const envelope = await encryptSnapshot({
      snapshot,
      recoveryKey,
      datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    const received = await decryptSnapshot({
      envelope,
      recoveryKey,
      expectedDatasetId: datasetId,
      cryptoSource: webcrypto
    });
    expect(received).toEqual(snapshot);
    expect(JSON.stringify(received)).not.toContain('FAKE_PRIVATE_PASSWORD');
    const { ui: _ui, ...empty } = normalizeState({ schemaVersion: 10 });
    const target = prepareFullPublicSnapshotReplace({
      localState: empty,
      cloudSnapshot: received,
      cryptoSource: webcrypto
    }).candidateState();
    expect(target.characters[0].stats).toMatchObject(LEGACY);
    expect(target.archivedCharacters[0].stats).toMatchObject(OLD);
    expect(target.characters[0].statsHistory[0].stats).toMatchObject(OLD);
    expect(target.archivedCharacters[0].statsHistory[0].stats).toMatchObject(LEGACY);
    expect(buildPublicSnapshot(target)).toEqual(snapshot);
    const { ui: _targetUi, ...reloaded } = normalizeState(JSON.parse(JSON.stringify(target)));
    expect(buildPublicSnapshot(reloaded)).toEqual(snapshot);
    expect(await baseline.stillCurrentAndSaved()).toBe(true);
    baseline.close();
  });
});
