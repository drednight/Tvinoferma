// js/modules/runes/catalog.js
// Каталог рун загружается из GitHub, локальный кэш используется без сети.

import { CLASSES } from '../../core/constants.js';

export const RUNE_CATALOG_URL = 'https://raw.githubusercontent.com/drednight/Tvinoferma/main/public/data/runes.json';
const BUNDLED_CATALOG_URL = '/data/runes.json';
const CACHE_KEY = 'tvinoferma-runes-catalog-v1';

export function validateRuneCatalog(payload) {
	if (payload?.schemaVersion !== 1 || !Array.isArray(payload.runes)) {
		throw new Error('Неизвестный формат каталога рун.');
	}

	const runes = payload.runes.flatMap((item, index) => {
		if (!item || typeof item !== 'object' || !CLASSES.includes(item.class)) return [];
		const fields = ['pve', 'pvp', 'additional', 'author', 'note', 'addedAt'];
		if (fields.some(field => item[field] !== undefined && typeof item[field] !== 'string')) return [];
		return [{
			id: typeof item.id === 'string' && item.id ? item.id : `${item.class}-${index}`,
			class: item.class,
			pve: item.pve || '',
			pvp: item.pvp || '',
			additional: item.additional || '',
			author: item.author || '',
			note: item.note || '',
			addedAt: item.addedAt || ''
		}];
	});
	return { schemaVersion: 1, runes };
}

export function filterRunes(runes, className = '') {
	return runes
		.filter(rune => !className || rune.class === className)
		.slice()
		.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
}

function readCache(storage) {
	try {
		const cached = JSON.parse(storage?.getItem(CACHE_KEY) || 'null');
		if (!cached?.catalog) return null;
		return { catalog: validateRuneCatalog(cached.catalog), cachedAt: cached.cachedAt || '' };
	} catch {
		return null;
	}
}

export async function loadRuneCatalog({ fetchImpl = globalThis.fetch, storage = globalThis.localStorage } = {}) {
	try {
		if (!fetchImpl) throw new Error('Сеть недоступна.');
		const response = await fetchImpl(RUNE_CATALOG_URL, { cache: 'no-store' });
		if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}.`);
		const catalog = validateRuneCatalog(await response.json());
		const cachedAt = new Date().toISOString();
		try { storage?.setItem(CACHE_KEY, JSON.stringify({ catalog, cachedAt })); } catch { /* кэш необязателен */ }
		return { catalog, cachedAt, fromCache: false, source: 'github' };
	} catch (error) {
		const cached = readCache(storage);
		if (cached) return { ...cached, fromCache: true, source: 'cache', error };
		try {
			const response = await fetchImpl(BUNDLED_CATALOG_URL);
			if (response.ok) {
				return { catalog: validateRuneCatalog(await response.json()), cachedAt: '', fromCache: true, source: 'bundle', error };
			}
		} catch { /* встроенный каталог тоже может быть недоступен */ }
		throw error;
	}
}
