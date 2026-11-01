// @ts-check
// Display ordering only. Never a replacement decision, authenticated causal
// ordering or permission to discard concurrent copies from the file engine.
export function providerCopyRows(files, showPrevious = false) {
  return ['google', 'yandex'].flatMap(provider => {
    const rows = files.flatMap(file =>
      file.locations
        .filter(location => location.provider === provider)
        .map(location => ({
          ...file,
          locations: [location]
        }))
    );
    const time = row => {
      const value = Date.parse(row.locations[0].modifiedAt);
      return Number.isFinite(value) ? value : -Infinity;
    };
    rows.sort((a, b) => time(b) - time(a) || a.versionId.localeCompare(b.versionId));
    return showPrevious ? rows : rows.slice(0, 1);
  });
}
const AUTO_KEY = 'tf_cloud_auto_check_v1';
const valid = value =>
  value?.version === 1 && typeof value.startup === 'boolean' && [0, 5, 15, 30, 60].includes(value.minutes);
export function readCloudAutoCheck(doc) {
  try {
    const raw = doc.defaultView?.localStorage?.getItem(AUTO_KEY);
    const value = raw && raw.length < 256 ? JSON.parse(raw) : null;
    if (valid(value)) return { version: 1, startup: value.startup, minutes: value.minutes };
  } catch {
    /* unavailable storage: safe defaults */
  }
  return { version: 1, startup: true, minutes: 5 };
}
export function writeCloudAutoCheck(doc, value) {
  try {
    if (!valid(value)) return false;
    doc.defaultView.localStorage.setItem(AUTO_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function clearCloudAutoCheck(doc) {
  try {
    doc.defaultView?.localStorage?.removeItem(AUTO_KEY);
  } catch {
    /* reset must continue */
  }
}
