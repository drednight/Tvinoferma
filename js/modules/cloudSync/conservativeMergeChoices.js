// @ts-check
// Conflict choices contain only record IDs, setting names and a digest, never
// values. The digest binds the choice to one observed comparison and queue state.
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { array, boolean, object } from './exportSchema.js';
import { PORTABLE_SETTING_GROUPS } from './settingsExport.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const MAX_CHOICES = 1000;
function invalid() {
  return new Error('Не удалось проверить выбор конфликтующих изменений');
}

/** @param {any} value */
export function parseConservativeMergeChoices(value) {
  validateJsonSnapshot(value);
  const input = object(value, ['reviewHash', 'cloudRecords', 'cloudSettings', 'cloudFinanceSettings']);
  if (typeof input.reviewHash !== 'string' || !HEX.test(input.reviewHash)) throw invalid();
  const records = array(input.cloudRecords, item => {
    const row = object(item, ['section', 'id']);
    if (!SECTIONS.includes(row.section) || !isSyncId(row.id)) throw invalid();
    return { section: row.section, id: row.id };
  });
  if (records.length > MAX_CHOICES || new Set(records.map(row => `${row.section}:${row.id}`)).size !== records.length)
    throw invalid();
  const settings = array(input.cloudSettings, value => value);
  if (JSON.stringify(settings) !== JSON.stringify(PORTABLE_SETTING_GROUPS.filter(group => settings.includes(group))))
    throw invalid();
  return {
    reviewHash: input.reviewHash,
    cloudRecords: records,
    cloudSettings: [...settings],
    cloudFinanceSettings: boolean(input.cloudFinanceSettings)
  };
}

/** The comparison, pins and queue revision must be the ones the person saw. */
export async function conservativeConflictReviewHash(value, cryptoSource = globalThis.crypto) {
  validateJsonSnapshot(value);
  const data = new TextEncoder().encode(`Tvinoferma conservative conflicts v1\n${JSON.stringify(value)}`);
  if (!cryptoSource?.subtle || data.length > 4 * 1024 * 1024) throw invalid();
  const digest = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', data));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
