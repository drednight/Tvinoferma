import fs from 'node:fs';
import { testFiles } from './test-balance.mjs';
const files = testFiles(),
  seen = new Set(),
  durations = {};
const reports = fs.readdirSync('.ci-results', { recursive: true }).filter(p => p.endsWith('.json'));
if (reports.length !== 8) throw new Error('Expected all eight shard reports');
for (const file of reports) {
  const report = JSON.parse(fs.readFileSync(`.ci-results/${file}`, 'utf8'));
  for (const name of report.files) {
    if (!files.includes(name) || seen.has(name)) throw new Error(`Invalid coverage: ${name}`);
    seen.add(name);
    const duration = report.durations[name];
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Missing measurement: ${name}`);
    durations[name] = duration;
  }
}
if (seen.size !== files.length) throw new Error('Incomplete test coverage');
fs.mkdirSync('.ci-timings', { recursive: true });
fs.writeFileSync('.ci-timings/latest.json', JSON.stringify(durations, null, 2) + '\n');
console.log(`Measured ${seen.size} test files, each covered exactly once.`);
