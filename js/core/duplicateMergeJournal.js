// Best-effort interruption indicator in the local WebView profile. It stores no
// contacts and is not an fsync, a transaction, or a cross-process lock.
const KEY = 'tf:duplicate-merge-pending-v1';
const NAME = /^state\.backup-[0-9]+-dup-([0-9a-f]{24})-[0-9]+-[0-9]+\.json$/;
const fail = () => new Error('Не удалось подтвердить отметку слияния; проверьте резервные копии');

export function readDuplicateMergeJournal() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { status: 'none' };
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { status: 'invalid' };
    }
    if (
      !entry ||
      entry.version !== 1 ||
      typeof entry.name !== 'string' ||
      !NAME.test(entry.name) ||
      typeof entry.at !== 'string' ||
      !Number.isFinite(Date.parse(entry.at))
    )
      return { status: 'invalid' };
    return { status: 'pending', name: entry.name, at: entry.at };
  } catch {
    return { status: 'unavailable' };
  }
}

export function beginDuplicateMergeJournal(name) {
  if (readDuplicateMergeJournal().status !== 'none' || typeof name !== 'string' || !NAME.test(name)) throw fail();
  const entry = { version: 1, name, at: new Date().toISOString() };
  const raw = JSON.stringify(entry);
  try {
    window.localStorage.setItem(KEY, raw);
    if (window.localStorage.getItem(KEY) !== raw) throw fail();
  } catch {
    throw fail();
  }
  return entry;
}

// Never clear another operation's marker or hide a failure to remove it.
export function clearDuplicateMergeJournal(entry) {
  const expected = JSON.stringify(entry);
  try {
    if (window.localStorage.getItem(KEY) !== expected) throw fail();
    window.localStorage.removeItem(KEY);
    if (window.localStorage.getItem(KEY) !== null) throw fail();
  } catch {
    throw fail();
  }
}
