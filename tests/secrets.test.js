import { describe, it, expect, beforeEach } from 'vitest';
import { hydrateSecrets, prepareForDisk, __setInvoke, vaultStatus, contactsJson } from '../js/core/secrets.js';
import { state } from '../js/core/state.js';

function fakeVault(initial = {}, { available = true } = {}) {
  const store = { ...initial };
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'secrets_available') return available;
    if (cmd === 'secrets_get_many') return Object.fromEntries(args.keys.filter(k => store[k]).map(k => [k, store[k]]));
    if (cmd === 'secrets_set_many') Object.entries(args.items).forEach(([k, v]) => { if (v) store[k] = v; else delete store[k]; });
    if (cmd === 'secrets_delete_many') args.keys.forEach(k => delete store[k]);
  };
  return { store, calls, invoke };
}

const contacts = (email, password = '') => ({ email, password, recoveryEmail: '', phone: '' });

describe('secrets', () => {
  beforeEach(() => { state.settings.security = { useVault: true }; });

  it('переносит открытые контакты из файла в хранилище и убирает их из снимка', async () => {
    const v = fakeVault();
    __setInvoke(v.invoke);
    const chars = [{ id: 'a', contacts: contacts('a@x.ru', 'pw') }, { id: 'b', contacts: contacts('') }];
    expect(await hydrateSecrets(chars)).toEqual({ migrated: 1 });
    const disk = await prepareForDisk({ characters: chars });
    expect(disk.secretsInVault).toBe(true);
    expect(disk.characters.every(c => c.contacts === null)).toBe(true);
    expect(JSON.parse(v.store.a)).toMatchObject({ email: 'a@x.ru', password: 'pw' });
    expect(v.store.b).toBeUndefined();
  });

  it('значение из хранилища главнее, повторная запись без изменений не делается', async () => {
    const v = fakeVault({ a: contactsJson(contacts('vault@x.ru', 'v')) });
    __setInvoke(v.invoke);
    const chars = [{ id: 'a', contacts: contacts('') }];
    await hydrateSecrets(chars);
    expect(chars[0].contacts.email).toBe('vault@x.ru');
    v.calls.length = 0;
    await prepareForDisk({ characters: chars });
    expect(v.calls).not.toContain('secrets_set_many');
  });

  it('удаляет записи удалённых персонажей', async () => {
    const v = fakeVault({ a: contactsJson(contacts('a')), b: contactsJson(contacts('b')) });
    __setInvoke(v.invoke);
    const chars = [{ id: 'a', contacts: contacts('') }, { id: 'b', contacts: contacts('') }];
    await hydrateSecrets(chars);
    await prepareForDisk({ characters: [chars[0]] });
    expect(Object.keys(v.store)).toEqual(['a']);
  });

  it('если хранилище недоступно — снимок не меняется (контакты не теряются)', async () => {
    const v = fakeVault({}, { available: false });
    __setInvoke(v.invoke);
    const chars = [{ id: 'a', contacts: contacts('a@x.ru') }];
    const res = await hydrateSecrets(chars);
    expect(res.error).toBeTruthy();
    expect(vaultStatus().ready).toBe(false);
    const snap = { characters: chars };
    expect(await prepareForDisk(snap)).toBe(snap);
  });

  it('выключенная настройка — хранилище не используется', async () => {
    state.settings.security = { useVault: false };
    const v = fakeVault();
    __setInvoke(v.invoke);
    await hydrateSecrets([{ id: 'a', contacts: contacts('a') }]);
    expect(v.calls).toEqual([]);
  });

  it('после смены id (миграция v4) читает старый ключ и переносит запись под новый', async () => {
    const v = fakeVault({ 'uuid-1': contactsJson(contacts('old@x.ru', 'pw')) });
    __setInvoke(v.invoke);
    const chars = [{ id: 'Bob', contacts: null }];
    await hydrateSecrets(chars, { aliases: { Bob: 'uuid-1' } });
    expect(chars[0].contacts.email).toBe('old@x.ru');
    await prepareForDisk({ characters: chars });
    expect(v.store['uuid-1']).toBeUndefined();
    expect(JSON.parse(v.store.Bob)).toMatchObject({ email: 'old@x.ru', password: 'pw' });
  });
});
