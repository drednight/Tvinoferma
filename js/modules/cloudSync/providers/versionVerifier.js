// @ts-check
// Изолированная сверка после отправки, не подключена к очереди или приложению.
// Передаётся доверенный GET-транспорт одного и того же подтверждённого аккаунта;
// ни этот модуль, ни совпадение ответа не доказывают подлинность аккаунта, полную
// видимость списка, сохранность облака в будущем или устойчивость локального журнала.
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId } from './common.js';
import { createGoogleVersionReader, createYandexVersionReader } from './versionReaders.js';

function invalid() {
  return new Error('Не удалось подготовить сверку облачной версии');
}

/**
 * Проверяет именно те ASCII-байты JSON-конверта, которые отправил uploadTransport.
 * Для Google дополнительно сверяет заранее сохранённый ID и два полных поиска;
 * для Яндекса — строго определённый путь и проверенную ссылку скачивания.
 * Отсутствие, расхождение или ошибка не разрешают удалить очередь или повторить запись.
 * При сравнении данные и исходные ошибки не возвращаются и не журналируются.
 *
 * @param {{provider:'google'|'yandex',datasetId:string,folderId?:string,send:(request:any)=>Promise<any>}} options
 */
export function createCloudVersionVerifier(options) {
  let input;
  try {
    input = object(options, ['provider', 'datasetId', 'send'], ['folderId']);
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !isSyncId(input.datasetId) ||
      typeof input.send !== 'function' ||
      (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined)
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  const { provider, datasetId, send, folderId } = input;
  const reader =
    provider === 'google'
      ? createGoogleVersionReader({ datasetId, folderId, send })
      : createYandexVersionReader({ datasetId, send });
  return Object.freeze({
    /** @param {{envelope:any,fileId?:string}} options */
    async verify(options) {
      let args;
      let expected;
      try {
        args = object(options, ['envelope'], provider === 'google' ? ['fileId'] : []);
        expected = copyCloudEnvelope(args.envelope, datasetId);
        if (provider === 'google' && !validGoogleId(args.fileId)) throw invalid();
      } catch {
        throw invalid();
      }
      // Шифртекст и порядок полей фиксируются до сети. Эти конверты содержат
      // только ASCII; ограниченный UTF-8 декодер не удаляет BOM и отклоняет ошибки.
      const expectedBytes = JSON.stringify(expected);
      try {
        const result =
          provider === 'google'
            ? await reader.readExact(expected.versionId, args.fileId)
            : await reader.readExact(expected.versionId);
        if (result.status === 'not_found') return { status: 'not_found' };
        if (result.status === 'identity_mismatch' || result.status === 'content_mismatch')
          return { status: 'mismatch' };
        if (result.status !== 'found' || typeof result.serialized !== 'string') return { status: 'unavailable' };
        return { status: result.serialized === expectedBytes ? 'verified' : 'mismatch' };
      } catch {
        // Даже временные URL могут содержаться в исключениях транспорта.
        return { status: 'unavailable' };
      }
    }
  });
}
