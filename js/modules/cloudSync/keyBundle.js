// @ts-check
// Экспериментальная обёртка случайного ключа данных двумя независимыми секретами.
// НЕТ подключения к state, UI, защищённому хранилищу, резервному копированию или сети.
// Возвращаемые dataKey и generatedBackupSecret — секреты: не логировать и не сохранять
// открытым текстом. Объект bundle содержит только защищённые копии ключа и метаданные.
// Перед реальным использованием нужны аудит формата, работа с защищённым хранилищем,
// доверенные постоянные отпечатки, подтверждение сохранения запасного секрета и проверка
// производительности на поддерживаемых устройствах. JS не гарантирует очистку строк в памяти.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { generateSyncId, isSyncId } from './envelope.js';
import { object, oneOf } from './exportSchema.js';

const FORMAT = 'tvinoferma-key-bundle';
const VERSION = 1;
const CIPHER = 'AES-256-GCM';
const KDF = 'scrypt';
const N = 32768;
const R = 8;
const P = 3;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const WRAPPED_BYTES = KEY_BYTES + 16;
const BACKUP_PREFIX = 'TFB1-';
const DATA_PREFIX = 'TF1-';
const MAX_SECRET_LENGTH = 1024;
const HKDF_SALT = 'tvinoferma-key-bundle-hkdf-v1';
const PROOF_INFO = 'tvinoferma-key-bundle-proof-v1';
const FINGERPRINT_CONTEXT = 'tvinoferma-key-bundle-sha256-v1';
const HEX256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
let busy = false;

function invalidBundle() {
  return new Error('Некорректный или неподдерживаемый набор ключей');
}
function invalidSecret() {
  return new Error('Секрет слишком короткий, простой или имеет неподдерживаемый формат');
}
function cannotOpen() {
  return new Error('Не удалось проверить или открыть набор ключей');
}
function cryptoProvider(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Безопасная криптография недоступна');
  }
  return crypto;
}

