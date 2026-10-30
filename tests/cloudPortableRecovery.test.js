import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecipheriv, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateSyncId,
  validateEnvelope
} from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { createDurableCloudOutbox } from '../js/modules/cloudSync/durableOutbox.js';
import { createKeyRecoverer } from '../js/modules/cloudSync/keyRecovery.js';
import { createKeyStateRecord } from '../js/modules/cloudSync/keyStateRecord.js';
import { findPortableKeyVersions } from '../js/modules/cloudSync/portableKeyDiscovery.js';
import { createPairingCode, parsePairingCode } from '../js/modules/cloudSync/pairingCode.js';
import {
  inspectPortableEnvelope,
  makePortableKeyCapsule,
  openPortableEnvelope,
  verifyPortableEnvelopeBinding
} from '../js/modules/cloudSync/portableKeyCapsule.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { copyCloudEnvelope } from '../js/modules/cloudSync/providers/common.js';

const datasetId = '01234567-89ab-4cde-8f01-23456789abcd';
const password = 'Синтетический пароль для тестов 1234!';
const otherPassword = 'Другой синтетический пароль 9876!';
const now = () => Date.parse('2026-10-30T11:00:00.000Z');
let keys, foreign, snapshot, root, legacy, child, childSnapshot;

beforeAll(async () => {
  keys = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: password },
    backup: { kind: 'generated' },
    cryptoSource: webcrypto
  });
  foreign = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: otherPassword },
    backup: { kind: 'generated' },
    cryptoSource: webcrypto
  });
  const { ui, ...state } = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'СИНТЕТИЧЕСКОЕ ИМЯ', notes: 'СИНТЕТИЧЕСКАЯ ЗАМЕТКА' }]
  });
  snapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource: webcrypto }).snapshot);
  root = await sealHistoryVersion({
    publicSnapshot: snapshot,
    parent: null,
    recoveryKey: keys.dataKey,
    datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: keys.bundle,
    keyPin: keys.pin,
    cryptoSource: webcrypto
  });
  legacy = await sealHistoryVersion({
    publicSnapshot: snapshot,
    parent: null,
    recoveryKey: keys.dataKey,
    datasetId,
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  });
  childSnapshot = structuredClone(snapshot);
  const first = childSnapshot.sections.characters.records[0];
  first.fields.nick = 'СИНТЕТИЧЕСКОЕ ИЗМЕНЕНИЕ';
  const added = structuredClone(first);
  added.id = generateSyncId(webcrypto);
  added.fields.nick = 'СИНТЕТИЧЕСКИЙ НОВЫЙ';
  childSnapshot.sections.characters.records.push(added);
  childSnapshot.sections.characters.order.active.push(added.id);
  child = await sealHistoryVersion({
    publicSnapshot: childSnapshot,
    parent: root.pin,
    recoveryKey: keys.dataKey,
    datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: keys.bundle,
    keyPin: keys.pin,
    cryptoSource: webcrypto
  });
}, 30_000);

