import fs from 'node:fs';
import path from 'node:path';
export function testFiles(root = process.cwd()) {
  return fs
    .readdirSync(path.join(root, 'tests'), { recursive: true })
    .filter(p => p.endsWith('.test.js'))
    .map(p => `tests/${p.replaceAll('\\', '/')}`)
    .sort();
}
export function balanceTests(files, durations = {}, count = 8) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('Invalid shard count');
  if (new Set(files).size !== files.length) throw new Error('Duplicate tests');
  const cost = file =>
    Number.isFinite(durations[file]) && durations[file] > 0 ? Math.min(durations[file], 3600000) + 500 : 3000;
  const shards = Array.from({ length: count }, () => ({ files: [], ms: 0 }));
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b, 'en'))) {
    const shard = shards.reduce((best, next) => (next.ms < best.ms ? next : best));
    shard.files.push(file);
    shard.ms += cost(file);
  }
  return shards;
}
export function durationsFromReport(report, root, allowed) {
  const result = {};
  for (const row of report.testResults || []) {
    const file = path.relative(root, row.name).replaceAll('\\', '/');
    const duration = row.endTime - row.startTime;
    if (allowed.includes(file) && Number.isFinite(duration) && duration >= 0) result[file] = Math.max(1, duration);
  }
  return result;
}
