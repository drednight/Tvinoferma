import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  contactSnapshotFromState,
  encryptContactFile,
  decryptContactFile,
  validateContactSnapshot,
  MAX_CONTACT_FILE_BYTES
} from '../js/settings/contactFileCodec.js';

const cryptoSource = webcrypto;
const source = {
  characters: [
    {
      id: 'a',
      nick: 'Alpha',
      contacts: { email: 'PRIVATE-EMAIL', password: 'PRIVATE-PASSWORD', recoveryEmail: '', phone: '' },
      notes: 'PRIVATE-NOTES'
    }
  ],
  archivedCharacters: [
    {
      id: 'b',
      nick: 'Beta',
      contacts: { email: '', password: '', recoveryEmail: 'PRIVATE-RECOVERY', phone: 'PRIVATE-PHONE' }
    }
  ]
};
const snapshot = () => contactSnapshotFromState(source, '2026-11-12T00:00:00.000Z');

describe('portable encrypted contact file', () => {
  it('encrypts active and archived contacts, excludes other information and keeps the recovery key separate', async () => {
    const data = snapshot();
    const { file, recoveryKey, count } = await encryptContactFile(data, cryptoSource);
    expect(count).toBe(2);
    expect(recoveryKey).toMatch(/^TF1-[A-Za-z0-9_-]{43}$/);
    expect(file).not.toContain(recoveryKey);
    for (const secret of [
      'PRIVATE-EMAIL',
      'PRIVATE-PASSWORD',
      'PRIVATE-RECOVERY',
      'PRIVATE-PHONE',
      'PRIVATE-NOTES',
      'Alpha'
    ])
      expect(file).not.toContain(secret);
    expect(JSON.stringify(data)).not.toContain('PRIVATE-NOTES');
    expect(await decryptContactFile(file, recoveryKey, cryptoSource)).toEqual(data);
    expect((await decryptContactFile(file, recoveryKey, cryptoSource)).characters[1].archived).toBe(true);
  });
  it('creates fresh independent keys and ciphertext on every export', async () => {
    const a = await encryptContactFile(snapshot(), cryptoSource);
    const b = await encryptContactFile(snapshot(), cryptoSource);
    expect(a.recoveryKey).not.toBe(b.recoveryKey);
    expect(a.file).not.toBe(b.file);
    await expect(decryptContactFile(a.file, b.recoveryKey, cryptoSource)).rejects.toThrow('Не удалось открыть');
  });
  it('rejects corruption, a wrong key, unknown fields, a mismatched format and oversize input', async () => {
    const { file, recoveryKey } = await encryptContactFile(snapshot(), cryptoSource);
    const data = JSON.parse(file);
    const bytes = Buffer.from(data.envelope.ciphertext, 'base64url');
    bytes[0] ^= 1;
    data.envelope.ciphertext = bytes.toString('base64url');
    await expect(decryptContactFile(JSON.stringify(data), recoveryKey, cryptoSource)).rejects.toThrow(
      'Не удалось открыть'
    );
    await expect(decryptContactFile(file, 'PRIVATE-WRONG', cryptoSource)).rejects.not.toThrow('PRIVATE-WRONG');
    const extra = JSON.parse(file);
    extra.unexpected = true;
    await expect(decryptContactFile(JSON.stringify(extra), recoveryKey, cryptoSource)).rejects.toThrow();
    await expect(
      decryptContactFile('x'.repeat(MAX_CONTACT_FILE_BYTES + 1), recoveryKey, cryptoSource)
    ).rejects.toThrow();
  });
  it('refuses missing fields, duplicated IDs and empty snapshots instead of silently claiming a complete backup', () => {
    const missing = structuredClone(snapshot());
    delete missing.characters[0].contacts.password;
    expect(() => validateContactSnapshot(missing)).toThrow();
    const duplicate = structuredClone(snapshot());
    duplicate.characters[1].id = 'A';
    expect(() => validateContactSnapshot(duplicate)).toThrow();
    const empty = structuredClone(snapshot());
    empty.characters = [];
    expect(() => validateContactSnapshot(empty)).toThrow();
    const extra = structuredClone(snapshot());
    extra.characters[0].contacts.other = 'x';
    expect(() => validateContactSnapshot(extra)).toThrow();
  });
});
