// @ts-check
/* global __TF_BUILD_INFO__ */
// Session-only, allowlisted telemetry. NEVER retain raw errors, provider bodies,
// account labels/IDs, tokens, envelopes, paths, signed URLs or arbitrary strings.
import {
  cloudAccessDiagnostic,
  CLOUD_ACCESS_MESSAGES,
  withCloudAccessDiagnostic
} from './providers/cloudAccessDiagnostics.js';
import { STANDALONE_STATUS_MESSAGES } from './standaloneStatus.js';
import { safePreparationDiagnosticCode, isPreparationDiagnosticCode } from './preparationDiagnostics.js';
import { cloudActivity, describeCloudActivity } from './cloudEventLog.js';
const STAGES = new Set([
  'ui_save',
  'ui_check',
  'ui_action',
  'ui_compare',
  'review_access',
  'review_download',
  'review_verify',
  'review_unlock',
  'review_compare',
  'ensure_ids',
  'scan_destinations',
  'open_account',
  'key_unlock',
  'snapshot_public',
  'snapshot_contents',
  'key_create',
  'key_capsule',
  'file_encrypt',
  'file_seal',
  'file_hash',
  'snapshot_hash',
  'save_dispatch',
  'local_patch',
  'disk_identity',
  'disk_identity_preview',
  'disk_list',
  'disk_folder_list',
  'disk_folder_create',
  'disk_generate_id',
  'disk_upload_link',
  'disk_upload_content',
  'disk_download_link',
  'disk_download_content',
  'disk_download',
  'disk_create',
  'disk_retire',
  'google_access',
  'oauth_login',
  'diagnostic_check',
  'provider_result',
  'account_label'
]);
const CODES = new Set([
  ...Object.keys(STANDALONE_STATUS_MESSAGES),
  ...Object.keys(CLOUD_ACCESS_MESSAGES),
  'unknown_error',
  'Error',
  'TypeError',
  'RangeError',
  'OperationError',
  'DataError',
  'QuotaExceededError',
  'AbortError',
  'closed',
  'pending_changed',
  'confirmation_required',
  'destination_required',
  'credential_changed'
]);
const OUTCOMES = new Set(['start', 'ok', 'failed', 'blocked', 'reused', 'refreshed', 'cancelled']);
const SOURCES = [
  'standaloneFileExchange.js',
  'standaloneFileRuntime.js',
  'standaloneFileCodec.js',
  'publicSnapshot.js',
  'snapshotFilePrivate.js',
  'snapshotFile.js',
  'envelope.js',
  'keyBundle.js',
  'portableKeyCapsule.js',
  'exportSchema.js',
  'guardedStateWrite.js',
  'ui/standaloneFilePanel.js',
  'providers/nativeCloudSession.js',
  'providers/nativeDiskFetch.js'
];
const moduleUrl = new URL(import.meta.url);
const own = new Map([
  [
    moduleUrl.origin + moduleUrl.pathname,
    moduleUrl.pathname.endsWith('/cloudDiagnostics.js') ? 'cloudDiagnostics.js' : 'app_bundle'
  ]
]);
for (const file of SOURCES) {
  const url = new URL(file, import.meta.url);
  own.set(url.origin + url.pathname, file);
}
const trace = [];
const failures = [];
let lastSaveFailure = null;
let context = new WeakMap();
const listeners = new Set();
function changed() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* presentation must not affect cloud work */
    }
  }
}
export function subscribeCloudDiagnostics(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function sourceLocations(error) {
  const result = [];
  if (typeof error?.stack !== 'string') return result;
  // Ignore the exception message. Only exact URLs of OUR code are accepted.
  for (const line of error.stack.split('\n').slice(1, 20)) {
    const match = line.match(/((?:file|https?|tauri):\/\/[^\s)]+):(\d+):(\d+)/);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const key = url.origin + url.pathname;
      const name = own.get(key);
      if (name && +match[2] <= 1_000_000 && +match[3] <= 10_000_000) result.push(`${name}:${+match[2]}:${+match[3]}`);
    } catch {
      /* no raw fallback */
    }
    if (result.length === 3) break;
  }
  return result;
}
export function safeCloudErrorCode(error) {
  const diagnostic = cloudAccessDiagnostic(error);
  if (diagnostic) return diagnostic;
  const schema = safePreparationDiagnosticCode(error);
  if (schema) return schema;
  try {
    const message = error?.message;
    const name = error?.name;
    if (CODES.has(message)) return message;
    if (['TypeError', 'RangeError', 'OperationError', 'DataError', 'QuotaExceededError', 'AbortError'].includes(name))
      return name;
  } catch {
    /* never inspect arbitrary provider text */
  }
  return 'unknown_error';
}
export function recordCloudDiagnostic({ stage, provider = null, outcome, code = null, httpStatus = null }) {
  if (!STAGES.has(stage) || !OUTCOMES.has(outcome) || ![null, 'google', 'yandex'].includes(provider)) return;
  const row = {
    at: new Date().toISOString(),
    stage,
    provider,
    outcome,
    ...(CODES.has(code) || isPreparationDiagnosticCode(code) ? { code } : {}),
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {})
  };
  trace.push(Object.freeze(row));
  if (trace.length > 160) trace.shift();
  changed();
}
export function captureCloudFailure(stage, error, provider = null) {
  if (!STAGES.has(stage)) stage = 'ui_action';
  const previous = error && typeof error === 'object' ? context.get(error) : null;
  if (previous) {
    if (stage === 'ui_save' && previous.code !== 'save_cancelled') lastSaveFailure = previous;
    return previous;
  }
  let sources = [];
  try {
    sources = sourceLocations(error);
  } catch {
    /* do not retain the error */
  }
  const failure = Object.freeze({
    at: new Date().toISOString(),
    stage,
    code: safeCloudErrorCode(error),
    sources: Object.freeze(sources),
    provider: ['google', 'yandex'].includes(provider) ? provider : null
  });
  if (stage === 'ui_save' && failure.code !== 'save_cancelled') lastSaveFailure = failure;
  failures.push(failure);
  if (failures.length > 10) failures.shift();
  if (error && typeof error === 'object') context.set(error, failure);
  changed();
  return failure;
}
export async function cloudStep(stage, provider, work) {
  recordCloudDiagnostic({ stage, provider, outcome: 'start' });
  try {
    const value = await work();
    recordCloudDiagnostic({ stage, provider, outcome: 'ok' });
    return value;
  } catch (error) {
    const failure = captureCloudFailure(stage, error, provider);
    recordCloudDiagnostic({
      stage,
      provider,
      outcome: failure.code === 'compare_cancelled' ? 'cancelled' : 'failed',
      code: failure.code
    });
    throw error;
  }
}
export function clearCloudDiagnostics() {
  trace.length = 0;
  failures.length = 0;
  context = new WeakMap();
  lastSaveFailure = null;
  changed();
}
export function cloudDiagnosticSnapshot() {
  return {
    ...(lastSaveFailure ? { lastSaveFailure: { ...lastSaveFailure, sources: [...lastSaveFailure.sources] } } : {}),
    trace: trace.map(row => ({ ...row })),
    failures: failures.map(row => ({ ...row, sources: [...row.sources] }))
  };
}
function buildIdentity() {
  const input = typeof __TF_BUILD_INFO__ === 'undefined' ? null : __TF_BUILD_INFO__;
  return {
    version: typeof input?.version === 'string' && /^\d+\.\d+\.\d+$/.test(input.version) ? input.version : 'unknown',
    revision: typeof input?.revision === 'string' && /^[0-9a-f]{40}$/.test(input.revision) ? input.revision : 'unknown'
  };
}
export function projectCloudDiagnosticResult(input) {
  function rows(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).flatMap(row => {
      try {
        const provider = row?.provider;
        const status = row?.status;
        if (!['google', 'yandex'].includes(provider)) return [];
        return [
          withCloudAccessDiagnostic(
            Object.freeze({
              provider,
              status:
                typeof status === 'string' && Object.hasOwn(STANDALONE_STATUS_MESSAGES, status)
                  ? status
                  : 'unknown_error'
            }),
            cloudAccessDiagnostic(row)
          )
        ];
      } catch {
        return [];
      }
    });
  }
  try {
    return { results: rows(input?.results), pending: rows(input?.pending) };
  } catch {
    return { results: [], pending: [] };
  }
}
export function cloudDiagnosticReport({ desktop = false, result = null } = {}) {
  const build = buildIdentity();
  const snapshot = cloudDiagnosticSnapshot();
  const lines = [
    'Твиноферма — диагностика облака v1',
    `Сформировано: ${new Date().toISOString()}`,
    `Версия: ${build.version}; исходный код: ${build.revision}`,
    `Режим: ${desktop ? 'desktop' : 'browser'}`,
    `navigator.onLine: ${typeof navigator === 'undefined' ? 'unknown' : navigator.onLine ? 'true' : 'false'} (не доказывает доступ к дискам)`,
    'Проверка не отправляет файлы, не создаёт ключи и не открывает новый OAuth-вход. Может обновить доступ и сверить прежнюю квитанцию.',
    'Аккаунты, содержимое, токены, пароли, URL и локальные пути исключены.'
  ];
  if (result) {
    lines.push('Результаты текущей проверки:');
    for (const row of [
      ...projectCloudDiagnosticResult(result).results,
      ...projectCloudDiagnosticResult(result).pending
    ]) {
      const provider = row?.provider;
      const inputStatus = row?.status;
      if (!['google', 'yandex'].includes(provider)) continue;
      const status =
        typeof inputStatus === 'string' && Object.hasOwn(STANDALONE_STATUS_MESSAGES, inputStatus)
          ? inputStatus
          : 'unknown_error';
      const code = cloudAccessDiagnostic(row);
      lines.push(`${provider}: ${status}${code ? ` / ${code} / ${CLOUD_ACCESS_MESSAGES[code]}` : ''}`);
    }
  }
  if (snapshot.lastSaveFailure) {
    const failure = snapshot.lastSaveFailure;
    lines.push(
      'Последняя ошибка сохранения (не стирается последующими проверками):',
      `${failure.at} ${failure.provider || 'common'} ${failure.stage}: ${failure.code}${failure.sources.length ? ' @ ' + failure.sources.join(' ← ') : ''}`
    );
  }
  lines.push('Последние ошибки этого запуска:');
  for (const failure of snapshot.failures)
    lines.push(
      `${failure.at} ${failure.provider || 'common'} ${failure.stage}: ${failure.code}${failure.sources.length ? ' @ ' + failure.sources.join(' ← ') : ''}`
    );
  if (!snapshot.failures.length) lines.push('Перехваченных исключений нет; см. результаты провайдеров и журнал.');
  lines.push('Этапы этого запуска (последние 80):');
  for (const row of snapshot.trace.slice(-80))
    lines.push(
      `${row.at} ${row.provider || 'common'} ${row.stage}: ${row.outcome}${row.code ? ' / ' + row.code : ''}${row.httpStatus ? ' / HTTP ' + row.httpStatus : ''}`
    );
  lines.push('Последние события местного журнала:');
  for (const row of cloudActivity().slice(0, 10)) lines.push(describeCloudActivity(row));
  return lines.join('\n');
}
