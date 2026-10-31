// @ts-check
// Чистая read-only проверка локального файла. Никаких storage/native/сети.
// Возвращает только фиксированные коды; JSON, имена файлов и пользовательские
// значения никогда не входят в отчёт. Нормализация соответствует обычной загрузке.
import { normalizeState } from '../../core/state/normalize.js';
import { SCHEMA_VERSION } from '../../core/migrations.js';
import { MAX_SNAPSHOT_BYTES, validateJsonSnapshot } from './envelope.js';
import { planSyncIdentities } from './identityMigration.js';
import { preparationCheck, preparationDiagnosticCode } from './preparationDiagnostics.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { exportCharacter } from './characterExport.js';
import { exportParty } from './partyExport.js';
import { exportMarathon } from './marathonExport.js';
import { exportMarathonTemplate } from './templateExport.js';
import { exportPlannerEntry } from './plannerExport.js';
import { exportFinance } from './financeExport.js';

const MAX_CODES = 64;
const report = codes => Object.freeze({ codes: Object.freeze([...codes]) });

/** Файл state.json, не частичный JSON-экспорт и не зашифрованный облачный файл. */
export function inspectStateFile(text, cryptoSource = globalThis.crypto) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES)
    return report(['file/size']);
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return report(['file/json']);
  }
  // Не выдаём пустую частичную выгрузку за успешно проверенную базу.
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    raw.schemaVersion > SCHEMA_VERSION ||
    !Array.isArray(raw.characters) ||
    !Array.isArray(raw.marathons)
  )
    return report(['file/state_required']);
  let planned;
  try {
    preparationCheck('snapshot', () => validateJsonSnapshot(raw));
    const { ui: _ui, ...loaded } = normalizeState(raw);
    planned = preparationCheck('ids', () => planSyncIdentities({ snapshot: loaded, cryptoSource })).snapshot;
  } catch (error) {
    return report([preparationDiagnosticCode(error)]);
  }
  const codes = new Set();
  let truncated = false;
  const check = (section, run) => {
    try {
      preparationCheck('public', () => preparationCheck(section, run));
    } catch (error) {
      const code = preparationDiagnosticCode(error);
      if (codes.size < MAX_CODES) codes.add(code);
      else if (!codes.has(code)) truncated = true;
    }
  };
  const mapping = rows => new Map(rows.map(row => [row.id, row.syncId]));
  const characterSyncIds = mapping([...planned.characters, ...planned.archivedCharacters]);
  const partySyncIds = mapping([...planned.parties, ...planned.archivedParties]);
  const marathonSyncIds = mapping(planned.marathons);
  const templateSyncIds = mapping(planned.marathonTemplates);
  for (const row of planned.characters)
    check('characters', () => exportCharacter(row, { syncId: row.syncId, partySyncIds }));
  for (const row of planned.archivedCharacters)
    check('archivedCharacters', () => exportCharacter(row, { syncId: row.syncId, partySyncIds, archived: true }));
  for (const row of planned.parties) check('parties', () => exportParty(row, { syncId: row.syncId, characterSyncIds }));
  for (const row of planned.archivedParties)
    check('archivedParties', () => exportParty(row, { syncId: row.syncId, characterSyncIds, archived: true }));
  for (const row of planned.marathons)
    check('marathons', () =>
      exportMarathon(row, { syncId: row.syncId, characterSyncIds, marathonSyncIds, templateSyncIds })
    );
  for (const row of planned.marathonTemplates)
    check('marathonTemplates', () => exportMarathonTemplate(row, { syncId: row.syncId }));
  for (const row of planned.plannerEntries)
    check('plannerEntries', () => exportPlannerEntry(row, { syncId: row.syncId }));
  check('finance', () => exportFinance(planned.finance));
  if (codes.size) return report([...codes, ...(truncated ? ['file/report_truncated'] : [])]);
  try {
    const before = preparationCheck('public', () => buildPublicSnapshot(planned));
    const { ui: _ui, ...normalized } = normalizeState(planned);
    const after = preparationCheck('reload', () => buildPublicSnapshot(normalized));
    const changes = preparationCheck('roundtrip', () => comparePublicSnapshots({ local: before, cloud: after }));
    if (changes.entries.length || changes.uncomparedSettings.length) return report(['file/reload_changes']);
  } catch (error) {
    return report([preparationDiagnosticCode(error)]);
  }
  return report(['file/structure_ok']);
}
