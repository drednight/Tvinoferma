import { describe, expect, it } from 'vitest';
import {
  cloudChangePath,
  cloudChangeValue,
  cloudChangeCounts,
  folderNextStep
} from '../js/modules/cloudSync/ui/cloudFilePresentation.js';
describe('human-readable, read-only cloud details', () => {
  it('translates known paths and statuses, never turns unknown fields into guesses', () => {
    expect(cloudChangePath(['statusByDate', '2026-11-01'])).toBe('Выполнение по дням › 01.11.2026');
    expect(cloudChangePath(['updatedAt'])).toBe('Дата изменения');
    expect(cloudChangePath(['toString'])).toBe('toString');
    expect(cloudChangeValue({ present: true, value: 'done' }, ['status'])).toBe('Выполнено');
    expect(cloudChangeValue({ present: true, value: 'done' }, ['notes'])).toBe('done');
    expect(cloudChangeValue({ present: false }, [])).toBe('отсутствует');
    expect(cloudChangeValue({ present: true, value: 'x'.repeat(500) }, [])).toHaveLength(300);
  });
  it('counts additions/changes/removals without modifying entries', () => {
    const entries = [{ kind: 'only_cloud' }, { kind: 'only_local' }, { kind: 'changed' }];
    const before = structuredClone(entries);
    expect(cloudChangeCounts(entries)).toEqual([
      ['Добавится', 1],
      ['Изменится', 1],
      ['Удалится', 1]
    ]);
    expect(entries).toEqual(before);
  });
  it('separates missing rights, DNS/TLS failures and uncertain writes with safe next steps', () => {
    expect(folderNextStep('folder_not_created', 'folder_forbidden')).toContain('старый токен');
    expect(folderNextStep('folder_unavailable', 'disk_native_connect')).toContain('DNS');
    expect(folderNextStep('folder_creation_unconfirmed', 'PRIVATE')).toContain('Сначала проверьте');
    expect(folderNextStep('unknown', 'PRIVATE')).not.toContain('PRIVATE');
  });
});
