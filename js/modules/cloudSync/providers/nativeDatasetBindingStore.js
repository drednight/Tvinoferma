// @ts-check
// Отключённый локальный pin набора/корня. Native под общим lock проверяет пару
// аккаунта и синтаксис ключа; JS дополнительно обязан проверить HMAC ключа.
// Ошибки и параметры не журналируются. Timeout не отменяет уже начатый IPC.
import { object } from '../exportSchema.js';
import { createDatasetBindingRecord, parseDatasetBindingRecord } from '../datasetBindingRecord.js';

function failed() {
  return new Error('Не удалось безопасно обработать локальную привязку синхронизации');
}
async function within(invoke, command, args, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(command, args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failed()), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Не устанавливает доверие к коду или найденной папке. Установка разрешена только
 * после отдельной проверки и подтверждения; этот флаг не доказывает их источник.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number}} options
 */
export function createNativeDatasetBindingStore(options) {
  let input;
  try {
    input = object(options, ['provider', 'invoke'], ['timeoutMs']);
    if (
      !['google', 'yandex'].includes(input.provider) ||
      typeof input.invoke !== 'function' ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  const { provider, invoke } = input;
  const ms = input.timeoutMs ?? 25_000;
  let active = false;
  let blocked = false;
  async function call(command, args, statuses) {
    if (active || blocked) throw failed();
    active = true;
    try {
      const reply = object(await within(invoke, command, args, ms), ['status'], ['record']);
      if (!statuses.includes(reply.status)) throw failed();
      if (reply.status === 'ready') {
        if (Object.keys(reply).length !== 2) throw failed();
        const parsed = parseDatasetBindingRecord(reply.record);
        if (parsed.binding.provider !== provider) throw failed();
        return Object.freeze({ status: 'ready', ...parsed });
      }
      if (Object.keys(reply).length !== 1) throw failed();
      if (reply.status === 'blocked') blocked = true;
      return Object.freeze({ status: reply.status });
    } catch {
      blocked = true;
      throw failed();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    read() {
      return call('cloud_dataset_binding_read', { provider }, ['empty', 'blocked', 'ready']);
    },
    install(binding, confirmed) {
      const prepared = createDatasetBindingRecord(binding);
      if (confirmed !== true || prepared.binding.provider !== provider) throw failed();
      return call('cloud_dataset_binding_install', { provider, record: prepared.raw, confirmed: true }, [
        'installed',
        'occupied',
        'blocked'
      ]);
    },
    forget(confirmed) {
      if (confirmed !== true) throw failed();
      return call('cloud_dataset_binding_forget', { provider, confirmed: true }, ['forgotten']);
    }
  });
}
