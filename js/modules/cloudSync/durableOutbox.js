// @ts-check
// Зашифрованный журнал отправки и одноразовых попыток. Его хранилище и сессия
// передаются отдельно; модуль ещё не подключён к настройкам или настоящим данным.
// Протокол требует атомарного CAS и независимой устойчивой проверки записи после
// каждого изменения. Одного localStorage, чтения после setItem или фиктивного CAS
// недостаточно. После неизвестного исхода НЕЛЬЗЯ автоматически повторять отправку.
// Ключи, зашифрованные записи, аккаунты, ответы и исходные ошибки не журналируются.
import { decryptSnapshot, encryptSnapshot, generateSyncId, isSyncId } from './envelope.js';
import { verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';
import { object } from './exportSchema.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { historyEnvelopePin, MAX_HISTORY_VERSIONS } from './history.js';
import { copyCloudEnvelope, validGoogleId } from './providers/common.js';
import { validOAuthAccountKey, validOAuthClientId } from './providers/oauthCommon.js';

const FORMAT = 'tvinoferma-durable-outbox';
const VERSION = 2;
const LEGACY_VERSION = 1;
const KEY_CONTEXT = 'tvinoferma-durable-outbox-key-v1';
const MAX_ENTRIES = 16;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_CHARS = 24 * 1024 * 1024;
// Запас для MIME-метаданных и границы в Google multipart с ограничением 5 MB.
const MAX_GOOGLE_ENVELOPE = 4_990_000;
const HEX = /^[0-9a-f]{64}$/;
const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];

function invalid() {
  return new Error('Не удалось безопасно обработать журнал отправки');
}
function response(status) {
  return Object.freeze({ status });
}
function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function masterBytes(value) {
  if (typeof value !== 'string' || !/^TF1-[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  let bytes;
  try {
    const binary = atob(value.slice(4).replaceAll('-', '+').replaceAll('_', '/') + '=');
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw invalid();
  }
  if (bytes.length !== 32 || `TF1-${bytesToBase64Url(bytes)}` !== value) throw invalid();
  return bytes;
}
function cryptoApi(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw invalid();
  return crypto;
}
async function journalKey(crypto, master, binding) {
  const raw = masterBytes(master);
  let derived;
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
    derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(KEY_CONTEXT),
          info: new TextEncoder().encode(JSON.stringify([binding.datasetId, binding.deviceId, binding.slotId]))
        },
        key,
        256
      )
    );
    if (derived.length !== 32) throw invalid();
    return `TF1-${bytesToBase64Url(derived)}`;
  } finally {
    raw.fill(0);
    derived?.fill(0);
  }
}
async function sha256(crypto, raw) {
  const bytes = new TextEncoder().encode(raw);
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (hash.length !== 32) throw invalid();
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}
function distinctId(crypto, previous = []) {
  const id = generateSyncId(crypto);
  if (previous.includes(id)) throw invalid();
  return id;
}
function validBinding(input) {
  return (
    ['google', 'yandex'].includes(input.provider) &&
    isSyncId(input.datasetId) &&
    isSyncId(input.deviceId) &&
    isSyncId(input.slotId) &&
    new Set([input.datasetId, input.deviceId, input.slotId]).size === 3 &&
    validOAuthClientId(input.provider, input.clientId) &&
    validOAuthAccountKey(input.accountKey) &&
    (input.provider === 'google' ? validGoogleId(input.folderId) : input.folderId === undefined)
  );
}
function bindingState(binding) {
  return {
    format: FORMAT,
    version: VERSION,
    provider: binding.provider,
    datasetId: binding.datasetId,
    deviceId: binding.deviceId,
    slotId: binding.slotId,
    clientId: binding.clientId,
    accountKey: binding.accountKey,
    folderId: binding.provider === 'google' ? binding.folderId : null,
    entries: [],
    confirmedReceipts: []
  };
}
function validParent(value, versionId) {
  if (value === null) return true;
  const parent = object(value, ['versionId', 'sha256']);
  return isSyncId(parent.versionId) && parent.versionId !== versionId && HEX.test(parent.sha256);
}

