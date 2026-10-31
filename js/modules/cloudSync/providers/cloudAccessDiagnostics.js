// @ts-check
// Only fixed, non-personal stage codes. No response, exception text, URL or token.
// WeakMap metadata never enters durable queues or serialized IPC payloads.
const codes = new Set(
  ['identity', 'disk', 'upload_link', 'file_id'].flatMap(stage =>
    [
      'unauthorized',
      'forbidden',
      'rate_limited',
      'service_unavailable',
      'http_error',
      'invalid_response',
      'transport_unavailable',
      'timeout',
      'aborted'
    ].map(reason => `${stage}_${reason}`)
  )
);
const diagnostics = new WeakMap();
export function withCloudAccessDiagnostic(value, code) {
  if (value && (typeof value === 'object' || typeof value === 'function') && codes.has(code))
    diagnostics.set(value, code);
  return value;
}
export function cloudAccessDiagnostic(value) {
  return value && (typeof value === 'object' || typeof value === 'function') ? diagnostics.get(value) : undefined;
}
export function cloudAccessHttpDiagnostic(stage, status) {
  const reason =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 429
          ? 'rate_limited'
          : status >= 500 && status <= 599
            ? 'service_unavailable'
            : 'http_error';
  const code = `${stage}_${reason}`;
  return codes.has(code) ? code : undefined;
}
