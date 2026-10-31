// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

beforeEach(() => vi.restoreAllMocks());

describe('новый персонаж редактора → подготовка облака без перезапуска', () => {
  it('сохраняет и готовит ID прямо из runtime-модели, не нормализуя персонажа заранее', async () => {
    vi.resetModules();
    localStorage.clear();
    const { state, normalizeState, normalizeCharacter } = await import('../js/core/state.js');
    const { createEmptyCharacter } = await import('../js/modules/characters/stateManager.js');
    const storage = await import('../js/core/storage.js');
    const { stageSyncIdentities } = await import('../js/modules/cloudSync/commitSyncIdentities.js');
    const { captureInitialCloudBaseline } = await import('../js/modules/cloudSync/initialCloudBaseline.js');
    Object.assign(state, normalizeState({ schemaVersion: 10, settings: { security: { useVault: false } } }));
    // Это путь редактора, не normalizeState fixture, скрывавший отсутствующие поля.
    const draft = createEmptyCharacter();
    const character = { ...draft, id: 'new-runtime-character', nick: 'Новый', lastCoinUpdate: draft.lastCoinUpdate };
    character.contacts.password = 'FAKE_PRIVATE_PASSWORD';
    character.launch = { ...draft.launch, gcPath: '/FAKE/PRIVATE/PATH' };
    state.characters.push(character);
    await storage.saveNow();
    const before = localStorage.getItem('tvinoferma_state_v1');
    const staged = stageSyncIdentities({ cryptoSource: webcrypto });
    expect(staged.status).toBe('prepared');
    expect(character).toEqual(normalizeCharacter(character));
    const assigned = await staged.operation.commit({ confirmed: true });
    expect(assigned.status).toBe('applied');
    expect(localStorage.getItem(assigned.backup)).toBe(before);
    expect(state.characters[0]).toBe(character);
    expect(character.contacts.password).toBe('FAKE_PRIVATE_PASSWORD');
    const baseline = await captureInitialCloudBaseline();
    expect(baseline.status).toBe('ready');
    const exported = JSON.stringify(baseline.getPublicSnapshot());
    expect(exported).toContain('Новый');
    expect(exported).not.toContain('FAKE_PRIVATE_PASSWORD');
    expect(exported).not.toContain('/FAKE/PRIVATE/PATH');
    baseline.close();
  });
  it('ранее сохранённый неполный персонаж восстанавливает стандартную схему при обычной загрузке', async () => {
    vi.resetModules();
    localStorage.clear();
    const { state, normalizeState } = await import('../js/core/state.js');
    const storage = await import('../js/core/storage.js');
    const { stageSyncIdentities } = await import('../js/modules/cloudSync/commitSyncIdentities.js');
    Object.assign(state, normalizeState({ schemaVersion: 10, settings: { security: { useVault: false } } }));
    const legacy = {
      ...normalizeState({ schemaVersion: 10, characters: [{ id: 'legacy', nick: 'Ранее созданный' }] }).characters[0]
    };
    for (const key of [
      'partyOrder',
      'launch',
      'statsHistory',
      'lastLoginCheck',
      'lastLoginReason',
      'marathonData',
      'coinsParserV',
      'isLoggedIn'
    ])
      delete legacy[key];
    legacy.lastCoinUpdate = undefined; // как в старом редакторе, файл это поле не содержит
    state.characters.push(legacy);
    await storage.saveNow();
    expect(() => stageSyncIdentities({ cryptoSource: webcrypto })).toThrow('неподдерживаемое значение');
    const saved = localStorage.getItem('tvinoferma_state_v1');
    Object.assign(state, normalizeState(JSON.parse(saved)));
    await storage.saveNow(); // мастер сохраняет нормализованную память перед планом
    const staged = stageSyncIdentities({ cryptoSource: webcrypto });
    expect((await staged.operation.commit({ confirmed: true })).status).toBe('applied');
    expect(state.characters[0].nick).toBe('Ранее созданный');
  });
});

async function mountPreparation({ damagedId = false, saveFails = false } = {}) {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  const { readFileSync } = await import('node:fs');
  const parsed = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
  document.getElementById('cloud-registration-provider').value = 'google';
  const { state, normalizeState } = await import('../js/core/state.js');
  const { createEmptyCharacter } = await import('../js/modules/characters/stateManager.js');
  Object.assign(state, normalizeState({ schemaVersion: 10, settings: { security: { useVault: false } } }));
  const draft = createEmptyCharacter();
  const character = { ...draft, id: 'runtime-hero', nick: 'Новый', lastCoinUpdate: draft.lastCoinUpdate };
  if (damagedId) character.syncId = 'FAKE_PRIVATE_BAD_ID';
  state.characters.push(character);
  if (saveFails) {
    const { localStorageAdapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
    vi.spyOn(localStorageAdapter, 'saveState').mockRejectedValue(new Error('FAKE_PRIVATE_DISK_PATH'));
  }
  const { bindInitialCloudPanel } = await import('../js/modules/cloudSync/ui/initialCloudPanel.js');
  const begin = vi.fn(async () => ({ status: 'prepared', generatedBackupSecret: 'FAKE_BACKUP_KEY' }));
  const makeSetup = vi.fn(() => ({ begin }));
  const loadNative = vi.fn(async () => ({ invoke: vi.fn() }));
  // prepareData намеренно НЕ подменён: реальный save → stage → guarded commit.
  bindInitialCloudPanel({ desktop: true, makeSetup, loadNative });
  document.getElementById('cloud-setup-main').value = 'A synthetic passphrase 2026';
  document.getElementById('cloud-setup-main-repeat').value = 'A synthetic passphrase 2026';
  document.getElementById('cloud-setup-new-approve').checked = true;
  document.getElementById('cloud-setup-create').click();
  await vi.waitFor(() =>
    expect(
      !document.getElementById('cloud-setup-confirm').hidden || !document.getElementById('cloud-setup-create').disabled
    ).toBe(true)
  );
  return {
    state,
    character,
    begin,
    makeSetup,
    loadNative,
    status: document.getElementById('cloud-setup-status').textContent
  };
}

describe('реальная автоматическая подготовка в Google-мастере', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
  it('кнопка с заполненной базой проходит подготовку без prepareData-заглушки', async () => {
    const f = await mountPreparation();
    expect(f.makeSetup).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.character.syncId).toMatch(/^[a-f0-9-]{36}$/);
    expect(document.getElementById('cloud-setup-confirm').hidden).toBe(false);
    expect(f.status).toContain('Ключи подготовлены в памяти');
    expect(document.body.textContent).not.toContain('FAKE_BACKUP_KEY');
    expect(document.getElementById('cloud-setup-generated').value).toBe('FAKE_BACKUP_KEY');
  });
  it('ошибка ID не называется ошибкой пароля и не начинает создание ключа', async () => {
    const f = await mountPreparation({ damagedId: true });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.loadNative).not.toHaveBeenCalled();
    expect(f.status).toContain('setup/identities');
    expect(f.status).toContain('Это не ошибка пароля');
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_BAD_ID');
    expect(f.character.syncId).toBe('FAKE_PRIVATE_BAD_ID');
  });
  it('сбой сохранения показывается отдельно без пути и без создания ключа', async () => {
    const f = await mountPreparation({ saveFails: true });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.loadNative).not.toHaveBeenCalled();
    expect(f.status).toContain('setup/local_save');
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_DISK_PATH');
    expect(f.character.syncId).toBeUndefined();
  });
});
