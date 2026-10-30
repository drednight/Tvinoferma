// @ts-check
// Каноническая запись Google OAuth ДЛЯ ОТКЛЮЧЁННЫХ ЭКСПЕРИМЕНТОВ.
// Готовая строка может содержать refresh token и личный идентификатор аккаунта:
// её нельзя логировать, помещать в обычное состояние или отправлять на диск пользователя.
// Этот кодек не подтверждает аккаунт, согласие, первый вход или сохранность записи.
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';

const FORMAT = 'tvinoferma-google-oauth-credential';
const VERSION = 1;
export const MAX_CREDENTIAL_RECORD_CHARS = 16 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = [
  'format',
  'version',
  'slotId',
  'clientId',
  'accountKey',
  'revision',
  'phase',
  'attemptId',
  'refreshToken',
  'refreshExpiresAt'
];

function invalid() {
  return new Error('Некорректная запись доступа к облачному диску');
}

/** @param {unknown} value */
export function validCredentialId(value) {
  return typeof value === 'string' && value.length === 36 && ID.test(value);
}

function canonical(record) {
  return {
    format: FORMAT,
    version: VERSION,
    slotId: record.slotId,
    clientId: record.clientId,
    accountKey: record.accountKey,
    revision: record.revision,
    phase: record.phase,
    attemptId: record.attemptId,
    refreshToken: record.refreshToken,
    refreshExpiresAt: record.refreshExpiresAt
  };
}

/** Разбор только собственных канонических записей. Результат содержит секреты. */
export function parseGoogleCredentialRecord(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CREDENTIAL_RECORD_CHARS) throw invalid();
  try {
    const parsed = JSON.parse(raw);
    const record = object(parsed, FIELDS);
    // JSON.parse сам по себе молча отбрасывает повторные ключи. Канонический
    // порядок и формат также отклоняют лишние поля и экранированные дубликаты.
    if (JSON.stringify(parsed) !== raw || JSON.stringify(canonical(record)) !== raw) throw invalid();
    if (
      record.format !== FORMAT ||
      record.version !== VERSION ||
      !validCredentialId(record.slotId) ||
      !validCredentialId(record.revision) ||
      record.slotId === record.revision ||
      !validOAuthClientId('google', record.clientId) ||
      !validOAuthAccountKey(record.accountKey) ||
      !(
        record.refreshExpiresAt === null ||
        (Number.isSafeInteger(record.refreshExpiresAt) && record.refreshExpiresAt > 0)
      )
    )
      throw invalid();
    if (record.phase === 'ready') {
      if (
        record.attemptId !== null ||
        typeof record.refreshToken !== 'string' ||
        record.refreshToken.length === 0 ||
        record.refreshToken.length > 8192 ||
        /[^\x21-\x7e]/.test(record.refreshToken)
      )
        throw invalid();
    } else if (record.phase === 'pending') {
      // В устойчивой pending-записи нет старого refresh: она не пригодна для POST.
      if (
        !validCredentialId(record.attemptId) ||
        record.attemptId === record.slotId ||
        record.attemptId === record.revision ||
        record.refreshToken !== null ||
        record.refreshExpiresAt !== null
      )
        throw invalid();
    } else throw invalid();
    return record;
  } catch {
    throw invalid();
  }
}

/**
 * Канонизирует проверенную запись. Результат чувствителен; возвращённый ready
 * НЕ означает, что пользователь одобрил аккаунт или что токен безопасно сохранён.
 */
export function serializeGoogleCredentialRecord(value) {
  try {
    const fields = object(value, FIELDS);
    const raw = JSON.stringify(canonical(fields));
    // Не позволяем canonical() исправить несоответствующий format/version.
    if (fields.format !== FORMAT || fields.version !== VERSION) throw invalid();
    parseGoogleCredentialRecord(raw);
    return raw;
  } catch {
    throw invalid();
  }
}

/**
 * Только формирует запись в памяти для будущей установки. ID и аккаунт должны
 * быть ранее и независимо закреплены доверенным вызывающим кодом; здесь это не
 * выполняется. Нельзя считать отсутствие записи доказательством первого входа.
 * @param {{slotId:string, clientId:string, accountKey:string, revision:string,
 * refreshToken:string, refreshExpiresAt:number|null}} options
 */
export function prepareGoogleCredentialRecord(options) {
  try {
    const fields = object(options, [
      'slotId',
      'clientId',
      'accountKey',
      'revision',
      'refreshToken',
      'refreshExpiresAt'
    ]);
    return serializeGoogleCredentialRecord({
      format: FORMAT,
      version: VERSION,
      ...fields,
      phase: 'ready',
      attemptId: null
    });
  } catch {
    throw invalid();
  }
}
