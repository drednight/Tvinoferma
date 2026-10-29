// @ts-check
// Подготовка запросов, а не сетевой клиент. Драйвер и проверка ответа подключаются отдельно.
import { isSyncId, validateEnvelope } from '../envelope.js';

/** Имя не содержит ни ника, ни контактов, ни пути пользователя. */
export function versionFileName(datasetId, versionId) {
  if (!isSyncId(datasetId) || !isSyncId(versionId)) throw new Error('Некорректный идентификатор облачной версии');
  return `tf-v1-${datasetId}-${versionId}.tfsc`;
}

export function envelopeBody(envelope, datasetId) {
  validateEnvelope(envelope);
  if (envelope.datasetId !== datasetId) throw new Error('Облачная версия относится к другому набору');
  return JSON.stringify(envelope);
}

export function validGoogleId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}
