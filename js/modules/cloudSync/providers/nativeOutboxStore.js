// @ts-check
// Экспериментальный IPC-адаптер зашифрованного журнала. Не подключён к UI или
// настоящим аккаунтам. Ошибка/потеря ответа записи блокирует этот экземпляр;
// отмена или timeout в JS не останавливают уже начатую native-операцию.
import { object } from '../exportSchema.js';
import { copyCloudEnvelope } from './common.js';

const ERROR = 'Не удалось безопасно обработать локальную очередь облака';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const MAX_RECORD_CHARS = 24 * 1024 * 1024;

function failed() {
  return new Error(ERROR);
}
function id(value) {
  return typeof value === 'string' && UUID.test(value);
}
function validRecord(input) {
  if (
    !id(input.slotId) ||
    !id(input.datasetId) ||
    !id(input.deviceId) ||
    !id(input.revisionId) ||
    new Set([input.slotId, input.datasetId, input.deviceId, input.revisionId]).size !== 4 ||
    typeof input.record !== 'string' ||
    input.record.length > MAX_RECORD_CHARS
  )
    throw failed();
  let parsed;
  try {
    parsed = JSON.parse(input.record);
    const envelope = copyCloudEnvelope(parsed, input.datasetId);
    if (envelope.versionId !== input.revisionId || JSON.stringify(envelope) !== input.record) throw failed();
  } catch {
    throw failed();
  }
}
function writeArgs(value, compare) {
  const fields = object(
    value,
    ['slotId', 'datasetId', 'deviceId', 'revisionId', 'record'],
    compare ? ['expectedRevisionId', 'expectedSha256'] : []
  );
  validRecord(fields);
  if (
    compare &&
    (!id(fields.expectedRevisionId) ||
      fields.expectedRevisionId === fields.revisionId ||
      typeof fields.expectedSha256 !== 'string' ||
      !HEX.test(fields.expectedSha256))
  )
    throw failed();
  return fields;
}
function reply(value, statuses) {
  const fields = object(value, ['status'], ['slotId', 'datasetId', 'deviceId', 'revisionId', 'sha256', 'record']);
  if (!statuses.includes(fields.status)) throw failed();
  if (fields.status !== 'ready') {
    if (Object.keys(fields).length !== 1) throw failed();
    return Object.freeze({ status: fields.status });
  }
  if (Object.keys(fields).length !== 7 || typeof fields.sha256 !== 'string' || !HEX.test(fields.sha256)) throw failed();
  validRecord(fields);
  return Object.freeze(fields);
}
function timeout(value) {
  const result = value === undefined ? 25_000 : value;
  if (!Number.isSafeInteger(result) || result < 20 || result > 120_000) throw failed();
  return result;
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

/**
 * Адаптер обращается только к заранее заданному провайдеру и трём операциям IPC.
 * Хранилище и lock должны выполнять договорённости durableOutbox; результат readback
 * не является доказательством fsync или защиты от согласованного отката обоих хранилищ.
 * Любая ошибка IPC не содержит исходного исключения и переводит объект в карантин.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number,
 * initialGuard?:{accountSlotId:string,keySlotId:string,bundleId:string,fingerprint:string}}} options
 */
export function createNativeOutboxStore(options) {
  let input;
  let timeoutMs;
  try {
    input = object(options, ['provider', 'invoke'], ['timeoutMs', 'initialGuard']);
    if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function') throw failed();
    if (input.initialGuard !== undefined) {
      const guard = object(input.initialGuard, ['accountSlotId', 'keySlotId', 'bundleId', 'fingerprint']);
      if (
        !id(guard.accountSlotId) ||
        !id(guard.keySlotId) ||
        !id(guard.bundleId) ||
        typeof guard.fingerprint !== 'string' ||
        !HEX.test(guard.fingerprint)
      )
        throw failed();
      input.initialGuard = Object.freeze({ ...guard });
    }
    timeoutMs = timeout(input.timeoutMs);
  } catch {
    throw failed();
  }
  const { provider, invoke } = input;
  let active = false;
  let blocked = false;
  async function call(command, args, statuses) {
    if (active || blocked) throw failed();
    active = true;
    try {
      return reply(await callWithin(invoke, command, args, timeoutMs), statuses);
    } catch {
      blocked = true;
      throw failed();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    read() {
      return call('cloud_outbox_read', { provider }, ['empty', 'ready', 'pending', 'blocked']);
    },
    install(value) {
      let args;
      try {
        args = writeArgs(value, false);
      } catch {
        throw failed();
      }
      return call('cloud_outbox_install', { provider, args }, ['installed', 'occupied', 'blocked']);
    },
    installInitial(value) {
      if (!input.initialGuard) throw failed();
      let args;
      try {
        args = writeArgs(value, false);
      } catch {
        throw failed();
      }
      return call('cloud_outbox_install_initial', { provider, args, guard: input.initialGuard }, [
        'installed',
        'occupied',
        'blocked'
      ]);
    },
    compareExchange(value) {
      let args;
      try {
        args = writeArgs(value, true);
      } catch {
        throw failed();
      }
      return call('cloud_outbox_compare_exchange', { provider, args }, ['swapped', 'mismatch', 'blocked']);
    }
  });
}
