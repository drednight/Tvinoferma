import { commandFingerprint } from './fingerprint.js';
// Bounded, allowlisted execution evidence. Never records arbitrary IPC payloads or raw exceptions.
const history = [];
let active = null;
const sensitive = /(?:https?:\/\/|token\s*[:=]|password\s*[:=]|cookie\s*[:=]|[A-Z]:\\|\/home\/|[\w.+-]+@[\w.-]+)/gi;
export const safeDiagnostic = value =>
  String(value ?? '')
    .replace(/(?:token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[скрыто]')
    .replace(sensitive, '[скрыто]')
    .slice(0, 240);
export function startExecutionTrace(command, config) {
  active = {
    runId: crypto.randomUUID(),
    commandId: command.id,
    fingerprint: commandFingerprint(command, config),
    startedAt: new Date().toISOString(),
    state: 'running',
    stage: 'start',
    events: [],
    omitted: 0
  };
  history.push(active);
  if (history.length > 20) history.shift();
  return active.runId;
}
export function executionStage(stage, status = 'ok', details = {}) {
  if (!active) return null;
  const allowed = {};
  for (const field of [
    'action',
    'key',
    'method',
    'pid',
    'startedAt',
    'hwnd',
    'count',
    'ok',
    'inputSent',
    'foregroundChanged',
    'errorCode',
    'timedOut',
    'timeoutMs',
    'releaseUnconfirmed',
    'deliveryUncertain',
    'attempt',
    'issueCount',
    'charId',
    'blockedBy',
    'elapsedMs',
    'phase',
    'asynchronous',
    'skipped',
    'visible',
    'minimized',
    'hung',
    'identityChecked',
    'integrityAllowed',
    'appElevated',
    'targetElevated',
    'selectedKeyHeld',
    'modifierHeld'
  ]) {
    const value = details[field];
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') allowed[field] = value;
    else if (typeof value === 'string') allowed[field] = safeDiagnostic(value);
  }
  active.stage = stage;
  const event = {
    runId: active.runId,
    n: active.events.length + active.omitted + 1,
    at: new Date().toISOString(),
    stage,
    status,
    details: allowed
  };
  const last = active.events.at(-1);
  if (
    last &&
    last.stage === stage &&
    last.status === status &&
    JSON.stringify(last.details) === JSON.stringify(allowed)
  ) {
    last.repeats = (last.repeats || 1) + 1;
    return event;
  }
  if (active.events.length < 250) active.events.push(event);
  else {
    active.events.splice(50, 1);
    active.events.push(event);
    active.omitted++;
  }
  return event;
}
export function finishExecutionTrace(state) {
  if (!active) return null;
  active.state = state;
  active.finishedAt = new Date().toISOString();
  const value = structuredClone(active);
  active = null;
  return value;
}
export function executionHistory() {
  return structuredClone(history);
}
export function clearExecutionHistory() {
  history.length = 0;
}
export function explainBackgroundResult(report) {
  if (report?.foregroundChanged) return 'FOREGROUND_CHANGED: активное окно изменилось; продолжать нельзя.';
  if (report?.blockedBy === 'physical-input') return 'PHYSICAL_INPUT: пользователь удерживает физический ввод.';
  if (report?.integrityAllowed === false) return 'INTEGRITY: уровень прав не позволяет отправку.';
  if (report?.minimized || report?.visible === false) return 'WINDOW_STATE: окно скрыто или свёрнуто.';
  if (report?.hung) return 'WINDOW_HUNG: Windows считает окно зависшим.';
  if (report?.error === 1460) return 'TIMEOUT_1460: нет ответа в заданный срок. Это не доказывает недоставку.';
  if (report?.error === 5) return 'ACCESS_DENIED_5: Windows отказала в доступе.';
  if (report?.refused) return 'PREFLIGHT_REFUSED: условия проверки не выполнены; клавиша могла не отправляться.';
  if (report?.ok === true) return 'API_OK_GAME_UNKNOWN: Windows приняла запрос; результат в игре неизвестен.';
  return 'UNCONFIRMED: технический или игровой результат не подтверждён.';
}

export function hasActiveExecution() {
  return active !== null;
}

export function currentExecutionId() {
  return active?.runId || null;
}
