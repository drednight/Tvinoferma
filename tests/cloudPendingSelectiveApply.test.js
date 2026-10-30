import { describe, expect, it } from 'vitest';
import {
  appendPendingSelectiveApply,
  requireResolvedSelectiveApply
} from '../js/modules/cloudSync/pendingSelectiveApply.js';
import { normalizeState } from '../js/core/state.js';

const event = () => ({
  provider: 'google',
  datasetId: '01234567-89ab-4cde-8f01-23456789abcd',
  pin: { versionId: '11234567-89ab-4cde-8f01-23456789abcd', sha256: 'a'.repeat(64) },
  records: [{ section: 'characters', id: '21234567-89ab-4cde-8f01-23456789abcd' }],
  settings: [],
  financeSettings: false
});

describe('отметка частично принятой версии', () => {
  it('не содержит значений и блокирует дальнейшую отправку после перезапуска', () => {
    expect(() => requireResolvedSelectiveApply({})).not.toThrow();
    const settings = appendPendingSelectiveApply({ privateValue: 'LOCAL_SECRET' }, event());
    expect(JSON.stringify(settings.cloudSyncPendingApply)).not.toContain('LOCAL_SECRET');
    expect(() => requireResolvedSelectiveApply(settings)).toThrow('происхождение');
    const reloaded = normalizeState({ schemaVersion: 10, settings }).settings;
    expect(() => requireResolvedSelectiveApply(reloaded)).toThrow('происхождение');
  });

  it.each([
    null,
    {},
    { version: 2, events: [] },
    { version: 1, events: [] },
    { version: 1, events: [{ ...event(), pin: { versionId: event().pin.versionId, sha256: 'wrong' } }] }
  ])('повреждённая отметка %j не считается отсутствующей', marker => {
    const settings = { cloudSyncPendingApply: marker };
    expect(() => requireResolvedSelectiveApply(settings)).toThrow();
    expect(() => appendPendingSelectiveApply(settings, event())).toThrow();
    expect(() => requireResolvedSelectiveApply(normalizeState({ schemaVersion: 10, settings }).settings)).toThrow();
  });

  it('не принимает дубли, неизвестные группы и добавленные посторонние поля', () => {
    const first = event();
    for (const next of [
      { ...first, records: [...first.records, ...first.records] },
      { ...first, settings: ['passwords'] },
      { ...first, privateValue: 'SECRET' }
    ])
      expect(() => appendPendingSelectiveApply({}, next)).toThrow();
  });
});
