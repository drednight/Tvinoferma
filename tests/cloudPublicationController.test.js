import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicationController } from '../js/modules/cloudSync/publicationController.js';

// Планировщик проверяется с поддельными IPC и таймерами, не с реальными дисками.
const key = 'tf_cloud_auto_publication_v1';
let controllers;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  controllers = [];
});
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(overrides = {}) {
  const queue = vi.fn(async () => ({ status: 'queued' }));
  const send = vi.fn(async () => ({ status: 'sent_verified' }));
  const report = vi.fn();
  const invoke = vi.fn();
  const loadNative = vi.fn(async () => ({ invoke }));
  const controller = createPublicationController({
    win: window,
    desktop: true,
    queue,
    send,
    report,
    loadNative,
    isOnline: () => true,
    ...overrides
  });
  controllers.push(controller);
  return { controller, queue, send, report, invoke, loadNative };
}
function event(type) {
  window.dispatchEvent(new Event(type));
}
async function advance(ms) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('экспериментальный планировщик отправки после сохранений', () => {
  it('по умолчанию ничего не запускает; ручная отправка не включает автоматизацию', async () => {
    const f = setup();
    event('tf-cloud-startup-check');
    event('tf-persisted');
    await advance(180_000);
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.controller.runManual('yandex')).toEqual({ status: 'sent_verified' });
    expect(f.queue).toHaveBeenCalledWith({ provider: 'yandex', invoke: f.invoke, prepareIdentities: true });
    expect(f.send).toHaveBeenCalledWith({ provider: 'yandex', invoke: f.invoke, signal: expect.any(AbortSignal) });
    expect(f.controller.configuredProvider()).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('восстанавливает явную локальную настройку и объединяет частые события сохранения', async () => {
    const first = setup();
    expect(first.controller.enable('google')).toBe(true);
    expect(JSON.parse(localStorage.getItem(key))).toEqual({ version: 1, provider: 'google' });
    first.controller.dispose();
    const f = setup();
    expect(f.controller.configuredProvider()).toBe('google');
    event('tf-persisted');
    await advance(4000);
    expect(f.queue).not.toHaveBeenCalled(); // boot ещё не завершён
    event('tf-cloud-startup-check');
    await advance(5001);
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    event('tf-persisted');
    await advance(500);
    event('tf-persisted');
    await advance(500);
    event('tf-persisted');
    await advance(1499);
    expect(f.queue).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(f.queue).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.every(([value]) => value.provider === 'google')).toBe(true);
  });

  it('без сети готовит очередь, после события online продолжает отправку', async () => {
    let online = false;
    const f = setup({ isOnline: () => online });
    event('tf-cloud-startup-check');
    expect(f.controller.enable('yandex')).toBe(true);
    await advance(1500);
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledWith('yandex', 'send', 'offline');
    online = true;
    event('online');
    await advance(0);
    expect(f.queue).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('после объединения запускает сохранённую очередь только при включённой автоотправке', async () => {
    const f = setup();
    event('tf-cloud-startup-check');
    event('tf-cloud-reconciled');
    await advance(1500);
    expect(f.queue).not.toHaveBeenCalled();
    f.controller.enable('yandex');
    await advance(1500);
    expect(f.queue).toHaveBeenCalledTimes(1);
    event('tf-cloud-reconciled');
    await advance(0);
    expect(f.queue).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(2);
    f.controller.disable();
    event('tf-cloud-reconciled');
    await advance(180_000);
    expect(f.queue).toHaveBeenCalledTimes(2);
  });

  it('выключение во время подготовки не запускает сеть и снимает локальное разрешение', async () => {
    let release;
    const pending = new Promise(resolve => (release = resolve));
    const queue = vi.fn(() => pending);
    const f = setup({ queue });
    event('tf-cloud-startup-check');
    f.controller.enable('yandex');
    await advance(1500);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(f.controller.disable()).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
    release({ status: 'queued' });
    await advance(0);
    await advance(180_000);
    expect(f.send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('отмена при сетевой проверке передаёт AbortSignal и не планирует новые попытки', async () => {
    let received;
    const send = vi.fn(({ signal }) => {
      received = signal;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled' })));
    });
    const f = setup({ send });
    event('tf-cloud-startup-check');
    f.controller.enable('google');
    await advance(1500);
    expect(received.aborted).toBe(false);
    expect(f.controller.disable()).toBe(true);
    expect(received.aborted).toBe(true);
    await advance(180_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('после занятой стартовой проверки повторяет позже, без быстрой бесконечной гонки', async () => {
    const queue = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable_or_busy' })
      .mockResolvedValue({ status: 'unchanged' });
    const f = setup({ queue });
    event('tf-cloud-startup-check');
    f.controller.enable('yandex');
    await advance(1500);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    await advance(89_999);
    expect(queue).toHaveBeenCalledTimes(1);
    await advance(2);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('не обходит блокировку очереди; при удалении сохраняет причину даже после попытки сверки', async () => {
    const queue = vi.fn().mockResolvedValueOnce({ status: 'journal_uncertain' });
    const f = setup({ queue });
    expect(await f.controller.runManual('google')).toEqual({ status: 'journal_uncertain' });
    expect(f.send).not.toHaveBeenCalled();
    queue.mockResolvedValueOnce({ status: 'deletions_need_review' });
    f.send.mockResolvedValueOnce({ status: 'latest_not_queued' });
    expect(await f.controller.runManual('google')).toEqual({ status: 'deletions_need_review' });
    expect(f.report).toHaveBeenLastCalledWith('google', 'queue', 'deletions_need_review');
  });

  it('сверяет старую попытку и обрабатывает новое сохранение отдельным проходом', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: 'verified_previous_attempt' })
      .mockResolvedValueOnce({ status: 'sent_verified' });
    const f = setup({ send });
    expect(await f.controller.runManual('yandex')).toEqual({ status: 'sent_verified' });
    expect(f.queue).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenCalledWith('yandex', 'send', 'verified_previous_attempt');
    expect(f.report).toHaveBeenCalledWith('yandex', 'send', 'sent_verified');
  });

  it('переключение диска отменяет старую автоматизацию; сброс убирает локальное разрешение', async () => {
    const f = setup();
    event('tf-cloud-startup-check');
    expect(f.controller.enable('google')).toBe(true);
    expect(f.controller.enable('yandex')).toBe(true);
    await advance(1500);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].provider).toBe('yandex');
    event('tf-factory-reset-started');
    expect(f.controller.configuredProvider()).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    event('tf-persisted');
    await advance(180_000);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('не включает автоматизацию при неподтверждённой записи разрешения или в браузерном демо', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('PRIVATE STORAGE ERROR');
      }),
      removeItem: vi.fn()
    };
    const f = setup({ storage });
    event('tf-cloud-startup-check');
    expect(f.controller.enable('google')).toBe(false);
    await advance(180_000);
    expect(f.queue).not.toHaveBeenCalled();
    const demo = setup({ desktop: false });
    expect(demo.controller.enable('google')).toBe(false);
    expect(await demo.controller.runManual('google')).toEqual({ status: 'unavailable' });
    expect(demo.queue).not.toHaveBeenCalled();
  });
});

it('новый файловый интерфейс не запускает старую автоотправку, но сохраняет ручное завершение очереди', async () => {
  localStorage.setItem(key, JSON.stringify({ version: 1, provider: 'google' }));
  const f = setup({ allowAutomatic: false });
  expect(f.controller.configuredProvider()).toBeNull();
  expect(f.controller.enable('google')).toBe(false);
  window.dispatchEvent(new Event('tf-cloud-startup-check'));
  window.dispatchEvent(new Event('tf-persisted'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.queue).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
  await f.controller.runManual('google');
  expect(f.queue).toHaveBeenCalled();
  expect(f.send).toHaveBeenCalled();
  expect(f.controller.configuredProvider()).toBeNull();
});