// Доказательство AES-GCM для конкретного ключа и базовая проверка формата истории.
// Это не доказывает полного облачного списка, общего предка или бизнес-валидности.
async function validateVersion(envelope, dataKey, binding, crypto) {
  if (envelope.version === 2) {
    // HMAC связывает капсулу с внутренним ключом, но не проверяет свежесть или оба секрета.
    await verifyPortableEnvelopeBinding({ envelope, dataKey, cryptoSource: crypto });
  }
  const payload = await decryptSnapshot({
    envelope,
    recoveryKey: dataKey,
    expectedDatasetId: binding.datasetId,
    cryptoSource: crypto
  });
  const history = object(payload, ['format', 'version', 'parent', 'publicSnapshot'], ['plannerDeletedIds']);
  if (
    history.format !== 'tvinoferma-public-history' ||
    ![1, 2].includes(history.version) ||
    !validParent(history.parent, envelope.versionId) ||
    (history.version === 1 && Object.hasOwn(history, 'plannerDeletedIds')) ||
    (history.version === 2 &&
      (!Array.isArray(history.plannerDeletedIds) ||
        history.plannerDeletedIds.length === 0 ||
        history.plannerDeletedIds.length > 10_000 ||
        new Set(history.plannerDeletedIds).size !== history.plannerDeletedIds.length ||
        history.plannerDeletedIds.some(id => !isSyncId(id)) ||
        history.parent === null))
  )
    throw invalid();
  publicSnapshotIdentityTypes(history.publicSnapshot);
}

function entryFor(value, binding) {
  const row = object(value, ['envelope', 'phase', 'fileId', 'attemptId']);
  const envelope = copyCloudEnvelope(row.envelope, binding.datasetId);
  if (binding.provider === 'google' && JSON.stringify(envelope).length > MAX_GOOGLE_ENVELOPE) throw invalid();
  if (!['queued', 'prepared', 'attempting', 'confirmed'].includes(row.phase)) throw invalid();
  if (row.phase === 'queued') {
    if (row.fileId !== null || row.attemptId !== null) throw invalid();
  } else {
    if (binding.provider === 'google' ? !validGoogleId(row.fileId) : row.fileId !== null) throw invalid();
    if (row.phase === 'prepared' ? row.attemptId !== null : !isSyncId(row.attemptId)) throw invalid();
  }
  return { envelope, phase: row.phase, fileId: row.fileId, attemptId: row.attemptId };
}
function receiptFor(value, binding) {
  const row = object(value, ['versionId', 'sha256', 'fileId', 'attemptId']);
  if (
    !isSyncId(row.versionId) ||
    typeof row.sha256 !== 'string' ||
    !HEX.test(row.sha256) ||
    (binding.provider === 'google' ? !validGoogleId(row.fileId) : row.fileId !== null) ||
    !isSyncId(row.attemptId)
  )
    throw invalid();
  return { versionId: row.versionId, sha256: row.sha256, fileId: row.fileId, attemptId: row.attemptId };
}
function checkState(value, binding) {
  const state = object(
    value,
    [
      'format',
      'version',
      'provider',
      'datasetId',
      'deviceId',
      'slotId',
      'clientId',
      'accountKey',
      'folderId',
      'entries'
    ],
    ['confirmedReceipts']
  );
  if (
    state.format !== FORMAT ||
    ![LEGACY_VERSION, VERSION].includes(state.version) ||
    (state.version === LEGACY_VERSION && Object.hasOwn(state, 'confirmedReceipts')) ||
    (state.version === VERSION && !Object.hasOwn(state, 'confirmedReceipts')) ||
    state.provider !== binding.provider ||
    state.datasetId !== binding.datasetId ||
    state.deviceId !== binding.deviceId ||
    state.slotId !== binding.slotId ||
    state.clientId !== binding.clientId ||
    state.accountKey !== binding.accountKey ||
    state.folderId !== (binding.provider === 'google' ? binding.folderId : null) ||
    !Array.isArray(state.entries) ||
    state.entries.length > MAX_ENTRIES ||
    (state.version === VERSION &&
      (!Array.isArray(state.confirmedReceipts) || state.confirmedReceipts.length > MAX_HISTORY_VERSIONS))
  )
    throw invalid();
  const entries = state.entries.map(row => entryFor(row, binding));
  const confirmedReceipts =
    state.version === LEGACY_VERSION ? [] : state.confirmedReceipts.map(row => receiptFor(row, binding));
  const versions = new Set();
  const attempts = new Set();
  const fileIds = new Set();
  for (const row of entries) {
    if (versions.has(row.envelope.versionId)) throw invalid();
    versions.add(row.envelope.versionId);
    if (row.fileId !== null) {
      if (fileIds.has(row.fileId)) throw invalid();
      fileIds.add(row.fileId);
    }
    if (row.attemptId !== null) {
      if (attempts.has(row.attemptId)) throw invalid();
      attempts.add(row.attemptId);
    }
  }
  for (const row of confirmedReceipts) {
    if (versions.has(row.versionId) || attempts.has(row.attemptId)) throw invalid();
    versions.add(row.versionId);
    attempts.add(row.attemptId);
    if (row.fileId !== null) {
      if (fileIds.has(row.fileId)) throw invalid();
      fileIds.add(row.fileId);
    }
  }
  const clean = { ...bindingState(binding), entries, confirmedReceipts };
  if (new TextEncoder().encode(JSON.stringify(clean)).length > MAX_STATE_BYTES) throw invalid();
  return clean;
}
function storeReply(value) {
  const reply = object(value, ['status'], ['slotId', 'datasetId', 'deviceId', 'revisionId', 'sha256', 'record']);
  if (!['empty', 'ready', 'pending', 'blocked'].includes(reply.status)) throw invalid();
  if (reply.status !== 'ready') {
    if (Object.keys(reply).length !== 1) throw invalid();
    return reply;
  }
  if (
    Object.keys(reply).length !== 7 ||
    !isSyncId(reply.slotId) ||
    !isSyncId(reply.datasetId) ||
    !isSyncId(reply.deviceId) ||
    !isSyncId(reply.revisionId) ||
    typeof reply.sha256 !== 'string' ||
    !HEX.test(reply.sha256) ||
    typeof reply.record !== 'string' ||
    reply.record.length > MAX_RECORD_CHARS
  )
    throw invalid();
  return reply;
}
function parseRecord(raw, binding, revisionId) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
    const envelope = copyCloudEnvelope(object(parsed, ENVELOPE_FIELDS), binding.datasetId);
    if (envelope.versionId !== revisionId || JSON.stringify(envelope) !== raw) throw invalid();
    return envelope;
  } catch {
    throw invalid();
  }
}

