// @ts-check
// Каноническая запись для будущей установки доступа Яндекса. Отключена от UI и
// ОС. Содержит access token и личный ID: её нельзя логировать, сохранять в
// обычный state/браузерное хранилище или отправлять в облако. Это не installer,
// не подтверждение аккаунта и не гарантия сохранности/свежести записи.
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { MAX_CREDENTIAL_RECORD_CHARS, validCredentialId } from './oauthCredentialRecord.js';

const FORMAT = 'tvinoferma-yandex-oauth-access';
const VERSION = 1;
const FIELDS = ['format', 'version', 'slotId', 'clientId', 'accountKey', 'revision', 'accessToken', 'expiresAt'];

function invalid() {
  return new Error('Некорректная запись доступа к облачному диску');
}

function canonical(record) {
  return {
    format: FORMAT,
    version: VERSION,
    slotId: record.slotId,
    clientId: record.clientId,
    accountKey: record.accountKey,
    revision: record.revision,
    accessToken: record.accessToken,
    expiresAt: record.expiresAt
  };
}

/** Результат содержит секрет. Разбираются только собственные канонические записи. */
export function parseYandexCredentialRecord(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CREDENTIAL_RECORD_CHARS) throw invalid();
  try {
    const parsed = JSON.parse(raw);
    const record = object(parsed, FIELDS);
    // JSON.parse без этой сверки скрывает повторные ключи и их экранированные формы.
    if (JSON.stringify(parsed) !== raw || JSON.stringify(canonical(record)) !== raw) throw invalid();
    if (
      record.format !== FORMAT ||
      record.version !== VERSION ||
      !validCredentialId(record.slotId) ||
      !validCredentialId(record.revision) ||
      record.slotId === record.revision ||
      !validOAuthClientId('yandex', record.clientId) ||
      !validOAuthAccountKey(record.accountKey) ||
      typeof record.accessToken !== 'string' ||
      !record.accessToken ||
      record.accessToken.length > 8192 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(record.accessToken) ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= 0
    )
      throw invalid();
    return record;
  } catch {
    throw invalid();
  }
}

/** Проверяет и сериализует запись; не сохраняет и не устанавливает её. */
export function serializeYandexCredentialRecord(value) {
  try {
    const fields = object(value, FIELDS);
    if (fields.format !== FORMAT || fields.version !== VERSION) throw invalid();
    const raw = JSON.stringify(canonical(fields));
    parseYandexCredentialRecord(raw);
    return raw;
  } catch {
    throw invalid();
  }
}

/**
 * Только создаёт запись в памяти. Refresh token намеренно не сохраняется:
 * возможность безопасно продлевать Яндекс-токен без общего client_secret ещё
 * не подтверждена. По истечении access token потребуется повторный вход.
 * @param {{slotId:string,clientId:string,accountKey:string,revision:string,accessToken:string,expiresAt:number}} options
 */
export function prepareYandexCredentialRecord(options) {
  try {
    const fields = object(options, ['slotId', 'clientId', 'accountKey', 'revision', 'accessToken', 'expiresAt']);
    return serializeYandexCredentialRecord({ format: FORMAT, version: VERSION, ...fields });
  } catch {
    throw invalid();
  }
}
