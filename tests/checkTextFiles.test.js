import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkTextFiles, inspectBytes, isTextPath, report } from '../scripts/check-text-files.mjs';

function repo(run) {
  const root = mkdtempSync(join(tmpdir(), 'tvinoferma-textcheck-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('accepts clean UTF-8 text including Cyrillic and empty files', () => {
  expect(inspectBytes(Buffer.from('const a = "Привет";\n'))).toBeNull();
  expect(inspectBytes(Buffer.from(''))).toBeNull();
});

it('detects UTF-16 with and without BOM', () => {
  expect(inspectBytes(Buffer.from('\ufeffbody{}\n', 'utf16le'))?.kind).toBe('utf16');
  expect(inspectBytes(Buffer.from('# Title line here\n', 'utf16le'))?.kind).toBe('utf16');
});

it('detects a zero-filled tail and stray NUL bytes', () => {
  const tail = Buffer.concat([Buffer.from('# Заголовок\nтекст\n'), Buffer.alloc(300)]);
  expect(inspectBytes(tail)?.kind).toBe('zero-tail');
  const middle = Buffer.concat([Buffer.from('{"a":1'), Buffer.from([0]), Buffer.from('}\n')]);
  expect(inspectBytes(middle)?.kind).toBe('nul-bytes');
});

it('only warns about non-UTF-8 text', () => {
  const result = inspectBytes(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]));
  expect(result?.level).toBe('warning');
  expect(result?.kind).toBe('invalid-utf8');
});

it('checks only text paths', () => {
  expect(isTextPath('css/core/fab.css')).toBe(true);
  expect(isTextPath('.githooks/pre-commit')).toBe(true);
  expect(isTextPath('public/icon.png')).toBe(false);
});

it('finds corrupted tracked files in the working tree and skips binaries and deleted files', () =>
  repo((root, git) => {
    writeFileSync(join(root, 'ok.js'), 'const a = 1;\n');
    writeFileSync(join(root, 'bad.css'), Buffer.concat([Buffer.from('body{}\n'), Buffer.alloc(64)]));
    writeFileSync(join(root, 'pic.png'), Buffer.from([0, 1, 0, 0]));
    git('add', '.');
    const problems = checkTextFiles(root);
    expect(problems.map(problem => problem.file)).toEqual(['bad.css']);
    const lines = [];
    const errors = report(problems, {}, { error: line => lines.push(line), warn: line => lines.push(line) });
    expect(errors).toBe(1);
    expect(lines.join('\n')).toContain("git checkout HEAD -- 'bad.css'");
  }));

it('checks the staged content, not the working copy, in staged mode', () =>
  repo((root, git) => {
    writeFileSync(join(root, 'file.md'), Buffer.from('\ufeff# T\n', 'utf16le'));
    git('add', 'file.md');
    writeFileSync(join(root, 'file.md'), '# Fixed after staging\n');
    expect(checkTextFiles(root, { staged: true }).map(problem => problem.kind)).toEqual(['utf16']);
    expect(checkTextFiles(root)).toEqual([]);
  }));
