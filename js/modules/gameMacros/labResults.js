import { commandFingerprint } from './fingerprint.js';
export const LAB_VERDICTS = {
  unverified: 'Не проверено',
  worked: 'Сработало в игре',
  failed: 'Не сработало',
  partial: 'Частично'
};
export function normalizeLabResults(value) {
  return (Array.isArray(value) ? value : [])
    .slice(-100)
    .filter(
      row =>
        row &&
        typeof row.commandId === 'string' &&
        typeof row.fingerprint === 'string' &&
        row.fingerprint.length <= 40000 &&
        Object.hasOwn(LAB_VERDICTS, row.verdict)
    )
    .map(row => ({
      commandId: row.commandId.slice(0, 80),
      fingerprint: row.fingerprint,
      verdict: row.verdict,
      notes: String(row.notes || '').slice(0, 600),
      observedAt: String(row.observedAt || '').slice(0, 40)
    }));
}
export function recordLabVerdict(c, command, verdict, notes) {
  if (!Object.hasOwn(LAB_VERDICTS, verdict)) throw new Error('Выберите результат ручной проверки.');
  const fingerprint = commandFingerprint(command, c);
  return [
    ...c.labResults.filter(row => row.commandId !== command.id),
    {
      commandId: command.id,
      fingerprint,
      verdict,
      notes: String(notes || '').slice(0, 600),
      observedAt: new Date().toISOString()
    }
  ].slice(-100);
}
export function labVerdict(c, command) {
  const row = c.labResults.find(row => row.commandId === command.id);
  return row?.fingerprint === commandFingerprint(command, c) ? row : null;
}
