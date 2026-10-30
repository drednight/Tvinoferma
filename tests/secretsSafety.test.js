import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setInvoke, contactsJson, hydrateSecrets, prepareForDisk, vaultStatus } from '../js/core/secrets.js';
import { state } from '../js/core/state.js';
import { isVaultWriteGuardError, wasVaultUpdated } from '../js/core/vaultWriteGuard.js';

const contact = (email = '', password = '', phone = '') => ({ email, password, recoveryEmail: '', phone });
const original = contactsJson(contact('original@example.test', 'PRIVATE-OLD'));

function fakeVault(initial = []) {
  const entries = new Map(initial);
  const calls = [];
  const flags = {
    available: true,
    failRead: false,
    failSetAfter: false,
    failDeleteAfter: false,
    failReadAfterWrite: false,
    mismatchAfterWrite: false,
    invalidReply: false,
    wrote: false
  };
  const invoke = vi.fn(async (command, args = {}) => {
    calls.push(command);
    if (command === 'secrets_available') return flags.available;
    if (command === 'secrets_get_many') {
      if (flags.failRead || (flags.wrote && flags.failReadAfterWrite)) throw new Error('PRIVATE-IPC-PATH');
      const found = Object.create(null);
      for (const key of args.keys) if (entries.has(key)) found[key] = entries.get(key);
      if (flags.wrote && flags.mismatchAfterWrite) found[args.keys[0]] = 'PRIVATE-UNEXPECTED';
      return found;
    }
    if (command === 'secrets_set_many') {
      flags.wrote = true;
      for (const [key, value] of Object.entries(args.items)) {
        if (value) entries.set(key, value);
        else entries.delete(key);
        if (flags.failSetAfter) throw new Error('PRIVATE-AFTER-SET');
      }
      return flags.invalidReply ? { unexpected: true } : null;
    }
    if (command === 'secrets_delete_many') {
      flags.wrote = true;
      for (const key of args.keys) {
        entries.delete(key);
        if (flags.failDeleteAfter) throw new Error('PRIVATE-AFTER-DELETE');
      }
      return null;
    }
    throw new Error('unexpected fixture command');
  });
  return { entries, flags, calls, invoke };
}

