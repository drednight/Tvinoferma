import { describe, expect, it, vi } from 'vitest';
import { createDatasetBindingRecord, parseDatasetBindingRecord } from '../js/modules/cloudSync/datasetBindingRecord.js';
import { createNativeDatasetBindingStore } from '../js/modules/cloudSync/providers/nativeDatasetBindingStore.js';

const accountSlotId = '01234567-89ab-4cde-8f01-23456789abcd';
const keySlotId = '21234567-89ab-4cde-8f01-23456789abcd';
const datasetId = '41234567-89ab-4cde-8f01-23456789abcd';
const bundleId = '51234567-89ab-4cde-8f01-23456789abcd';
const versionId = '61234567-89ab-4cde-8f01-23456789abcd';
const input = provider => ({
  provider,
  accountSlotId,
  keySlotId,
  datasetId,
  keyPin: { bundleId, sha256: 'a'.repeat(64) },
  rootPin: { versionId, sha256: 'b'.repeat(64) },
  ...(provider === 'google' ? { folderId: 'FOLDER_123' } : {})
});

describe.each(['google', 'yandex'])('%s: локальный pin набора и корня', provider => {
  it('канонически кодируется без ключей и токенов и не оставляет изменяемых ссылок', () => {
    const original = input(provider);
    const made = createDatasetBindingRecord(original);
    expect(parseDatasetBindingRecord(made.raw)).toEqual(made);
    expect(made.raw).not.toContain('TF1-');
    expect(made.raw).not.toContain('accessToken');
    expect(made.raw).not.toContain('refreshToken');
    original.keyPin.sha256 = 'c'.repeat(64);
    expect(made.binding.keyPin.sha256).toBe('a'.repeat(64));
    expect(Object.isFrozen(made.binding)).toBe(true);
    expect(Object.isFrozen(made.binding.keyPin)).toBe(true);
  });
  it('не принимает повреждённые записи, дополнительные поля, неточные хеши и подмену провайдера', () => {
    const raw = createDatasetBindingRecord(input(provider)).raw;
    const malformed = [
      `${raw}|extra`,
      raw.replace('|ready|', '|pending|'),
      raw.replace('a'.repeat(64), 'A'.repeat(64)),
      raw.replace(datasetId, 'bad'),
      raw.replace(provider, 'other'),
      raw.slice(0, raw.lastIndexOf('|')),
      raw + '\n'
    ];
    if (provider === 'google')
      malformed.push(raw.replace('FOLDER_123', '../bad'), raw.replace('FOLDER_123', 'x'.repeat(257)));
    else malformed.push(raw.replace(/-$/, 'FOLDER_123'));
    for (const value of malformed) expect(() => parseDatasetBindingRecord(value)).toThrow();
    expect(() => createDatasetBindingRecord({ ...input(provider), secret: 'no' })).toThrow();
    expect(() =>
      createDatasetBindingRecord({
        ...input(provider),
        ...(provider === 'google' ? { folderId: '' } : { folderId: 'x' })
      })
    ).toThrow();
  });
  it('через fake IPC устанавливает только с подтверждением, перечитывает и забывает', async () => {
    let raw = null;
    const invoke = vi.fn(async (cmd, args) => {
      expect(args.provider).toBe(provider);
      if (cmd === 'cloud_dataset_binding_read')
        return raw === null ? { status: 'empty' } : { status: 'ready', record: raw };
      if (cmd === 'cloud_dataset_binding_install') {
        if (raw !== null) return { status: 'occupied' };
        expect(args.confirmed).toBe(true);
        raw = args.record;
        return { status: 'installed' };
      }
      if (cmd === 'cloud_dataset_binding_forget') {
        expect(args.confirmed).toBe(true);
        raw = null;
        return { status: 'forgotten' };
      }
      throw new Error('PRIVATE');
    });
    const store = createNativeDatasetBindingStore({ provider, invoke });
    expect(await store.read()).toEqual({ status: 'empty' });
    expect(() => store.install(input(provider), false)).toThrow();
    expect(() => store.forget(false)).toThrow();
    expect(await store.install(input(provider), true)).toEqual({ status: 'installed' });
    expect((await store.read()).binding).toEqual(input(provider));
    expect(await store.install(input(provider), true)).toEqual({ status: 'occupied' });
    expect(await store.forget(true)).toEqual({ status: 'forgotten' });
    expect(await store.read()).toEqual({ status: 'empty' });
  });
  it('повреждённый ответ, неизвестный исход и blocked закрывают экземпляр', async () => {
    for (const reply of [
      { status: 'ready', record: 'bad' },
      { status: 'empty', record: 'bad' },
      { status: 'unknown' },
      { status: 'ready', record: createDatasetBindingRecord(input(provider === 'google' ? 'yandex' : 'google')).raw }
    ]) {
      const invoke = vi.fn(async () => reply);
      const store = createNativeDatasetBindingStore({ provider, invoke });
      await expect(store.read()).rejects.toThrow();
      await expect(store.read()).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
    const invoke = vi.fn(async () => ({ status: 'blocked' }));
    const store = createNativeDatasetBindingStore({ provider, invoke });
    expect(await store.read()).toEqual({ status: 'blocked' });
    await expect(store.read()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
