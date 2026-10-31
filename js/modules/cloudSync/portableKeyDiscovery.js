// @ts-check
// Только поиск в УЖЕ открытой и привязанной к dataset/аккаунту сессии. Он не выдаёт
// облачный pin за доверенный, не выбирает «самую новую» версию и не меняет данные.
// Неполный/устаревший список на стороне провайдера этим обнаружить нельзя.
import { MAX_HISTORY_INPUT_VERSIONS, MAX_HISTORY_INPUT_CHARS } from './history.js';
import { isSyncId } from './envelope.js';
import { array, object } from './exportSchema.js';
import { inspectPortableEnvelope } from './portableKeyCapsule.js';
import { copyCloudEnvelope } from './providers/common.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';

const MAX_VERSIONS = MAX_HISTORY_INPUT_VERSIONS;
const MAX_TOTAL_CHARS = MAX_HISTORY_INPUT_CHARS;
function failed() {
  return new Error('Не удалось безопасно найти версии для восстановления ключа');
}
function result(status) {
  return Object.freeze({ status });
}
function checkedMetadata(value) {
  const item = object(value, ['versionId', 'modifiedAt']);
  if (!isSyncId(item.versionId)) throw failed();
  const modifiedAt = item.modifiedAt === null ? null : parseCloudModifiedTime(item.modifiedAt);
  if (item.modifiedAt !== null && modifiedAt === null) throw failed();
  return { versionId: item.versionId, modifiedAt };
}
function checkedAt(clock) {
  const value = clock();
  if (!Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000) throw failed();
  return new Date(value).toISOString();
}

/**
 * Получает список и затем каждый файл; не трактует v1 как удалённый ключ. Возвращает
 * только версии, время файла и НЕПРОВЕРЕННЫЕ отпечатки. Файлы надо заново читать и
 * проверять при восстановлении; время проверки — локальные часы, не доказательство свежести.
 * Отмена не обещает остановки уже начатого native-чтения: ждём его завершения и не начинаем следующее.
 * @param {{session:any, datasetId:string, cryptoSource?:Crypto, now?:()=>number, signal?:AbortSignal}} options
 */
export async function findPortableKeyVersions(options) {
  const input = object(options, ['session', 'datasetId'], ['cryptoSource', 'now', 'signal']);
  if (
    !isSyncId(input.datasetId) ||
    !input.session ||
    typeof input.session.listWithDates !== 'function' ||
    typeof input.session.read !== 'function' ||
    (input.now !== undefined && typeof input.now !== 'function') ||
    (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
  )
    throw failed();
  const { session, datasetId, cryptoSource } = input;
  const clock = input.now || Date.now;
  const signal = input.signal;
  if (signal?.aborted) return result('cancelled');
  try {
    const listing = object(await session.listWithDates(), ['status'], ['versions']);
    if (signal?.aborted) return result('cancelled');
    if (listing.status === 'account_mismatch' || listing.status === 'account_unavailable')
      return result(listing.status);
    if (listing.status !== 'listed') return result('unavailable');
    const metadata = array(listing.versions, checkedMetadata);
    if (metadata.length > MAX_VERSIONS || new Set(metadata.map(item => item.versionId)).size !== metadata.length)
      throw failed();
    const candidates = [];
    const legacy = [];
    let total = 0;
    for (const item of metadata) {
      if (signal?.aborted) return result('cancelled');
      const received = object(await session.read(item.versionId), ['status'], ['envelope']);
      if (signal?.aborted) return result('cancelled');
      if (received.status === 'account_mismatch' || received.status === 'account_unavailable')
        return result(received.status);
      if (received.status === 'not_found' || received.status === 'identity_mismatch') return result('changed');
      if (received.status !== 'found') return result('unavailable');
      const envelope = copyCloudEnvelope(received.envelope, datasetId);
      if (envelope.versionId !== item.versionId) return result('changed');
      total += envelope.ciphertext.length + envelope.iv.length + (envelope.keyCapsule?.length || 0);
      if (total > MAX_TOTAL_CHARS) throw failed();
      if (envelope.version === 1) {
        legacy.push(Object.freeze(item));
        continue;
      }
      const inspected = await inspectPortableEnvelope({ envelope, cryptoSource });
      if (signal?.aborted) return result('cancelled');
      candidates.push(Object.freeze({ ...item, pin: inspected.pin }));
    }
    return Object.freeze({
      status: 'listed',
      checkedAt: checkedAt(clock),
      candidates: Object.freeze(candidates),
      legacy: Object.freeze(legacy)
    });
  } catch {
    if (signal?.aborted) return result('cancelled');
    // Ответ провайдера может включать токен или временную URL; не передаём его дальше.
    throw failed();
  }
}
