// @ts-check
// Отключённый шифрующий слой записей Google/Яндекса. НЕ является реализацией
// безопасного, атомарного или устойчивого к сбою хранилища ОС. Бэкенд и ключ
// внедряются доверенным вызывающим кодом; Web Storage вместо него не подходит.
// Строки до шифрования, ключ и аргументы методов чувствительны: не логировать.
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import {
  MAX_CREDENTIAL_RECORD_CHARS,
  parseGoogleCredentialRecord,
  validCredentialId
} from './oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from './oauthYandexCredentialRecord.js';

const FORMATS = Object.freeze({
  google: 'tvinoferma-local-google-oauth-sealed',
  yandex: 'tvinoferma-local-yandex-oauth-sealed'
});
const VERSION = 1;
const ALGORITHM = 'AES-256-GCM';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CIPHER_BYTES = MAX_CREDENTIAL_RECORD_CHARS + TAG_BYTES;
const MAX_ENVELOPE_CHARS = 24 * 1024;
const RECENT_NONCES = 1024;
const FIELDS = ['format', 'version', 'algorithm', 'iv', 'ciphertext'];

function failed() {
  return new Error('Не удалось безопасно обработать запись доступа к облачному диску');
}

function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function bytesFromBase64url(value, maxBytes) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1 ||
    value.length > Math.ceil(maxBytes / 3) * 4
  )
    throw failed();
  let binary;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw failed();
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > maxBytes || base64url(bytes) !== value) throw failed();
  return bytes;
}

function envelopeFor(format, iv, ciphertext) {
  return { format, version: VERSION, algorithm: ALGORITHM, iv, ciphertext };
}

function parseEnvelope(raw, format) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_ENVELOPE_CHARS) throw failed();
  try {
    const parsed = JSON.parse(raw);
    const value = object(parsed, FIELDS);
    if (
      value.format !== format ||
      value.version !== VERSION ||
      value.algorithm !== ALGORITHM ||
      JSON.stringify(parsed) !== raw ||
      JSON.stringify(envelopeFor(format, value.iv, value.ciphertext)) !== raw
    )
      throw failed();
    const iv = bytesFromBase64url(value.iv, IV_BYTES);
    const ciphertext = bytesFromBase64url(value.ciphertext, MAX_CIPHER_BYTES);
    if (iv.length !== IV_BYTES || ciphertext.length <= TAG_BYTES) throw failed();
    return { iv, ciphertext };
  } catch {
    throw failed();
  }
}

function validKey(key) {
  try {
    return (
      key?.type === 'secret' &&
      key.extractable === false &&
      key.algorithm?.name === 'AES-GCM' &&
      key.algorithm?.length === 256 &&
      key.usages?.length === 2 &&
      key.usages.includes('encrypt') &&
      key.usages.includes('decrypt')
    );
  } catch {
    return false;
  }
}

/**
 * Оборачивает ОДНУ запись, но не создаёт хранилище и не проверяет его гарантии.
 * backend.read() -> точная строка шифротекста/null;
 * backend.compareExchange(expectedCiphertext|null, nextCiphertext) ->
 * 'swapped' или 'mismatch'. Он обязан быть атомарным между ВСЕМИ участниками,
 * сохранять замену до подтверждения, возвращать актуальные данные и не допускать
 * неучаствующих записей. Исключение/потеря ответа могут означать запись. Ни
 * readback, ни этот слой не доказывают CAS, fsync, отсутствие отката или защиту
 * файлов от удаления. Готового подходящего бэкенда в приложении пока нет.
 *
 * key должен быть отдельным неэкспортируемым AES-256-GCM ключом этой установки;
 * его создание/надёжное хранение и независимо защищённые slotId/clientId/accountKey
 * здесь не реализованы. Те же данные привязаны через AAD и проверяются после
 * расшифровки. Токены и идентификаторы не включаются в видимый конверт, но его
 * размер виден. Ключ/вызывающий JS/cryptoSource/backend полностью доверенные.
 *
 * compareExchange(null, record) — отдельная потенциально опасная ПЕРВАЯ установка,
 * не автоматический fallback: предварительно нужны подтверждение пользователя,
 * защита pin и проверка имеющихся данных. null не доказывает, что записи никогда
 * не было. Смена аккаунта, повторная установка, reset и восстановление не реализованы.
 * Для Google дополнительно допускаются только переходы ready -> pending -> ready
 * с новыми случайными ревизиями. Для Яндекса разрешена только первая установка;
 * замена истёкшего access token не реализована. Старое содержимое/откат всего
 * конверта не распознаются.
 *
 * @param {'google'|'yandex'} provider
 * @param {{slotId:string, clientId:string, accountKey:string, key:CryptoKey,
 * backend:{read:()=>Promise<string|null>, compareExchange:(expected:string|null,next:string)=>Promise<'swapped'|'mismatch'>},
 * cryptoSource?:Crypto}} options
 */
