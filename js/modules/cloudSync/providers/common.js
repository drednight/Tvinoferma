// @ts-check
// Подготовка запросов, а не сетевой клиент. Драйвер и проверка ответа подключаются отдельно.
import { isSyncId, validateEnvelope } from '../envelope.js';
import { object } from '../exportSchema.js';

const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];
const PORTABLE_ENVELOPE_FIELDS = [
  'format',
  'version',
  'algorithm',
  'datasetId',
  'versionId',
  'keyCapsule',
  'iv',
  'ciphertext'
];

/** Независимая каноническая копия до первого await; наличие шифрования не доказывается форматом. */
export function copyCloudEnvelope(value, datasetId) {
  const fields = object(value, ENVELOPE_FIELDS, ['keyCapsule']);
  // Копируем и необязательное поле, даже если указан v1, чтобы валидатор отклонил его.
  const keys = Object.hasOwn(fields, 'keyCapsule') ? PORTABLE_ENVELOPE_FIELDS : ENVELOPE_FIELDS;
  const copy = Object.fromEntries(keys.map(key => [key, fields[key]]));
  validateEnvelope(copy);
  if (copy.datasetId !== datasetId) throw new Error('Облачная версия относится к другому набору');
  return Object.freeze(copy);
}

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
