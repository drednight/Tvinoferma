import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
const script = readFileSync('scripts/build-windows-local.ps1', 'utf8');
it('uses explicit unsigned locked Windows target and deterministic ignored output', () => {
  expect(script).toContain("$target = 'x86_64-pc-windows-msvc'");
  for (const flag of ["'--no-bundle'", "'--no-sign'", "'--locked'", "'--target'"]) expect(script).toContain(flag);
  expect(script).toContain('local-acceptance\\');
  expect(readFileSync('.gitignore', 'utf8')).toContain('/local-acceptance/');
  expect(script).toContain('Get-FileHash');
  expect(script).toContain('SHA256SUMS.txt');
  expect(script).toContain('BUILD-INFO.json');
});
it('checks exit codes, source identity and dependency files; never publishes or launches exe', () => {
  expect(script).toContain('$LASTEXITCODE -ne 0');
  expect(script).toContain('Dependency file changed during build');
  expect(script).toContain('HEAD changed during build');
  expect(script).toContain('-not $AllowDirty');
  expect(script).not.toMatch(/^\s*(?:Start-Process|git (?:reset|checkout|push)|gh release|Set-ExecutionPolicy)\b/im);
  expect(script).toContain("$env:SKIP_GIT_HOOKS = '1'");
  expect(script).toContain('[Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]');
  expect(script).toContain('SEPARATE Windows test user');
});
it('documents real Windows prerequisites, clean source and test-only limitations', () => {
  const doc = readFileSync('docs/LOCAL-WINDOWS-BUILD.md', 'utf8');
  for (const term of [
    'WebView2',
    'MSVC',
    '22.12',
    '-Checks Full',
    '-SkipInstall',
    '-AllowDirty',
    'НЕ изолированы',
    'Linux'
  ])
    expect(doc).toContain(term);
});
