/** Stable page identity: parser readiness/report fragments never belong to a source URL. */
export function normalizeMarathonUrl(value) {
  if (!String(value || '').trim()) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = 'https:';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return null;
  }
}
