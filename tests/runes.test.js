import { describe, expect, it, vi } from 'vitest';
import { filterRunes, loadRuneCatalog, RUNE_CATALOG_URL, validateRuneCatalog } from '../js/modules/runes/catalog.js';
import { createRuneSubmission, submitRuneSuggestion } from '../js/modules/runes/submit.js';

const rune = (overrides = {}) => ({
  id: 'warrior-pve', class: 'Воин', pve: 'A1 B2', pvp: 'C3', additional: 'D4',
  author: 'Игрок', note: 'Для фарма', addedAt: '2026-10-01', ...overrides
});

describe('каталог рун', () => {
  it('принимает схему v1 и пропускает некорректные записи', () => {
    const catalog = validateRuneCatalog({ schemaVersion: 1, runes: [rune(), rune({ class: 'Неизвестный класс' }), null] });
    expect(catalog.runes).toHaveLength(1);
    expect(catalog.runes[0]).toMatchObject({ class: 'Воин', pve: 'A1 B2', additional: 'D4' });
  });

  it('отклоняет неизвестную версию схемы', () => {
    expect(() => validateRuneCatalog({ schemaVersion: 2, runes: [] })).toThrow('Неизвестный формат');
  });

  it('фильтрует класс и сортирует новые раскладки первыми', () => {
    expect(filterRunes([rune({ id: 'old', addedAt: '2026-01-01' }), rune({ id: 'new', addedAt: '2026-09-01' }), rune({ id: 'mage', class: 'Маг' })], 'Воин').map(item => item.id)).toEqual(['new', 'old']);
  });

  it('загружает каталог с GitHub и сохраняет кэш', async () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, runes: [rune()] }) });
    const result = await loadRuneCatalog({ fetchImpl, storage });
    expect(fetchImpl).toHaveBeenCalledWith(RUNE_CATALOG_URL, { cache: 'no-store' });
    expect(result.catalog.runes).toHaveLength(1);
    expect(result.fromCache).toBe(false);
    expect(result.source).toBe('github');
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it('использует кэш, если GitHub недоступен', async () => {
    const cached = JSON.stringify({ cachedAt: '2026-10-01T00:00:00.000Z', catalog: { schemaVersion: 1, runes: [rune()] } });
    const storage = { getItem: () => cached };
    const result = await loadRuneCatalog({ fetchImpl: async () => { throw new Error('offline'); }, storage });
    expect(result.fromCache).toBe(true);
    expect(result.catalog.runes).toHaveLength(1);
  });

  it('использует встроенный каталог, если GitHub недоступен и кэша нет', async () => {
    const fetchImpl = async url => url === RUNE_CATALOG_URL
      ? { ok: false, status: 404 }
      : { ok: true, json: async () => ({ schemaVersion: 1, runes: [] }) };
    const result = await loadRuneCatalog({ fetchImpl, storage: { getItem: () => null } });
    expect(result.source).toBe('bundle');
    expect(result.catalog.runes).toEqual([]);
  });
});

describe('отправка предложений', () => {
  const validSubmission = { class: 'Воин', author: 'Игрок', pve: 'A1', pvp: 'B2', additional: '', note: '' };

  it('нормализует данные формы и требует PvE и PvP раскладки', () => {
    expect(createRuneSubmission({ ...validSubmission, author: '  Игрок  ' }).author).toBe('Игрок');
    expect(() => createRuneSubmission({ ...validSubmission, pvp: '' })).toThrow('Заполните PvE- и PvP-руны');
    expect(() => createRuneSubmission({ ...validSubmission, note: 'x'.repeat(501) })).toThrow('превышает 500 символов');
  });

  it('отправляет JSON в настроенный Apps Script endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ type: 'opaque' });
    await submitRuneSuggestion(validSubmission, { endpoint: 'https://script.google.com/macros/s/test/exec', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('https://script.google.com/macros/s/test/exec', expect.objectContaining({
      method: 'POST', mode: 'no-cors', body: JSON.stringify(validSubmission)
    }));
  });

  it('объясняет, что приёмник ещё не подключён', async () => {
    await expect(submitRuneSuggestion(validSubmission, { endpoint: '' })).rejects.toThrow('Приём заявок ещё не подключён');
  });
});