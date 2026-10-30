import { beforeEach, describe, expect, it, vi } from 'vitest';

let beginOperation;
let beginReset;
beforeEach(async () => {
  vi.resetModules();
  ({ beginCloudCredentialOperation: beginOperation, beginCloudCredentialReset: beginReset } =
    await import('../js/modules/cloudSync/credentialResetCoordination.js'));
});

describe('барьер OAuth-сценариев и локального сброса', () => {
  it('ждёт завершения всех участвующих операций и не принимает повторное завершение', () => {
    const first = beginOperation();
    const second = beginOperation();
    expect(() => beginReset()).toThrow();
    first.finish(false);
    expect(() => first.finish(false)).toThrow();
    expect(() => beginReset()).toThrow();
    expect(() => second.finish('false')).toThrow();
    expect(() => beginReset()).toThrow();
    second.finish(false);
    const release = beginReset();
    expect(() => beginOperation()).toThrow();
    expect(() => beginReset()).toThrow();
    release();
    expect(() => release()).toThrow();
    const third = beginOperation();
    third.finish(false);
  });

  it('не очищает неопределённость после завершения других операций', () => {
    const first = beginOperation();
    const second = beginOperation();
    first.finish(true);
    second.finish(false);
    expect(() => beginReset()).toThrow();
    const third = beginOperation();
    third.finish(false);
    expect(() => beginReset()).toThrow();
  });

  it('старый release не снимает новый барьер', () => {
    const firstRelease = beginReset();
    firstRelease();
    const secondRelease = beginReset();
    expect(() => firstRelease()).toThrow();
    expect(() => beginOperation()).toThrow();
    secondRelease();
    const operation = beginOperation();
    operation.finish(false);
  });
});