function beginOptions(overrides = {}) {
  return {
    envelope: root.envelope,
    expectedDatasetId: datasetId,
    expectedPin: keys.pin,
    independentPinConfirmed: true,
    ...overrides
  };
}
function fakeStore() {
  let raw = null;
  const read = vi.fn(async () => (raw ? { status: 'ready', raw } : { status: 'empty' }));
  const install = vi.fn(async pending => {
    if (raw) return { status: 'occupied' };
    raw = (await createKeyStateRecord(pending, webcrypto)).raw;
    return { status: 'installed' };
  });
  return { read, install, raw: () => raw };
}
function fakeSession(items = [{ envelope: root.envelope, modifiedAt: '2026-10-29T12:00:00.000Z' }]) {
  return {
    listWithDates: vi.fn(async () => ({
      status: 'listed',
      versions: items.map(item => ({ versionId: item.envelope.versionId, modifiedAt: item.modifiedAt }))
    })),
    read: vi.fn(async id => {
      const match = items.find(item => item.envelope.versionId === id);
      return match ? { status: 'found', envelope: match.envelope } : { status: 'not_found' };
    })
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('переносимая капсула внутри облачной версии', () => {
  it('не содержит данных или секретов и привязана к стандартному AES-GCM', async () => {
    const envelope = root.envelope;
    expect(envelope.version).toBe(2);
    expect(validateEnvelope(envelope)).toBe(true);
    expect(copyCloudEnvelope(envelope, datasetId)).toEqual(envelope);
    const serialized = JSON.stringify(envelope);
    const decodedCapsule = Buffer.from(envelope.keyCapsule, 'base64url').toString('utf8');
    for (const value of [
      'СИНТЕТИЧЕСКОЕ ИМЯ',
      'СИНТЕТИЧЕСКАЯ ЗАМЕТКА',
      password,
      keys.dataKey,
      keys.generatedBackupSecret
    ]) {
      expect(serialized).not.toContain(value);
      expect(decodedCapsule).not.toContain(value);
    }
    const encrypted = Buffer.from(envelope.ciphertext, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(keys.dataKey.slice(4), 'base64url'),
      Buffer.from(envelope.iv, 'base64url')
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([
          envelope.format,
          envelope.version,
          envelope.algorithm,
          envelope.datasetId,
          envelope.versionId,
          envelope.keyCapsule
        ])
      )
    );
    decipher.setAuthTag(encrypted.subarray(-16));
    const plain = JSON.parse(
      Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8')
    );
    expect(plain.publicSnapshot).toEqual(snapshot);
    const history = await verifyHistory({
      envelopes: [envelope],
      expectedDatasetId: datasetId,
      recoveryKey: keys.dataKey,
      root: root.pin,
      knownPins: [],
      cryptoSource: webcrypto
    });
    expect(history.publicSnapshot(root.pin)).toEqual(snapshot);
  });

  it('открывается основным или независимым запасным секретом только при доверенном pin', async () => {
    for (const [role, secret] of [
      ['main', password],
      ['backup', keys.generatedBackupSecret]
    ]) {
      const opened = await openPortableEnvelope({
        envelope: root.envelope,
        expectedDatasetId: datasetId,
        expectedPin: keys.pin,
        role,
        secret,
        cryptoSource: webcrypto
      });
      expect(opened.dataKey).toBe(keys.dataKey);
      expect(opened.snapshot.publicSnapshot).toEqual(snapshot);
    }
    await expect(
      openPortableEnvelope({
        envelope: root.envelope,
        expectedDatasetId: datasetId,
        expectedPin: keys.pin,
        role: 'main',
        secret: otherPassword,
        cryptoSource: webcrypto
      })
    ).rejects.not.toThrow(otherPassword);
    await expect(
      openPortableEnvelope({
        envelope: root.envelope,
        expectedDatasetId: datasetId,
        expectedPin: foreign.pin,
        role: 'backup',
        secret: keys.generatedBackupSecret,
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
    await expect(
      openPortableEnvelope({
        envelope: root.envelope,
        expectedDatasetId: generateSyncId(webcrypto),
        expectedPin: keys.pin,
        role: 'main',
        secret: password,
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
  }, 20_000);

  it('привязывает всю капсулу к GCM, а HMAC — к тому же ключу данных', async () => {
    const foreignCapsule = await makePortableKeyCapsule({
      bundle: foreign.bundle,
      pin: foreign.pin,
      dataKey: foreign.dataKey,
      datasetId,
      cryptoSource: webcrypto
    });
    const replaced = { ...root.envelope, keyCapsule: foreignCapsule };
    await expect(
      decryptSnapshot({
        envelope: replaced,
        recoveryKey: keys.dataKey,
        expectedDatasetId: datasetId,
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
    await expect(
      verifyPortableEnvelopeBinding({ envelope: replaced, dataKey: keys.dataKey, cryptoSource: webcrypto })
    ).rejects.toThrow();
    // Даже собственноручно пересчитанный GCM не проходит проверку связности капсулы.
    const forged = await encryptSnapshot({
      snapshot: { format: 'tvinoferma-public-history', version: 1, parent: null, publicSnapshot: snapshot },
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: generateSyncId(webcrypto),
      keyCapsule: foreignCapsule,
      cryptoSource: webcrypto
    });
    expect(
      (
        await decryptSnapshot({
          envelope: forged,
          recoveryKey: keys.dataKey,
          expectedDatasetId: datasetId,
          cryptoSource: webcrypto
        })
      ).publicSnapshot
    ).toEqual(snapshot);
    await expect(
      verifyPortableEnvelopeBinding({ envelope: forged, dataKey: keys.dataKey, cryptoSource: webcrypto })
    ).rejects.toThrow();
    const store = { read: vi.fn(), install: vi.fn(), compareExchange: vi.fn() };
    const session = { upload: vi.fn(), verify: vi.fn() };
    const queue = createDurableCloudOutbox({
      provider: 'yandex',
      datasetId,
      deviceId: generateSyncId(webcrypto),
      slotId: generateSyncId(webcrypto),
      clientId: '0123456789abcdef',
      accountKey: 'FAKE_ACCOUNT',
      dataKey: keys.dataKey,
      store,
      session,
      cryptoSource: webcrypto
    });
    expect(await queue.enqueue(forged)).toEqual({ status: 'invalid_version' });
    expect(store.read).not.toHaveBeenCalled();
    expect(session.upload).not.toHaveBeenCalled();
    await expect(
      verifyHistory({
        envelopes: [forged],
        expectedDatasetId: datasetId,
        recoveryKey: keys.dataKey,
        root: { versionId: forged.versionId, sha256: '0'.repeat(64) },
        knownPins: [],
        cryptoSource: webcrypto
      })
    ).rejects.toThrow('Не удалось проверить зашифрованную историю');
  });

  it('не создаёт v2 с неверным pin, набором или внутренним ключом', async () => {
    const args = { bundle: keys.bundle, pin: keys.pin, dataKey: keys.dataKey, datasetId, cryptoSource: webcrypto };
    await expect(makePortableKeyCapsule({ ...args, pin: foreign.pin })).rejects.toThrow();
    await expect(makePortableKeyCapsule({ ...args, dataKey: foreign.dataKey })).rejects.toThrow();
    await expect(makePortableKeyCapsule({ ...args, datasetId: generateSyncId(webcrypto) })).rejects.toThrow();
    await expect(
      sealHistoryVersion({
        publicSnapshot: snapshot,
        parent: null,
        recoveryKey: keys.dataKey,
        datasetId,
        versionId: generateSyncId(webcrypto),
        keyBundle: keys.bundle,
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
  });

  it('отклоняет неканонический base64, лишние поля, некорректную JSON-капсулу и getter', async () => {
    const badJson = Buffer.from(JSON.stringify({ ...keys.bundle, extra: 'PRIVATE' })).toString('base64url');
    const withGetter = { ...root.envelope };
    let getter = false;
    Object.defineProperty(withGetter, 'keyCapsule', {
      enumerable: true,
      get() {
        getter = true;
        return 'unsafe';
      }
    });
    for (const envelope of [
      { ...root.envelope, keyCapsule: root.envelope.keyCapsule + '=' },
      { ...root.envelope, keyCapsule: 'A'.repeat(12_000) },
      { ...root.envelope, keyCapsule: badJson },
      { ...root.envelope, secret: password },
      withGetter
    ]) {
      await expect(inspectPortableEnvelope({ envelope, cryptoSource: webcrypto })).rejects.toThrow();
    }
    expect(getter).toBe(false);
    let nestedGetter = false;
    const nested = Object.defineProperty({}, 'length', {
      get() {
        nestedGetter = true;
        return 10;
      }
    });
    await expect(
      verifyHistory({
        envelopes: [{ ...root.envelope, keyCapsule: nested }],
        expectedDatasetId: datasetId,
        recoveryKey: keys.dataKey,
        root: root.pin,
        knownPins: [],
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
    expect(nestedGetter).toBe(false);
  });

  it('фиксирует облачный файл и доверенный pin до асинхронной проверки', async () => {
    const mutable = { ...root.envelope };
    const pin = { ...keys.pin };
    const promise = openPortableEnvelope({
      envelope: mutable,
      expectedDatasetId: datasetId,
      expectedPin: pin,
      role: 'backup',
      secret: keys.generatedBackupSecret,
      cryptoSource: webcrypto
    });
    mutable.keyCapsule = 'A'.repeat(88);
    pin.sha256 = '0'.repeat(64);
    const opened = await promise;
    expect(opened.dataKey).toBe(keys.dataKey);
    expect(opened.pin).toEqual(keys.pin);
  }, 20_000);

  it('проверяет смешанную v1/v2 историю, не меняя старые отпечатки', async () => {
    const child = await sealHistoryVersion({
      publicSnapshot: snapshot,
      parent: legacy.pin,
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: keys.bundle,
      keyPin: keys.pin,
      cryptoSource: webcrypto
    });
    const history = await verifyHistory({
      envelopes: [legacy.envelope, child.envelope],
      expectedDatasetId: datasetId,
      recoveryKey: keys.dataKey,
      root: legacy.pin,
      knownPins: [child.pin],
      cryptoSource: webcrypto
    });
    expect(history.publicSnapshot(child.pin)).toEqual(snapshot);
    await expect(
      verifyHistory({
        envelopes: [
          legacy.envelope,
          {
            ...child.envelope,
            keyCapsule: root.envelope.keyCapsule.slice(0, -1) + (root.envelope.keyCapsule.endsWith('A') ? 'B' : 'A')
          }
        ],
        expectedDatasetId: datasetId,
        recoveryKey: keys.dataKey,
        root: legacy.pin,
        knownPins: [child.pin],
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
  });
});

describe('код независимой сверки', () => {
  it('содержит только ID и отпечатки ключа и корня, без секретов', () => {
    const code = createPairingCode({ datasetId, keyPin: keys.pin, rootPin: root.pin });
    const raw = Buffer.from(code.slice(5), 'base64url').toString('utf8');
    for (const secret of [password, keys.dataKey, keys.generatedBackupSecret]) {
      expect(code).not.toContain(secret);
      expect(raw).not.toContain(secret);
    }
    expect(parsePairingCode(code)).toEqual({
      format: 'tvinoferma-pairing-code',
      version: 1,
      datasetId,
      keyPin: keys.pin,
      rootPin: root.pin
    });
  });

  it('отклоняет повреждённый и неканонический код, не выполняет getter', () => {
    const code = createPairingCode({ datasetId, keyPin: keys.pin, rootPin: root.pin });
    const raw = JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('ascii'));
    const extra = 'TFP1-' + Buffer.from(JSON.stringify({ ...raw, secret: password })).toString('base64url');
    const space = 'TFP1-' + Buffer.from(JSON.stringify(raw, null, 1)).toString('base64url');
    for (const bad of [code + '=', code + 'A'.repeat(4000), extra, space, 'TFP2-' + code.slice(5), 'TFP1-!']) {
      expect(() => parsePairingCode(bad)).toThrow();
    }
    let accessed = false;
    const input = { datasetId, keyPin: keys.pin, rootPin: root.pin };
    Object.defineProperty(input, 'keyPin', {
      enumerable: true,
      get() {
        accessed = true;
        return keys.pin;
      }
    });
    expect(() => createPairingCode(input)).toThrow();
    expect(accessed).toBe(false);
  });
});

describe('поиск переносимых версий без выбора победителя по дате', () => {
  it('возвращает неподтверждённые pin, отдельное время проверки и неизвестную дату как null', async () => {
    const session = fakeSession([
      { envelope: root.envelope, modifiedAt: null },
      { envelope: legacy.envelope, modifiedAt: '2026-10-29T15:00:00+03:00' }
    ]);
    expect(await findPortableKeyVersions({ session, datasetId, cryptoSource: webcrypto, now })).toEqual({
      status: 'listed',
      checkedAt: '2026-10-30T11:00:00.000Z',
      candidates: [{ versionId: root.envelope.versionId, modifiedAt: null, pin: keys.pin }],
      legacy: [{ versionId: legacy.envelope.versionId, modifiedAt: '2026-10-29T12:00:00.000Z' }]
    });
  });

  it('не возвращает частичные результаты при изменении, проблеме аккаунта или сети', async () => {
    for (const status of ['not_found', 'identity_mismatch', 'account_mismatch', 'account_unavailable', 'unavailable']) {
      const session = fakeSession();
      session.read.mockResolvedValue({ status });
      const result = await findPortableKeyVersions({ session, datasetId, cryptoSource: webcrypto, now });
      expect(result).toEqual({ status: ['not_found', 'identity_mismatch'].includes(status) ? 'changed' : status });
      expect(result).not.toHaveProperty('candidates');
    }
  });

  it('останавливается на дублях, неверных датах, чужом наборе и повреждённой капсуле', async () => {
    const duplicate = fakeSession([
      { envelope: root.envelope, modifiedAt: null },
      { envelope: root.envelope, modifiedAt: null }
    ]);
    const invalidDate = fakeSession([{ envelope: root.envelope, modifiedAt: '2026-02-30T00:00:00Z' }]);
    const other = fakeSession([
      { envelope: { ...root.envelope, datasetId: generateSyncId(webcrypto) }, modifiedAt: null }
    ]);
    const bad = fakeSession([{ envelope: { ...root.envelope, keyCapsule: 'A'.repeat(88) }, modifiedAt: null }]);
    for (const session of [duplicate, invalidDate, other, bad]) {
      await expect(findPortableKeyVersions({ session, datasetId, cryptoSource: webcrypto, now })).rejects.toThrow(
        'Не удалось безопасно'
      );
    }
  });

  it('после отмены дожидается начатого чтения и не запускает следующее', async () => {
    const session = fakeSession([
      { envelope: root.envelope, modifiedAt: null },
      { envelope: legacy.envelope, modifiedAt: null }
    ]);
    const gate = deferred();
    session.read.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    let finished = false;
    const pending = findPortableKeyVersions({
      session,
      datasetId,
      cryptoSource: webcrypto,
      now,
      signal: controller.signal
    });
    pending.then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(session.read).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve({ status: 'found', envelope: root.envelope });
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(session.read).toHaveBeenCalledOnce();
  });

  it('не раскрывает исключения транспорта и не выдумывает дату проверки', async () => {
    const session = fakeSession();
    session.listWithDates.mockRejectedValue(new Error('PRIVATE_TOKEN_OR_URL'));
    await expect(findPortableKeyVersions({ session, datasetId, cryptoSource: webcrypto, now })).rejects.not.toThrow(
      'PRIVATE_TOKEN_OR_URL'
    );
    await expect(
      findPortableKeyVersions({ session: fakeSession(), datasetId, cryptoSource: webcrypto, now: () => NaN })
    ).rejects.toThrow();
  });
});

describe('сравнение проверенной истории без применения', () => {
  function options(session, extra = {}) {
    return {
      provider: 'google',
      session,
      datasetId,
      dataKey: keys.dataKey,
      rootPin: root.pin,
      knownPins: [],
      localSnapshot: snapshot,
      localSavedAt: '2026-10-28T16:00:00+03:00',
      cryptoSource: webcrypto,
      now,
      ...extra
    };
  }
  function sessionWithHistory() {
    // Даты намеренно идут в обратном порядке: они не определяют потомка.
    return fakeSession([
      { envelope: root.envelope, modifiedAt: '2026-10-30T12:00:00.000Z' },
      { envelope: child.envelope, modifiedAt: '2026-10-29T12:00:00.000Z' }
    ]);
  }

  it('показывает отдельные времена и различия для ЯВНО выбранного отпечатка', async () => {
    const review = await prepareCloudReview(options(sessionWithHistory()));
    expect(review.status).toBe('ready_for_review');
    expect(review.provider).toBe('google');
    expect(review.checkedAt).toBe('2026-10-30T11:00:00.000Z');
    expect(review.localSavedAt).toBe('2026-10-28T13:00:00.000Z');
    expect(review.versions).toEqual([
      { pin: root.pin, modifiedAt: '2026-10-30T12:00:00.000Z', observedHead: false },
      { pin: child.pin, modifiedAt: '2026-10-29T12:00:00.000Z', observedHead: true }
    ]);
    const rootComparison = review.compare(root.pin);
    expect(rootComparison.differences.entries).toEqual([]);
    const chosen = review.compare(child.pin);
    expect(chosen.cloudModifiedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(chosen.differences.entries.map(item => item.kind).sort()).toEqual(['changed', 'only_cloud']);
    expect(chosen.differences.entries.find(item => item.kind === 'changed').changes[0].path).toEqual(['nick']);
    expect(chosen.differences.entries.find(item => item.kind === 'only_cloud').label).toBe('СИНТЕТИЧЕСКИЙ НОВЫЙ');
    expect(() => review.compare({ ...child.pin, sha256: '0'.repeat(64) })).toThrow();
  });

  it('фиксирует локальные данные до ожидания диска и не выдумывает время сохранения', async () => {
    const gate = deferred();
    const session = sessionWithHistory();
    const original = session.listWithDates;
    session.listWithDates = vi.fn(() => gate.promise);
    const local = structuredClone(snapshot);
    const pending = prepareCloudReview(options(session, { localSnapshot: local, localSavedAt: null }));
    local.sections.characters.records[0].fields.nick = 'ПОЗДНЕЕ ИЗМЕНЕНИЕ';
    gate.resolve(await original());
    const review = await pending;
    expect(review.localSavedAt).toBeNull();
    expect(review.compare(root.pin).differences.entries).toEqual([]);
    expect(
      review.compare(child.pin).differences.entries.find(item => item.kind === 'changed').changes[0].local.value
    ).toBe('СИНТЕТИЧЕСКОЕ ИМЯ');
  });

  it('отказывает в частичном результате при потере файла или смене аккаунта', async () => {
    for (const status of ['not_found', 'identity_mismatch', 'account_mismatch', 'account_unavailable', 'unavailable']) {
      const session = sessionWithHistory();
      session.read.mockResolvedValue({ status });
      const review = await prepareCloudReview(options(session));
      expect(review).toEqual({ status: ['not_found', 'identity_mismatch'].includes(status) ? 'changed' : status });
    }
  });

  it('не сравнивает при неправильном ключе, корне, повреждении или неполной истории', async () => {
    expect(await prepareCloudReview(options(sessionWithHistory(), { dataKey: foreign.dataKey }))).toEqual({
      status: 'history_unverified'
    });
    expect(
      await prepareCloudReview(options(sessionWithHistory(), { rootPin: { ...root.pin, sha256: '0'.repeat(64) } }))
    ).toEqual({ status: 'history_unverified' });
    expect(await prepareCloudReview(options(fakeSession([{ envelope: child.envelope, modifiedAt: null }])))).toEqual({
      status: 'history_unverified'
    });
    const changed = {
      ...child.envelope,
      ciphertext: (child.envelope.ciphertext[0] === 'A' ? 'B' : 'A') + child.envelope.ciphertext.slice(1)
    };
    const corrupt = fakeSession([
      { envelope: root.envelope, modifiedAt: null },
      { envelope: changed, modifiedAt: null }
    ]);
    expect(await prepareCloudReview(options(corrupt))).toEqual({ status: 'history_unverified' });
  });

  it('не передаёт неподходящий локальный снимок в сеть и не раскрывает ошибки транспорта', async () => {
    const session = sessionWithHistory();
    const privateSnapshot = structuredClone(snapshot);
    privateSnapshot.sections.characters.records[0].fields.password = 'PRIVATE_PASSWORD';
    await expect(prepareCloudReview(options(session, { localSnapshot: privateSnapshot }))).rejects.not.toThrow(
      'PRIVATE_PASSWORD'
    );
    expect(session.listWithDates).not.toHaveBeenCalled();
    session.listWithDates.mockRejectedValue(new Error('PRIVATE_ACCESS_TOKEN'));
    await expect(prepareCloudReview(options(session))).rejects.not.toThrow('PRIVATE_ACCESS_TOKEN');
    await expect(prepareCloudReview(options(sessionWithHistory(), { localSavedAt: 'not a date' }))).rejects.toThrow();
  });

  it('отмена во время чтения не выдаёт частичное сравнение и не начинает следующий запрос', async () => {
    const session = sessionWithHistory();
    const gate = deferred();
    session.read.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    const pending = prepareCloudReview(options(session, { signal: controller.signal }));
    await vi.waitFor(() => expect(session.read).toHaveBeenCalledOnce());
    controller.abort();
    gate.resolve({ status: 'found', envelope: root.envelope });
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(session.read).toHaveBeenCalledOnce();
  });

  it('считает дату из диска неизвестной, а не локальным временем проверки', async () => {
    const session = fakeSession([{ envelope: root.envelope, modifiedAt: null }]);
    const review = await prepareCloudReview(options(session, { provider: 'yandex', localSavedAt: null }));
    const comparison = review.compare(root.pin);
    expect(comparison.cloudModifiedAt).toBeNull();
    expect(comparison.localSavedAt).toBeNull();
    expect(comparison.checkedAt).toBe('2026-10-30T11:00:00.000Z');
    expect(comparison.provider).toBe('yandex');
  });
});

describe('установка восстановленного ключа в защищённое хранилище (fake)', () => {
  it('требует отдельного подтверждения и совпадения доверенного pin до установки', async () => {
    const store = fakeStore();
    const recoverer = createKeyRecoverer({ store, cryptoSource: webcrypto });
    expect(await recoverer.begin(beginOptions({ independentPinConfirmed: false }))).toEqual({
      status: 'confirmation_required'
    });
    expect(await recoverer.begin(beginOptions({ expectedPin: foreign.pin }))).toEqual({ status: 'pin_mismatch' });
    expect(store.install).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it('не затирает занятую или повреждённую локальную запись', async () => {
    for (const status of ['ready', 'blocked']) {
      const store = fakeStore();
      store.read.mockResolvedValue({ status });
      const recoverer = createKeyRecoverer({ store, cryptoSource: webcrypto });
      expect(await recoverer.begin(beginOptions())).toEqual({
        status: status === 'ready' ? 'already_configured' : 'local_blocked'
      });
      expect(store.install).not.toHaveBeenCalled();
    }
  });

  it('после ошибки секрета позволяет повторить ввод, а успешный readback не раскрывает ключ', async () => {
    const store = fakeStore();
    const recoverer = createKeyRecoverer({ store, cryptoSource: webcrypto });
    const attempt = await recoverer.begin(beginOptions());
    expect(attempt.status).toBe('prepared');
    expect(await attempt.recover({ role: 'main', secret: otherPassword })).toEqual({
      status: 'invalid_secret_or_file'
    });
    expect(store.install).not.toHaveBeenCalled();
    const done = await attempt.recover({ role: 'main', secret: password });
    expect(done).toEqual({ status: 'installed' });
    expect(JSON.stringify(done)).not.toContain(keys.dataKey);
    expect(store.install).toHaveBeenCalledOnce();
    expect(store.raw()).toContain(keys.dataKey); // этот raw допустим только внутри fake OS vault
    expect(attempt.cancel()).toEqual({ status: 'closed' });
  }, 20_000);

  it('отмена во время scrypt не записывает ключ', async () => {
    const store = fakeStore();
    const attempt = await createKeyRecoverer({ store, cryptoSource: webcrypto }).begin(beginOptions());
    const running = attempt.recover({ role: 'backup', secret: keys.generatedBackupSecret });
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(await running).toEqual({ status: 'cancelled' });
    expect(store.install).not.toHaveBeenCalled();
  }, 20_000);

  it('не повторяет запись при неизвестном результате и не обещает отмену начатого install', async () => {
    const store = fakeStore();
    const gate = deferred();
    store.install.mockImplementation(async () => gate.promise);
    const attempt = await createKeyRecoverer({ store, cryptoSource: webcrypto }).begin(beginOptions());
    const running = attempt.recover({ role: 'backup', secret: keys.generatedBackupSecret });
    await vi.waitFor(() => expect(store.install).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(attempt.cancel()).toEqual({ status: 'installation_in_progress' });
    gate.resolve({ status: 'installed' });
    expect(await running).toEqual({ status: 'installation_uncertain' }); // readback остался empty
    expect(store.install).toHaveBeenCalledOnce();
    expect(attempt.cancel()).toEqual({ status: 'closed' });
  }, 20_000);

  it('не повторяет install после исключения даже если запись уже могла произойти', async () => {
    const store = fakeStore();
    store.install.mockImplementation(async () => {
      throw new Error('PRIVATE_UNCERTAIN');
    });
    const attempt = await createKeyRecoverer({ store, cryptoSource: webcrypto }).begin(beginOptions());
    const result = await attempt.recover({ role: 'backup', secret: keys.generatedBackupSecret });
    expect(result).toEqual({ status: 'installation_uncertain' });
    expect(store.install).toHaveBeenCalledOnce();
    await expect(attempt.recover({ role: 'backup', secret: keys.generatedBackupSecret })).rejects.toThrow();
  }, 20_000);
});
