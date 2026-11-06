import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { balanceTests, testFiles, durationsFromReport } from './test-balance.mjs';
const [index, count] = (process.argv[2] || '').split('/').map(Number);
if (!Number.isInteger(index) || index < 1 || index > count) throw new Error('Expected shard INDEX/COUNT');
const root = process.cwd(),
  files = testFiles(root);
let timings = {};
try {
  timings = JSON.parse(fs.readFileSync('.ci-timings/latest.json', 'utf8'));
} catch {
  /* first run: collect baseline */
}
const shards = balanceTests(files, timings, count),
  selected = shards[index - 1].files;
if (!selected.length) throw new Error('Empty shard');
const measured = files.filter(file => timings[file] > 0).length;
console.log(
  `Balanced shard ${index}/${count}: ${selected.length}/${files.length} files; ${measured} measured. Estimated loads: ${shards.map(s => Math.round(s.ms / 1000)).join(', ')} seconds (before worker parallelism).`
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tvinoferma-tests-')),
  report = path.join(scratch, 'report.json');
const require = createRequire(import.meta.url),
  cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
let exit;
try {
  const child = spawnSync(
    process.execPath,
    [cli, 'run', ...selected, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${report}`],
    { stdio: 'inherit' }
  );
  exit = child.status ?? 1;
  if (child.error) console.error('Test runner could not start');
  if (fs.existsSync(report)) {
    const durations = durationsFromReport(JSON.parse(fs.readFileSync(report, 'utf8')), root, selected);
    fs.mkdirSync('.ci-results', { recursive: true });
    fs.writeFileSync(`.ci-results/${index}.json`, JSON.stringify({ files: selected, durations }));
    const slowest = Object.entries(durations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    console.log(
      `::notice title=JS shard ${index} measured::${slowest.map(([file, ms]) => `${file}: ${ms}ms`).join('; ')}`
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Shard ${index}/${count} slowest files\n\n| File | Measured time |\n| --- | --- |\n${slowest.map(([file, ms]) => `| ${file} | ${ms} ms |`).join('\n')}\n`
      );
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = exit;
