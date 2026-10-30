// @ts-check
// Отключённый адаптер внутреннего ключа: только нативное хранилище ОС.
// Записи содержат секрет, не логировать. Timeout не отменяет уже начатый IPC.
import { object } from '../exportSchema.js';
import { createKeyStateRecord, parseKeyStateRecord } from '../keyStateRecord.js';

function failed() {
  return new Error('Не удалось безопасно обработать локальный ключ синхронизации');
}
function timeout(value) {
  const ms = value === undefined ? 25_000 : value;
  if (!Number.isSafeInteger(ms) || ms < 20 || ms > 120_000) throw failed();
  return ms;
}
async function callWithin(invoke, command, args, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(command, args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failed()), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function checkedReply(value, statuses, cryptoSource) {
  const data = object(value, ['status'], ['slotId', 'record']);
  if (!statuses.includes(data.status)) throw failed();
  if (data.status !== 'ready') {
    if (Object.keys(data).length !== 1) throw failed();
    return Object.freeze({ status: data.status });
  }
  if (Object.keys(data).length !== 3 || typeof data.record !== 'string') throw failed();
  const parsed = await parseKeyStateRecord(data.record, cryptoSource);
  if (parsed.state.slotId !== data.slotId) throw failed();
  // state и raw содержат секреты; разрешено передавать только коду синхронизации.
  return Object.freeze({ status: 'ready', state: parsed.state, raw: parsed.raw });
}

/**
 * Ошибка, неизвестный результат или повреждённый ответ блокируют экземпляр.
 * Readback не доказывает fsync, неизменность после чтения или отсутствие отката.
 * @param {{invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number,cryptoSource?:Crypto}} options
 */
export function createNativeKeyStateStore(options) {
  let input;
  let ms;
  try {
    input = object(options, ['invoke'], ['timeoutMs', 'cryptoSource']);
    if (typeof input.invoke !== 'function') throw failed();
    ms = timeout(input.timeoutMs);
  } catch {
    throw failed();
  }
  const { invoke, cryptoSource } = input;
  let active = false;
  let blocked = false;
  async function call(command, args, statuses) {
    if (active || blocked) throw failed();
    active = true;
    try {
      const reply = await checkedReply(await callWithin(invoke, command, args, ms), statuses, cryptoSource);
      if (reply.status === 'blocked') blocked = true;
      return reply;
    } catch {
      blocked = true;
      throw failed();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    read() {
      return call('cloud_key_state_read', {}, ['empty', 'ready', 'blocked']);
    },
    async install(value) {
      let next;
      try {
        next = await createKeyStateRecord(value, cryptoSource);
      } catch {
        throw failed();
      }
      return call('cloud_key_state_install', { slotId: next.state.slotId, record: next.raw }, [
        'installed',
        'occupied',
        'blocked'
      ]);
    },
    async compareExchange(value) {
      let previous;
      let next;
      try {
        const input = object(value, ['expected', 'next']);
        previous = await parseKeyStateRecord(input.expected, cryptoSource);
        next = await createKeyStateRecord(input.next, cryptoSource);
        if (
          previous.state.slotId !== next.state.slotId ||
          previous.state.datasetId !== next.state.datasetId ||
          previous.state.dataKey !== next.state.dataKey ||
          previous.state.revision === next.state.revision ||
          previous.state.bundle.bundleId === next.state.bundle.bundleId ||
          previous.state.pin.sha256 === next.state.pin.sha256
        )
          throw failed();
      } catch {
        throw failed();
      }
      return call(
        'cloud_key_state_compare_exchange',
        {
          slotId: next.state.slotId,
          expected: previous.raw,
          next: next.raw
        },
        ['swapped', 'mismatch', 'blocked']
      );
    },
    forget(confirmed) {
      if (confirmed !== true) throw failed();
      return call('cloud_key_state_forget', { confirmed: true }, ['forgotten']);
    }
  });
}
