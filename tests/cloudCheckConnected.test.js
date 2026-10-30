import { describe, expect, it, vi } from 'vitest';
import { checkConnectedCloud } from '../js/modules/cloudSync/checkConnectedCloud.js';

describe.each(['google', 'yandex'])('%s: проверка уже закреплённого набора', provider => {
  it('при отсутствии локального pin не подготавливает данные, не читает ключ и не трогает диск', async () => {
    const invoke = vi.fn(async command => {
      if (command === 'cloud_dataset_binding_read') return { status: 'empty' };
      throw new Error('неожиданный вызов');
    });
    expect(await checkConnectedCloud({ provider, invoke })).toEqual({ status: 'binding_missing' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('cloud_dataset_binding_read');
  });

  it('при отмене до начала не обращается к IPC', async () => {
    const invoke = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(await checkConnectedCloud({ provider, invoke, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
