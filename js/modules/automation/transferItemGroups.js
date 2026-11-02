// A site checkbox is an indivisible packet. Category/deadline do not split the
// display group, but remain on each real packet for exact native revalidation.
export function transferExpiry(until) {
  const text = String(until || '')
    .trim()
    .replace(/^до\s+/i, '');
  const match =
    /^(?:(\d{1,2}):(\d{2})\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?(?:\s*(?:МСК|мск))?$/.exec(text);
  if (!match) return Infinity; // Unknown dates never get an invented priority.
  const [, beforeH, beforeM, d, m, y, afterH, afterM] = match;
  if (beforeH !== undefined && afterH !== undefined) return Infinity;
  const hour = Number(beforeH ?? afterH ?? 23),
    minute = Number(beforeM ?? afterM ?? 59);
  const at = Date.UTC(Number(y), Number(m) - 1, Number(d), hour, minute);
  const date = new Date(at);
  if (
    hour > 23 ||
    minute > 59 ||
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  )
    return Infinity;
  return at - 3 * 3600000; // Website deadlines are Moscow time, not this PC's TZ.
}
export function groupTransferItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = JSON.stringify([item.name, item.qty]);
    if (!groups.has(key)) groups.set(key, { ...item, items: [] });
    groups.get(key).items.push(item);
  }
  for (const group of groups.values()) group.items.sort((a, b) => compareExpiry(a, b));
  return [...groups.values()];
}
function compareExpiry(a, b) {
  const left = transferExpiry(a.until),
    right = transferExpiry(b.until);
  return left === right ? 0 : left < right ? -1 : 1;
}
export function chooseTransferPackets(group, count, previous) {
  if (!Number.isSafeInteger(count) || count < 0 || count > group.items.length) return null;
  const next = new Set(previous);
  group.items.forEach(item => next.delete(item.id));
  [...group.items]
    .sort(compareExpiry)
    .slice(0, count)
    .forEach(item => next.add(item.id));
  return next;
}
