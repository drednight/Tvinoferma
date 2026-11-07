import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatStaged } from '../scripts/format-staged.mjs';
async function repo(run) {
  const root = mkdtempSync(join(tmpdir(), 'tvinoferma-precommit-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    writeFileSync(join(root, '.prettierrc.json'), JSON.stringify({ singleQuote: true, semi: true }));
    writeFileSync(join(root, '.prettierignore'), 'ignored.js\n');
    await run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it('formats staged files including spaces, ignores excluded files and leaves unrelated edits alone', async () =>
  repo(async (root, git) => {
    writeFileSync(join(root, 'a file.js'), 'const a="test"');
    writeFileSync(join(root, 'ignored.js'), 'const b=1');
    writeFileSync(join(root, 'untracked.js'), 'const untouched=  2');
    git('add', 'a file.js', 'ignored.js');
    expect(await formatStaged(root)).toBe(1);
    expect(git('show', ':a file.js')).toBe("const a = 'test';\n");
    expect(readFileSync(join(root, 'a file.js'), 'utf8')).toBe("const a = 'test';\n");
    expect(git('show', ':ignored.js')).toBe('const b=1');
    expect(readFileSync(join(root, 'untracked.js'), 'utf8')).toBe('const untouched=  2');
    expect(git('diff', '--name-only')).toBe('');
    expect(await formatStaged(root)).toBe(0);
  }));
it('blocks formatting of partially staged files without losing staged or unstaged work', async () =>
  repo(async (root, git) => {
    writeFileSync(join(root, 'partial.js'), 'const a=1');
    git('add', 'partial.js');
    writeFileSync(join(root, 'partial.js'), 'const a=1\n// Not staged\n');
    await expect(formatStaged(root)).rejects.toThrow('Частично подготовленный файл');
    expect(git('show', ':partial.js')).toBe('const a=1');
    expect(readFileSync(join(root, 'partial.js'), 'utf8')).toBe('const a=1\n// Not staged\n');
  }));
it('blocks a syntax error before modifying any staged file', async () =>
  repo(async (root, git) => {
    writeFileSync(join(root, 'first.js'), 'let a=1');
    writeFileSync(join(root, 'invalid.js'), 'const =');
    git('add', '.');
    await expect(formatStaged(root)).rejects.toThrow();
    expect(git('show', ':first.js')).toBe('let a=1');
    expect(readFileSync(join(root, 'first.js'), 'utf8')).toBe('let a=1');
  }));

it('handles Windows CRLF working files without treating them as partial staging', async () =>
  repo(async (root, git) => {
    writeFileSync(join(root, '.gitattributes'), '* text=auto eol=lf\n');
    writeFileSync(join(root, 'windows.js'), 'const a=1\r\n');
    git('add', 'windows.js');
    expect(await formatStaged(root)).toBe(1);
    expect(git('show', ':windows.js')).toBe('const a = 1;\n');
    expect(git('diff', '--name-only')).toBe('');
  }));