function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value, bytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil((bytes * 8) / 6) || !/^[A-Za-z0-9_-]+$/.test(value))
    throw invalidBundle();
  let result;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
    result = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw invalidBundle();
  }
  if (result.length !== bytes || b64(result) !== value) throw invalidBundle();
  return result;
}
function random(crypto, size) {
  return crypto.getRandomValues(new Uint8Array(size));
}
function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left[i] ^ right[i];
  return result === 0;
}
function secret(value, newSecret) {
  // Unicode NFC даёт одинаковый результат для составной и объединённой формы. TextEncoder
  // заменяет одиночные суррогаты, поэтому их отклоняем вместо молчаливого изменения секрета.
  if (typeof value !== 'string' || value.length > MAX_SECRET_LENGTH || /[\uD800-\uDFFF]/u.test(value))
    throw invalidSecret();
  const normalized = value.normalize('NFC');
  const controls = [...normalized].some(char => {
    const code = char.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
  if (!normalized || normalized.length > MAX_SECRET_LENGTH || controls) throw invalidSecret();
  if (newSecret) {
    const characters = [...normalized];
    const compact = normalized.toLowerCase().replace(/[\s._-]/gu, '');
    const sequences = [
      '0123456789',
      '9876543210',
      'abcdefghijklmnopqrstuvwxyz',
      'zyxwvutsrqponmlkjihgfedcba',
      'qwertyuiop'
    ];
    const obvious =
      sequences.some(sequence => sequence.repeat(128).includes(compact)) ||
      ['passwordpassword', 'парольпарольпароль', 'qwertyqwertyqwerty'].includes(compact);
    if (characters.length < 16 || new Set(characters.map(char => char.toLowerCase())).size < 6 || obvious)
      throw invalidSecret();
  }
  return normalized;
}
function credentials(primaryValue, backupValue) {
  const primary = object(primaryValue, ['kind', 'secret']);
  const primaryKind = oneOf(primary.kind, ['password', 'custom']);
  const primarySecret = secret(primary.secret, true);
  const backup = object(backupValue, ['kind'], ['secret']);
  const backupKind = oneOf(backup.kind, ['generated', 'custom']);
  let backupSecret = null;
  if (backupKind === 'custom') {
    if (!Object.hasOwn(backup, 'secret')) throw invalidSecret();
    backupSecret = secret(backup.secret, true);
  } else if (Object.hasOwn(backup, 'secret')) {
    // Старый случайный ключ можно ввести как собственный; не называем введённое значение
    // заново сгенерированным, поскольку его случайность нельзя удостоверить по тексту.
    throw invalidSecret();
  }
  if (backupSecret !== null && backupSecret === primarySecret) throw invalidSecret();
  return { primaryKind, primarySecret, backupKind, backupSecret };
}
function pin(value) {
  const data = object(value, ['bundleId', 'sha256']);
  if (!isSyncId(data.bundleId) || typeof data.sha256 !== 'string' || !HEX256.test(data.sha256)) throw invalidBundle();
  return { bundleId: data.bundleId, sha256: data.sha256 };
}
function slot(value, role) {
  const data = object(value, ['kind', 'kdf', 'n', 'r', 'p', 'salt', 'algorithm', 'iv', 'ciphertext']);
  const allowedKinds = role === 'main' ? ['password', 'custom'] : ['generated', 'custom'];
  if (
    !allowedKinds.includes(data.kind) ||
    data.kdf !== KDF ||
    data.n !== N ||
    data.r !== R ||
    data.p !== P ||
    data.algorithm !== CIPHER
  )
    throw invalidBundle();
  const parsed = {
    kind: data.kind,
    kdf: KDF,
    n: N,
    r: R,
    p: P,
    salt: data.salt,
    algorithm: CIPHER,
    iv: data.iv,
    ciphertext: data.ciphertext
  };
  decode(parsed.salt, SALT_BYTES);
  decode(parsed.iv, IV_BYTES);
  decode(parsed.ciphertext, WRAPPED_BYTES);
  return parsed;
}
function parseBundle(value) {
  const data = object(value, ['format', 'version', 'datasetId', 'bundleId', 'main', 'backup', 'proof']);
  if (data.format !== FORMAT || data.version !== VERSION || !isSyncId(data.datasetId) || !isSyncId(data.bundleId))
    throw invalidBundle();
  const main = slot(data.main, 'main');
  const backup = slot(data.backup, 'backup');
  decode(data.proof, KEY_BYTES);
  if (main.salt === backup.salt || main.iv === backup.iv) throw invalidBundle();
  return {
    format: FORMAT,
    version: VERSION,
    datasetId: data.datasetId,
    bundleId: data.bundleId,
    main,
    backup,
    proof: data.proof
  };
}
function slotArray(value) {
  return [value.kind, value.kdf, value.n, value.r, value.p, value.salt, value.algorithm, value.iv, value.ciphertext];
}
function canonicalValues(data, includeProof = false) {
  const values = [FORMAT, VERSION, data.datasetId, data.bundleId, slotArray(data.main), slotArray(data.backup)];
  if (includeProof) values.push(data.proof);
  return values;
}
function canonical(data) {
  return encoder.encode(JSON.stringify(canonicalValues(data)));
}
function aad(datasetId, bundleId, role, item) {
  return encoder.encode(
    JSON.stringify([FORMAT, VERSION, datasetId, bundleId, role, item.kind, KDF, N, R, P, item.salt, CIPHER, item.iv])
  );
}
async function derive(crypto, input, salt, usage) {
  const password = encoder.encode(input);
  let key;
  try {
    key = await scryptAsync(password, salt, {
      N,
      r: R,
      p: P,
      dkLen: KEY_BYTES,
      maxmem: 64 * 1024 * 1024,
      asyncTick: 10
    });
    return await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    password.fill(0);
    key?.fill(0);
  }
}
async function wrap(crypto, master, datasetId, bundleId, role, kind, input, salt, iv) {
  const item = { kind, kdf: KDF, n: N, r: R, p: P, salt: b64(salt), algorithm: CIPHER, iv: b64(iv), ciphertext: '' };
  const key = await derive(crypto, input, salt, 'encrypt');
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(datasetId, bundleId, role, item), tagLength: 128 },
    key,
    master
  );
  item.ciphertext = b64(new Uint8Array(encrypted));
  return item;
}
async function unwrap(crypto, data, role, input) {
  const item = data[role];
  const salt = decode(item.salt, SALT_BYTES);
  const iv = decode(item.iv, IV_BYTES);
  const ciphertext = decode(item.ciphertext, WRAPPED_BYTES);
  const key = await derive(crypto, input, salt, 'decrypt');
  const result = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(data.datasetId, data.bundleId, role, item), tagLength: 128 },
      key,
      ciphertext
    )
  );
  if (result.length !== KEY_BYTES) {
    result.fill(0);
    throw cannotOpen();
  }
  return result;
}
async function proofKey(crypto, master, data, usages) {
  const material = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(JSON.stringify([PROOF_INFO, data.datasetId, data.bundleId]))
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    usages
  );
}
async function signProof(crypto, master, data) {
  const key = await proofKey(crypto, master, data, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, canonical(data))));
}
async function verifyProof(crypto, master, data) {
  const key = await proofKey(crypto, master, data, ['verify']);
  return crypto.subtle.verify('HMAC', key, decode(data.proof, KEY_BYTES), canonical(data));
}
async function fingerprint(crypto, data) {
  const bytes = encoder.encode(JSON.stringify([FINGERPRINT_CONTEXT, ...canonicalValues(data, true)]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { bundleId: data.bundleId, sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}
async function checkPin(crypto, data, expected) {
  const actual = await fingerprint(crypto, data);
  if (actual.bundleId !== expected.bundleId || actual.sha256 !== expected.sha256) {
    throw new Error('Отпечаток набора ключей не совпадает с доверенным');
  }
}
async function checkedMaster(crypto, data, expectedDatasetId, expectedPin, role, input) {
  if (data.datasetId !== expectedDatasetId) throw new Error('Набор ключей относится к другим данным');
  await checkPin(crypto, data, expectedPin);
  let master;
  try {
    master = await unwrap(crypto, data, role, input);
    if (!(await verifyProof(crypto, master, data))) throw cannotOpen();
    return master;
  } catch {
    master?.fill(0);
    throw cannotOpen();
  }
}
function dataKeyBytes(value) {
  if (typeof value !== 'string' || !value.startsWith(DATA_PREFIX)) throw cannotOpen();
  try {
    return decode(value.slice(DATA_PREFIX.length), KEY_BYTES);
  } catch {
    throw cannotOpen();
  }
}
async function locked(action) {
  // В одном JS-контексте не запускаем несколько расходующих память scrypt одновременно.
  if (busy) throw new Error('Другая операция с ключами ещё выполняется');
  busy = true;
  try {
    return await action();
  } finally {
    busy = false;
  }
}
async function makeBundle(crypto, datasetId, master, creds, previousBundleId = null) {
  const bundleId = generateSyncId(crypto);
  if (bundleId === previousBundleId || bundleId === datasetId) throw invalidBundle();
  let generatedBackupSecret = null;
  let backupSecret = creds.backupSecret;
  if (backupSecret === null) {
    const randomBackup = random(crypto, KEY_BYTES);
    try {
      if (equalBytes(randomBackup, master)) throw invalidBundle();
      backupSecret = BACKUP_PREFIX + b64(randomBackup);
      generatedBackupSecret = backupSecret;
    } finally {
      randomBackup.fill(0);
    }
  }
  const dataKey = DATA_PREFIX + b64(master);
  if (backupSecret === creds.primarySecret || dataKey === backupSecret || dataKey === creds.primarySecret)
    throw invalidSecret();
  const mainSalt = random(crypto, SALT_BYTES);
  const backupSalt = random(crypto, SALT_BYTES);
  const mainIv = random(crypto, IV_BYTES);
  const backupIv = random(crypto, IV_BYTES);
  if (equalBytes(mainSalt, backupSalt) || equalBytes(mainIv, backupIv)) throw invalidBundle();
  const main = await wrap(
    crypto,
    master,
    datasetId,
    bundleId,
    'main',
    creds.primaryKind,
    creds.primarySecret,
    mainSalt,
    mainIv
  );
  const backup = await wrap(
    crypto,
    master,
    datasetId,
    bundleId,
    'backup',
    creds.backupKind,
    backupSecret,
    backupSalt,
    backupIv
  );
  const unsigned = { format: FORMAT, version: VERSION, datasetId, bundleId, main, backup };
  const proof = await signProof(crypto, master, unsigned);
  const bundle = parseBundle({ ...unsigned, proof });
  let openedMain;
  let openedBackup;
  try {
    // Проверяем обе независимые копии, но это не подтверждает, что пользователь сохранил ключ.
    openedMain = await unwrap(crypto, bundle, 'main', creds.primarySecret);
    openedBackup = await unwrap(crypto, bundle, 'backup', backupSecret);
    if (
      !equalBytes(master, openedMain) ||
      !equalBytes(master, openedBackup) ||
      !(await verifyProof(crypto, master, bundle))
    )
      throw cannotOpen();
    return { bundle, pin: await fingerprint(crypto, bundle), dataKey, generatedBackupSecret };
  } finally {
    openedMain?.fill(0);
    openedBackup?.fill(0);
  }
}

/** Проверяет форму и возвращает независимую копию без дополнительных полей или getter. */
export function copyKeyBundle(bundle) {
  return parseBundle(bundle);
}

/** Только структурный отпечаток. Доверять ему можно лишь после независимой проверки и сохранения. */
export async function fingerprintKeyBundle(bundle, cryptoSource) {
  const data = parseBundle(bundle);
  const crypto = cryptoProvider(cryptoSource);
  return fingerprint(crypto, data);
}

/**
 * Проверяет внутренний ключ по доверенному отпечатку и доказательству обеих обёрток.
 * Не подтверждает свежесть отпечатка или защищённость места его хранения.
 * Ключ передаётся только в памяти и не должен попадать в журналы.
 * @param {{bundle: any, expectedDatasetId: string, expectedPin: any, dataKey: string, cryptoSource?: Crypto}} options
 */
export async function verifyKeyBundleDataKey(options) {
  const input = object(options, ['bundle', 'expectedDatasetId', 'expectedPin', 'dataKey'], ['cryptoSource']);
  const data = parseBundle(input.bundle);
  const expected = pin(input.expectedPin);
  if (!isSyncId(input.expectedDatasetId)) throw invalidBundle();
  const crypto = cryptoProvider(input.cryptoSource);
  const master = dataKeyBytes(input.dataKey);
  try {
    if (data.datasetId !== input.expectedDatasetId) throw cannotOpen();
    await checkPin(crypto, data, expected);
    if (!(await verifyProof(crypto, master, data))) throw cannotOpen();
    return true;
  } finally {
    master.fill(0);
  }
}

/**
 * Создаёт две проверенные обёртки одного случайного ключа; НИЧЕГО не сохраняет и не отправляет.
 * generatedBackupSecret возвращается только при создании нового случайного запасного ключа.
 * dataKey совместим с envelope.js и должен оставаться секретом.
 * @param {{datasetId: string, primary: any, backup: any, cryptoSource?: Crypto}} options
 */
export async function createKeyBundle(options) {
  const input = object(options, ['datasetId', 'primary', 'backup'], ['cryptoSource']);
  if (!isSyncId(input.datasetId)) throw invalidBundle();
  const creds = credentials(input.primary, input.backup);
  const crypto = cryptoProvider(input.cryptoSource);
  const datasetId = input.datasetId;
  return locked(async () => {
    const master = random(crypto, KEY_BYTES);
    try {
      return await makeBundle(crypto, datasetId, master, creds);
    } finally {
      master.fill(0);
    }
  });
}

/**
 * Открывает ТОЛЬКО набор с переданным доверенным отпечатком и проверяет целостность ОБЕИХ
 * обёрток. Отпечаток нельзя автоматически считать доверенным только потому, что его прислал диск.
 * @param {{bundle: any, expectedDatasetId: string, expectedPin: any, role: 'main'|'backup', secret: string, cryptoSource?: Crypto}} options
 */
export async function openKeyBundle(options) {
  const input = object(options, ['bundle', 'expectedDatasetId', 'expectedPin', 'role', 'secret'], ['cryptoSource']);
  const data = parseBundle(input.bundle);
  const expectedPin = pin(input.expectedPin);
  if (!isSyncId(input.expectedDatasetId)) throw invalidBundle();
  const role = oneOf(input.role, ['main', 'backup']);
  const entered = secret(input.secret, false);
  const crypto = cryptoProvider(input.cryptoSource);
  const expectedDatasetId = input.expectedDatasetId;
  return locked(async () => {
    const master = await checkedMaster(crypto, data, expectedDatasetId, expectedPin, role, entered);
    try {
      return { datasetId: data.datasetId, bundleId: data.bundleId, dataKey: DATA_PREFIX + b64(master) };
    } finally {
      master.fill(0);
    }
  });
}

/**
 * По одному сохранённому секрету создаёт НОВЫЕ обёртки того же ключа данных. Исходный файл
 * не меняется; старые версии остаются открываемыми старым секретом. Это не отзыв доступа.
 * @param {{bundle: any, expectedDatasetId: string, expectedPin: any, role: 'main'|'backup', secret: string, primary: any, backup: any, cryptoSource?: Crypto}} options
 */
export async function rewrapKeyBundle(options) {
  const input = object(
    options,
    ['bundle', 'expectedDatasetId', 'expectedPin', 'role', 'secret', 'primary', 'backup'],
    ['cryptoSource']
  );
  const data = parseBundle(input.bundle);
  const expectedPin = pin(input.expectedPin);
  if (!isSyncId(input.expectedDatasetId)) throw invalidBundle();
  const expectedDatasetId = input.expectedDatasetId;
  const role = oneOf(input.role, ['main', 'backup']);
  const entered = secret(input.secret, false);
  const creds = credentials(input.primary, input.backup);
  const crypto = cryptoProvider(input.cryptoSource);
  return locked(async () => {
    const master = await checkedMaster(crypto, data, expectedDatasetId, expectedPin, role, entered);
    try {
      return await makeBundle(crypto, data.datasetId, master, creds, data.bundleId);
    } finally {
      master.fill(0);
    }
  });
}

/**
 * Подготавливает новые обёртки, если внутренний ключ данных сохранился на доверенном ПК.
 * Сначала проверяет доверенный отпечаток и целостность старого набора с этим ключом.
 * Не читает защищённое хранилище и не сохраняет результат; dataKey нельзя логировать.
 * @param {{bundle: any, expectedDatasetId: string, expectedPin: any, dataKey: string, primary: any, backup: any, cryptoSource?: Crypto}} options
 */
export async function rewrapKeyBundleFromDataKey(options) {
  const input = object(
    options,
    ['bundle', 'expectedDatasetId', 'expectedPin', 'dataKey', 'primary', 'backup'],
    ['cryptoSource']
  );
  const data = parseBundle(input.bundle);
  const expectedPin = pin(input.expectedPin);
  if (!isSyncId(input.expectedDatasetId)) throw invalidBundle();
  const expectedDatasetId = input.expectedDatasetId;
  const creds = credentials(input.primary, input.backup);
  const crypto = cryptoProvider(input.cryptoSource);
  const master = dataKeyBytes(input.dataKey);
  try {
    return await locked(async () => {
      if (data.datasetId !== expectedDatasetId) throw new Error('Набор ключей относится к другим данным');
      await checkPin(crypto, data, expectedPin);
      try {
        if (!(await verifyProof(crypto, master, data))) throw cannotOpen();
      } catch {
        throw cannotOpen();
      }
      return makeBundle(crypto, data.datasetId, master, creds, data.bundleId);
    });
  } finally {
    master.fill(0);
  }
}

/**
 * Только подготавливает ключи НОВОГО набора после потери старых. Ничего не удаляет,
 * не создаёт резервную копию и не объявляет перезапуск выполненным.
 * @param {{previousDatasetId: string, primary: any, backup: any, cryptoSource?: Crypto}} options
 */
export async function prepareKeyLossRestart(options) {
  const input = object(options, ['previousDatasetId', 'primary', 'backup'], ['cryptoSource']);
  if (!isSyncId(input.previousDatasetId)) throw invalidBundle();
  const creds = credentials(input.primary, input.backup);
  const crypto = cryptoProvider(input.cryptoSource);
  const previousDatasetId = input.previousDatasetId;
  return locked(async () => {
    const datasetId = generateSyncId(crypto);
    if (datasetId === previousDatasetId) throw invalidBundle();
    const master = random(crypto, KEY_BYTES);
    try {
      const result = await makeBundle(crypto, datasetId, master, creds);
      return { status: 'prepared_only', previousDatasetId, ...result };
    } finally {
      master.fill(0);
    }
  });
}