beforeEach(() => {
  state.settings.security = { useVault: true };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('защита чтения контактов в хранилище ОС', () => {
  it('не применяет даже валидные записи частично, если другая запись повреждена', async () => {
    const vault = fakeVault([
      ['a', original],
      ['b', '{"password":"PRIVATE-DAMAGED"']
    ]);
    __setInvoke(vault.invoke);
    const characters = [
      { id: 'a', contacts: contact('local-a') },
      { id: 'b', contacts: contact('local-b') }
    ];
    const before = structuredClone(characters);
    const result = await hydrateSecrets(characters, { requiresVault: true });
    expect(result.blocked).toBe(true);
    expect(characters).toEqual(before);
    expect(vault.entries.get('b')).toBe('{"password":"PRIVATE-DAMAGED"');
    expect(vaultStatus()).toMatchObject({ blocked: true, ready: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.calls).not.toContain('secrets_set_many');
    expect(vault.calls).not.toContain('secrets_delete_many');
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('PRIVATE');
  });

  it.each([
    ['сломанный JSON', '{PRIVATE'],
    ['повторный ключ', '{"email":"one","email":"two"}'],
    ['экранированный повтор', '{"email":"one","\\u0065mail":"two"}'],
    ['неизвестное поле', '{"email":"one","future":"PRIVATE"}'],
    ['объект вместо строки', '{"email":{"private":"PRIVATE"}}'],
    ['число вместо строки', '{"phone":123}'],
    ['пустая строка', ''],
    ['массив', '[]'],
    ['null', 'null']
  ])('блокирует неоднозначную запись (%s), даже если state не помечен vault', async (_label, raw) => {
    const vault = fakeVault([['a', raw]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'a', contacts: contact('local') }];
    const result = await hydrateSecrets(characters);
    expect(result.blocked).toBe(true);
    expect(characters[0].contacts.email).toBe('local');
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.entries.get('a')).toBe(raw);
    expect(vault.calls.filter(command => command.endsWith('_many'))).toEqual(['secrets_get_many']);
  });

  it('допускает форматированный JSON, пропущенные поля и escape, не переписывая неизменённую запись', async () => {
    const raw = '{\n  "pass\\u0077ord" : "PRIVATE-OLD", "email": "original@example.test"\n}';
    const vault = fakeVault([['a', raw]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'a', contacts: contact() }];
    expect(await hydrateSecrets(characters)).toEqual({ migrated: 0 });
    expect(characters[0].contacts).toMatchObject({ email: 'original@example.test', password: 'PRIVATE-OLD' });
    vault.calls.length = 0;
    const disk = await prepareForDisk({ characters });
    expect(disk.characters[0].contacts).toBeNull();
    expect(vault.entries.get('a')).toBe(raw);
    expect(vault.calls).toEqual([]);
    expect(wasVaultUpdated(disk)).toBe(false);
  });

  it('не выбирает молча один из разных контактов под старым и новым ID', async () => {
    const vault = fakeVault([
      ['new', original],
      ['old', contactsJson(contact('other@example.test', 'PRIVATE-OTHER'))]
    ]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'new', contacts: contact() }];
    expect((await hydrateSecrets(characters, { aliases: { new: 'old' } })).blocked).toBe(true);
    expect(characters[0].contacts.email).toBe('');
    expect(vault.entries.size).toBe(2);
  });

  it('блокирует отключённый или недоступный vault только когда исходный state на него ссылается', async () => {
    const unavailable = fakeVault();
    unavailable.flags.available = false;
    __setInvoke(unavailable.invoke);
    const characters = [{ id: 'a', contacts: contact('local') }];
    expect((await hydrateSecrets(characters, { requiresVault: true })).blocked).toBe(true);
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
    state.settings.security.useVault = false; // настройка не должна обходить уже установленную защиту
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);

    __setInvoke(unavailable.invoke);
    state.settings.security.useVault = true;
    expect((await hydrateSecrets(characters)).blocked).toBeUndefined();
    const snapshot = { characters };
    expect(await prepareForDisk(snapshot)).toBe(snapshot); // прежний fallback без ссылки на vault
  });

  it.each([contact('new@example.test', 'PRIVATE-NEW'), contact()])(
    'не заменяет изменённые или явно очищенные открытые контакты старой записью vault',
    async localContacts => {
      const vault = fakeVault([['a', original]]);
      __setInvoke(vault.invoke);
      const characters = [{ id: 'a', contacts: localContacts }];
      const before = JSON.stringify(characters);
      const result = await hydrateSecrets(characters, { plaintextIds: new Set(['a']) });
      expect(result.blocked).toBe(true);
      expect(JSON.stringify(characters)).toBe(before);
      expect(vault.entries.get('a')).toBe(original);
      expect(vault.calls).not.toContain('secrets_set_many');
    }
  );

  it('при совпадающих открытых контактах и vault разрешает чтение', async () => {
    const vault = fakeVault([['a', original]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'a', contacts: contact('original@example.test', 'PRIVATE-OLD') }];
    expect(await hydrateSecrets(characters, { plaintextIds: new Set(['a']) })).toEqual({ migrated: 0 });
  });

  it('при выключенном vault всё же читает контакты, если исходный файл на него ссылается', async () => {
    const vault = fakeVault([['a', original]]);
    __setInvoke(vault.invoke);
    state.settings.security.useVault = false;
    const characters = [{ id: 'a', contacts: contact() }];
    expect(await hydrateSecrets(characters, { requiresVault: true })).toEqual({ migrated: 0 });
    expect(characters[0].contacts.email).toBe('original@example.test');
    const snapshot = { characters };
    expect(await prepareForDisk(snapshot)).toBe(snapshot);
    expect(vault.calls).not.toContain('secrets_set_many');
  });

  it('не подменяет отсутствие записи неправильным ответом IPC или посторонним ключом', async () => {
    for (const response of [null, [], { other: original }, { a: 12 }]) {
      __setInvoke(async command => (command === 'secrets_available' ? true : response));
      const characters = [{ id: 'a', contacts: contact('local') }];
      expect((await hydrateSecrets(characters)).blocked).toBe(true);
      expect(characters[0].contacts.email).toBe('local');
    }
  });
});

