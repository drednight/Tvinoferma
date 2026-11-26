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
  expect(script).toContain('Get-SourceSnapshot');
  expect(script).toContain('$finalSourceSnapshot.Fingerprint -ne $sourceSnapshot.Fingerprint');
  expect(script).toContain('sourceFingerprint = $sourceSnapshot.Fingerprint');
  expect(script).not.toMatch(/^\s*(?:Start-Process|git (?:reset|checkout|push)|gh release|Set-ExecutionPolicy)\b/im);
  expect(script).toContain("$env:SKIP_GIT_HOOKS = '1'");
  expect(script).toContain('[Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]');
  expect(script).toContain('SEPARATE Windows test user');
});
it('does not die on a busy node_modules: verifies the tree before npm ci', () => {
  // На Windows `npm ci` удаляет node_modules целиком. Нативный .node (rolldown/vite)
  // может быть занят dev-сервером или антивирусом — удаление падает с EPERM -4048.
  // Скрипт обязан: (1) сначала проверить, что дерево и так совпадает с lock,
  // (2) при сбое объяснить причину по-русски, а не показать сырой стек.
  expect(script).toContain('Test-DependenciesMatchLock');
  expect(script).toContain('Dependencies already match package-lock.json; npm ci skipped.');
  expect(script).toContain('Format-InstallFailure');
  expect(script).toContain('EPERM');
  expect(script).toContain('node_modules/.bin/tauri.cmd');
  // Диагностика npm не должна проходить через `2>&1` в PowerShell: при
  // $ErrorActionPreference='Stop' это превращает stderr нативной команды в
  // исключение раньше, чем мы прочитаем код возврата. Перенаправление — в файл.
  expect(script).not.toMatch(/& npm\.cmd ci[^\n]*2>&1/);
  expect(script).toContain('cmd.exe /d /c');
  // Подсказка о занятом файле перечисляет реальные причины и не обещает `-SkipInstall` молча.
  for (const term of ['npm run dev', 'Get-Process node', '-SkipInstall']) expect(script).toContain(term);
});

it('guess-free dependency check: strict but not paranoid', () => {
  // Правила проверки должны оставаться явными в тексте скрипта.
  expect(script).toContain('meta.optional || meta.dev');
  expect(script).toContain('checked < 100');
  expect(script).toContain("'node_modules/vite'");
  expect(script).toContain("'node_modules/@tauri-apps/cli'");
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
    'НЕ проверены на Windows',
    'Linux',
    'Ctrl+Shift+B',
    'I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA',
    'EPERM',
    'npm ci skipped'
  ])
    expect(doc).toContain(term);
});

it('provides VS Code build/run tasks and validates the selected local executable', () => {
  const tasks = JSON.parse(readFileSync('.vscode/tasks.json', 'utf8'));
  const labels = tasks.tasks.map(task => task.label);
  expect(labels).toContain('Tvinoferma: Windows build (isolated)');
  expect(labels).toContain('Tvinoferma: Run latest Windows build (isolated)');
  expect(labels).toContain('Tvinoferma: Windows build (shared current data)');
  expect(labels).toContain('Tvinoferma: Run latest Windows build (shared current data)');
  const isolatedBuild = tasks.tasks.find(task => task.label === 'Tvinoferma: Windows build (isolated)');
  const sharedBuild = tasks.tasks.find(task => task.label === 'Tvinoferma: Windows build (shared current data)');
  expect(isolatedBuild.group).toEqual({ kind: 'build', isDefault: true });
  expect(isolatedBuild.args).toContain('-AllowDirty');
  expect(sharedBuild.args).toContain('${input:sharedProfileConfirmation}');
  const runner = readFileSync('scripts/run-windows-local.ps1', 'utf8');
  expect(runner).toContain('Start-Process');
  expect(runner).toContain('Get-FileHash');
  expect(runner).toContain('Get-Process -Name');
  expect(runner).toContain('I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA');
});
