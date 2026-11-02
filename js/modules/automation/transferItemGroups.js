// One selectable site checkbox is an indivisible packet. Only genuinely identical
// packets are grouped; different quantities, sources or expiry dates stay separate.
export function groupTransferItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = JSON.stringify([item.name, item.qty, item.source || '', item.until || '']);
    if (!groups.has(key)) groups.set(key, { ...item, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export function chooseTransferPackets(group, count, previous) {
  if (!Number.isSafeInteger(count) || count < 0 || count > group.items.length) return null;
  const ids = group.items.map(item => item.id);
  const next = new Set(previous);
  const order = [...ids.filter(id => next.has(id)), ...ids.filter(id => !next.has(id))];
  ids.forEach(id => next.delete(id));
  order.slice(0, count).forEach(id => next.add(id));
  return next;
}
