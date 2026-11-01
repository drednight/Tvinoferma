// @ts-check
// Local UI choices only: never passwords, files/paths, account IDs or consent.
const KEY = 'tf_cloud_file_options_v1';
const LISTS = Object.freeze({
  destinations: ['google', 'yandex'],
  privateFields: ['email', 'recoveryEmail', 'phone', 'password'],
  settings: ['appearance', 'navigation', 'planner', 'eventReminders']
});
function checked(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const result = { version: 1 };
  for (const [key, allowed] of Object.entries(LISTS)) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > allowed.length ||
      value[key].some(item => !allowed.includes(item)) ||
      new Set(value[key]).size !== value[key].length
    )
      return null;
    result[key] = allowed.filter(item => value[key].includes(item));
  }
  if (
    !['current', 'file'].includes(value.source) ||
    typeof value.remember !== 'boolean' ||
    typeof value.backups !== 'boolean'
  )
    return null;
  return { ...result, source: value.source, remember: value.remember, backups: value.backups };
}
export function readStandaloneFileOptions(doc) {
  try {
    const raw = doc.defaultView?.localStorage?.getItem(KEY);
    return raw && raw.length <= 2048 ? checked(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function writeStandaloneFileOptions(doc, value) {
  try {
    const safe = checked(value);
    if (!safe) return false;
    doc.defaultView.localStorage.setItem(KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}
export function clearStandaloneFileOptions(doc) {
  try {
    doc.defaultView?.localStorage?.removeItem(KEY);
  } catch {
    /* Reset cannot be interrupted by UI preferences. */
  }
}
