import { beforeEach, describe, expect, it } from 'vitest';
import {
  providerCopyRows,
  readCloudAutoCheck,
  writeCloudAutoCheck,
  clearCloudAutoCheck
} from '../js/modules/cloudSync/ui/cloudCopyPresentation.js';
const row = (versionId, locations) => ({ versionId, sha256: 'a'.repeat(64), locations });
beforeEach(() => localStorage.clear());
describe('per-provider presentation, not automatic replacement ordering', () => {
  it('splits identical copies, selects the latest by each disk date, leaves engine input intact', () => {
    const files = [
      row('same', [
        { provider: 'google', modifiedAt: '2026-11-01' },
        { provider: 'yandex', modifiedAt: '2026-11-02' }
      ]),
      row('old', [{ provider: 'yandex', modifiedAt: '2026-10-01' }]),
      row('new', [{ provider: 'google', modifiedAt: '2026-11-03' }])
    ];
    const before = structuredClone(files);
    expect(providerCopyRows(files).map(file => [file.versionId, file.locations[0].provider])).toEqual([
      ['new', 'google'],
      ['same', 'yandex']
    ]);
    expect(files).toEqual(before);
    expect(providerCopyRows(files, true)).toHaveLength(4);
  });
  it('handles absent/invalid dates and ties deterministically without losing explicit previous copies', () => {
    const files = [
      row('b', [{ provider: 'google', modifiedAt: 'bad' }]),
      row('a', [{ provider: 'google', modifiedAt: null }])
    ];
    expect(providerCopyRows(files)[0].versionId).toBe('a');
    expect(providerCopyRows(files, true)).toHaveLength(2);
    expect(providerCopyRows([])).toEqual([]);
  });
});
it('persists only validated startup and interval preferences, reset restores safe defaults', () => {
  expect(readCloudAutoCheck(document)).toEqual({ version: 1, startup: true, minutes: 15 });
  expect(writeCloudAutoCheck(document, { version: 1, startup: false, minutes: 15 })).toBe(true);
  expect(readCloudAutoCheck(document)).toEqual({ version: 1, startup: false, minutes: 15 });
  expect(writeCloudAutoCheck(document, { version: 1, startup: true, minutes: -1 })).toBe(false);
  clearCloudAutoCheck(document);
  expect(readCloudAutoCheck(document).minutes).toBe(15);
});

it('supports custom whole-minute periods and migrates old five-minute schedules without a tight loop', () => {
  for (const minutes of [0, 15, 30, 60, 47, 1440, 10080]) {
    expect(writeCloudAutoCheck(document, { version: 1, startup: false, minutes })).toBe(true);
    expect(readCloudAutoCheck(document).minutes).toBe(minutes);
  }
  for (const minutes of [1, 5, 14, 15.5, NaN, Infinity, 10081, '30'])
    expect(writeCloudAutoCheck(document, { version: 1, startup: true, minutes })).toBe(false);
  localStorage.setItem('tf_cloud_auto_check_v1', JSON.stringify({ version: 1, startup: false, minutes: 5 }));
  expect(readCloudAutoCheck(document)).toEqual({ version: 1, startup: false, minutes: 15 });
});
