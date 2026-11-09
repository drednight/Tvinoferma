import { normalizeConditions } from './testConditions.js';
import { safeDiagnostic } from './trace.js';
import { BACKGROUND_METHODS } from './background.js';
export const EVIDENCE_METHODS = {
  ...BACKGROUND_METHODS,
  'mirror-combined': 'Повтор клавиатуры · PostMessage + activity-notify (ручное наблюдение)',
  'mirror-post': 'Повтор клавиатуры · PostMessage (ручное наблюдение)'
};
export function trialTrace(run) {
  if (!run || !Array.isArray(run.events)) return null;
  const events = run.events.length > 60 ? [...run.events.slice(0, 20), ...run.events.slice(-40)] : run.events;
  return {
    runId: String(run.runId || '').slice(0, 80),
    state: String(run.state || 'unknown').slice(0, 30),
    stage: String(run.stage || '').slice(0, 100),
    omitted: Math.max(0, Number(run.omitted) || 0) + run.events.length - events.length,
    events: events
      .filter(event => event && typeof event.stage === 'string')
      .map(event => ({
        stage: safeDiagnostic(event.stage),
        status: safeDiagnostic(event.status),
        at: String(event.at || '').slice(0, 40),
        details: Object.fromEntries(
          Object.entries(event.details || {})
            .filter(
              ([key, value]) =>
                [
                  'phase',
                  'method',
                  'pid',
                  'hwnd',
                  'key',
                  'ok',
                  'inputSent',
                  'foregroundChanged',
                  'errorCode',
                  'blockedBy',
                  'elapsedMs',
                  'visible',
                  'minimized',
                  'hung',
                  'identityChecked',
                  'integrityAllowed'
                ].includes(key) && ['string', 'boolean', 'number'].includes(typeof value)
            )
            .map(([key, value]) => [key, typeof value === 'string' ? safeDiagnostic(value) : value])
        )
      }))
  };
}
export function normalizeTrials(value) {
  return (Array.isArray(value) ? value : [])
    .slice(-40)
    .filter(
      row =>
        row &&
        typeof row.id === 'string' &&
        typeof row.charId === 'string' &&
        typeof row.key === 'string' &&
        Object.hasOwn(EVIDENCE_METHODS, row.method)
    )
    .map(row => ({
      id: row.id.slice(0, 80),
      charId: row.charId.slice(0, 200),
      partyId: String(row.partyId || '').slice(0, 200),
      key: row.key.slice(0, 60),
      method: row.method,
      conditions: normalizeConditions(row.conditions),
      verdict: ['unverified', 'worked', 'failed', 'partial'].includes(row.verdict) ? row.verdict : 'unverified',
      notes: String(row.notes || '').slice(0, 600),
      at: String(row.at || '').slice(0, 40),
      technical: {
        trace: trialTrace(row.technical?.trace),
        runId: String(row.technical?.runId || '').slice(0, 80),
        state: String(row.technical?.state || 'unknown').slice(0, 30),
        stage: String(row.technical?.stage || '').slice(0, 100),
        known: String(row.technical?.known || 'Нет данных.').slice(0, 600),
        unknown: String(row.technical?.unknown || 'Реакция игры неизвестна.').slice(0, 300),
        next: String(row.technical?.next || '').slice(0, 600)
      }
    }));
}