describe('подтверждение локальных изменений vault', () => {
  it('сверяет старое значение, записывает и перечитывает новое до выдачи подготовленного снимка', async () => {
    const vault = fakeVault([['a', original]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'a', contacts: contact() }];
    await hydrateSecrets(characters);
    characters[0].contacts.password = 'PRIVATE-NEW';
    vault.calls.length = 0;
    const disk = await prepareForDisk({ characters });
    expect(vault.calls).toEqual(['secrets_get_many', 'secrets_set_many', 'secrets_get_many']);
    expect(JSON.parse(vault.entries.get('a')).password).toBe('PRIVATE-NEW');
    expect(disk.characters[0].contacts).toBeNull();
    expect(wasVaultUpdated(disk)).toBe(true);
    expect(JSON.stringify(disk)).not.toContain('PRIVATE');
  });

  it('не перезаписывает данные, изменённые после загрузки', async () => {
    const vault = fakeVault([['a', original]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'a', contacts: contact() }];
    await hydrateSecrets(characters);
    characters[0].contacts.password = 'PRIVATE-LOCAL-NEW';
    const other = contactsJson(contact('other@example.test', 'PRIVATE-EXTERNAL'));
    vault.entries.set('a', other);
    vault.calls.length = 0;
    const error = await prepareForDisk({ characters }).catch(e => e);
    expect(isVaultWriteGuardError(error)).toBe(true);
    expect(String(error)).not.toContain('PRIVATE');
    expect(vault.calls).toEqual(['secrets_get_many']);
    expect(vault.entries.get('a')).toBe(other);
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
  });

  it('не перезаписывает найденную после загрузки запись нового персонажа', async () => {
    const vault = fakeVault();
    __setInvoke(vault.invoke);
    await hydrateSecrets([]);
    vault.entries.set('a', original);
    await expect(prepareForDisk({ characters: [{ id: 'a', contacts: contact('new') }] })).rejects.toSatisfy(
      isVaultWriteGuardError
    );
    expect(vault.entries.get('a')).toBe(original);
    expect(vault.calls).not.toContain('secrets_set_many');
  });

  it.each(['failSetAfter', 'failReadAfterWrite', 'mismatchAfterWrite', 'invalidReply'])(
    'после %s не считает частичную запись подтверждённой и не повторяет',
    async flag => {
      const vault = fakeVault([['a', original]]);
      __setInvoke(vault.invoke);
      const characters = [{ id: 'a', contacts: contact() }];
      await hydrateSecrets(characters);
      characters[0].contacts.password = 'PRIVATE-NEW';
      vault.flags[flag] = true;
      const error = await prepareForDisk({ characters }).catch(e => e);
      expect(isVaultWriteGuardError(error)).toBe(true);
      expect(String(error)).not.toContain('PRIVATE');
      expect(vaultStatus()).toMatchObject({ blocked: true, ready: false });
      vault.flags[flag] = false;
      const writes = vault.calls.filter(command => command === 'secrets_set_many').length;
      await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
      expect(vault.calls.filter(command => command === 'secrets_set_many')).toHaveLength(writes);
    }
  );

  it('не повторяет удаление после ошибки, возникшей после удаления одной записи', async () => {
    const vault = fakeVault([
      ['a', original],
      ['b', original]
    ]);
    __setInvoke(vault.invoke);
    await hydrateSecrets([
      { id: 'a', contacts: contact() },
      { id: 'b', contacts: contact() }
    ]);
    vault.flags.failDeleteAfter = true;
    await expect(prepareForDisk({ characters: [] })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.entries.size).toBe(1); // только тестовая заглушка знает, что удаление уже произошло
    const writes = vault.calls.filter(command => command === 'secrets_delete_many').length;
    vault.flags.failDeleteAfter = false;
    await expect(prepareForDisk({ characters: [] })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.calls.filter(command => command === 'secrets_delete_many')).toHaveLength(writes);
  });

  it('сохраняет ключ __proto__ как обычный ID, а не свойство прототипа', async () => {
    const vault = fakeVault();
    __setInvoke(vault.invoke);
    const characters = [{ id: '__proto__', contacts: contact('proto@example.test') }];
    await hydrateSecrets(characters);
    const disk = await prepareForDisk({ characters });
    expect(vault.entries.has('__proto__')).toBe(true);
    expect(JSON.parse(vault.entries.get('__proto__')).email).toBe('proto@example.test');
    expect(disk.characters[0].contacts).toBeNull();
  });

  it('не начинает запись при дублирующихся без учёта регистра ID в снимке', async () => {
    const vault = fakeVault();
    __setInvoke(vault.invoke);
    await hydrateSecrets([]);
    const characters = [
      { id: 'a', contacts: contact('first') },
      { id: 'A', contacts: contact('second') }
    ];
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.calls).not.toContain('secrets_set_many');
  });

  it.each([{ a: 'B' }, { a: 'OLD', b: 'old' }, { a: 'A' }])(
    'не читает перекрывающиеся старые и новые ID',
    async aliases => {
      const vault = fakeVault();
      __setInvoke(vault.invoke);
      const characters = [
        { id: 'a', contacts: contact('first') },
        { id: 'b', contacts: contact('second') }
      ];
      expect((await hydrateSecrets(characters, { aliases, requiresVault: true })).blocked).toBe(true);
      expect(characters.map(c => c.contacts.email)).toEqual(['first', 'second']);
      expect(vault.calls).not.toContain('secrets_get_many');
    }
  );

  it('не удаляет старую запись при изменении лишь регистра ID', async () => {
    const vault = fakeVault([['hero', original]]);
    __setInvoke(vault.invoke);
    const characters = [{ id: 'hero', contacts: contact() }];
    await hydrateSecrets(characters);
    characters[0].id = 'Hero';
    await expect(prepareForDisk({ characters })).rejects.toSatisfy(isVaultWriteGuardError);
    expect(vault.entries.get('hero')).toBe(original);
    expect(vault.calls).not.toContain('secrets_set_many');
    expect(vault.calls).not.toContain('secrets_delete_many');
  });

  it.each([{ characters: null }, { characters: [], archivedCharacters: {} }])(
    'не возвращает неподходящий снимок в открытом виде при активном vault',
    async snapshot => {
      const vault = fakeVault();
      __setInvoke(vault.invoke);
      await hydrateSecrets([]);
      await expect(prepareForDisk(snapshot)).rejects.toSatisfy(isVaultWriteGuardError);
      expect(vault.calls).not.toContain('secrets_set_many');
    }
  );
});
