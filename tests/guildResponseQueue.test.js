import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createResponseQueue, normalizePendingResponses } from '../js/modules/guild/responseQueue.js';
import { getClassIconSrcByStem } from '../js/core/constants.js';
import { normalizeState } from '../js/core/state.js';
import { state } from '../js/core/state.js';
import {
  readGuildData,
  readPendingResponses,
  writeGuildData,
  writePendingResponses
} from '../js/modules/guild/state.js';
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));

let entries, queue, send, read, task, changed, allowed;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.useFakeTimers();
  entries = [];
  allowed = true;
  task = {
    status: 'running',
    waitTurn: vi.fn(async () => {}),
    progress: vi.fn(),
    log: vi.fn(),
    finish: vi.fn(function () {
      this.status = 'done';
    })
  };
  send = vi.fn(async () => ({ ok: true }));
  read = vi.fn(async () => ({ events: entries.map(row => ({ id: row.eventId, response: row.response })) }));
  changed = vi.fn();
  queue = createResponseQueue({
    getEntries: () => entries,
    saveEntries: async rows => {
      entries = rows;
    },
    send,
    read,
    begin: async () => task,
    changed,
    enabled: () => allowed
  });
});
afterEach(() => vi.useRealTimers());

describe('отложенный перенос ответов в кланер', () => {
  it('сразу показывает выбор, сбрасывает 7 секунд после последнего действия и объединяет изменения одного события', async () => {
    await queue.enqueue('462', 'yes');
    expect(entries).toEqual([{ eventId: '462', response: 'yes', failed: false }]);
    expect(changed).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    await queue.enqueue('464', 'no');
    await queue.enqueue('462', 'no');
    await vi.advanceTimersByTimeAsync(6000);
    queue.touch();
    await vi.advanceTimersByTimeAsync(6999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls).toEqual([
      ['464', 'no'],
      ['462', 'no']
    ]);
    expect(entries).toHaveLength(2); // acknowledgement alone is not confirmation
    await vi.advanceTimersByTimeAsync(3000);
    expect(entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(task.finish).toHaveBeenCalledWith('Ответы подтверждены сайтом', 'done');
  });

  it('не отправляет следующий ответ, пока предыдущий не завершился', async () => {
    const pending = deferred();
    send.mockImplementationOnce(() => pending.promise);
    await queue.enqueue('1', 'yes');
    await queue.enqueue('2', 'no');
    await vi.advanceTimersByTimeAsync(7000);
    expect(send).toHaveBeenCalledTimes(1);
    await queue.flush(); // parallel flush is coalesced
    pending.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
  });

  it('не теряет новый выбор того же события во время переноса и не выдаёт устаревший ответ за ошибку', async () => {
    const pending = deferred();
    send.mockImplementationOnce(() => pending.promise);
    read.mockResolvedValue({ events: [{ id: '1', response: 'yes' }] });
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(7000);
    await queue.enqueue('1', 'no');
    pending.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(entries).toEqual([{ eventId: '1', response: 'no', failed: false }]);
    expect(task.finish).not.toHaveBeenCalledWith(expect.any(String), 'warn');
    await vi.advanceTimersByTimeAsync(3999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith('1', 'no');
  });

  it.each([false, 'timeout'])(
    'проверяет реальный ответ после неясного результата POST (%s), без ложной ошибки',
    async verdict => {
      if (verdict === false) send.mockResolvedValue({ ok: false });
      else send.mockRejectedValue(verdict);
      await queue.enqueue('1', 'yes');
      await vi.advanceTimersByTimeAsync(10000);
      expect(entries).toEqual([]);
      expect(task.finish).toHaveBeenCalledWith('Ответы подтверждены сайтом', 'done');
    }
  );

  it('ещё раз перечитывает сайт, если он применяет ответы не сразу', async () => {
    read.mockResolvedValueOnce({ events: [{ id: '1', response: 'no' }] });
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(10000);
    expect(entries).toHaveLength(1);
    expect(task.finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('хранит не подтверждённый ответ отдельно; повторяет только после явного клика', async () => {
    read.mockRejectedValue('login');
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(13000);
    expect(entries).toEqual([{ eventId: '1', response: 'yes', failed: true }]);
    expect(task.finish).toHaveBeenCalledWith(expect.stringContaining('Не подтверждено'), 'warn');
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({ events: [{ id: '1', response: 'yes' }] });
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(10000);
    expect(entries).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('подтверждает только совпавшие события, остальные сохраняет для повтора', async () => {
    read.mockResolvedValue({ events: [{ id: '1', response: 'yes' }] });
    await queue.enqueue('1', 'yes');
    await queue.enqueue('2', 'no');
    await vi.advanceTimersByTimeAsync(13000);
    expect(entries).toEqual([{ eventId: '2', response: 'no', failed: true }]);
  });

  it('ждёт очередь скриптов и снова учитывает недавние действия до отправки', async () => {
    const turn = deferred();
    task.waitTurn.mockReturnValue(turn.promise);
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(7000);
    await queue.enqueue('1', 'no');
    await vi.advanceTimersByTimeAsync(3000);
    turn.resolve();
    await vi.advanceTimersByTimeAsync(3999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledWith('1', 'no');
  });

  it('восстанавливает очередь после запуска, но не повторяет прошлые ошибки молча', async () => {
    entries = [
      { eventId: '1', response: 'yes', failed: false },
      { eventId: '2', response: 'no', failed: true }
    ];
    queue.resume();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send.mock.calls).toEqual([['1', 'yes']]);
    expect(entries).toEqual([{ eventId: '2', response: 'no', failed: true }]);
  });

  it('сверка по кнопке обновления убирает уже применённые ответы без повторного POST', async () => {
    entries = [{ eventId: '1', response: 'yes', failed: true }];
    await queue.reconcile({ events: [{ id: '1', response: 'yes' }] });
    expect(entries).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('при выключенном клане ничего не отправляет', async () => {
    await queue.enqueue('1', 'yes');
    allowed = false;
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).not.toHaveBeenCalled();
    expect(await queue.enqueue('2', 'no')).toBe(false);
    expect(entries).toHaveLength(1);
  });

  it('не забывает уже подтверждённые ответы, если повторное чтение сайта не удалось', async () => {
    read.mockResolvedValueOnce({ events: [{ id: '1', response: 'yes' }] }).mockRejectedValueOnce('timeout');
    await queue.enqueue('1', 'yes');
    await queue.enqueue('2', 'no');
    await vi.advanceTimersByTimeAsync(13000);
    expect(entries).toEqual([{ eventId: '2', response: 'no', failed: true }]);
  });

  it('не отправляет несохранённый выбор по старому таймеру и не повторяет неясную запись на диск', async () => {
    const store = vi.fn(async rows => {
      entries = rows;
      if (rows.some(row => row.response === 'no')) throw new Error('disk');
    });
    queue = createResponseQueue({ getEntries: () => entries, saveEntries: store, send, read, begin: async () => task });
    await queue.enqueue('1', 'yes');
    await vi.advanceTimersByTimeAsync(6000);
    await expect(queue.enqueue('1', 'no')).rejects.toThrow('disk');
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledTimes(2);
    expect(entries[0]).toEqual({ eventId: '1', response: 'no', failed: true });
  });

  it('не принимает повреждённые ID и ответы', async () => {
    expect(await queue.enqueue('1;alert(1)', 'yes')).toBe(false);
    expect(await queue.enqueue('1', 'maybe')).toBe(false);
    expect(
      normalizePendingResponses([
        { eventId: '1', response: 'yes' },
        null,
        { eventId: 'x', response: 'no' },
        { eventId: '1', response: 'no', failed: true }
      ])
    ).toEqual([{ eventId: '1', response: 'no', failed: true }]);
  });
});

describe('локальное намерение не подменяет сводку сайта', () => {
  it('сохраняет очередь при нормализации и настоящем обновлении, не меняет ответ сайта и время последней сводки при клике', async () => {
    state.settings.guild = { enabled: true, syncedAt: 123, events: [{ id: '1', response: 'no' }] };
    await writePendingResponses([{ eventId: '1', response: 'yes', failed: false }]);
    expect(readGuildData().syncedAt).toBe(123);
    expect(readGuildData().events[0].response).toBe('no');
    const restored = normalizeState({ settings: { guild: state.settings.guild } });
    expect(restored.settings.guild.pendingResponses).toEqual(readPendingResponses());
    await writeGuildData({ events: [{ id: '1', response: 'no' }] });
    expect(readPendingResponses()).toEqual([{ eventId: '1', response: 'yes', failed: false }]);
    expect(readGuildData().events[0].response).toBe('no');
  });
  it('приводит внешнее имя priest к существующей иконке prist', () => {
    expect(getClassIconSrcByStem('Priest')).toBe(getClassIconSrcByStem('prist'));
    expect(getClassIconSrcByStem('../prist')).toBeNull();
  });
});
it('сопоставляет внешние имена иконки стрелка с локальным gan.webp', () => {
  for (const stem of ['gun', 'Gun', 'gunner', 'gan'])
    expect(getClassIconSrcByStem(stem)).toBe('assets/icons/classes/gan.webp');
});

it('keeps manual display leader separate from site metadata across refresh and normalization', async () => {
  const { setGuildLeaderOverride } = await import('../js/modules/guild/state.js');
  state.settings.guild = {
    enabled: true,
    parties: [{ name: 'Party', members: [{ nick: 'Alpha' }, { nick: 'Beta' }] }]
  };
  await setGuildLeaderOverride('Party', 'Beta');
  expect(readGuildData().leaderOverrides).toEqual([{ party: 'Party', nick: 'Beta' }]);
  expect(readGuildData().parties[0].members.every(m => !m.leader)).toBe(true);
  await writeGuildData({ parties: [{ name: 'Party', members: [{ nick: 'Alpha', leader: true }, { nick: 'Beta' }] }] });
  expect(readGuildData().leaderOverrides).toEqual([{ party: 'Party', nick: 'Beta' }]);
  expect(normalizeState({ settings: { guild: state.settings.guild } }).settings.guild.leaderOverrides).toEqual([
    { party: 'Party', nick: 'Beta' }
  ]);
  await expect(setGuildLeaderOverride('Party', 'Missing')).rejects.toThrow();
  await setGuildLeaderOverride('Party', '');
  expect(readGuildData().leaderOverrides).toEqual([]);
});