function createEncryptedCredentialStore(provider, options) {
  let input;
  let backend;
  try {
    input = object(options, ['slotId', 'clientId', 'accountKey', 'key', 'backend'], ['cryptoSource']);
    backend = object(input.backend, ['read', 'compareExchange']);
  } catch {
    throw failed();
  }
  const crypto = input.cryptoSource === undefined ? globalThis.crypto : input.cryptoSource;
  try {
    if (
      !validCredentialId(input.slotId) ||
      !validOAuthClientId(provider, input.clientId) ||
      !validOAuthAccountKey(input.accountKey) ||
      !validKey(input.key) ||
      !crypto?.subtle ||
      typeof crypto.getRandomValues !== 'function' ||
      typeof backend.read !== 'function' ||
      typeof backend.compareExchange !== 'function'
    )
      throw failed();
  } catch {
    throw failed();
  }

  const { slotId, clientId, accountKey, key } = input;
  const format = FORMATS[provider];
  const readCiphertext = backend.read;
  const replaceCiphertext = backend.compareExchange;
  const aadText = JSON.stringify([format, VERSION, ALGORITHM, provider, slotId, clientId, accountKey]);
  // Только раннее обнаружение недавнего повтора в этом экземпляре. Уникальность
  // nonce между процессами/перезапусками не доказывается; необходим доверенный CSPRNG.
  const recentNonces = new Set();

  function checkedRecord(raw) {
    const record = provider === 'google' ? parseGoogleCredentialRecord(raw) : parseYandexCredentialRecord(raw);
    if (record.slotId !== slotId || record.clientId !== clientId || record.accountKey !== accountKey) throw failed();
    return record;
  }

  async function seal(raw) {
    checkedRecord(raw);
    const plain = new TextEncoder().encode(raw);
    const aad = new TextEncoder().encode(aadText);
    const iv = new Uint8Array(IV_BYTES);
    try {
      if (plain.length > MAX_CREDENTIAL_RECORD_CHARS || crypto.getRandomValues(iv) !== iv) throw failed();
      const ivText = base64url(iv);
      if (iv.every(byte => byte === 0) || recentNonces.has(ivText)) throw failed();
      recentNonces.add(ivText);
      if (recentNonces.size > RECENT_NONCES) recentNonces.delete(recentNonces.values().next().value);
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain)
      );
      try {
        if (encrypted.length !== plain.length + TAG_BYTES) throw failed();
        const result = JSON.stringify(envelopeFor(format, ivText, base64url(encrypted)));
        if (result.length > MAX_ENVELOPE_CHARS) throw failed();
        return result;
      } finally {
        encrypted.fill(0);
      }
    } finally {
      plain.fill(0);
      aad.fill(0);
      iv.fill(0);
    }
  }

  async function unseal(raw) {
    const { iv, ciphertext } = parseEnvelope(raw, format);
    const aad = new TextEncoder().encode(aadText);
    let plain;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext)
      );
      if (!plain.length || plain.length > MAX_CREDENTIAL_RECORD_CHARS) throw failed();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      checkedRecord(text);
      return text;
    } finally {
      iv.fill(0);
      ciphertext.fill(0);
      aad.fill(0);
      plain?.fill(0);
    }
  }

  async function readBackend() {
    const raw = await readCiphertext();
    if (raw !== null && (typeof raw !== 'string' || !raw || raw.length > MAX_ENVELOPE_CHARS)) throw failed();
    return raw;
  }

  return Object.freeze({
    async read() {
      try {
        const ciphertext = await readBackend();
        return ciphertext === null ? null : await unseal(ciphertext);
      } catch {
        throw failed();
      }
    },

    async compareExchange(expected, next) {
      try {
        const nextRecord = checkedRecord(next);
        if (provider === 'yandex') {
          // Не придумываем замену токена и подтверждение аккаунта: до отдельного
          // безопасного сценария разрешена только установка в пустой backend.
          if (expected !== null) throw failed();
        } else if (expected === null) {
          if (nextRecord.phase !== 'ready') throw failed();
        } else {
          const previous = checkedRecord(expected);
          if (
            previous.revision === nextRecord.revision ||
            !(
              (previous.phase === 'ready' &&
                nextRecord.phase === 'pending' &&
                nextRecord.attemptId !== previous.revision) ||
              (previous.phase === 'pending' &&
                nextRecord.phase === 'ready' &&
                nextRecord.revision !== previous.attemptId)
            )
          )
            throw failed();
        }
        const before = await readBackend();
        if (expected === null) {
          if (before !== null) return 'mismatch';
        } else {
          if (before === null || (await unseal(before)) !== expected) return 'mismatch';
        }
        const after = await seal(next);
        const outcome = await replaceCiphertext(before, after);
        if (outcome === 'mismatch') return 'mismatch';
        if (outcome !== 'swapped' || (await readBackend()) !== after) throw failed();
        return 'swapped';
      } catch {
        // Исключение не говорит, произошла ли запись: вызвавшая сторона обязана
        // остановиться и считать результат неизвестным, а не повторить автоматически.
        throw failed();
      }
    }
  });
}

/** @param {Parameters<typeof createEncryptedCredentialStore>[1]} options */
export function createGoogleEncryptedCredentialStore(options) {
  return createEncryptedCredentialStore('google', options);
}

/** @param {Parameters<typeof createEncryptedCredentialStore>[1]} options */
export function createYandexEncryptedCredentialStore(options) {
  return createEncryptedCredentialStore('yandex', options);
}
