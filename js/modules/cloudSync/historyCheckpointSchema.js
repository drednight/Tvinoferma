// @ts-check
// Authenticated compaction statement, not an unauthenticated list of deletions.
import { object, array } from './exportSchema.js';
import { isSyncId } from './envelope.js';
export const MAX_RETIRED_PINS = 4096;
const TYPES = new Set([
  'characters:character',
  'parties:party',
  'marathons:marathon',
  'marathons:marathonSeries',
  'marathons:marathonTemplate',
  'planner:plannerEntry',
  'finance:financeOperation',
  'finance:financeShopItem',
  'finance:financeLoan',
  'finance:financePayment'
]);
const fail = () => new Error('Некорректная контрольная версия истории');
export function checkpointPin(value) {
  const p = object(value, ['versionId', 'sha256']);
  if (!isSyncId(p.versionId) || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(p.sha256)) throw fail();
  return { ...p };
}
export function parseHistoryCheckpoint(value) {
  const c = object(value, ['source', 'retiredPins', 'identities', 'archiveSha256']);
  if (
    !Array.isArray(c.retiredPins) ||
    !c.retiredPins.length ||
    c.retiredPins.length > MAX_RETIRED_PINS ||
    typeof c.archiveSha256 !== 'string' ||
    !/^[0-9a-f]{64}(?![\s\S])/.test(c.archiveSha256)
  )
    throw fail();
  const source = checkpointPin(c.source),
    retiredPins = array(c.retiredPins, checkpointPin);
  if (
    new Set(retiredPins.map(p => p.versionId)).size !== retiredPins.length ||
    !retiredPins.some(p => p.versionId === source.versionId && p.sha256 === source.sha256)
  )
    throw fail();
  const identities = array(c.identities, value => {
    const row = object(value, ['id', 'type']);
    if (!isSyncId(row.id) || !TYPES.has(row.type)) throw fail();
    return { ...row };
  });
  if (new Set(identities.map(row => row.id)).size !== identities.length) throw fail();
  return {
    source,
    retiredPins: retiredPins.sort((a, b) => a.versionId.localeCompare(b.versionId)),
    identities: identities.sort((a, b) => a.id.localeCompare(b.id)),
    archiveSha256: c.archiveSha256
  };
}
