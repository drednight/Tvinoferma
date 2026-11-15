// Format only staged regular files. Never stash, stage unrelated edits, or create a commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export async function formatStaged(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  const updates = [];
  for (const file of files) {
    const stage = git('ls-files', '--stage', '-z', '--', file);
    const mode = stage.split(' ')[0];
    if (!['100644', '100755'].includes(mode)) continue;
    const path = resolve(cwd, file);
    const info = await prettier.getFileInfo(path, {
      ignorePath: [resolve(cwd, '.prettierignore'), resolve(cwd, '.gitignore')]
    });
    if (info.ignored || !info.inferredParser) continue;
    const original = execFileSync('git', ['show', `:${file}`], { cwd });
    const config = (await prettier.resolveConfig(path, { editorconfig: true })) || {};
    const formatted = Buffer.from(await prettier.format(original.toString('utf8'), { ...config, filepath: path }));
    if (original.equals(formatted)) continue;
    // Compare Git's clean representation: CRLF checkouts must not look partially staged.
    const workingHash = execFileSync('git', ['hash-object', `--path=${file}`, '--stdin'], {
      cwd,
      input: readFileSync(path),
      encoding: 'utf8'
    }).trim();
    if (workingHash !== stage.split(' ')[1]) {
      throw new Error(
        `Частично подготовленный файл ${JSON.stringify(file)} требует форматирования. Отформатируйте его и заново выберите изменения для коммита. Неподготовленные правки не изменены.`
      );
    }
    updates.push({ file, path, mode, formatted });
  }
  for (const { file, path, mode, formatted } of updates) {
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      input: formatted,
      encoding: 'utf8'
    }).trim();
    writeFileSync(path, formatted);
    git('update-index', '--cacheinfo', mode, hash, file);
    console.log(`Prettier: ${JSON.stringify(file)}`);
  }
  return updates.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  formatStaged().catch(error => {
    console.error(`Prettier pre-commit: ${error.message}`);
    process.exitCode = 1;
  });
}