/**
 * CAS-хранилище должно возвращать `empty`, `ready`, `pending` или `blocked` из read(),
 * а install()/compareExchange() должны выполнять атомарное сравнение и сохранять
 * зашифрованную строку вместе с независимой контрольной отметкой. `pending` блокирует
 * автоматическую работу. Обёртка не доказывает fsync, защищённость хранилища, отсутствие
 * отката или корректность реального провайдера. `empty` не доказывает первый запуск.
 *
 * session должна относиться к тому же ранее подтверждённому аккаунту и набору и выполнять
 * собственную повторную проверку аккаунта. Доверие к session и store здесь не устанавливается.
 * Перед подключением к приложению нужны native-реализация store, ключи, backup и восстановление.
 * @param {{provider:'google'|'yandex',datasetId:string,deviceId:string,slotId:string,
 * clientId:string,accountKey:string,folderId?:string,dataKey:string,
 * store:{read:()=>Promise<any>,install:(args:any)=>Promise<any>,compareExchange:(args:any)=>Promise<any>},
 * session:{generateFileId:()=>Promise<any>,upload:(args:any)=>Promise<any>,verify:(args:any)=>Promise<any>},
 * cryptoSource?:Crypto}} options
 */
export function createDurableCloudOutbox(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'datasetId', 'deviceId', 'slotId', 'clientId', 'accountKey', 'dataKey', 'store', 'session'],
      ['folderId', 'cryptoSource']
    );
    if (
      !validBinding(input) ||
      !input.store ||
      typeof input.store.read !== 'function' ||
      typeof input.store.install !== 'function' ||
      typeof input.store.compareExchange !== 'function' ||
      !input.session ||
      typeof input.session.upload !== 'function' ||
      typeof input.session.verify !== 'function' ||
      (input.provider === 'google' && typeof input.session.generateFileId !== 'function')
    )
      throw invalid();
    const check = masterBytes(input.dataKey);
    check.fill(0);
  } catch {
    throw invalid();
  }
  const binding = Object.freeze({
    provider: input.provider,
    datasetId: input.datasetId,
    deviceId: input.deviceId,
    slotId: input.slotId,
    clientId: input.clientId,
    accountKey: input.accountKey,
    ...(input.provider === 'google' ? { folderId: input.folderId } : {})
  });
  const { store, session, dataKey } = input;
  const crypto = cryptoApi(input.cryptoSource);
  const keyPromise = journalKey(crypto, dataKey, binding);
  // Отклонение не должно породить unhandled rejection, если первый вызов будет позднее.
  keyPromise.catch(() => {});
  let active = false;
  let blocked = false;

  async function read() {
    const reply = storeReply(await store.read());
    if (reply.status !== 'ready') return { status: reply.status };
    if (
      reply.slotId !== binding.slotId ||
      reply.datasetId !== binding.datasetId ||
      reply.deviceId !== binding.deviceId ||
      (await sha256(crypto, reply.record)) !== reply.sha256
    )
      throw invalid();
    const envelope = parseRecord(reply.record, binding, reply.revisionId);
    const decoded = await decryptSnapshot({
      envelope,
      recoveryKey: await keyPromise,
      expectedDatasetId: binding.datasetId,
      cryptoSource: crypto
    });
    return { status: 'ready', receipt: reply, state: checkState(decoded, binding) };
  }
  async function write(previous, state) {
    const clean = checkState(state, binding);
    const revisionId = distinctId(crypto, [
      binding.datasetId,
      binding.deviceId,
      binding.slotId,
      ...(previous ? [previous.receipt.revisionId] : []),
      ...clean.entries.map(row => row.envelope.versionId),
      ...clean.entries.map(row => row.attemptId).filter(Boolean),
      ...clean.confirmedReceipts.flatMap(row => [row.versionId, row.attemptId])
    ]);
    const encrypted = await encryptSnapshot({
      snapshot: clean,
      recoveryKey: await keyPromise,
      datasetId: binding.datasetId,
      versionId: revisionId,
      cryptoSource: crypto
    });
    const record = JSON.stringify(copyCloudEnvelope(encrypted, binding.datasetId));
    if (record.length > MAX_RECORD_CHARS) throw invalid();
    const expectedDigest = await sha256(crypto, record);
    const common = {
      slotId: binding.slotId,
      datasetId: binding.datasetId,
      deviceId: binding.deviceId,
      revisionId,
      record
    };
    let result;
    try {
      result = previous
        ? await store.compareExchange({
            ...common,
            expectedRevisionId: previous.receipt.revisionId,
            expectedSha256: previous.receipt.sha256
          })
        : await store.install(common);
      const checked = object(result, ['status']);
      if (!['installed', 'swapped', 'occupied', 'mismatch', 'blocked'].includes(checked.status)) throw invalid();
      if (checked.status === 'occupied' || checked.status === 'mismatch') return { status: 'changed' };
      if (checked.status === 'blocked') return { status: 'journal_blocked' };
      if (checked.status !== (previous ? 'swapped' : 'installed')) throw invalid();
      const verified = await read();
      if (
        verified.status !== 'ready' ||
        verified.receipt.revisionId !== revisionId ||
        verified.receipt.sha256 !== expectedDigest ||
        verified.receipt.record !== record
      )
        throw invalid();
      return verified;
    } catch {
      // Исключение, таймаут или утерянный ответ после начала записи не доказывают,
      // что она не произошла. Этот экземпляр больше не начинает операции.
      blocked = true;
      return { status: 'journal_uncertain' };
    }
  }
  async function run(work) {
    if (blocked) return response('journal_uncertain');
    if (active) return response('busy');
    active = true;
    try {
      return await work();
    } catch {
      blocked = true;
      return response('journal_blocked');
    } finally {
      active = false;
    }
  }
  function unavailable(value) {
    if (value.status === 'empty') return response('not_initialized');
    if (value.status === 'pending' || value.status === 'blocked') return response('journal_blocked');
    return response(value.status);
  }

  return Object.freeze({
    /** Только явная подготовка НОВОГО журнала; empty не удостоверяет отсутствие старых данных. */
    async initialize(confirmedNew) {
      if (confirmedNew !== true) throw invalid();
      return run(async () => {
        const before = await read();
        if (before.status === 'ready') return response('already_initialized');
        if (before.status !== 'empty') return unavailable(before);
        const saved = await write(null, bindingState(binding));
        return response(saved.status === 'ready' ? 'initialized' : saved.status);
      });
    },
    /** Подтверждённый сохранённый локальный снимок должен подготовить вызывающий код. */
    async enqueue(envelope) {
      let copy;
      try {
        copy = copyCloudEnvelope(envelope, binding.datasetId);
        if (binding.provider === 'google' && JSON.stringify(copy).length > MAX_GOOGLE_ENVELOPE) throw invalid();
      } catch {
        throw invalid();
      }
      return run(async () => {
        // Проверяем шифрование ДО изменения журнала. При другой истории/ключе
        // исходные данные и детали ошибки не выходят наружу.
        try {
          await validateVersion(copy, dataKey, binding, crypto);
        } catch {
          return response('invalid_version');
        }
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        if (
          current.state.entries.some(row => row.envelope.versionId === copy.versionId) ||
          current.state.confirmedReceipts.some(row => row.versionId === copy.versionId)
        )
          return response('duplicate');
        if (current.state.entries.length >= MAX_ENTRIES) return response('full');
        const next = {
          ...current.state,
          entries: [...current.state.entries, { envelope: copy, phase: 'queued', fileId: null, attemptId: null }]
        };
        try {
          checkState(next, binding);
        } catch {
          return response('full');
        }
        const saved = await write(current, next);
        return response(saved.status === 'ready' ? 'queued' : saved.status);
      });
    },
    /** Первая неподтверждённая версия не пропускается ради более новых. */
    async sendNext() {
      return run(async () => {
        let current = await read();
        if (current.status !== 'ready') return unavailable(current);
        let index = current.state.entries.findIndex(row => row.phase !== 'confirmed');
        if (index < 0) return response('idle');
        let row = current.state.entries[index];
        if (row.phase === 'attempting') return response('needs_verification');
        if (row.phase === 'queued') {
          let fileId = null;
          if (binding.provider === 'google') {
            let generated;
            try {
              generated = object(await session.generateFileId(), ['status'], ['fileId']);
            } catch {
              return response('unavailable');
            }
            if (generated.status !== 'generated' || !validGoogleId(generated.fileId)) return response('unavailable');
            fileId = generated.fileId;
          }
          const entries = current.state.entries.slice();
          entries[index] = { ...row, phase: 'prepared', fileId };
          current = await write(current, { ...current.state, entries });
          if (current.status !== 'ready') return response(current.status);
          index = current.state.entries.findIndex(item => item.phase !== 'confirmed');
          row = current.state.entries[index];
          if (!row || row.phase !== 'prepared') throw invalid();
        }
        const attemptId = distinctId(crypto, [
          binding.datasetId,
          binding.deviceId,
          binding.slotId,
          current.receipt.revisionId,
          ...current.state.entries.map(item => item.envelope.versionId),
          ...current.state.entries.map(item => item.attemptId).filter(Boolean),
          ...current.state.confirmedReceipts.flatMap(item => [item.versionId, item.attemptId])
        ]);
        const entries = current.state.entries.slice();
        entries[index] = { ...row, phase: 'attempting', attemptId };
        current = await write(current, { ...current.state, entries });
        if (current.status !== 'ready') return response(current.status);
        // Первый и единственный вызов записи разрешён только ПОСЛЕ подтверждённой
        // устойчивой записи phase=attempting. Никаких повторов при потере ответа.
        let uploadStatus = 'unknown';
        try {
          const result = object(
            await session.upload({
              envelope: row.envelope,
              ...(binding.provider === 'google' ? { fileId: row.fileId } : {})
            }),
            ['status']
          );
          uploadStatus = result.status;
        } catch {
          // Запрос мог дойти до диска.
        }
        if (['not_sent', 'account_unavailable', 'account_mismatch'].includes(uploadStatus)) {
          // Только доверенный транспорт может удостоверить, что операция записи
          // вообще не начиналась. Если другой участник изменил журнал после нас,
          // не отменяем его состояние и не делаем предположений об отправке.
          const latest = await read();
          if (
            latest.status !== 'ready' ||
            latest.receipt.revisionId !== current.receipt.revisionId ||
            latest.receipt.sha256 !== current.receipt.sha256 ||
            latest.state.entries[index]?.phase !== 'attempting' ||
            latest.state.entries[index]?.attemptId !== attemptId
          )
            return response('changed');
          const deferred = latest.state.entries.slice();
          deferred[index] = { ...latest.state.entries[index], phase: 'prepared', attemptId: null };
          const saved = await write(latest, { ...latest.state, entries: deferred });
          if (saved.status !== 'ready') return response(saved.status);
          return response(uploadStatus === 'account_mismatch' ? 'account_mismatch' : 'deferred');
        }
        return response('needs_verification');
      });
    },
    /** Только чтение и точная сверка; отсутствие не разрешает повторную отправку. */
    async verifyNext() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const index = current.state.entries.findIndex(row => row.phase !== 'confirmed');
        if (index < 0) return response('idle');
        const row = current.state.entries[index];
        if (row.phase !== 'attempting') return response('not_attempted');
        let result;
        try {
          result = object(
            await session.verify({
              envelope: row.envelope,
              ...(binding.provider === 'google' ? { fileId: row.fileId } : {})
            }),
            ['status']
          );
        } catch {
          return response('unavailable');
        }
        if (result.status === 'mismatch') return response('needs_review');
        if (result.status !== 'verified') return response('unavailable');
        const entries = current.state.entries.slice();
        entries[index] = { ...row, phase: 'confirmed' };
        const saved = await write(current, { ...current.state, entries });
        // Совпадение в облаке не является доказательством дальнейшей сохранности.
        return response(saved.status === 'ready' ? 'confirmed' : saved.status);
      });
    },
    /**
     * Сокращает только подтверждённые точной сверкой записи, сохраняя их ID,
     * отпечаток истории и адрес для обнаружения повтора. Облако не изменяется.
     * Внешний доверенный pin и политика общей истории по-прежнему обязательны.
     */
    async compactConfirmed() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const confirmed = current.state.entries.filter(row => row.phase === 'confirmed');
        if (!confirmed.length) return response('idle');
        if (current.state.confirmedReceipts.length + confirmed.length > MAX_HISTORY_VERSIONS)
          return response('receipt_limit');
        const receipts = [];
        for (const row of confirmed) {
          const pin = await historyEnvelopePin({
            envelope: row.envelope,
            expectedDatasetId: binding.datasetId,
            cryptoSource: crypto
          });
          receipts.push({ ...pin, fileId: row.fileId, attemptId: row.attemptId });
        }
        const next = {
          ...current.state,
          entries: current.state.entries.filter(row => row.phase !== 'confirmed'),
          confirmedReceipts: [...current.state.confirmedReceipts, ...receipts]
        };
        const saved = await write(current, next);
        return saved.status === 'ready'
          ? Object.freeze({ status: 'compacted', count: confirmed.length })
          : response(saved.status);
      });
    },
    /** Пины локальных подтверждений; они не доказывают полноту или свежесть облака. */
    async confirmedPins() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const pins = current.state.confirmedReceipts.map(row => ({ versionId: row.versionId, sha256: row.sha256 }));
        if (pins.length + current.state.entries.filter(row => row.phase === 'confirmed').length > MAX_HISTORY_VERSIONS)
          return response('receipt_limit');
        for (const row of current.state.entries) {
          if (row.phase === 'confirmed')
            pins.push(
              await historyEnvelopePin({
                envelope: row.envelope,
                expectedDatasetId: binding.datasetId,
                cryptoSource: crypto
              })
            );
        }
        return Object.freeze({ status: 'ready', pins: Object.freeze(pins.map(pin => Object.freeze(pin))) });
      });
    },
    async status() {
      return run(async () => {
        const current = await read();
        if (current.status !== 'ready') return unavailable(current);
        const counts = { queued: 0, prepared: 0, attempting: 0, confirmed: 0 };
        for (const row of current.state.entries) counts[row.phase]++;
        return Object.freeze({ status: 'ready', counts: Object.freeze(counts) });
      });
    }
  });
}
