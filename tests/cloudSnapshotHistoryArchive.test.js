import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, sealFileSnapshot, verifyHistory } from '../js/modules/cloudSync/history.js';
import { createPairingCode } from '../js/modules/cloudSync/pairingCode.js';
import {
  createEncryptedHistoryArchive,
  verifyEncryptedHistoryArchive,
  historyCapacity,
  MAX_HISTORY_ARCHIVE_BYTES
} from '../js/modules/cloudSync/snapshotHistoryArchive.js';
const cryptoSource = webcrypto,
  id = () => generateSyncId(cryptoSource);
let key, root, child, history, envelopes, archive, pairingCode;
beforeAll(async () => {
  const datasetId = id();
  key = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: 'Тестовый основной секрет 987654321' },
    backup: { kind: 'generated' },
    cryptoSource
  });
  const { ui, ...state } = normalizeState({ characters: [{ id: 'a', nick: 'ARCHIVED_PUBLIC_NICK' }] });
  const snapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource }).snapshot);
  const common = { datasetId, recoveryKey: key.dataKey, keyBundle: key.bundle, keyPin: key.pin, cryptoSource };
  root = await sealHistoryVersion({ ...common, publicSnapshot: snapshot, parent: null, versionId: id() });
  child = await sealFileSnapshot({
    ...common,
    publicSnapshot: snapshot,
    parent: root.pin,
    versionId: id(),
    privateSnapshot: {
      schemaVersion: 1,
      records: [
        { characterId: snapshot.sections.characters.records[0].id, fields: { password: 'ARCHIVED_PRIVATE_PASSWORD' } }
      ]
    }
  });
  envelopes = [child.envelope, root.envelope];
  history = await verifyHistory({
    envelopes,
    expectedDatasetId: datasetId,
    root: root.pin,
    knownPins: [root.pin],
    recoveryKey: key.dataKey,
    cryptoSource
  });
  pairingCode = createPairingCode({ datasetId, rootPin: root.pin, keyPin: key.pin });
  archive = await createEncryptedHistoryArchive({
    provider: 'google',
    history,
    envelopes,
    keyPin: key.pin,
    cryptoSource
  });
});
const verify = (text = archive.text, extra = {}) =>
  verifyEncryptedHistoryArchive({
    text,
    provider: 'google',
    expectedPairingCode: pairingCode,
    recoveryKey: key.dataKey,
    knownPins: [root.pin, child.pin],
    cryptoSource,
    ...extra
  });
async function rehash(raw) {
  const { sha256, ...data } = raw;
  data.envelopes.sort((a, b) => a.versionId.localeCompare(b.versionId));
  raw.sha256 = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))
  ).toString('hex');
  return JSON.stringify(raw);
}
describe('зашифрованный архив облачной истории', () => {
  it('содержит точные конверты, но не открытые данные, dataKey или основной секрет', async () => {
    expect((await verify()).status).toBe('archive_verified');
    for (const secret of ['ARCHIVED_PRIVATE_PASSWORD', 'ARCHIVED_PUBLIC_NICK', key.dataKey, 'Тестовый основной секрет'])
      expect(archive.text).not.toContain(secret);
    const raw = JSON.parse(archive.text);
    expect(raw.envelopes).toEqual([...envelopes].sort((a, b) => a.versionId.localeCompare(b.versionId)));
    expect(raw.pairingCode).toBe(pairingCode);
    expect(archive.bytes).toBe(new TextEncoder().encode(archive.text).byteLength);
  });
  it('не доверяет коду из самого файла и другому провайдеру', async () => {
    await expect(verify(archive.text, { provider: 'yandex' })).rejects.toThrow();
    await expect(
      verify(archive.text, {
        expectedPairingCode: createPairingCode({
          datasetId: history.identity().datasetId,
          keyPin: key.pin,
          rootPin: { ...root.pin, sha256: '0'.repeat(64) }
        })
      })
    ).rejects.toThrow();
  });
  it('не считает внешний checksum заменой AES/pin проверки', async () => {
    const raw = JSON.parse(archive.text);
    raw.envelopes[0].ciphertext =
      (raw.envelopes[0].ciphertext[0] === 'A' ? 'B' : 'A') + raw.envelopes[0].ciphertext.slice(1);
    await expect(verify(await rehash(raw))).rejects.toThrow();
  });
  it('не принимает пропущенную известную версию даже с пересчитанным checksum', async () => {
    const raw = JSON.parse(archive.text);
    raw.envelopes = raw.envelopes.filter(e => e.versionId !== child.pin.versionId);
    await expect(verify(await rehash(raw))).rejects.toThrow();
  });
  it('отклоняет дублированные версии, неизвестные поля и повреждённый checksum', async () => {
    const raw = JSON.parse(archive.text);
    for (const changed of [
      { ...raw, extra: 'forbidden' },
      { ...raw, sha256: '0'.repeat(64) },
      { ...raw, envelopes: [...raw.envelopes, raw.envelopes[0]] }
    ])
      await expect(verify(JSON.stringify(changed))).rejects.toThrow();
  });
  it('не требует исходного форматирования JSON, но проверяет содержимое', async () => {
    expect((await verify(JSON.stringify(JSON.parse(archive.text), null, 2))).status).toBe('archive_verified');
  });
  it('не принимает неверный ключ', async () => {
    await expect(verify(archive.text, { recoveryKey: id() })).rejects.toThrow();
  });
  it('не принимает непроверенный history или чужие байты при создании архива', async () => {
    await expect(
      createEncryptedHistoryArchive({
        provider: 'google',
        history: { ...history },
        envelopes,
        keyPin: key.pin,
        cryptoSource
      })
    ).rejects.toThrow();
    await expect(
      createEncryptedHistoryArchive({
        provider: 'google',
        history,
        envelopes: [root.envelope],
        keyPin: key.pin,
        cryptoSource
      })
    ).rejects.toThrow();
  });
  it('копирует входные конверты до первого await', async () => {
    const copy = structuredClone(envelopes),
      pending = createEncryptedHistoryArchive({
        provider: 'google',
        history,
        envelopes: copy,
        keyPin: key.pin,
        cryptoSource
      });
    copy[0].ciphertext = 'REPLACED';
    expect((await verify((await pending).text)).status).toBe('archive_verified');
  });
  it('показывает запас и ноль безопасных удалений, не повышая существующие лимиты', () => {
    expect(historyCapacity(envelopes)).toMatchObject({
      versions: 2,
      remainingVersions: 126,
      nearLimit: false,
      protectedVersions: 2,
      deletableVersions: 0
    });
    expect(historyCapacity(Array(96).fill(root.envelope)).nearLimit).toBe(true);
    expect(historyCapacity(Array(128).fill(root.envelope)).remainingVersions).toBe(0);
    expect(() => historyCapacity(Array(129).fill(root.envelope))).toThrow();
    expect(() => historyCapacity([])).toThrow();
    expect(MAX_HISTORY_ARCHIVE_BYTES).toBeLessThan(97 * 1024 * 1024);
  });
});
