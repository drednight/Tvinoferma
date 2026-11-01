// @ts-check
import { GOOGLE_RECONNECT_STATUSES } from './standaloneStatus.js';
// Resume only preparation after explicit browser sign-in. Never retries a write,
// settles a refresh claim, changes a key, or removes an immutable pending file.
export async function prepareStandaloneSave({ engine, options, connect, progress }) {
  let prepared;
  let failure;
  try {
    prepared = await engine.prepareSave(options);
  } catch (error) {
    if (!Array.isArray(error.results)) throw error;
    failure = error;
  }
  const rows = prepared?.results || failure?.results || [];
  let connected = false;
  const attempted = new Set();
  for (const row of rows) {
    if (!options.targets.includes(row.provider) || attempted.has(row.provider)) continue;
    const needsLogin =
      row.status === 'credential_missing' ||
      (row.provider === 'google' && GOOGLE_RECONNECT_STATUSES.includes(row.status));
    if (!needsLogin) continue;
    attempted.add(row.provider);
    progress(row.provider);
    if (await connect(row.provider)) connected = true;
  }
  // Re-scan after a successful sign-in, exactly once. In particular, an unknown
  // refresh/write is NOT retried in a loop. Healthy destinations stay independent.
  if (connected) return engine.prepareSave(options);
  if (failure) throw failure;
  return prepared;
}
